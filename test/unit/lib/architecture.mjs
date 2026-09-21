// Pure architecture checker for Blob. NO fs, NO Electron: it takes a Map of relative path -> source
// text plus the parsed root package.json, and returns a list of violations. That is what lets the
// tests feed it synthetic trees (proving every rule has teeth) and the real repo (proving the code
// obeys the rules). The rules come from docs/NOTES-PLAN.md section 3 ("Dependency rules").
//
// Layout of this file, top to bottom:
//   1. tokenizer      comments / strings / templates / regex literals, so identifier rules only ever
//                     look at real code and import rules only ever look at real import statements
//   2. imports        import / export-from / import() / require() extraction and path resolution
//   3. small helpers  glob matcher, HTML <script> reader, cycle finder
//   4. the rules      one small function per rule, gathered in the RULES table
//   5. checkArchitecture()

import { posix } from 'node:path'; // pure string maths on '/' paths: not file system access

// ---------------------------------------------------------------------------------------------
// 1. Tokenizer
// ---------------------------------------------------------------------------------------------

// After one of these words a "/" starts a regex literal; after any other word (an identifier or a
// number) it is a division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

const isWordChar = (c) => /[\w$]/.test(c) || c.charCodeAt(0) > 127;

// End index (exclusive) of the string literal starting at i, or -1 when it is unterminated. A
// string cannot span lines (except via a backslash line continuation), so a stray quote only ever
// costs one line: the lexer treats it as punctuation and carries on.
function scanString(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 2 : 1; continue; }
    if (ch === quote) return j + 1;
    if (ch === '\n' || ch === '\r') return -1;
  }
  return -1;
}

// End index (exclusive, flags included) of the regex literal starting at i, or -1. Handles escapes
// and character classes, where an unescaped "/" does not end the literal.
function scanRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') { j++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '/') {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      return k;
    }
  }
  return -1;
}

// Can a "/" here begin a regex literal? Decided by the previous significant token. The classic
// ambiguity: after ")" or "]" it is a division; after "}" we guess a regex (statement start).
function regexAllowed(prev, prev2) {
  if (!prev) return true;
  if (prev.type === 'word') {
    const isProperty = prev2 && prev2.type === 'punct' && prev2.text === '.';
    return REGEX_KEYWORDS.has(prev.text) && !isProperty;
  }
  if (prev.type === 'template') return prev.opens; // "${" opens an expression, a closing backtick ends one
  if (prev.type === 'punct') return ![')', ']', '++', '--'].includes(prev.text);
  return false; // after a string or a regex literal
}

// Splits source into tokens of type: space | comment | string | template | regex | word | punct.
// Concatenating every token's text gives the source back exactly. Template literals are split so
// that the text pieces are 'template' tokens (delimiters included: the opening backtick, "${", the
// "}" that closes an expression, the closing backtick) while the code inside "${ ... }" is lexed
// as ordinary code, because it is real code.
export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  const interp = []; // open-brace count inside each active "${ }"
  let prev = null;
  let prev2 = null;
  let i = 0;

  const push = (type, start, end, extra) => {
    tokens.push({ type, start, end, text: src.slice(start, end), ...extra });
    if (type !== 'space' && type !== 'comment') { prev2 = prev; prev = tokens[tokens.length - 1]; }
  };

  // Lex template text from `from` up to the closing backtick or the next "${"; the token starts at
  // `start` (the opening backtick, or the "}" that closed the previous expression).
  const lexTemplate = (start, from) => {
    for (let j = from; j < n; j++) {
      const ch = src[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '`') { push('template', start, j + 1, { opens: false }); return j + 1; }
      if (ch === '$' && src[j + 1] === '{') {
        interp.push(0);
        push('template', start, j + 2, { opens: true });
        return j + 2;
      }
    }
    push('template', start, n, { opens: false }); // unterminated: swallow the rest
    return n;
  };

  if (src.startsWith('#!')) { // shebang line
    let j = 0;
    while (j < n && src[j] !== '\n') j++;
    push('comment', 0, j);
    i = j;
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    let j;
    if (/\s/.test(c)) {
      j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      push('space', i, j);
    } else if (c === '/' && d === '/') {
      j = i;
      while (j < n && src[j] !== '\n' && src[j] !== '\r') j++;
      push('comment', i, j);
    } else if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2);
      j = close < 0 ? n : close + 2;
      push('comment', i, j);
    } else if (c === '"' || c === "'") {
      j = scanString(src, i);
      if (j < 0) { j = i + 1; push('punct', i, j); } else push('string', i, j);
    } else if (c === '`') {
      j = lexTemplate(i, i + 1);
    } else if (c === '}' && interp.length && interp[interp.length - 1] === 0) {
      interp.pop();
      j = lexTemplate(i, i + 1);
    } else if (c === '/' && regexAllowed(prev, prev2) && (j = scanRegex(src, i)) > 0) {
      push('regex', i, j);
    } else if (isWordChar(c)) {
      j = i + 1;
      while (j < n && isWordChar(src[j])) j++;
      push('word', i, j);
    } else {
      j = (c === '+' || c === '-') && d === c ? i + 2 : i + 1; // "++" / "--" are one token
      if (interp.length) {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') interp[interp.length - 1]--;
      }
      push('punct', i, j);
    }
    i = j;
  }
  return tokens;
}

