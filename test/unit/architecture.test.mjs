// The architecture test: "no cross wires" is CHECKED here, not just intended. The rules are written
// from docs/NOTES-PLAN.md section 3 by a different hand than the code they police; if this test
// blocks you, the design is telling you something. Extend the rules deliberately (say why in the
// commit), never weaken them to get a green run.
//
//   Part 1  the checker's own helpers (tokenizer, import reader, glob matcher ...)
//   Part 2  META-TESTS: for every rule, a tiny synthetic tree that violates it (the checker must
//           name that rule and that file) and a conforming variant (the checker must say nothing)
//   Part 3  the REAL TREE: the actual repo files run through the same checker
//
// Run with: node --test "test/unit/**/*.test.mjs"   (quote the glob)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES, checkArchitecture, extractImports, findCalls, findCycles, globToRegExp, isPackaged,
  readScriptTags, resolveImport, stripCode, stripComments, tokenize,
} from './lib/architecture.mjs';

// Phase flags. A rule marked (renderer) or (main) only runs against the REAL tree when its flag is
// true, because that half of the layout does not exist yet. The owner of the migration flips them at
// the phase gates: `renderer` once src/ui/ and index.html are the modules from the plan (Phase 1),
// `main` once main/ and the split preload are in place (Phase 2). The meta-tests ignore these flags.
// renderer: true from Phase 1 (renderer.js/taskStore.js retired, index.html is one module script).
// main: true from Phase 2 (main/{window,tray,ipc,settings}.js split out, navigation lockdown added).
const PHASE = { renderer: true, main: true };

const lines = (...parts) => `${parts.join('\n')}\n`;

// =============================================================================================
// Part 1: the checker's own helpers
// =============================================================================================

describe('helper: stripCode / stripComments (identifier rules only ever see real code)', () => {
  const has = (text, word) => new RegExp(`\\b${word}\\b`).test(text);

  it('blanks line and block comments, keeping line breaks so line numbers stay valid', () => {
    const src = lines('a // document', '/* window', '   document */ b');
    const code = stripCode(src);
    assert.equal(code.length, src.length);
    assert.equal(code.split('\n').length, src.split('\n').length);
    assert.ok(has(code, 'a') && has(code, 'b'));
    assert.ok(!has(code, 'document') && !has(code, 'window'));
  });

  it('does not mistake // or /* inside a string for a comment, and keeps the code after it', () => {
    const code = stripCode(`const u = 'http://x.com'; const s = "/* nope"; document.title;`);
    assert.ok(has(code, 'document'));
    assert.ok(!has(code, 'http') && !has(code, 'nope'));
  });

  it('handles escaped quotes inside strings', () => {
    const code = stripCode(String.raw`const s = 'it\'s window'; const t = "say \"document\""; process.exit();`);
    assert.ok(!has(code, 'window') && !has(code, 'document'));
    assert.ok(has(code, 'process'));
  });

  it('blanks template text but keeps the code inside ${ } (it is real code), nested included', () => {
    const code = stripCode('const t = `hello window ${document.title} bye ${ `deep ${localStorage.x} text` } end`;');
    assert.ok(!has(code, 'window') && !has(code, 'hello') && !has(code, 'deep'));
    assert.ok(has(code, 'document') && has(code, 'localStorage'));
  });

  it('copes with braces inside ${ } (object literals, arrow bodies)', () => {
    const code = stripCode('const t = `a ${ [1].map((x) => { return { v: x }; }).length } window`; document;');
    assert.ok(!has(code, 'window'));
    assert.ok(has(code, 'document'));
  });

  it('recognises regex literals, including quotes and slashes inside them', () => {
    const code = stripCode(lines(
      String.raw`const r = /['"]window\/x[/]/g;`,
      'function f(s) { return /document/.test(s); }',
      'const ok = 1; fetch;',
    ));
    assert.ok(!has(code, 'window') && !has(code, 'document'));
    assert.ok(has(code, 'fetch') && has(code, 'ok'), 'code after a quote-bearing regex must survive');
  });

  it('tells division from a regex', () => {
    const code = stripCode(lines('const a = b / c; const d = e / f; document;', 'x = (a + b) / 2 + window;', 'i++ / 2; require;'));
    assert.ok(has(code, 'document') && has(code, 'window') && has(code, 'require'));
    assert.ok(has(stripCode('const a = b.return / 2 / 3; process;'), 'process'), 'a property called return is not the keyword');
    assert.ok(!has(stripCode('const t = `${/window/.source}`;'), 'window'), 'a regex can start right after ${');
  });

  it('survives an unterminated string without swallowing the next lines, and a shebang', () => {
    assert.ok(has(stripCode(`const a = 'oops\ndocument;`), 'document'));
    assert.ok(has(stripCode('#!/usr/bin/env node\nwindow;'), 'window'));
    assert.ok(!has(stripCode('#!/usr/bin/env node window\nx;'), 'window'));
  });

  it('tokenize is lossless', () => {
    const src = lines('#!/x', 'import a from "./a.js"; // c', 'const r = /a\\/b/g, t = `x${1 + `y${2}`}z`;', '/* end */');
    assert.equal(tokenize(src).map((t) => t.text).join(''), src);
  });

  it('stripComments keeps string contents (imports and channel names live there)', () => {
    const out = stripComments(`import x from './a.js'; // window\n/* document */ const s = "keep";`);
    assert.ok(out.includes(`'./a.js'`) && out.includes('"keep"'));
    assert.ok(!has(out, 'window') && !has(out, 'document'));
  });
});

