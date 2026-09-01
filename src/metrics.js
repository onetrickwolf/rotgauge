// Per-file metric extraction: inline HTML scripts, line counting, and the
// AST walk that finds mutable state, coupling, and nesting.

import { parse } from '@babel/parser';
import { CODE_EXT_RE, HAS_EXT_RE } from './files.js';

// --- HTML analysis ---

export function analyzeHTML(source) {
  // Extract inline <script> blocks (skip external src= scripts).
  // Blocks are kept separate so duplicate `let` names across blocks
  // don't collide when parsed.
  const scripts = [];
  const scriptRe = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(source)) !== null) {
    const tagAttrs = match[0].split('>')[0];
    if (/\bsrc\s*=/.test(tagAttrs)) continue;
    const isModule = /\btype\s*=\s*["']module["']/i.test(tagAttrs);
    scripts.push({ code: match[1], isModule });
  }

  // Count non-blank inline <style> lines.
  let inlineCssLOC = 0;
  const styleRe = /<style(?:\s[^>]*)?>([^]*?)<\/style>/gi;
  while ((match = styleRe.exec(source)) !== null) {
    for (const line of match[1].split('\n')) {
      if (line.trim()) inlineCssLOC++;
    }
  }

  // Count inline event handlers outside <script>/<style> blocks.
  const stripped = source
    .replace(/<script(?:\s[^>]*)?>([^]*?)<\/script>/gi, '')
    .replace(/<style(?:\s[^>]*)?>([^]*?)<\/style>/gi, '');
  const handlerMatches = stripped.match(/\bon\w+\s*=/gi);
  const inlineHandlers = handlerMatches ? handlerMatches.length : 0;

  return { scripts, inlineCssLOC, inlineHandlers };
}

// --- Line counting ---

export function countLines(source) {
  let code = 0;
  let comments = 0;
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      comments++;
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      comments++;
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//')) { comments++; continue; }
    if (trimmed === '') continue;
    code++;
  }
  return { code, comments };
}

// --- AST analysis ---

const NESTING_NODES = new Set([
  'IfStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement',
  'SwitchStatement', 'ForInStatement', 'ForOfStatement', 'ConditionalExpression',
]);

// Collect every bound name out of a declaration pattern, including
// destructuring: `let { a, b: [c] } = x` yields a, c.
function collectPatternNames(id, names) {
  if (!id) return;
  switch (id.type) {
    case 'Identifier':
      names.add(id.name);
      break;
    case 'ObjectPattern':
      for (const p of id.properties) {
        collectPatternNames(p.type === 'RestElement' ? p.argument : p.value, names);
      }
      break;
    case 'ArrayPattern':
      for (const el of id.elements) collectPatternNames(el, names);
      break;
    case 'AssignmentPattern':
      collectPatternNames(id.left, names);
      break;
    case 'RestElement':
      collectPatternNames(id.argument, names);
      break;
    case 'TSParameterProperty': // constructor(private x: number)
      collectPatternNames(id.parameter, names);
      break;
  }
}

// A let declared inside a function this long behaves like module state: no
// one editing line 800 can see what line 200 did to it. Bindings in large
// enclosing functions get closure-state weighting instead of local.
export const CLOSURE_FN_LINES = 100;

export function emptyMetrics() {
  return {
    imports: [], fanOut: 0, exports: 0, letCount: 0, mutations: 0,
    functions: 0, maxFnLength: 0, maxNesting: 0, maxFnComplexity: 0,
    maxFnNesting: 0, templateLiteralLOC: 0, moduleLets: 0, moduleMutations: 0,
    closureLets: 0, closureMutations: 0,
    paramPropMutations: 0, maxDestructureWidth: 0, constObjMutations: 0,
    thisMutations: 0, maxParamCount: 0, importMethodCalls: 0,
  };
}

const SUM_KEYS = [
  'fanOut', 'exports', 'letCount', 'mutations', 'functions', 'templateLiteralLOC',
  'moduleLets', 'moduleMutations', 'closureLets', 'closureMutations',
  'paramPropMutations', 'constObjMutations',
  'thisMutations', 'importMethodCalls',
];
const MAX_KEYS = [
  'maxFnLength', 'maxNesting', 'maxFnComplexity', 'maxFnNesting',
  'maxDestructureWidth', 'maxParamCount',
];

export function mergeMetrics(list) {
  const out = emptyMetrics();
  for (const m of list) {
    out.imports.push(...m.imports);
    for (const k of SUM_KEYS) out[k] += m[k];
    for (const k of MAX_KEYS) out[k] = Math.max(out[k], m[k]);
  }
  return out;
}