// Same length, same line breaks: every character except a newline becomes a space, so offsets and
// line numbers computed on the stripped text are valid for the original source.
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

const BLANKED_IN_CODE = new Set(['comment', 'string', 'template', 'regex']);

// Source with comments blanked out. Strings survive (import specifiers and channel names live there).
export function stripComments(src) {
  return tokenize(src).map((t) => (t.type === 'comment' ? blank(t.text) : t.text)).join('');
}

// Source with comments, strings, template text and regex literals blanked out: only real code
// remains, including the code inside "${ }". Identifier rules run on this.
export function stripCode(src) {
  return tokenize(src).map((t) => (BLANKED_IN_CODE.has(t.type) ? blank(t.text) : t.text)).join('');
}

// 1-based line number of a character offset.
export function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text[k] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------------------------
// 2. Imports, calls and path resolution
// ---------------------------------------------------------------------------------------------

const significant = (src) => tokenize(src).filter((t) => t.type !== 'space' && t.type !== 'comment');
const isPunct = (t, text) => !!t && t.type === 'punct' && t.text === text;
const isWord = (t, text) => !!t && t.type === 'word' && t.text === text;

// The string a token stands for when it is a plain string literal (or a template without "${ }"),
// else null. Escapes are not decoded: specifiers and channel names never contain any.
function literalValue(t) {
  if (!t) return null;
  if (t.type === 'string') return t.text.slice(1, -1);
  const plainTemplate = t.type === 'template' && !t.opens && t.text.length >= 2
    && t.text.startsWith('`') && t.text.endsWith('`');
  return plainTemplate ? t.text.slice(1, -1) : null;
}

// Every module dependency a file declares, read from its TOKENS (never from raw text), so an import
// inside a comment or a string is not one. Returns [{ kind, specifier, line }] where kind is
// 'import' (static import, or export ... from), 'dynamic' (import()), or 'require' (require()).
// specifier is null when a dynamic import()/require() is not a plain string literal: the checker
// cannot see where that goes, and the rules treat it as a violation of its own.
export function extractImports(src) {
  const sig = significant(src);
  const found = [];
  const add = (kind, specifier, at) => found.push({ kind, specifier, line: lineOf(src, at.start) });

  // The specifier of import()/require(): a lone string literal argument, else null.
  const callSpecifier = (k) => {
    const value = literalValue(sig[k + 2]);
    const closed = isPunct(sig[k + 3], ')') || isPunct(sig[k + 3], ',');
    return value !== null && closed ? value : null;
  };
  // First string literal after index k, giving up at ";". Covers `import 'x'`, `import a from 'x'`,
  // `import { a } from 'x'`, `import * as a from 'x'` and `export * from 'x'`.
  const firstStringAfter = (k) => {
    for (let m = k + 1; m < sig.length && !isPunct(sig[m], ';'); m++) {
      if (sig[m].type === 'string') return sig[m];
    }
    return null;
  };

  // A call, as opposed to a method DEFINITION such as `class A { require(x) { ... } }`: a definition
  // has a "{" right after its closing parenthesis.
  const isDefinition = (k) => {
    let depth = 0;
    for (let m = k + 1; m < sig.length; m++) {
      if (isPunct(sig[m], '(')) depth++;
      else if (isPunct(sig[m], ')') && --depth === 0) return isPunct(sig[m + 1], '{');
    }
    return false;
  };
  // Handles import()/require(): a literal specifier is always a call; anything else must not be a
  // method definition to count as an unverifiable one.
  const addCall = (kind, k, at) => {
    const specifier = callSpecifier(k);
    if (specifier !== null || !isDefinition(k)) add(kind, specifier, at);
  };

  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.type !== 'word') continue;
    const before = sig[k - 1];
    const next = sig[k + 1];
    // `x.require(...)` is a method call, not the keyword; `...require(...)` (spread) is not a member access.
    if (isPunct(before, '.') && !isPunct(sig[k - 2], '.')) continue;

    if (t.text === 'import') {
      if (isPunct(next, '.')) continue; // import.meta
      if (isPunct(next, '(')) addCall('dynamic', k, t);
      else {
        const s = firstStringAfter(k);
        if (s) add('import', literalValue(s), t);
      }
    } else if (t.text === 'require' && isPunct(next, '(') && !isWord(before, 'function')) {
      addCall('require', k, t);
    } else if (t.text === 'export') {
      if (isPunct(next, '*')) {
        const s = firstStringAfter(k);
        if (s) add('import', literalValue(s), t);
      } else if (isPunct(next, '{')) { // export { a, b } from 'x'   (without "from" it is a local export)
        let m = k + 2;
        while (m < sig.length && !isPunct(sig[m], '}')) m++;
        if (isWord(sig[m + 1], 'from') && sig[m + 2] && sig[m + 2].type === 'string') {
          add('import', literalValue(sig[m + 2]), t);
        }
      }
    }
  }
  return found;
}