describe('helper: extractImports (imports are read from tokens, never from raw text)', () => {
  const specs = (src) => extractImports(src).map((i) => i.specifier);

  it('reads every static import form, including multi-line lists and attributes', () => {
    const src = lines(
      `import a from './a.js';`, `import { b } from "./b.js";`, `import * as c from './c.js';`, `import './d.js';`,
      `import e, { f } from './e.js';`, 'import {', '  g,', '  h as i,', `} from './g.js'`,
      `import data from './data.json' with { type: 'json' };`,
    );
    assert.deepEqual(specs(src), ['./a.js', './b.js', './c.js', './d.js', './e.js', './g.js', './data.json']);
  });

  it('reads re-exports but not local exports', () => {
    const src = lines(`export * from './a.js';`, `export * as ns from './b.js';`, `export { x, y as z } from './c.js';`,
      'export { local };', 'export const k = 1;', 'export default function () {}', 'export function f() {}');
    assert.deepEqual(specs(src), ['./a.js', './b.js', './c.js']);
  });

  it('reads dynamic import() and require(), and flags a non-literal target as null', () => {
    const src = lines(`const a = await import('./a.js');`, `import("./b.js").then(f);`, `const c = require('./c');`,
      'const d = require(name);', `const e = import('./x' + suffix);`, 'const f = import(`./t.js`);');
    assert.deepEqual(specs(src), ['./a.js', './b.js', './c', null, null, './t.js']);
    assert.deepEqual(extractImports(src).map((i) => i.kind), ['dynamic', 'dynamic', 'require', 'require', 'dynamic', 'dynamic']);
  });

  it('is not fooled by comments, strings, templates, properties or method definitions', () => {
    const src = lines(
      `// import x from './comment.js'`, `/* require('./block.js') */`, `const s = "import y from './string.js'";`,
      'const t = `import z from "./template.js"`;', `const u = import.meta.url;`, `x.import('./prop.js'); y.require('./prop2.js');`,
      'class A { require(a, b) { return a; } }', 'const o = { async import(e) { return e; } };', 'function require(x) { return x; }',
    );
    assert.deepEqual(specs(src), []);
  });

  it('counts a spread require and reports the line number', () => {
    const found = extractImports(lines('', '', `module.exports = { ...require('./a') };`));
    assert.deepEqual(found.map((i) => [i.specifier, i.line]), [['./a', 3]]);
  });
});

describe('helper: findCalls (channel names from ipcMain/ipcRenderer/webContents calls)', () => {
  const chans = (src, obj, methods) => findCalls(src, obj, methods).map((c) => [c.method, c.channel]);

  it('finds the listed methods on the named object, with any receiver in front', () => {
    const src = lines(`ipcMain.handle('a', f);`, `ipcMain.on("b", f);`, `ipcMain?.once('c', f);`,
      `win.webContents.send('d');`, `ipcMain.handle(/* why */ 'e', f);`);
    assert.deepEqual(chans(src, 'ipcMain', ['handle', 'on', 'once']), [['handle', 'a'], ['on', 'b'], ['once', 'c'], ['handle', 'e']]);
    assert.deepEqual(chans(src, 'webContents', ['send']), [['send', 'd']]);
  });

  it('ignores other methods, comments and strings, and reports non-literal names as null', () => {
    const src = lines(`ipcMain.removeHandler('x');`, `// ipcMain.handle('commented', f)`, `const s = "ipcMain.handle('str', f)";`,
      'ipcMain.handle(name, f);', `ipcMain.handle('a' + b, f);`, 'ipcMain.handle(`t`, f);');
    assert.deepEqual(chans(src, 'ipcMain', ['handle']), [['handle', null], ['handle', null], ['handle', 't']]);
  });
});

describe('helper: resolveImport (relative specifiers resolve against the importing file)', () => {
  it('resolves and normalises relative paths', () => {
    const at = (from, spec) => resolveImport(from, spec).path;
    assert.equal(at('src/ui/views/axisView.js', '../dom.js'), 'src/ui/dom.js');
    assert.equal(at('src/ui/views/axisView.js', '../../core/itemStore.js'), 'src/core/itemStore.js');
    assert.equal(at('src/ui/views/axisView.js', './itemRow.js'), 'src/ui/views/itemRow.js');
    assert.equal(at('src/ui/views/axisView.js', '../views/../views/itemRow.js'), 'src/ui/views/itemRow.js');
    assert.equal(at('main.js', './main/ipc'), 'main/ipc');
    assert.equal(at('main/ipc.js', '../src/core/x.js'), 'src/core/x.js');
    assert.equal(at('src/core/a.js', '../../../x.js'), '../x.js', 'climbing above the repo root stays visible');
  });

  it('classifies everything that is not relative', () => {
    for (const s of ['electron', 'fs', 'node:path', 'electron/main', 'lodash']) assert.equal(resolveImport('src/a.js', s).kind, 'bare', s);
    for (const s of ['/x.js', 'file:///x.js', 'https://x.test/a.js']) assert.equal(resolveImport('src/a.js', s).kind, 'absolute', s);
    assert.equal(resolveImport('src/a.js', null).kind, 'dynamic');
  });
});

describe('helper: isPackaged / globToRegExp (the tiny build.files matcher)', () => {
  it('matches exact names only exactly', () => {
    assert.ok(isPackaged('main.js', ['main.js']));
    assert.ok(!isPackaged('main.jsx', ['main.js']));
    assert.ok(!isPackaged('xmain.js', ['main.js']));
    assert.ok(!isPackaged('styleXcss', ['style.css']), 'a dot in a pattern is a dot, not "any character"');
  });

  it("'dir/**' covers everything below dir at any depth, and nothing else", () => {
    assert.ok(isPackaged('src/a.js', ['src/**']));
    assert.ok(isPackaged('src/ui/views/x.js', ['src/**']));
    assert.ok(!isPackaged('src', ['src/**']));
    assert.ok(!isPackaged('srcx/a.js', ['src/**']));
    assert.ok(!isPackaged('other/src/a.js', ['src/**']));
    assert.ok(!isPackaged('src/ui/a.js', ['src/core/**']));
  });

  it("supports '*', '?' and '**/' too", () => {
    assert.ok(isPackaged('src/a.js', ['src/*.js']));
    assert.ok(!isPackaged('src/ui/a.js', ['src/*.js']), "'*' stops at a slash");
    assert.ok(isPackaged('a.js', ['**/*.js']) && isPackaged('x/y/a.js', ['**/*.js']) && !isPackaged('a.css', ['**/*.js']));
    assert.ok(isPackaged('a1.js', ['a?.js']) && !isPackaged('a12.js', ['a?.js']));
    assert.ok(globToRegExp('main/**').test('main/lib/x.js') && !globToRegExp('main/**').test('main'));
    assert.ok(globToRegExp('a+b(c).js').test('a+b(c).js'), 'regex metacharacters in a name are literal');
  });

  it('applies patterns in order with negation, ignores non-strings, tolerates ./', () => {
    assert.ok(isPackaged('src/a.js', ['src/**', '!src/**/*.test.js']));
    assert.ok(!isPackaged('src/ui/a.test.js', ['src/**', '!src/**/*.test.js']));
    assert.ok(isPackaged('src/x.js', ['!src/x.js', 'src/**']), 'a later positive pattern wins');
    assert.ok(!isPackaged('a.js', [{ from: 'a.js' }]));
    assert.ok(isPackaged('main.js', ['./main.js']));
    assert.ok(!isPackaged('main.js', []));
  });
});