// TypeScript expression wrappers carry no runtime meaning. Look through them so
// `(state as Foo).n++` and `p.y! = 2` count like their plain forms.
const TS_WRAPPERS = new Set([
  'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression',
]);
function unwrapTS(node) {
  while (node && TS_WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

// Type space: nothing in here runs, so nothing in here is mutable state, a
// function, or a template literal. Skipped wholesale rather than taught to the
// walker case by case. Namespaces are not here: their bodies are real code.
const TYPE_SPACE_KEYS = new Set([
  'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'superTypeParameters', 'implements',
]);

function isLocalCodeImport(src) {
  if (!src.startsWith('.') && !src.startsWith('/')) return false;
  // Skip asset imports (css, json, svg, ...) — only code modules count
  // toward fan-out. Extensionless specifiers are assumed to be code.
  return CODE_EXT_RE.test(src) || !HAS_EXT_RE.test(src);
}

export function analyzeAST(ast) {
  const m = emptyMetrics();
  const importedNames = new Set();
  const letVars = new Set();
  const closureLetNames = new Set();
  const paramStack = [];
  const fnLenStack = []; // line lengths of enclosing functions

  // Pre-walk: module-scope mutable (let/var) and const binding names.
  const moduleLetNames = new Set();
  const moduleConstNames = new Set();
  for (const stmt of ast.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'VariableDeclaration') {
      const target = decl.kind === 'const' ? moduleConstNames : moduleLetNames;
      for (const d of decl.declarations) collectPatternNames(d.id, target);
    }
  }
  m.moduleLets = moduleLetNames.size;

  function rootOf(memberExpr) {
    let cur = unwrapTS(memberExpr);
    while (cur.type === 'MemberExpression') cur = unwrapTS(cur.object);
    return cur;
  }

  function isParamName(name) {
    for (let i = paramStack.length - 1; i >= 0; i--) {
      if (paramStack[i].has(name)) return true;
    }
    return false;
  }

  function collectParamNames(params) {
    const names = new Set();
    for (const p of params) {
      collectPatternNames(p, names);
      if (p.type === 'ObjectPattern' && p.properties.length > m.maxDestructureWidth) {
        m.maxDestructureWidth = p.properties.length;
      }
    }
    return names;
  }

  function countMutation(target) {
    const targetNode = unwrapTS(target);
    if (targetNode.type === 'Identifier' && letVars.has(targetNode.name)) {
      m.mutations++;
      if (moduleLetNames.has(targetNode.name)) m.moduleMutations++;
      else if (closureLetNames.has(targetNode.name)) m.closureMutations++;
    }
    if (targetNode.type === 'MemberExpression') {
      const root = rootOf(targetNode);
      if (root.type === 'ThisExpression') m.thisMutations++;
      else if (root.type === 'Identifier') {
        if (isParamName(root.name)) m.paramPropMutations++;
        if (moduleConstNames.has(root.name)) m.constObjMutations++;
      }
    }
  }

  function visitChildren(node, depth, fnNesting, fnInfo, inTpl) {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      if (TYPE_SPACE_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            walk(item, depth, fnNesting, fnInfo, inTpl);
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        walk(child, depth, fnNesting, fnInfo, inTpl);
      }
    }
  }

  function walk(node, depth, fnNesting, fnInfo, inTpl) {
    if (NESTING_NODES.has(node.type)) {
      depth++;
      fnNesting++;
    }
    if (depth > m.maxNesting) m.maxNesting = depth;
    if (fnInfo && fnNesting > fnInfo.maxNesting) fnInfo.maxNesting = fnNesting;

    switch (node.type) {
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
      case 'TSDeclareFunction':
      case 'TSDeclareMethod':
        return; // type space: declares a shape, runs nothing

      case 'TSImportEqualsDeclaration': {
        // import x = require('./y'): CommonJS in TypeScript clothing.
        const ref = node.moduleReference;
        if (
          ref && ref.type === 'TSExternalModuleReference' && ref.expression &&
          typeof ref.expression.value === 'string' && isLocalCodeImport(ref.expression.value)
        ) {
          m.fanOut++;
          m.imports.push(ref.expression.value);
        }
        if (node.id && node.id.name) importedNames.add(node.id.name);
        break;
      }

      case 'ImportDeclaration': {
        const src = node.source.value;
        if (isLocalCodeImport(src)) {
          m.fanOut++;
          m.imports.push(src);
        }
        for (const spec of node.specifiers || []) {
          if (spec.local && spec.local.name) importedNames.add(spec.local.name);
        }
        break;
      }

      case 'ExportNamedDeclaration': {
        const decl = node.declaration;
        if (decl) {
          if (decl.declarations) {
            m.exports += decl.declarations.length;
          } else if (decl.type === 'TSDeclareFunction' && !decl.declare) {
            // An overload signature: the implementation that follows is the export.
          } else {
            m.exports++; // function, class, interface, type alias, enum, namespace
          }
        }
        if (node.specifiers) m.exports += node.specifiers.length;
        break;
      }

      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        m.exports++;
        break;

      case 'VariableDeclaration': {
        for (const decl of node.declarations) {
          if (node.kind === 'let' || node.kind === 'var') {
            const names = new Set();
            collectPatternNames(decl.id, names);
            m.letCount += names.size;
            for (const n of names) letVars.add(n);
            const enclosingFnLen = fnLenStack.length > 0 ? fnLenStack[fnLenStack.length - 1] : 0;
            if (enclosingFnLen >= CLOSURE_FN_LINES) {
              m.closureLets += names.size;
              for (const n of names) closureLetNames.add(n);
            }
          }
          if (decl.id && decl.id.type === 'ObjectPattern' && decl.id.properties.length > m.maxDestructureWidth) {
            m.maxDestructureWidth = decl.id.properties.length;
          }
        }
        break;
      }

      case 'AssignmentExpression':
        if (node.left) countMutation(node.left);
        break;

      case 'UpdateExpression':
        if (node.argument) countMutation(node.argument);
        break;

      case 'CallExpression': {
        if (node.callee && node.callee.type === 'MemberExpression') {
          const root = rootOf(node.callee);
          if (root.type === 'Identifier' && importedNames.has(root.name)) m.importMethodCalls++;
        }
        // CommonJS: require('./x') counts toward fan-out like an import.
        if (
          node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
          node.arguments && node.arguments[0] && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string' && isLocalCodeImport(node.arguments[0].value)
        ) {
          m.fanOut++;
          m.imports.push(node.arguments[0].value);
        }
        break;
      }

      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        m.functions++;
        if (node.params.length > m.maxParamCount) m.maxParamCount = node.params.length;
        const fnLength = node.loc.end.line - node.loc.start.line + 1;
        if (fnLength > m.maxFnLength) m.maxFnLength = fnLength;

        paramStack.push(collectParamNames(node.params));
        fnLenStack.push(fnLength);
        const info = { maxNesting: 0 };
        visitChildren(node, depth, 0, info, inTpl);
        const compound = fnLength * (1 + info.maxNesting * 0.3);
        if (compound > m.maxFnComplexity) {
          m.maxFnComplexity = compound;
          m.maxFnNesting = info.maxNesting;
        }
        paramStack.pop();
        fnLenStack.pop();
        return; // children already visited
      }

      case 'TemplateLiteral': {
        // Only count top-level templates; a nested template's lines are
        // already inside the outer one's span.
        if (!inTpl) {
          const spanned = node.loc.end.line - node.loc.start.line + 1;
          if (spanned >= 3) m.templateLiteralLOC += spanned;
        }
        visitChildren(node, depth, fnNesting, fnInfo, true);
        return;
      }
    }

    visitChildren(node, depth, fnNesting, fnInfo, inTpl);
  }

  walk(ast, 0, 0, null, false);
  return m;
}

