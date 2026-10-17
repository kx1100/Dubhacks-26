// Smoke test of the extension host code with a mocked `vscode` module.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const sampleRoot = path.join(__dirname, '..', 'sample');

const posted = [];
let onMessage = null;
const commands = {};
const listFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const Uri = {
  file: p => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }),
  joinPath: (u, ...parts) => Uri.file(path.join(u.fsPath, ...parts)),
  from: o => ({ ...o, toString: () => o.scheme + ':' + o.path })
};
class CancellationTokenSource {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
const vscode = {
  Uri,
  ViewColumn: { One: 1, Beside: -2 },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  CancellationTokenSource,
  LanguageModelError: class extends Error {},
  LanguageModelChatMessage: { User: t => ({ role: 'user', content: t }) },
  lm: {
    async selectChatModels() {
      return [{
        name: 'Mock', family: 'mock', maxInputTokens: 100000,
        async sendRequest(messages) {
          const prompt = messages[0].content;
          const id = /(N\d+) method geo::Canvas::render/.exec(prompt)[1];
          const mainId = /(N\d+) function main/.exec(prompt)[1];
          return { text: (async function* () { yield 'Rendering starts in [[' + mainId + ']] '; yield 'and goes to [[' + id + ']].\nHIGHLIGHT: ' + mainId + ', ' + id + '\nPATH: ' + mainId + ' -> ' + id; })() };
        }
      }];
    }
  },
  workspace: {
    workspaceFolders: [{ name: 'sample', uri: Uri.file(sampleRoot) }],
    textDocuments: [],
    getConfiguration: () => ({ get: k => ({ include: '**/*.{c,cpp,h}', exclude: '', maxFiles: 100, autoRefresh: true })[k] }),
    async findFiles() { return listFiles(sampleRoot).map(Uri.file); },
    fs: { readFile: async u => fs.readFileSync(u.fsPath) },
    asRelativePath: u => path.relative(sampleRoot, u.fsPath),
    async openTextDocument(u) { const text = fs.readFileSync(u.fsPath, 'utf8'); return { getText: () => text, lineCount: text.split('\n').length }; },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    activeTextEditor: null,
    createWebviewPanel() {
      return {
        webview: {
          cspSource: 'mock',
          asWebviewUri: u => u.fsPath,
          set html(h) { this._html = h; },
          postMessage: m => posted.push(m),
          onDidReceiveMessage: cb => (onMessage = cb)
        },
        onDidDispose() {},
        reveal() {}
      };
    },
    async showTextDocument(doc, opts) { posted.push({ type: '_opened', line: opts.selection.start.line }); },
    showErrorMessage: m => console.error('ERR', m),
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined
  },
  commands: { registerCommand: (id, fn) => ((commands[id] = fn), { dispose() {} }), executeCommand() {} }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const ext = require('../src/extension');
const context = { subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')) };
(async () => {
  ext.activate(context);
  const expected = ['codeGraph.open', 'codeGraph.refresh', 'codeGraph.revealInGraph', 'codeGraph.compareCommits', 'codeGraph.ask'];
  for (const c of expected) if (!commands[c]) throw new Error('missing command ' + c);
  await commands['codeGraph.open']();
  await onMessage({ type: 'ready' });
  await new Promise(r => setTimeout(r, 50));
  const g = posted.find(m => m.type === 'graph');
  if (!g || g.graph.nodes.length < 40) throw new Error('graph not posted');
  await onMessage({ type: 'open', file: 'src/main.cpp', line: 10 });
  await onMessage({ type: 'ask', question: 'How does rendering work?', focus: null });
  const res = posted.find(m => m.type === 'aiResult');
  if (!res || res.highlight.length !== 2 || res.path.length !== 2 || !res.answer.includes('[[fn:main')) throw new Error('bad ai result ' + JSON.stringify(res));
  console.log('posted:', posted.map(m => m.type).join(', '));
  console.log('answer:', res.answer);
  console.log('SMOKE OK');
})().catch(e => { console.error(e); process.exit(1); });