describe('helper: readScriptTags (index.html)', () => {
  it('reads one module script and its attributes, however they are written', () => {
    const one = readScriptTags(`<html><script type="module" src="src/ui/app.js"></script></html>`);
    assert.equal(one.count, 1);
    assert.deepEqual(one.first.attrs, { type: 'module', src: 'src/ui/app.js' });
    assert.equal(one.first.body, '');
    const odd = readScriptTags(`<SCRIPT src='./a.js' type=module defer></SCRIPT>`);
    assert.deepEqual(odd.first.attrs, { src: './a.js', type: 'module', defer: '' });
  });

  it('ignores HTML comments, counts every tag, and sees inline code', () => {
    assert.equal(readScriptTags('<!-- <script src="old.js"></script> -->').count, 0);
    assert.equal(readScriptTags('<script src="a.js"></script>\n<script src="b.js"></script>').count, 2);
    assert.equal(readScriptTags('<script>alert(1)</script>').first.body, 'alert(1)');
  });
});

describe('helper: findCycles', () => {
  const graph = (edges) => new Map(Object.entries(edges));

  it('finds nothing in an acyclic graph (a diamond is fine)', () => {
    assert.deepEqual(findCycles(graph({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })), []);
  });

  it('reports each cycle once, rotated to start at the smallest node', () => {
    assert.deepEqual(findCycles(graph({ b: ['a'], a: ['b'] })), [['a', 'b']]);
    assert.deepEqual(findCycles(graph({ c: ['a'], a: ['b'], b: ['c'] })), [['a', 'b', 'c']]);
    assert.deepEqual(findCycles(graph({ a: ['a'] })), [['a']], 'a self-import is a cycle');
    assert.deepEqual(findCycles(graph({ a: ['b'], b: ['a'], x: ['y'], y: ['x'] })), [['a', 'b'], ['x', 'y']]);
  });

  it('ignores edges to nodes outside the graph', () => {
    assert.deepEqual(findCycles(graph({ a: ['missing'] })), []);
  });
});

// =============================================================================================
// Part 2: META-TESTS. Every rule gets a synthetic tree that violates it and one that conforms.
// All rules run here regardless of PHASE (the checker is given { renderer: true, main: true }).
// =============================================================================================

// A small tree that satisfies EVERY rule. Each meta-test starts from it and changes a file or two,
// so a violation can only come from the change under test.
const BASE_FILES = {
  'index.html': lines('<!DOCTYPE html>', '<html><body>', '<script type="module" src="src/ui/app.js"></script>', '</body></html>'),
  'style.css': 'body { margin: 0; }\n',
  'main.js': lines(`const { app } = require('electron');`, `const { registerIpc } = require('./main/ipc');`, 'app.whenReady().then(() => registerIpc());'),
  'preload.js': lines(
    `const { contextBridge, ipcRenderer } = require('electron');`,
    `contextBridge.exposeInMainWorld('threadAxis', {`,
    `  loadThreads: () => ipcRenderer.invoke('load-threads'),`,
    `  quit: () => ipcRenderer.send('quit-app'),`,
    `  onShown: (cb) => ipcRenderer.on('window-shown', () => cb()),`,
    '});',
  ),
  'main/ipc.js': lines(
    `const { ipcMain, app } = require('electron');`,
    'function registerIpc(win) {',
    `  ipcMain.handle('load-threads', () => null);`,
    `  ipcMain.on('quit-app', () => app.quit());`,
    `  win.on('show', () => win.webContents.send('window-shown'));`,
    '}',
    'module.exports = { registerIpc };',
  ),
  'main/lib/safeUrl.js': lines(
    'function safeUrl(s) {',
    '  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }',
    '}',
    'module.exports = { safeUrl };',
  ),
  'src/package.json': '{ "type": "module" }\n',
  'src/core/history.js': 'export const toHistory = (item) => ({ text: item.text });\n',
  'src/core/itemStore.js': lines(`import { toHistory } from './history.js';`, 'export function createItemStore(persistence, onChange) {',
    '  return { toHistory, persistence, onChange };', '}'),
  'src/core/selectors.js': `export const activeThreads = (state) => state.threads.filter((t) => t.status === 'axis');\n`,
  'src/core/linkify.js': `export const linkify = (text) => [{ type: 'text', value: text }];\n`,
  'src/ui/dom.js': `export const el = (tag) => document.createElement(tag);\n`,
  'src/ui/theme.js': `export const COLORS = { q1: '#e5484d' };\n`,
  'src/ui/format.js': 'export const fmtWhen = (t) => String(t);\n',
  'src/ui/bridge.js': 'export const createBridge = () => window.threadAxis;\n',
  'src/ui/hover.js': 'export const setHovered = (id) => id;\n',
  'src/ui/views/itemRow.js': lines(`import { el } from '../dom.js';`, `export const itemRow = () => el('div');`),
  'src/ui/views/bodyEditor.js': lines(`import { el } from '../dom.js';`, `import { linkify } from '../../core/linkify.js';`,
    'export const bodyEditor = (text) => [el(\'div\'), linkify(text)];'),
  'src/ui/views/titleEditor.js': lines(`import { el } from '../dom.js';`, `import { EDIT_ENDED } from './bodyEditor.js';`,
    'export const titleEditor = () => [el(\'input\'), EDIT_ENDED];'),
  'src/ui/views/orbView.js': lines(`import { el } from '../dom.js';`, `import { COLORS } from '../theme.js';`,
    'export const createOrbView = (root, actions) => ({',
    `  render() { root.textContent = ''; root.append(el('div')); void COLORS; void actions; },`, '});'),
  'src/ui/app.js': lines(
    `import { createBridge } from './bridge.js';`, `import { createItemStore } from '../core/itemStore.js';`,
    `import { createOrbView } from './views/orbView.js';`,
    'const store = createItemStore(createBridge(), () => {});',
    'createOrbView(document.body, {});',
    `document.documentElement.dataset.ready = '1';`,
  ),
};
const BASE_PACKAGE = {
  build: { files: ['main.js', 'preload.js', 'main/**', 'src/**', 'styles/**', 'index.html', 'style.css', 'assets/**', 'package.json'] },
};

