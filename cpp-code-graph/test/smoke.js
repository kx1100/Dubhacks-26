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
  // Declared up front: TypeScript's `import * as vscode` sees only the keys that exist when it is imported.
  ProgressLocation: { Notification: 15 },
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
    async openTextDocument(u) { const text = fs.readFileSync(u.fsPath, 'utf8'); const lines = text.split('\n'); return { getText: () => text, lineCount: lines.length, lineAt: i => ({ text: lines[i].replace(/\r$/, '') }) }; },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    activeTextEditor: null,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
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

// --bundle checks out/extension.js, what VS Code loads, instead of the sources.
const ext = require(process.argv.includes('--bundle') ? '../out/extension.js' : '../src/extension.ts');
const workspaceStore = new Map();
const context = { subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')), asAbsolutePath: p => path.join(__dirname, '..', p), workspaceState: { get: k => workspaceStore.get(k), update: async (k, v) => workspaceStore.set(k, v) } };
(async () => {
  ext.activate(context);
  const expected = ['codeGraph.open', 'codeGraph.refresh', 'codeGraph.revealInGraph', 'codeGraph.ask'];
  for (const c of expected) if (!commands[c]) throw new Error('missing command ' + c);
  if (commands['codeGraph.compareCommits']) throw new Error('compare commits should be gone');
  await commands['codeGraph.open']();
  await onMessage({ type: 'ready' });
  await new Promise(r => setTimeout(r, 50));
  const g = posted.find(m => m.type === 'graph');
  if (!g || g.data.nodes.length < 40) throw new Error('graph not posted');
  await onMessage({ type: 'openLocation', file: 'src/main.cpp', line: 10 });
  // Inline code: the webview asks for a line range and gets it back.
  await onMessage({ type: 'getSource', reqId: 1, file: 'src/main.cpp', start: 10, end: 12 });
  const src = posted.find(m => m.type === 'source' && m.reqId === 1);
  if (!src || src.error || src.startLine !== 10 || src.lines.length !== 3 || src.truncated || !src.lines[0].includes('main')) throw new Error('bad source reply ' + JSON.stringify(src));
  await onMessage({ type: 'getSource', reqId: 2, file: 'src/main.cpp', start: 1, end: 100000 });
  const big = posted.find(m => m.type === 'source' && m.reqId === 2);
  if (!big || big.error || big.lines.length > 200 || big.startLine !== 1) throw new Error('bad capped source reply ' + JSON.stringify(big && { n: big.lines && big.lines.length, e: big.error }));
  await onMessage({ type: 'getSource', reqId: 3, file: 'nope/missing.cpp', start: 1, end: 5 });
  const missing = posted.find(m => m.type === 'source' && m.reqId === 3);
  if (!missing || !missing.error) throw new Error('missing file should report an error');
  await onMessage({ type: 'ask', question: 'How does rendering work?', focus: null });
  const res = posted.find(m => m.type === 'aiResult');
  if (!res || res.highlight.length !== 2 || res.path.length !== 2 || !res.answer.includes('[[function:src/main.cpp:main')) throw new Error('bad ai result ' + JSON.stringify(res));
  console.log('posted:', posted.map(m => m.type).join(', '));
  console.log('answer:', res.answer);

  // Tool calling (VS Code 1.95+): the agent investigates, then finishes.
  vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  vscode.LanguageModelToolCallPart = class { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } };
  vscode.LanguageModelToolResultPart = class { constructor(callId, content) { this.callId = callId; this.content = content; } };
  vscode.LanguageModelChatMessage.Assistant = parts => ({ role: 'assistant', content: parts });
  vscode.LanguageModelChatToolMode = { Auto: 1, Required: 2 };
  const requests = [];
  const toolModel = {
    name: 'MockTools', family: 'mock', maxInputTokens: 100000,
    async sendRequest(messages, options) {
      requests.push({ messages, options });
      const intro = messages[0].content;
      const mainRef = /(N\d+) function main/.exec(intro)[1];
      const parts = [];
      if (requests.length === 1) parts.push(new vscode.LanguageModelTextPart('Checking main.'), new vscode.LanguageModelToolCallPart('t1', 'neighbors', { node: mainRef, direction: 'out', kinds: ['call'] }));
      else {
        const results = messages[messages.length - 1].content;
        const renderRef = /call -> (N\d+) method geo::Canvas::render/.exec(results[0].content[0].value)[1];
        parts.push(new vscode.LanguageModelToolCallPart('t2', 'finish', { answer: `[[${mainRef}]] calls [[${renderRef}]].`, path: [mainRef, renderRef], evidence: [{ file: 'src/main.cpp', line: 15, claim: 'render call' }], confidence: 'high' }));
      }
      return { stream: (async function* () { yield* parts; })() };
    }
  };
  vscode.lm.selectChatModels = async () => [toolModel];
  posted.length = 0;
  await onMessage({ type: 'ask', question: 'How does rendering work?', focus: null, mode: 'path' });
  const steps = posted.filter(m => m.type === 'aiStep');
  const tres = posted.find(m => m.type === 'aiResult');
  if (requests.length !== 2 || requests[0].options.tools.length < 8) throw new Error('agent did not use tools: ' + requests.length);
  if (!/execution path/.test(requests[0].messages[0].content)) throw new Error('path mode hint missing');
  const sent = requests[1].messages;
  if (sent[1].role !== 'assistant' || sent[1].content[0].value !== 'Checking main.' || sent[1].content[1].callId !== 't1') throw new Error('assistant turn not replayed');
  if (!(sent[2].content[0] instanceof vscode.LanguageModelToolResultPart) || sent[2].content[0].callId !== 't1') throw new Error('tool result not sent');
  if (steps.length !== 3 || steps[1].step.tool !== 'read_code' || steps[2].step.tool !== 'neighbors' || !steps[2].step.nodeIds.length) throw new Error('bad steps ' + JSON.stringify(steps));
  if (!tres || tres.path.length !== 2 || tres.hops[0].inferred || tres.evidence.length !== 1 || tres.confidence !== 'high' || tres.confidenceReason !== 'read the code of 2 of the 2 functions it cites; 1 cited source line' || !tres.answer.startsWith('[[function:src/main.cpp:main')) throw new Error('bad agent result ' + JSON.stringify(tres));
  console.log('agent answer:', tres.answer);

  // Stop during an investigation still ends with a (cancelled) result, so the panel is not left busy.
  const stopModel = {
    name: 'Stopper', family: 'mock', maxInputTokens: 100000,
    async sendRequest(messages) {
      const mainRef = /(N\d+) function main/.exec(messages[0].content)[1];
      await onMessage({ type: 'cancelAsk' });
      return { stream: (async function* () { yield new vscode.LanguageModelToolCallPart('s1', 'get_node', { node: mainRef }); })() };
    }
  };
  vscode.lm.selectChatModels = async () => [stopModel];
  posted.length = 0;
  await onMessage({ type: 'ask', question: 'Stop me', focus: null });
  const sres = posted.filter(m => m.type === 'aiResult');
  if (sres.length !== 1 || !sres[0].cancelled || sres[0].answer !== '_Cancelled._') throw new Error('stop left no result ' + JSON.stringify(sres));

  // A model that rejects tools falls back to the single prompt.
  const fallbackModel = {
    name: 'NoTools', family: 'mock', maxInputTokens: 100000,
    async sendRequest(messages, options) {
      if (options.tools) throw Object.assign(new vscode.LanguageModelError('tools not supported'), { code: 'NoTools' });
      return { text: (async function* () { yield 'Plain answer.\nHIGHLIGHT: none\nPATH: none'; })() };
    }
  };
  vscode.lm.selectChatModels = async () => [fallbackModel];
  posted.length = 0;
  await onMessage({ type: 'ask', question: 'Anything?', focus: null });
  const fres = posted.find(m => m.type === 'aiResult');
  if (!fres || fres.answer !== 'Plain answer.' || fres.error) throw new Error('bad fallback result ' + JSON.stringify(fres));

  // Copilot's "Auto" router rejects extension requests with a plain Error; it is skipped when another model exists.
  const autoModel = {
    id: 'auto', name: 'Auto', family: 'auto', maxInputTokens: 100000,
    async sendRequest() { throw new Error('Auto mode needs a prompt or a command to route a request.'); }
  };
  vscode.lm.selectChatModels = async () => [autoModel, fallbackModel];
  posted.length = 0;
  await onMessage({ type: 'ask', question: 'Anything?', focus: null });
  const ares = posted.find(m => m.type === 'aiResult');
  if (!ares || ares.answer !== 'Plain answer.' || ares.model !== 'NoTools') throw new Error('auto model was not skipped ' + JSON.stringify(ares));
  // With only the router available, its error is reported as a model failure, not a crash.
  vscode.lm.selectChatModels = async () => [autoModel];
  posted.length = 0;
  await onMessage({ type: 'ask', question: 'Anything?', focus: null });
  const ores = posted.find(m => m.type === 'aiResult');
  if (!ores || ores.error || !/request failed \(Auto mode needs a prompt/.test(ores.answer)) throw new Error('router error not handled ' + JSON.stringify(ores));

  // History: every answered question is saved for the workspace, newest first, with its steps.
  // Stop is not saved; the router failure above is (it still produced an answer).
  const saved = workspaceStore.get('codeGraph.aiHistory');
  const qs = saved.map(e => e.question);
  if (qs.join('|') !== 'Anything?|Anything?|Anything?|How does rendering work?|How does rendering work?') throw new Error('bad history ' + JSON.stringify(qs));
  const agentEntry = saved[3];
  if (agentEntry.mode !== 'path' || agentEntry.steps.length !== 3 || agentEntry.steps[2].tool !== 'neighbors' || agentEntry.path.length !== 2 || agentEntry.evidence.length !== 1) throw new Error('bad agent entry ' + JSON.stringify(agentEntry));
  if (posted.find(m => m.type === 'aiResult').entryId !== saved[0].id) throw new Error('result does not name its history entry');
  posted.length = 0;
  await onMessage({ type: 'ready' });
  const histMsg = posted.find(m => m.type === 'aiHistory');
  if (!histMsg || histMsg.entries.length !== 5) throw new Error('history not sent on ready');
  await onMessage({ type: 'aiHistoryDelete', id: saved[0].id });
  if (workspaceStore.get('codeGraph.aiHistory').length !== 4) throw new Error('delete failed');
  await onMessage({ type: 'aiHistoryClear' });
  if (workspaceStore.get('codeGraph.aiHistory').length !== 0 || posted.filter(m => m.type === 'aiHistory').pop().entries.length !== 0) throw new Error('clear failed');

  // AI node summaries: generated once, then served from the workspace cache until the code changes.
  let summaryCalls = 0;
  const summaryModel = {
    name: 'Summarizer', family: 'mock', maxInputTokens: 100000,
    async sendRequest(messages) {
      summaryCalls++;
      if (!/Element: geo::Canvas::render \(method\)/.test(messages[0].content)) throw new Error('bad summary prompt');
      return { text: (async function* () { yield '{"purpose": "Draws every shape (' + summaryCalls + ').", "tags": ["rendering"], "notes": []}'; })() };
    }
  };
  vscode.lm.selectChatModels = async () => [summaryModel];
  const renderId = g.data.nodes.find(n => n.qname === 'geo::Canvas::render').id;
  const lastSummary = () => posted.filter(m => m.type === 'summary').pop();
  await onMessage({ type: 'getSummary', id: renderId });
  let sm = lastSummary();
  if (!sm || !sm.summary || sm.summary.purpose !== 'Draws every shape (1).' || sm.cached || sm.model !== 'Summarizer' || summaryCalls !== 1) throw new Error('bad summary ' + JSON.stringify(sm));
  await onMessage({ type: 'getSummary', id: renderId });
  sm = lastSummary();
  if (!sm.cached || sm.summary.purpose !== 'Draws every shape (1).' || summaryCalls !== 1) throw new Error('summary not cached ' + JSON.stringify(sm));
  await onMessage({ type: 'getSummary', id: renderId, refresh: true });
  if (!lastSummary().summary || lastSummary().summary.purpose !== 'Draws every shape (2).' || summaryCalls !== 2) throw new Error('refresh did not regenerate ' + JSON.stringify(lastSummary()));
  // Changed code (a new hash) is summarized again.
  g.data.nodes.find(n => n.id === renderId).hash = 'edited';
  await onMessage({ type: 'getSummary', id: renderId });
  if (lastSummary().cached || summaryCalls !== 3) throw new Error('changed code was served from the cache');
  if (workspaceStore.get('codeGraph.aiSummaries')[renderId].summary.purpose !== 'Draws every shape (3).') throw new Error('summary not saved');
  // Folders are not summarized; the setting turns summaries off; without a model they are unavailable.
  await onMessage({ type: 'getSummary', id: 'dir:src' });
  if (!lastSummary().disabled) throw new Error('folder should not be summarized');
  const getConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({ get: k => (k === 'aiSummaries' ? false : undefined) });
  await onMessage({ type: 'getSummary', id: renderId, refresh: true });
  vscode.workspace.getConfiguration = getConfiguration;
  if (!lastSummary().disabled || summaryCalls !== 3) throw new Error('setting did not disable summaries');
  vscode.lm.selectChatModels = async () => [];
  await onMessage({ type: 'getSummary', id: renderId, refresh: true });
  if (!lastSummary().unavailable) throw new Error('missing model not reported');

  // Change impact, computed in the extension host.
  posted.length = 0;
  const logId = g.data.nodes.find(n => n.label === 'log_message').id;
  await onMessage({ type: 'impact', id: logId, changeType: 'remove' });
  const imp = posted.find(m => m.type === 'impactResult');
  if (!imp || imp.id !== logId || imp.requested !== 'remove' || imp.changeType !== 'remove' || imp.summary.high < 2 || !imp.labels.relations.caller) throw new Error('bad impact ' + JSON.stringify(imp && imp.summary));
  await onMessage({ type: 'impact', id: 'dir:src', changeType: 'remove' });
  if (!posted.filter(m => m.type === 'impactResult').pop().error) throw new Error('folder impact should be refused');

  // The AI layer: built with a progress notification, saved, and merged into the graph the webview gets.
  const infos = [];
  vscode.ProgressLocation = { Notification: 15 };
  vscode.window.withProgress = async (opts, fn) => fn({ report() {} }, { isCancellationRequested: false });
  vscode.window.showInformationMessage = m => infos.push(m);
  let semCalls = 0;
  const semModel = {
    name: 'Layer', family: 'mock', maxInputTokens: 100000,
    async sendRequest(messages) {
      semCalls++;
      const p = messages[0].content;
      let reply;
      if (p.startsWith('You are labeling')) reply = JSON.stringify(Object.fromEntries((p.match(/^E\d+(?= )/gm) || []).map(r => [r, ['drawing']])));
      else reply = JSON.stringify((p.match(/^P\d+(?= )/gm) || []).map(ref => ({ ref, relation: 'alternative', confidence: 0.8, reason: 'same job' })));
      return { text: (async function* () { yield reply; })() };
    }
  };
  vscode.lm.selectChatModels = async () => [semModel];
  posted.length = 0;
  await onMessage({ type: 'buildSemantic' });
  const layerState = workspaceStore.get('codeGraph.semanticLayer');
  if (!layerState || layerState.model !== 'Layer' || layerState.edges.length !== 2 || !Object.keys(layerState.concepts).length) throw new Error('layer not saved ' + JSON.stringify(layerState && { m: layerState.model, e: layerState.edges.length }));
  const lg = posted.filter(m => m.type === 'graph').pop();
  if (!lg || lg.data.edges.filter(e => e.kind === 'semantic').length !== 2 || !lg.data.concepts[renderId] || lg.data.semantic.edges !== 2) throw new Error('layer not in the posted graph');
  if (posted.filter(m => m.type === 'semanticBuilding').map(m => m.busy).join() !== 'true,false') throw new Error('busy state not posted');
  if (!/concepts? tagged/.test(infos.pop())) throw new Error('no summary message');
  // The workspace graph itself is not changed: impact and summaries see only the code's relationships.
  if (g.data.edges.some(e => e.kind === 'semantic')) throw new Error('semantic edges leaked into the workspace graph');
  // A second build asks nothing.
  const before = semCalls;
  await onMessage({ type: 'buildSemantic' });
  if (semCalls !== before) throw new Error('rebuild asked again: ' + (semCalls - before));
  console.log('SMOKE OK');
})().catch(e => { console.error(e); process.exit(1); });