// Calls like `ipcMain.handle('channel', ...)` or `webContents.send('channel')`: every call of one of
// `methods` on an identifier called `objectName` (so `win.webContents.send(` matches too).
// Returns [{ method, channel, line }]; channel is null when the first argument is not a plain
// string literal.
export function findCalls(src, objectName, methods) {
  const sig = significant(src);
  const calls = [];
  for (let k = 0; k < sig.length; k++) {
    if (!isWord(sig[k], objectName)) continue;
    let m = k + 1;
    if (isPunct(sig[m], '?')) m++; // optional chaining: obj?.method(
    if (!isPunct(sig[m], '.')) continue;
    const method = sig[m + 1];
    if (!method || method.type !== 'word' || !methods.includes(method.text) || !isPunct(sig[m + 2], '(')) continue;
    const value = literalValue(sig[m + 3]);
    const closed = isPunct(sig[m + 4], ')') || isPunct(sig[m + 4], ',');
    calls.push({ method: method.text, channel: value !== null && closed ? value : null, line: lineOf(src, sig[k].start) });
  }
  return calls;
}

// Where does `specifier`, written inside file `fromPath`, point?
//   { kind: 'relative', path }  a ./ or ../ specifier, resolved against the importing file's folder
//                               and normalised: 'src/ui/views/x.js' + '../../core/a.js' -> 'src/core/a.js'
//   { kind: 'bare' }            a package or built-in: 'electron', 'fs', 'node:path'
//   { kind: 'absolute' }        '/x.js', 'file:...', 'https:...': cannot be checked, never allowed
//   { kind: 'dynamic' }         not a string literal
export function resolveImport(fromPath, specifier) {
  if (specifier === null) return { kind: 'dynamic' };
  if (/^\.{1,2}(\/|$)/.test(specifier)) {
    return { kind: 'relative', path: posix.normalize(posix.join(posix.dirname(fromPath), specifier)) };
  }
  if (/^(\/|file:|https?:|data:)/i.test(specifier)) return { kind: 'absolute' };
  return { kind: 'bare' };
}

const isScript = (path) => /\.(js|mjs|cjs)$/.test(path);
const startsWithDir = (path, dir) => path.startsWith(dir); // dir always ends with "/"

// ---------------------------------------------------------------------------------------------
// 3. Small helpers: glob matcher, HTML <script> reader, cycle finder
// ---------------------------------------------------------------------------------------------