const ALL = { renderer: true, main: true };
const OFF = { renderer: false, main: false };

// BASE_FILES plus a delta: path -> new source, or null to delete the file.
function tree(delta = {}) {
  const files = new Map(Object.entries(BASE_FILES));
  for (const [path, source] of Object.entries(delta)) {
    if (source === null) files.delete(path);
    else files.set(path, source);
  }
  return files;
}
const run = (delta, { phase = ALL, packageJson = BASE_PACKAGE } = {}) => checkArchitecture({ files: tree(delta), packageJson, phase });
const show = (violations) => (violations.length ? violations.map((v) => `${v.rule} ${v.file}`).join(', ') : 'nothing');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bookkeeping for the guard tests at the end of Part 2: which rules have a violating and a
// conforming meta-test, and every violating tree (re-run there to prove the phase gating).
const seen = { violates: new Set(), conforms: new Set(), cases: [] };

// `delta` breaks `rule` in `file`: the checker must name both, must say so in the message, and (unless
// `also` lists rules that legitimately trip as well) must fire no other rule.
function expectViolation(rule, delta, file, { also = [], packageJson = BASE_PACKAGE, message } = {}) {
  const violations = run(delta, { packageJson });
  const hits = violations.filter((v) => v.rule === rule && v.file === file);
  assert.ok(hits.length > 0, `expected ${rule} on ${file}; the checker reported ${show(violations)}`);
  for (const v of hits) assert.ok(v.message.includes(rule) && v.message.includes(file), `message must name rule and file: ${v.message}`);
  if (message) assert.match(hits.map((v) => v.message).join('\n'), message);
  assert.deepEqual([...new Set(violations.map((v) => v.rule))].sort(), [rule, ...also].sort(),
    `only ${[rule, ...also].join('+')} should fire; the checker reported ${show(violations)}`);
  seen.violates.add(rule);
  seen.cases.push({ rule, delta, file, packageJson });
  return hits;
}

// `delta` is a conforming variant: the WHOLE checker (every rule) must say nothing.
function expectConforming(rule, delta, { packageJson = BASE_PACKAGE } = {}) {
  assert.deepEqual(run(delta, { packageJson }).map((v) => v.message), []);
  seen.conforms.add(rule);
}

describe('meta: the baseline tree', () => {
  it('conforms to every rule, so any violation below is caused by the change under test', () => {
    assert.deepEqual(run({}).map((v) => v.message), []);
    assert.deepEqual(run({}, { phase: OFF }).map((v) => v.message), []);
  });
});

describe('R1 core-purity', () => {
  it('flags an import that leaves src/core/, resolving the path (../ui/dom.js from core is src/ui/dom.js)', () => {
    expectViolation('R1', { 'src/core/x.js': lines(`import '../ui/dom.js';`, 'export const x = 1;') }, 'src/core/x.js', { message: /src\/ui\/dom\.js/ });
  });

  it('flags re-exports, import() and bare packages that leave src/core/', () => {
    expectViolation('R1', { 'src/core/x.js': `export * from '../ui/theme.js';\n` }, 'src/core/x.js');
    expectViolation('R1', { 'src/core/x.js': `export const load = () => import('../ui/dom.js');\n` }, 'src/core/x.js');
    expectViolation('R1', { 'src/core/x.js': `import { app } from 'electron';\nexport const a = app;\n` }, 'src/core/x.js');
    expectViolation('R1', { 'src/core/x.js': 'export const load = (name) => import(name);\n' }, 'src/core/x.js', { message: /not a string literal/ });
  });

  const IDENTIFIERS = [
    ['window', 'export const w = () => window.innerWidth;'],
    ['document', 'export const t = () => document.title;'],
    ['require(', `const h = require('./history.js');\nexport const t = h;`],
    ['electron', 'export const e = electron;'],
    ['process.', 'export const home = () => process.env.HOME;'],
    ['localStorage', `export const s = () => localStorage.getItem('x');`],
    ['fetch(', `export const f = () => fetch('/x');`],
  ];
  for (const [label, source] of IDENTIFIERS) {
    it(`flags the identifier ${label} in code`, () => {
      expectViolation('R1', { 'src/core/x.js': source }, 'src/core/x.js', { message: new RegExp(escapeRe(`\`${label}\``)) });
    });
  }

  it('flags an identifier used inside a template ${ } expression: that is real code', () => {
    expectViolation('R1', { 'src/core/x.js': 'export const t = `title: ${document.title}`;\n' }, 'src/core/x.js');
  });

  it('accepts imports that resolve back inside src/core/, however they are spelled', () => {
    expectConforming('R1', {
      'src/core/x.js': lines(`import { toHistory } from '../core/history.js';`, `import { linkify } from './sub/../linkify.js';`,
        `export { toHistory as th } from './history.js';`, 'export const x = [toHistory, linkify];'),
    });
  });

  it('ignores the forbidden words in comments, strings, template text and regexes', () => {
    expectConforming('R1', {
      'src/core/x.js': lines(
        '// window document require( electron process. localStorage fetch(',
        '/* window', '   document */',
        `export const a = 'window document require( electron process. localStorage fetch(';`,
        'export const b = `document ${1 + 1} window`;',
        'export const c = /window|document/;',
        `export const d = "a // not a comment"; export const windowSize = 1; export const documentId = 2;`,
        'export const isElectron = false; export const preprocess = (x) => x;',
      ),
    });
  });
});