// --- Source analysis (parse + walk) ---
//
// The source is parsed as written, types and JSX included. Nothing is
// transpiled: an agent edits the .ts file, so the .ts file is what gets
// measured. Function lengths are real line counts, an enum is a type rather
// than a mutable var, and type-heavy code is at least visible as size.

// Which syntax a file speaks. `.ts` deliberately leaves JSX off: `<T>(x)` is
// a generic arrow in .ts and a JSX tag in .tsx.
export function dialectFor(filePath) {
  if (/\.d\.[mc]?ts$/.test(filePath)) return 'dts';
  if (/\.(ts|mts|cts)$/.test(filePath)) return 'ts';
  if (filePath.endsWith('.tsx')) return 'tsx';
  return 'js';
}

const PLUGINS = {
  js: ['estree', 'jsx'],
  ts: ['estree', 'typescript'],
  dts: ['estree', ['typescript', { dts: true }]],
  tsx: ['estree', 'typescript', 'jsx'],
};

// The estree plugin makes Babel's AST match the ESTree shapes the walker was
// written against; TypeScript nodes come through with their TS* names.
export function parseJS(source, sourceType = 'module', dialect = 'js') {
  return parse(source, {
    sourceType,
    plugins: PLUGINS[dialect],
    attachComment: false,
  }).program;
}

// Analyze a JS/TS/JSX source string. Tries module parse first, falls back
// to script for CommonJS-flavored files.
export function analyzeSource(source, { dialect = 'js' } = {}) {
  if (!source.trim()) return emptyMetrics();
  let ast;
  try {
    ast = parseJS(source, 'module', dialect);
  } catch (moduleErr) {
    try {
      ast = parseJS(source, 'script', dialect);
    } catch {
      throw moduleErr;
    }
  }
  return analyzeAST(ast);
}