// Tiny glob -> RegExp, enough for electron-builder's `files` entries:
//   exact names ('main.js'), 'dir/**' (everything below dir), '**/x' (x at any depth),
//   '*' (anything except '/'), '?' (one character except '/').
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } // "**/": any number of folders, or none
      else re += '.*'; // trailing "**": anything below
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Is `path` shipped by these electron-builder `files` patterns? Patterns apply in order and the last
// match wins, so "!pattern" removes files again. Non-string entries (FileSet objects) are ignored.
export function isPackaged(path, patterns) {
  let shipped = false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const negated = raw.startsWith('!');
    const glob = raw.slice(negated ? 1 : 0).replace(/^\.\//, '');
    if (globToRegExp(glob).test(path)) shipped = !negated;
  }
  return shipped;
}

// Attributes of one tag's text, lower-cased names: ` type="module" src='a.js' defer ` -> { type, src, defer }.
function parseAttributes(text) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

// The <script> tags of an HTML page (HTML comments ignored): { count, first: { attrs, body } | null }.
export function readScriptTags(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const count = (text.match(/<script\b/gi) || []).length;
  const m = /<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/i.exec(text);
  return { count, first: m ? { attrs: parseAttributes(m[1]), body: m[2] } : null };
}

// Import cycles in a graph (Map: node -> array of nodes it imports). Returns each cycle once, as an
// array of nodes starting from the alphabetically smallest, e.g. ['a.js', 'b.js'] for a -> b -> a.
export function findCycles(graph) {
  const state = new Map(); // node -> 1 while on the current path, 2 once fully explored
  const path = [];
  const seen = new Set();
  const cycles = [];
  const visit = (node) => {
    state.set(node, 1);
    path.push(node);
    for (const next of [...(graph.get(node) || [])].sort()) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 1) {
        const loop = path.slice(path.indexOf(next));
        const from = loop.indexOf([...loop].sort()[0]);
        const cycle = [...loop.slice(from), ...loop.slice(0, from)];
        if (!seen.has(cycle.join('>'))) { seen.add(cycle.join('>')); cycles.push(cycle); }
      } else if (!state.has(next)) visit(next);
    }
    path.pop();
    state.set(node, 2);
  };
  for (const node of [...graph.keys()].sort()) if (!state.has(node)) visit(node);
  return cycles;
}

// ---------------------------------------------------------------------------------------------
// 4. The rules. Each one is a small function (ctx, report) -> void, listed in RULES below.
//    ctx: files, packageJson, paths, scripts(predicate), code(path), noComments(path), imports(path)
//    report(file, message, line?) records one violation of that rule.
// ---------------------------------------------------------------------------------------------

const CORE = 'src/core/';
const VIEWS = 'src/ui/views/';
const BRIDGE = 'src/ui/bridge.js';
const IPC = 'main/ipc.js';
const PRELOAD = 'preload.js';

// A view may import ONLY these files (resolved paths). Everything else it needs is handed to it.
// (titleEditor was added with the rename feature: like bodyEditor it is one more editor a row uses, and it too
// is handed everything it needs. The rule keeps views from reaching the store or the bridge; it is not there to
// freeze the list of view files.)
const VIEW_ALLOWED_IMPORTS = new Set([
  'src/ui/dom.js', 'src/ui/theme.js', 'src/ui/format.js',
  'src/ui/views/itemRow.js', 'src/ui/views/bodyEditor.js', 'src/ui/views/titleEditor.js',
  'src/core/selectors.js', 'src/core/linkify.js',
]);

// Identifiers matched against real code (comments, strings, templates and regex literals blanked).
const id = (label, source) => ({ label, re: new RegExp(source) });
const CORE_FORBIDDEN = [
  id('window', '\\bwindow\\b'), id('document', '\\bdocument\\b'), id('require(', '\\brequire\\s*\\('),
  id('electron', '\\belectron\\b'), id('process.', '\\bprocess\\s*\\??\\.'),
  id('localStorage', '\\blocalStorage\\b'), id('fetch(', '\\bfetch\\s*\\('),
];
const UI_FORBIDDEN = [id('electron', '\\belectron\\b'), id('require(', '\\brequire\\s*\\(')];
const DOM_IDENTIFIERS = [id('window', '\\bwindow\\b'), id('document', '\\bdocument\\b')];

// First occurrence of each pattern in `text`: [{ label, line }].
function firstHits(text, patterns) {
  const hits = [];
  for (const { label, re } of patterns) {
    const m = re.exec(text);
    if (m) hits.push({ label, line: lineOf(text, m.index) });
  }
  return hits;
}