describe('R2 views-isolation (renderer)', () => {
  const view = 'src/ui/views/axisView.js';

  it('flags a view importing core/itemStore (../../core/itemStore.js resolves from src/ui/views/)', () => {
    expectViolation('R2', { [view]: lines(`import { createItemStore } from '../../core/itemStore.js';`, 'export const v = createItemStore;') }, view,
      { message: /src\/core\/itemStore\.js/ });
  });

  it('flags a view importing ui/bridge, a sibling view, a package, or using import()/require()', () => {
    expectViolation('R2', { [view]: `import { createBridge } from '../bridge.js';\nexport const v = createBridge;\n` }, view);
    expectViolation('R2', { [view]: `import { createOrbView } from './orbView.js';\nexport const v = createOrbView;\n` }, view);
    expectViolation('R2', { [view]: `import _ from 'lodash';\nexport const v = _;\n` }, view);
    expectViolation('R2', { [view]: `export const v = () => import('../bridge.js');\n` }, view);
    expectViolation('R2', { [view]: `export const v = () => import(someName);\n` }, view, { message: /not a string literal/ });
    expectViolation('R2', { [view]: `const store = require('../../core/itemStore.js');\nexport const v = store;\n` }, view, { also: ['R4'] });
  });

  it('accepts every allowed import, and resolves odd spellings of them correctly', () => {
    expectConforming('R2', {
      [view]: lines(
        `import { el } from '../dom.js';`, `import { COLORS } from '../theme.js';`, `import { fmtWhen } from '../format.js';`,
        `import { itemRow } from './itemRow.js';`, `import { bodyEditor } from './bodyEditor.js';`, `import { titleEditor } from './titleEditor.js';`,
        `import { activeThreads } from '../../core/selectors.js';`, `import { linkify } from '../../core/linkify.js';`,
        `import { itemRow as again } from '../views/itemRow.js';`, `import { el as el2 } from '../../ui/dom.js';`,
        'export const v = [el, COLORS, fmtWhen, itemRow, bodyEditor, titleEditor, activeThreads, linkify, again, el2];',
      ),
    });
  });

  it('does not count a forbidden import that only appears in a comment or a string', () => {
    expectConforming('R2', {
      [view]: lines(`// never: import { createItemStore } from '../../core/itemStore.js'`,
        `export const note = "import x from '../bridge.js'";`, '/* require("../../core/itemStore.js") */'),
    });
  });
});

describe('R3 bridge-only (renderer)', () => {
  const VARIANTS = [
    ['window.threadAxis', 'export const api = () => window.threadAxis;'],
    ['window[\'threadAxis\']', `export const api = () => window['threadAxis'];`],
    ['globalThis.threadAxis', 'export const api = () => globalThis.threadAxis;'],
    ['destructuring it off window', 'const { threadAxis } = window;\nexport const api = threadAxis;'],
  ];
  for (const [label, source] of VARIANTS) {
    it(`flags ${label} outside src/ui/bridge.js`, () => {
      expectViolation('R3', { 'src/ui/hover.js': source }, 'src/ui/hover.js');
    });
  }

  it('applies to src/ui/app.js too: it may import the bridge, not read the global', () => {
    expectViolation('R3', { 'src/ui/app.js': `${BASE_FILES['src/ui/app.js']}const api = window.threadAxis;\n` }, 'src/ui/app.js');
  });

  it('requires bridge.js to exist and to be the one that reads it ("exactly one file")', () => {
    expectViolation('R3', { 'src/ui/bridge.js': null }, 'src/ui/bridge.js');
    expectViolation('R3', { 'src/ui/bridge.js': 'export const createBridge = () => ({});\n' }, 'src/ui/bridge.js');
  });

  it('accepts the bridge reading it, and other files only talking about it in comments', () => {
    expectConforming('R3', { 'src/ui/hover.js': lines('// window.threadAxis is read in bridge.js only', 'export const setHovered = (id) => id;') });
  });
});

describe('R4 ui-does-not-reach-into-main-or-electron', () => {
  const ui = 'src/ui/hover.js';

  it('flags imports of main/, main.js and preload.js, resolved from where the file lives', () => {
    expectViolation('R4', { [ui]: `import { createWindow } from '../../main/window.js';\nexport const w = createWindow;\n` }, ui, { message: /main\/window\.js/ });
    expectViolation('R4', { [ui]: `import '../../main.js';\n` }, ui);
    expectViolation('R4', { [ui]: `import '../../preload.js';\n` }, ui);
  });

  it('flags electron (import, subpath import) and require( in src/', () => {
    expectViolation('R4', { [ui]: `import { shell } from 'electron';\nexport const s = shell;\n` }, ui);
    expectViolation('R4', { [ui]: `import { shell } from 'electron/common';\nexport const s = shell;\n` }, ui);
    expectViolation('R4', { [ui]: `const fs = require('fs');\nexport const f = fs;\n` }, ui);
    expectViolation('R4', { [ui]: 'export const e = electron;\n' }, ui);
  });

  it('leaves src/core/ to R1 (no double reporting)', () => {
    const v = run({ 'src/core/x.js': `import { shell } from 'electron';\nexport const s = shell;\n` });
    assert.ok(v.some((x) => x.rule === 'R1'));
    assert.ok(!v.some((x) => x.rule === 'R4'), 'R4 must not repeat what R1 already says about core');
  });

  it('accepts src/ files that only mention these words in comments and strings', () => {
    expectConforming('R4', {
      [ui]: lines(`// talks to electron via bridge.js, never require('x') or ../../main/window.js`,
        `export const help = "import x from '../../main/window.js'; electron";`),
    });
  });
});