// Human wording for one import in a message.
function describeImport(imp, target) {
  if (imp.specifier === null) {
    return `a ${imp.kind === 'require' ? 'require()' : 'dynamic import()'} whose target is not a string literal (it cannot be checked)`;
  }
  return `imports '${imp.specifier}'${target.kind === 'relative' ? ` (${target.path})` : ''}`;
}

// R1: src/core/ is pure. It runs in Node today and in a phone app later, so it may import only other
// core files and must not mention anything from the browser, Electron or Node.
function corePurity(ctx, report) {
  for (const file of ctx.scripts((p) => startsWithDir(p, CORE))) {
    for (const imp of ctx.imports(file)) {
      const target = resolveImport(file, imp.specifier);
      if (target.kind === 'relative' && startsWithDir(target.path, CORE)) continue;
      report(file, `${describeImport(imp, target)}, which is outside src/core/. Core imports only other core files: `
        + 'take what it needs as an argument instead of reaching out.', imp.line);
    }
    for (const hit of firstHits(ctx.code(file), CORE_FORBIDDEN)) {
      report(file, `uses \`${hit.label}\`. Core is pure (no DOM, no Electron, no I/O, no globals): `
        + 'pass that capability in as an argument.', hit.line);
    }
  }
}

// R2 (renderer): views are handed what they need, they never fetch it themselves. The short
// allow-list keeps them from touching the store (mutation) or the bridge (I/O).
function viewsIsolation(ctx, report) {
  for (const file of ctx.scripts((p) => startsWithDir(p, VIEWS))) {
    for (const imp of ctx.imports(file)) {
      const target = resolveImport(file, imp.specifier);
      if (target.kind === 'relative' && VIEW_ALLOWED_IMPORTS.has(target.path)) continue;
      report(file, `${describeImport(imp, target)}. Views may import only ui/dom, ui/theme, ui/format, views/itemRow, `
        + 'views/bodyEditor, views/titleEditor, core/selectors and core/linkify. They receive data and actions as arguments; ui/app.js does the wiring '
        + '(never import core/itemStore or ui/bridge from a view).', imp.line);
    }
  }
}

// R3 (renderer): one door to Electron. The bare name is matched (not just "window.threadAxis") so
// window['threadAxis'], globalThis.threadAxis and `const { threadAxis } = window` cannot sneak round it.
function bridgeOnly(ctx, report) {
  for (const file of ctx.scripts((p) => startsWithDir(p, 'src/') && p !== BRIDGE)) {
    const text = ctx.noComments(file);
    const m = /\bthreadAxis\b/.exec(text);
    if (m) {
      report(file, 'mentions threadAxis, the Electron bridge. Only src/ui/bridge.js may read window.threadAxis: '
        + 'ui/app.js imports the bridge and hands each module the functions it needs.', lineOf(text, m.index));
    }
  }
  // "Exactly one file": the door itself has to exist and use the bridge.
  if (!ctx.files.has(BRIDGE) || !/\bthreadAxis\b/.test(ctx.noComments(BRIDGE))) {
    report(BRIDGE, 'is missing, or never reads window.threadAxis. It must be the single place that does.');
  }
}

// R4: the UI half of the app never reaches into the main process or Electron. (src/core/ is covered,
// more strictly, by R1.) Dynamic imports with a non-literal target cannot be proven bad here; the
// allow-list rules R1 and R2 reject them where it matters.
function uiDoesNotReachMain(ctx, report) {
  for (const file of ctx.scripts((p) => startsWithDir(p, 'src/') && !startsWithDir(p, CORE))) {
    for (const imp of ctx.imports(file)) {
      const target = resolveImport(file, imp.specifier);
      const intoMain = target.kind === 'relative'
        && (startsWithDir(target.path, 'main/') || target.path === 'main.js' || target.path === PRELOAD);
      const electron = target.kind === 'bare' && /^electron(\/|$)/.test(imp.specifier);
      if (intoMain || electron) {
        report(file, `${describeImport(imp, target)}. The UI never imports from the main process or Electron: `
          + 'go through src/ui/bridge.js (window.threadAxis) instead.', imp.line);
      }
    }
    for (const hit of firstHits(ctx.code(file), UI_FORBIDDEN)) {
      report(file, `mentions \`${hit.label}\`. The UI never touches Electron or CommonJS: go through src/ui/bridge.js.`, hit.line);
    }
  }
}