describe('R5 main-does-not-reach-into-src (main)', () => {
  it('flags main/ and main.js importing or requiring anything under src/', () => {
    expectViolation('R5', { 'main/window.js': `const store = require('../src/core/itemStore.js');\nmodule.exports = { store };\n` }, 'main/window.js', { message: /src\/core\/itemStore\.js/ });
    expectViolation('R5', { 'main.js': `${BASE_FILES['main.js']}const app2 = require('./src/ui/app.js');\n` }, 'main.js');
    expectViolation('R5', { 'main/tray.js': `import { linkify } from '../src/core/linkify.js';\nexport { linkify };\n` }, 'main/tray.js');
  });

  it('flags the DOM identifiers window and document in main.js and main/**', () => {
    expectViolation('R5', { 'main/window.js': 'module.exports = { title: () => document.title };\n' }, 'main/window.js');
    expectViolation('R5', { 'main.js': `${BASE_FILES['main.js']}const w = window;\n` }, 'main.js');
  });

  it('lets preload.js use window (it runs next to one), and ignores DOM words in strings and comments', () => {
    expectConforming('R5', { 'preload.js': `${BASE_FILES['preload.js']}window.addEventListener('DOMContentLoaded', () => {});\n` });
    expectConforming('R5', {
      'main/window.js': lines(`// there is no window or document here: the renderer owns those`,
        `const inject = (win) => win.webContents.executeJavaScript('document.title');`,
        'const mainWindow = null; const windowState = {}; module.exports = { inject, mainWindow, windowState };'),
    });
  });
});

describe('R6 ipc-single-door (main)', () => {
  it('flags ipcMain. anywhere but main/ipc.js, including bracket access', () => {
    expectViolation('R6', { 'main.js': `${BASE_FILES['main.js']}ipcMain.handle('x', () => 1);\n` }, 'main.js');
    expectViolation('R6', { 'main/window.js': `ipcMain['handle']('x', () => 1);\n` }, 'main/window.js');
    expectViolation('R6', { 'main/window.js': 'ipcMain?.on(name, () => 1);\n' }, 'main/window.js');
  });

  it('flags ipcRenderer anywhere but preload.js (main, src, even main/ipc.js)', () => {
    expectViolation('R6', { 'src/ui/hover.js': `export const q = () => ipcRenderer.send('quit-app');\n` }, 'src/ui/hover.js');
    expectViolation('R6', { 'main/ipc.js': `${BASE_FILES['main/ipc.js']}const r = ipcRenderer;\n` }, 'main/ipc.js');
    expectViolation('R6', { 'main.js': `${BASE_FILES['main.js']}const { ipcRenderer } = require('electron');\n` }, 'main.js');
  });

  it('accepts the words in comments/strings, and ipcMain passed around without a member access', () => {
    expectConforming('R6', { 'main.js': lines(`const { app, ipcMain } = require('electron'); // ipcMain.handle lives in main/ipc.js`,
      `const doc = "ipcMain.handle and ipcRenderer.send";`, 'module.exports = { app, ipcMain, doc };') });
  });
});

describe('R7 channels-match (main)', () => {
  it('flags a channel preload.js uses that main/ipc.js never registers, by name, in both directions', () => {
    const hits = expectViolation('R7',
      { 'preload.js': `${BASE_FILES['preload.js']}  extra: () => ipcRenderer.invoke('extra-channel'),\n`.replace('});\n', '') + '});\n' },
      'preload.js', { message: /extra-channel/ });
    assert.ok(hits.some((v) => /main\/ipc\.js never registers it/.test(v.message)));
  });

  it('flags a channel main/ipc.js registers that preload.js never uses, by name', () => {
    expectViolation('R7', { 'main/ipc.js': BASE_FILES['main/ipc.js'].replace('}\nmodule.exports', `  ipcMain.handle('orphan-channel', () => null);\n}\nmodule.exports`) },
      'main/ipc.js', { message: /orphan-channel/ });
  });

  it('treats a channel main pushes with webContents.send as valid for a preload LISTENER only', () => {
    expectConforming('R7', {
      'preload.js': `${BASE_FILES['preload.js']}  onPushed: (cb) => ipcRenderer.on('pushed-channel', () => cb()),\n`.replace('});\n', '').concat('});\n'),
      'main/tray.js': `function announce(win) { win.webContents.send('pushed-channel'); }\nmodule.exports = { announce };\n`,
    });
    // but invoking/sending (not listening) a push-only channel is still unregistered
    expectViolation('R7', {
      'preload.js': `${BASE_FILES['preload.js']}  callPushed: () => ipcRenderer.invoke('pushed-channel'),\n`.replace('});\n', '').concat('});\n'),
      'main/tray.js': `function announce(win) { win.webContents.send('pushed-channel'); }\nmodule.exports = { announce };\n`,
    }, 'preload.js', { message: /pushed-channel/ });
  });

  it('flags a non-literal channel name on either side, by file', () => {
    expectViolation('R7', { 'preload.js': `${BASE_FILES['preload.js']}  dyn: (name) => ipcRenderer.invoke(name),\n`.replace('});\n', '').concat('});\n') },
      'preload.js', { message: /not a string literal/ });
    expectViolation('R7', { 'main/ipc.js': BASE_FILES['main/ipc.js'].replace('}\nmodule.exports', `  ipcMain.handle(chanName, () => null);\n}\nmodule.exports`) },
      'main/ipc.js', { message: /not a string literal/ });
  });

  it('accepts the base tree\'s matched channel set, invoke and send/on both counted', () => {
    expectConforming('R7', {});
  });
});

describe('R8 no-innerHTML-writes', () => {
  it('flags any assignment to innerHTML other than empty-string clearing', () => {
    expectViolation('R8', { 'src/ui/hover.js': `export const set = (el, html) => { el.innerHTML = html; };\n` }, 'src/ui/hover.js');
    expectViolation('R8', { 'src/ui/hover.js': `export const set = (el) => { el.innerHTML = '<b>x</b>'; };\n` }, 'src/ui/hover.js');
    expectViolation('R8', { 'src/ui/hover.js': "export const set = (el, name) => { el.innerHTML = `<b>${name}</b>`; };\n" }, 'src/ui/hover.js');
    expectViolation('R8', { 'src/ui/hover.js': `export const set = (el) => { el.innerHTML += 'x'; };\n` }, 'src/ui/hover.js');
  });

  it('flags outerHTML and insertAdjacentHTML, and bracket access to either property', () => {
    expectViolation('R8', { 'src/ui/hover.js': `export const set = (el, html) => { el.outerHTML = html; };\n` }, 'src/ui/hover.js');
    expectViolation('R8', { 'src/ui/hover.js': `export const set = (el, html) => { el.insertAdjacentHTML('beforeend', html); };\n` }, 'src/ui/hover.js');
    expectViolation('R8', { 'src/ui/hover.js': `export const get = (el) => el['innerHTML'];\n` }, 'src/ui/hover.js');
  });

  it('flags reading innerHTML too, not only writing it', () => {
    expectViolation('R8', { 'src/ui/hover.js': 'export const read = (el) => el.innerHTML;\n' }, 'src/ui/hover.js');
  });

  it('accepts clearing with \'\' or "", in both quote styles, and leaves other work untouched', () => {
    expectConforming('R8', { 'src/ui/hover.js': lines(`export const clear = (el) => { el.innerHTML = ''; };`, `export const clear2 = (el) => { el.innerHTML = ""; };`) });
  });

  it('does not flag the word innerHTML in a comment or a string, or an unrelated .textContent write', () => {
    expectConforming('R8', {
      'src/ui/hover.js': lines('// never set el.innerHTML = data', `export const warn = "don't use innerHTML here";`,
        `export const set = (el, text) => { el.textContent = text; };`),
    });
  });
});

describe('R9 packaging', () => {
  it('flags a src/ file missing from build.files, naming the src/** fix', () => {
    expectViolation('R9', { 'src/ui/extra.js': 'export const x = 1;\n' }, 'src/ui/extra.js',
      { packageJson: { build: { files: ['main.js', 'preload.js', 'main/**', 'index.html', 'style.css'] } }, message: /src\/\*\*/ });
  });

  it('flags a main/ file missing from build.files, naming the main/** fix', () => {
    expectViolation('R9', { 'main/extra.js': 'module.exports = {};\n' }, 'main/extra.js',
      { packageJson: { build: { files: ['main.js', 'preload.js', 'src/**', 'index.html', 'style.css'] } }, message: /main\/\*\*/ });
  });

  it('flags a root runtime file (e.g. index.html) missing from the list', () => {
    expectViolation('R9', {}, 'index.html', { packageJson: { build: { files: ['main.js', 'preload.js', 'main/**', 'src/**', 'style.css'] } } });
  });

  it('flags every needed file, individually, when build.files is missing entirely', () => {
    const v = run({}, { packageJson: {} });
    assert.ok(v.every((x) => x.rule === 'R9') && v.some((x) => x.file === 'main.js') && v.some((x) => x.file === 'src/core/history.js'));
    assert.match(v.find((x) => x.file === 'main.js').message, /Add 'main\.js'/);
  });

  it('respects negation: a pattern that un-ships a file after src/** is still a violation', () => {
    expectViolation('R9', {}, 'src/core/history.js', { packageJson: { build: { files: [...BASE_PACKAGE.build.files, '!src/core/history.js'] } } });
  });

  it('accepts the base tree\'s file list as-is, and a build.files that also lists node_modules or dist (irrelevant, ignored)', () => {
    expectConforming('R9', {}, { packageJson: { build: { files: [...BASE_PACKAGE.build.files, 'node_modules/**'] } } });
  });
});

describe('R10 legacy-scripts-gone (renderer)', () => {
  it('flags renderer.js or taskStore.js existing at the repo root', () => {
    expectViolation('R10', { 'renderer.js': '// old\n' }, 'renderer.js', { phase: ALL });
    expectViolation('R10', { 'taskStore.js': '// old\n' }, 'taskStore.js', { phase: ALL });
  });

  it('flags index.html having more than one <script>, or zero', () => {
    expectViolation('R10', { 'index.html': '<html><body><script type="module" src="src/ui/app.js"></script><script src="x.js"></script></body></html>' }, 'index.html');
    expectViolation('R10', { 'index.html': '<html><body>no script here</body></html>' }, 'index.html');
  });

  it('flags the one script tag being the wrong path, missing type=module, or carrying inline code', () => {
    expectViolation('R10', { 'index.html': '<html><body><script type="module" src="src/ui/renderer.js"></script></body></html>' }, 'index.html');
    expectViolation('R10', { 'index.html': '<html><body><script src="src/ui/app.js"></script></body></html>' }, 'index.html');
    expectViolation('R10', { 'index.html': `<html><body><script type="module" src="src/ui/app.js">console.log(1)</script></body></html>` }, 'index.html');
  });

  it('accepts exactly the one module entry script, and no renderer.js/taskStore.js at the root', () => {
    expectConforming('R10', {});
  });
});