// R5 (main): the main process never reaches into the renderer code, and has no DOM. preload.js is
// checked for imports only: it legitimately runs next to a window.
function mainDoesNotReachSrc(ctx, report) {
  const mainSide = ctx.scripts((p) => p === 'main.js' || p === PRELOAD || startsWithDir(p, 'main/'));
  for (const file of mainSide) {
    for (const imp of ctx.imports(file)) {
      const target = resolveImport(file, imp.specifier);
      if (target.kind === 'relative' && startsWithDir(target.path, 'src/')) {
        report(file, `${describeImport(imp, target)}. The main process never imports renderer code (src/): `
          + 'put shared logic in a pure module under main/lib/ (main re-validates on its own side on purpose).', imp.line);
      }
    }
  }
  for (const file of mainSide.filter((p) => p !== PRELOAD)) {
    for (const hit of firstHits(ctx.code(file), DOM_IDENTIFIERS)) {
      report(file, `uses \`${hit.label}\`. The main process has no DOM: that belongs in src/ui/.`, hit.line);
    }
  }
}

// R6 (main): every IPC channel goes through one door on each side.
function ipcSingleDoor(ctx, report) {
  for (const file of ctx.scripts(() => true)) {
    const code = ctx.code(file);
    let m = file === IPC ? null : /\bipcMain\s*(?:\?\.|\.|\[)/.exec(code);
    if (m) {
      report(file, 'uses ipcMain. Only main/ipc.js registers channels: add the channel to that table.', lineOf(code, m.index));
    }
    m = file === PRELOAD ? null : /\bipcRenderer\b/.exec(code);
    if (m) {
      report(file, 'uses ipcRenderer. Only preload.js may: expose a method on window.threadAxis there '
        + 'and reach it through src/ui/bridge.js.', lineOf(code, m.index));
    }
  }
}

// R7 (main): the channels preload.js uses and the ones main/ipc.js registers are the same set. A
// channel main only PUSHES (webContents.send) is valid on the preload side as a listener. Channel
// names must be string literals, otherwise there is nothing to compare.
function channelsMatch(ctx, report) {
  const source = (path) => ctx.files.get(path) ?? '';
  const LISTEN = ['on', 'once'];
  const NOT_LITERAL = 'gets a channel name that is not a string literal, so it cannot be checked against the other side: write the name out.';

  const used = new Map(); // channel -> { methods, line } as used in preload.js
  for (const c of findCalls(source(PRELOAD), 'ipcRenderer', ['invoke', 'send', 'sendSync', ...LISTEN])) {
    if (c.channel === null) { report(PRELOAD, `ipcRenderer.${c.method}() ${NOT_LITERAL}`, c.line); continue; }
    const entry = used.get(c.channel) || { methods: [], line: c.line };
    entry.methods.push(c.method);
    used.set(c.channel, entry);
  }
  const registered = new Map(); // channel -> line in main/ipc.js
  for (const c of findCalls(source(IPC), 'ipcMain', ['handle', 'handleOnce', 'on', 'once'])) {
    if (c.channel === null) report(IPC, `ipcMain.${c.method}() ${NOT_LITERAL}`, c.line);
    else if (!registered.has(c.channel)) registered.set(c.channel, c.line);
  }
  const pushed = new Set(); // channels main sends to the renderer
  for (const file of ctx.scripts((p) => p === 'main.js' || startsWithDir(p, 'main/'))) {
    for (const c of findCalls(source(file), 'webContents', ['send'])) if (c.channel !== null) pushed.add(c.channel);
  }

  for (const [channel, { methods, line }] of used) {
    const listenOnly = methods.every((m) => LISTEN.includes(m));
    if (registered.has(channel) || (listenOnly && pushed.has(channel))) continue;
    report(PRELOAD, `channel '${channel}' is used here but main/ipc.js never registers it`
      + `${listenOnly ? ' and main never pushes it with webContents.send' : ''}: add it to the ipc.js table, or remove it here.`, line);
  }
  for (const [channel, line] of registered) {
    if (!used.has(channel)) {
      report(IPC, `channel '${channel}' is registered here but preload.js never uses it: expose it on window.threadAxis, or remove the handler.`, line);
    }
  }
}

// R8: markup is never built from strings. The single allowed use is clearing: `el.innerHTML = ''`.
// (outerHTML and insertAdjacentHTML are the same door under another name.)
const CLEARING_ASSIGNMENT = /^innerHTML\s*=(?![=>])\s*(?:''|"")\s*(?=[;,)}\]]|\r?\n|$)/;
function noInnerHtml(ctx, report) {
  const advice = 'Markup is never built from strings (note and link text could inject it); the only allowed use is `el.innerHTML = \'\'`. '
    + 'Build nodes with el()/svgEl() and set textContent.';
  for (const file of ctx.scripts((p) => startsWithDir(p, 'src/'))) {
    const code = ctx.code(file); // comments and strings blanked
    const text = ctx.noComments(file); // same offsets, strings intact
    for (const m of code.matchAll(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/g)) {
      const isMember = /\.\s*$/.test(code.slice(0, m.index));
      const clears = m[1] === 'innerHTML' && isMember && CLEARING_ASSIGNMENT.test(text.slice(m.index));
      if (!clears) report(file, `uses ${m[1]}. ${advice}`, lineOf(code, m.index));
    }
    for (const m of text.matchAll(/\[\s*(['"`])(?:inner|outer)HTML\1\s*\]/g)) {
      report(file, `reaches ${m[0].replace(/\s+/g, '')} by bracket. ${advice}`, lineOf(text, m.index));
    }
  }
}

// R9: everything the packaged app needs must be listed in package.json build.files. `npm start` reads
// the source tree, so a file missing from the list only breaks the BUILT app: this is the trap that
// once would have shipped a broken build. (styles/ is listed on top of the plan's src/ and main/
// because the plan puts new stylesheets there.)
const PACKAGED_DIRS = ['src/', 'main/', 'styles/'];
const PACKAGED_ROOT_FILES = ['main.js', 'preload.js', 'index.html', 'style.css'];
function packaging(ctx, report) {
  const needed = ctx.paths.filter((p) => !p.endsWith('.DS_Store')
    && (PACKAGED_ROOT_FILES.includes(p) || PACKAGED_DIRS.some((d) => startsWithDir(p, d))));
  const raw = ctx.packageJson && ctx.packageJson.build && ctx.packageJson.build.files;
  const patterns = Array.isArray(raw) ? raw : []; // no list at all = nothing is shipped: every needed file is named below
  for (const path of needed) {
    if (isPackaged(path, patterns)) continue;
    const dir = PACKAGED_DIRS.find((d) => startsWithDir(path, d));
    report(path, `is not covered by package.json build.files, so the packaged app would ship without it (npm start would still work: that is the trap). Add '${dir ? `${dir}**` : path}'.`);
  }
}

// R10 (renderer): after the module split there is one entry point and no classic scripts.
const LEGACY_SCRIPTS = ['renderer.js', 'taskStore.js'];
const ENTRY_SCRIPT = 'src/ui/app.js';
function legacyScriptsGone(ctx, report) {
  for (const file of LEGACY_SCRIPTS) {
    if (ctx.files.has(file)) report(file, 'is a pre-module classic script at the repo root and must be deleted: its code lives under src/ now.');
  }
  const html = ctx.files.get('index.html');
  if (html === undefined) { report('index.html', 'is missing.'); return; }
  const wanted = `<script type="module" src="${ENTRY_SCRIPT}"></script>`;
  const { count, first } = readScriptTags(html);
  if (count !== 1) { report('index.html', `has ${count} <script> tags; it must have exactly one: ${wanted}`); return; }
  const isEntry = String(first.attrs.type).toLowerCase() === 'module'
    && posix.normalize(first.attrs.src || '') === ENTRY_SCRIPT && first.body.trim() === '';
  if (!isEntry) report('index.html', `its one <script> tag must be ${wanted}: a module entry point, no inline code.`);
}

// R11: no import cycles among src/ files. A cycle is two modules that cannot be understood, tested
// or replaced one without the other.
function noCycles(ctx, report) {
  const nodes = new Set(ctx.scripts((p) => startsWithDir(p, 'src/')));
  const graph = new Map();
  for (const file of nodes) {
    const edges = [];
    for (const imp of ctx.imports(file)) {
      const target = resolveImport(file, imp.specifier);
      const hit = target.kind === 'relative' ? [target.path, `${target.path}.js`].find((p) => nodes.has(p)) : null;
      if (hit) edges.push(hit);
    }
    graph.set(file, edges);
  }
  for (const cycle of findCycles(graph)) {
    report(cycle[0], `is part of an import cycle: ${[...cycle, cycle[0]].join(' -> ')}. `
      + 'Break it: move the shared piece into a third module, or pass it in as an argument.');
  }
}

// R12 (renderer): modules keep their own state; nothing is planted on window or globalThis.
// (Test-only globals are injected by the tests from outside.) Matches window.x = ..., window.a.b += ...,
// window['x'] = ..., window.x++, and the function forms Object.assign(window, ...) / defineProperty.
const GLOBAL_WRITE = new RegExp(
  '\\b(?:window|globalThis)(?:\\s*(?:\\?\\.|\\.)\\s*[\\w$]+|\\s*\\[[^\\]\\n]*\\])+'
  + '\\s*(?:(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])|\\+\\+|--)', 'g');
const GLOBAL_DEFINE = /\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties)|Reflect\s*\.\s*(?:set|defineProperty))\s*\(\s*(?:window|globalThis)\b/g;
function noGlobalsLeak(ctx, report) {
  for (const file of ctx.scripts((p) => startsWithDir(p, 'src/'))) {
    const code = ctx.code(file);
    for (const m of [...code.matchAll(GLOBAL_WRITE), ...code.matchAll(GLOBAL_DEFINE)]) {
      report(file, `assigns to a global (\`${m[0].replace(/\s+/g, ' ').slice(0, 50)}\`). Modules keep their own state; `
        + 'nothing is planted on window/globalThis (tests inject globals from outside).', lineOf(code, m.index));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 5. The rule table and the entry point
// ---------------------------------------------------------------------------------------------

// phase: null = always runs on whatever files exist; 'renderer' / 'main' = runs only once that half
// of the layout exists (the caller passes { renderer, main } flags).
export const RULES = [
  { id: 'R1', name: 'core-purity', phase: null, check: corePurity },
  { id: 'R2', name: 'views-isolation', phase: 'renderer', check: viewsIsolation },
  { id: 'R3', name: 'bridge-only', phase: 'renderer', check: bridgeOnly },
  { id: 'R4', name: 'ui-does-not-reach-into-main-or-electron', phase: null, check: uiDoesNotReachMain },
  { id: 'R5', name: 'main-does-not-reach-into-src', phase: 'main', check: mainDoesNotReachSrc },
  { id: 'R6', name: 'ipc-single-door', phase: 'main', check: ipcSingleDoor },
  { id: 'R7', name: 'channels-match', phase: 'main', check: channelsMatch },
  { id: 'R8', name: 'no-innerHTML-writes', phase: null, check: noInnerHtml },
  { id: 'R9', name: 'packaging', phase: null, check: packaging },
  { id: 'R10', name: 'legacy-scripts-gone', phase: 'renderer', check: legacyScriptsGone },
  { id: 'R11', name: 'no-cycles', phase: null, check: noCycles },
  { id: 'R12', name: 'no-globals-leak', phase: 'renderer', check: noGlobalsLeak },
];

function createContext(files, packageJson) {
  const memo = (fn) => {
    const cache = new Map();
    return (path) => {
      if (!cache.has(path)) cache.set(path, fn(path));
      return cache.get(path);
    };
  };
  const paths = [...files.keys()].sort();
  return {
    files,
    packageJson,
    paths,
    scripts: (predicate) => paths.filter((p) => isScript(p) && predicate(p)),
    code: memo((p) => stripCode(files.get(p))),
    noComments: memo((p) => stripComments(files.get(p))),
    imports: memo((p) => extractImports(files.get(p))),
  };
}

// Runs every rule whose phase is switched on and returns Violation[] = { rule, file, message }.
//   files:       Map<relative path, source text>, e.g. 'src/ui/views/axisView.js'
//   packageJson: the parsed root package.json
//   phase:       { renderer: boolean, main: boolean }
export function checkArchitecture({ files, packageJson, phase = {} }) {
  const fileMap = files instanceof Map ? files : new Map(Object.entries(files));
  const ctx = createContext(fileMap, packageJson);
  const violations = [];
  for (const rule of RULES) {
    if (rule.phase && !phase[rule.phase]) continue;
    rule.check(ctx, (file, message, line) => {
      violations.push({ rule: rule.id, file, message: `${rule.id} ${rule.name}: ${file}${line ? `:${line}` : ''} ${message}` });
    });
  }
  return violations;
}