// note: R11's fixtures need an entry point that imports the cyclic pair, because R3 requires
// bridge.js to be read from app.js's tree only incidentally; here we add a fresh, self-contained
// pair of files so the cycle is the only change from baseline.
describe('R11 no-cycles', () => {
  it('flags a direct two-file cycle and reports the path through both files', () => {
    expectViolation('R11',
      { 'src/core/a.js': `import { b } from './b.js';\nexport const a = () => b;\n`, 'src/core/b.js': `import { a } from './a.js';\nexport const b = () => a;\n` },
      'src/core/a.js', { message: /src\/core\/a\.js -> src\/core\/b\.js -> src\/core\/a\.js/ });
  });

  it('flags a longer cycle, here rerouted through the existing core/linkify.js', () => {
    // both files stay inside src/core/, so this trips only R11, not R1 (core-purity only cares that
    // relative imports resolve back inside src/core/, which a.js -> linkify.js -> a.js does).
    expectViolation('R11', {
      'src/core/a.js': `import { linkify } from './linkify.js';\nexport const a = linkify;\n`,
      'src/core/linkify.js': `import { a } from './a.js';\nexport const linkify = () => a;\n`,
    }, 'src/core/a.js');
    expectViolation('R11', { 'src/core/a.js': `import { a } from './a.js';\nexport { a };\n` }, 'src/core/a.js');
  });

  it('does not flag an import of a file that resolves outside the known src/ set (unresolved edges are dropped, not cycles)', () => {
    expectConforming('R11', { 'src/core/a.js': `import { missing } from './missing.js';\nexport const a = missing;\n` }, {});
  });

  it('accepts a diamond (two modules sharing a common dependency is not a cycle)', () => {
    expectConforming('R11', {
      'src/core/a.js': `import { toHistory } from './history.js';\nexport const a = toHistory;\n`,
      'src/core/linkify.js': `import { toHistory } from './history.js';\nexport const linkify = () => toHistory;\n`,
    });
  });
});

describe('R12 no-globals-leak (renderer)', () => {
  it('flags an assignment to window.<anything> or globalThis.<anything> in src/', () => {
    expectViolation('R12', { 'src/ui/hover.js': `window.blobDebug = 1;\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
    expectViolation('R12', { 'src/ui/hover.js': `globalThis.blobDebug = { x: 1 };\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
  });

  it('flags bracket assignment, compound assignment, increment, and Object.defineProperty(window, ...)', () => {
    expectViolation('R12', { 'src/ui/hover.js': `window['blobDebug'] = 1;\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
    expectViolation('R12', { 'src/ui/hover.js': `window.count += 1;\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
    expectViolation('R12', { 'src/ui/hover.js': `window.count++;\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
    expectViolation('R12', { 'src/ui/hover.js': `Object.defineProperty(window, 'blobDebug', { value: 1 });\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
  });

  it('flags a nested-path assignment like window.blob.debug = 1', () => {
    expectViolation('R12', { 'src/ui/hover.js': `window.blob.debug = 1;\nexport const noop = () => {};\n` }, 'src/ui/hover.js');
  });

  it('does not flag reading a global, only writing one, and ignores comments/strings', () => {
    expectConforming('R12', {
      'src/ui/hover.js': lines('// never: window.blobDebug = 1', `export const note = "window.x = 1";`, 'export const hasWindow = typeof window !== \'undefined\';',
        'export const ua = globalThis.navigator ? globalThis.navigator.userAgent : \'\';'),
    });
  });

  it('accepts ordinary module-local state (nothing touches window/globalThis)', () => {
    expectConforming('R12', { 'src/ui/hover.js': 'let hovered = null;\nexport const setHovered = (id) => { hovered = id; };\nexport const getHovered = () => hovered;\n' });
  });
});

describe('meta: every rule has both a violating and a conforming case, and phase gating holds', () => {
  it('R1..R12 each have at least one violating and one conforming meta-test above', () => {
    for (const rule of RULES) {
      assert.ok(seen.violates.has(rule.id), `${rule.id} (${rule.name}) has no violating meta-test`);
      assert.ok(seen.conforms.has(rule.id), `${rule.id} (${rule.name}) has no conforming meta-test`);
    }
  });

  it('a (renderer)/(main) rule stays silent with its phase flag off, even on a tree that violates it', () => {
    for (const { rule, delta, file, packageJson } of seen.cases) {
      const phaseOf = RULES.find((r) => r.id === rule).phase;
      if (!phaseOf) continue; // always-on rule: nothing to gate
      const off = checkArchitecture({ files: tree(delta), packageJson, phase: { renderer: false, main: false } });
      assert.ok(!off.some((v) => v.rule === rule), `${rule} fired on ${file} with its phase flag off`);
    }
  });

  it('an always-on rule keeps firing regardless of the phase flags', () => {
    for (const { rule, delta, file, packageJson } of seen.cases) {
      if (RULES.find((r) => r.id === rule).phase) continue; // only checking always-on rules here
      const off = checkArchitecture({ files: tree(delta), packageJson, phase: { renderer: false, main: false } });
      assert.ok(off.some((v) => v.rule === rule && v.file === file), `${rule} should still fire on ${file} with phases off`);
    }
  });
});

// =============================================================================================
// Part 3: the REAL TREE. The actual repo, read from disk, run through the very same checker
// (checkArchitecture itself never touches fs — that is what lets Part 2 feed it fake trees).
// =============================================================================================

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const isJs = (name) => /\.(js|mjs|cjs)$/.test(name);

// Every file under `dir` for which `test(name)` is true, skipping node_modules/dist/.git anywhere
// in the tree. Absolute paths; missing `dir` (main/ does not exist yet) just yields nothing.
function walk(dir, test, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

// src/**/*.js, main/**/*.js, main.js, preload.js, index.html, style.css -> Map<relative posix path, source>.
// style.css is read too (beyond the plan's script-file list) because R9 packaging explicitly names it
// as one of the files that must be covered by build.files; leaving it out would leave that half of
// R9 unchecked on the real tree.
function readRealTree() {
  const files = new Map();
  const add = (absPath) => files.set(relative(REPO_ROOT, absPath).split(sep).join('/'), readFileSync(absPath, 'utf8'));
  for (const dir of ['src', 'main']) for (const f of walk(join(REPO_ROOT, dir), isJs)) add(f);
  for (const rootFile of ['main.js', 'preload.js', 'index.html', 'style.css']) {
    const p = join(REPO_ROOT, rootFile);
    if (existsSync(p)) add(p);
  }
  return files;
}

describe('REAL TREE: the repo as it exists right now', () => {
  it('has zero architecture violations under the current PHASE flags', () => {
    const files = readRealTree();
    assert.ok(files.has('main.js') && files.has('preload.js') && files.has('index.html'), 'sanity: the walk found the repo, not an empty directory');
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const violations = checkArchitecture({ files, packageJson, phase: PHASE });
    assert.deepEqual(violations.map((v) => v.message), []);
  });
});
