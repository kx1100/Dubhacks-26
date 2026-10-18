'use strict';

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { WorkspaceIndex, nodeAt } = require('./workspaceIndex');
const { buildGraph } = require('./graph/builder');
const { diffGraphs } = require('./graph/diff');
const git = require('./git');
const { askQuestion } = require('./ai');
const { selectModel, streamText } = require('./ai/model');
const { GraphTools } = require('./ai/graphTools');
const { contentKey, summarize } = require('./ai/summaries');
const { predictImpact, checkPrediction, RELATION_LABELS, CHANGE_TYPES } = require('./ai/impact');
const { checkWithModel } = require('./ai/impactCheck');
const { buildSemanticLayer, currentLayer } = require('./ai/semantic');

const MAX_SNIPPET_LINES = 200; // longest snippet sent to the webview for inline code
const DEFAULT_SNIPPET_LINES = 30; // used when a node has no known end line
const HISTORY_KEY = 'codeGraph.aiHistory';
const HISTORY_MAX = 30; // answers kept per workspace
const HISTORY_STEP_NODES = 40; // node ids kept per investigation step
const SUMMARY_KEY = 'codeGraph.aiSummaries';
const SUMMARY_MAX = 400; // node summaries kept per workspace
const SEMANTIC_KEY = 'codeGraph.semanticLayer';

/** The single Code Graph webview panel. */
class GraphPanel {
  constructor(context, index) {
    this.context = context;
    this.index = index;
    this.panel = null;
    this.ready = false;
    this.pending = [];
    this.aiCancel = null;
    this.summaryCancel = null;
    this.impactCancel = null;
    this.toolsByGraph = new WeakMap(); // graph -> GraphTools, for summaries
  }

  show() {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('codeGraph', 'Code Graph', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media]
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.ready = false;
    this.panel.webview.html = this.html(this.panel.webview, media);
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.ready = false;
      this.pending = [];
    });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.error(err)));
  }

  post(msg) {
    if (!this.panel) return;
    if (!this.ready) this.pending.push(msg);
    else this.panel.webview.postMessage(msg);
  }

  error(err) {
    const msg = (err && err.message) || String(err);
    this.post({ type: 'status', text: msg, error: true });
    vscode.window.showErrorMessage('Code Graph: ' + msg);
  }

  async refreshWorkspace(silent) {
    if (!this.panel) return;
    if (!silent) this.post({ type: 'status', text: 'Scanning C/C++ files…', busy: true });
    const graph = await this.index.scan();
    this.post({ type: 'graph', mode: 'workspace', graph: this.withSemantic(graph), title: graph.title });
    if (graph.stats.truncated) {
      this.post({ type: 'status', text: `Only the first ${graph.stats.maxFiles} files were analyzed (codeGraph.maxFiles).` });
    }
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const p of this.pending.splice(0)) this.panel.webview.postMessage(p);
        if (this.index.graph) this.post({ type: 'graph', mode: 'workspace', graph: this.withSemantic(this.index.graph), title: this.index.graph.title });
        else await this.refreshWorkspace();
        this.postHistory();
        break;
      case 'open':
        await this.openSource(m);
        break;
      case 'getSource':
        await this.sendSource(m);
        break;
      case 'refresh':
        await this.refreshWorkspace();
        break;
      case 'ask':
        await this.ask(m.question, m.focus, m.mode);
        break;
      case 'getSummary':
        await this.getSummary(m);
        break;
      case 'impact':
        this.sendImpact(m);
        break;
      case 'impactAI':
        await this.impactAI(m);
        break;
      case 'buildSemantic':
        await this.buildSemantic();
        break;
      case 'impactCheck':
        await this.impactCheck(m);
        break;
      case 'cancelAsk':
        if (this.aiCancel) this.aiCancel.cancel();
        break;
      case 'aiHistoryDelete':
        await this.saveHistory(this.history().filter(e => e.id !== m.id));
        break;
      case 'aiHistoryClear':
        await this.saveHistory([]);
        break;
    }
  }

  // ---- source navigation ---------------------------------------------------

  uriFor(file) {
    return this.index.uriFor(file);
  }

  async openSource(m) {
    const uri = this.uriFor(m.file);
    if (!uri) return;
    const line = Math.max(0, (m.line || 1) - 1);
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    await vscode.window.showTextDocument(doc, {
      viewColumn: this.panel && this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
      selection: new vscode.Range(pos, pos),
      preserveFocus: !!m.preserveFocus
    });
  }

  /** Replies to a webview `getSource` request with the lines [start, end] of a file. */
  async sendSource(m) {
    const reply = { type: 'source', reqId: m.reqId };
    try {
      const uri = this.uriFor(m.file);
      if (!uri) throw new Error('Source is not available.');
      const doc = await vscode.workspace.openTextDocument(uri);
      const first = Math.min(Math.max(1, m.start | 0 || 1), Math.max(1, doc.lineCount));
      const wanted = Math.max(first, m.end | 0 || first + DEFAULT_SNIPPET_LINES - 1);
      const last = Math.min(doc.lineCount, wanted, first + MAX_SNIPPET_LINES - 1);
      const lines = [];
      for (let i = first; i <= last; i++) lines.push(doc.lineAt(i - 1).text);
      this.post({ ...reply, startLine: first, lines, truncated: wanted > last });
    } catch (err) {
      this.post({ ...reply, error: (err && err.message) || String(err) });
    }
  }

  async revealAtCursor() {
    const editor = vscode.window.activeTextEditor;
    this.show();
    if (!this.index.graph) await this.refreshWorkspace();
    if (!editor || !this.index.graph) return;
    const rel = this.index.relPathOf(editor.document.uri);
    const node = nodeAt(this.index.graph, rel, editor.selection.active.line + 1);
    if (node) this.post({ type: 'reveal', id: node.id });
  }

  // ---- AI ----------------------------------------------------------------------

  async ask(question, focus, mode) {
    question = (question || '').trim();
    if (!question) return;
    this.show();
    const graph = this.withSemantic(this.index.graph || (await this.index.scan()));
    if (this.aiCancel) this.aiCancel.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.aiCancel = cts;
    this.post({ type: 'aiStart', question });
    const readSource = file => this.readTarget(file);
    const steps = [];
    try {
      const result = await askQuestion(graph, question, {
        focusId: focus,
        mode,
        readSource,
        token: cts.token,
        onText: text => this.post({ type: 'aiPartial', text }),
        onStep: step => {
          steps.push(step);
          if (!cts.token.isCancellationRequested) this.post({ type: 'aiStep', step });
        }
      });
      if (!cts.token.isCancellationRequested) {
        const entry = this.historyEntry(question, mode, result, steps);
        this.post({ type: 'aiResult', ...result, entryId: entry.id, time: entry.time });
        await this.saveHistory([entry, ...this.history()]);
      } else if (this.aiCancel === cts) this.post(cancelledResult());
    } catch (err) {
      // A question replaced by a newer one reports nothing, so it can't overwrite the newer answer.
      if (cts.token.isCancellationRequested) {
        if (this.aiCancel === cts) this.post(cancelledResult());
      } else this.post({ type: 'aiResult', answer: 'Error: ' + ((err && err.message) || err), highlight: [], path: [], error: true });
    } finally {
      if (this.aiCancel === cts) this.aiCancel = null;
      cts.dispose();
    }
  }

  /** Text of a file in the workspace. */
  async readTarget(file) {
    const uri = this.uriFor(file);
    if (!uri) return null;
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  }

  /** GraphTools for the graph on screen, built once per graph. */
  graphTools() {
    const graph = this.index.graph;
    if (!graph) return null;
    let tools = this.toolsByGraph.get(graph);
    if (!tools) this.toolsByGraph.set(graph, (tools = new GraphTools(graph, { readSource: file => this.readTarget(file) })));
    return tools;
  }

  // ---- Semantic layer (AI concepts and inferred relationships) -----------------------

  /**
   * The workspace graph plus the saved semantic layer, keeping only the parts
   * whose code has not changed since they were built. The graph itself is not
   * modified: impact and summaries work on the code's own relationships.
   */
  withSemantic(graph) {
    const state = this.context.workspaceState && this.context.workspaceState.get(SEMANTIC_KEY);
    if (!state || !graph || graph !== this.index.graph) return graph;
    const layer = currentLayer(this.graphTools(), state);
    return {
      ...graph,
      edges: graph.edges.concat(layer.edges),
      concepts: layer.concepts,
      semantic: { model: state.model, time: state.time, edges: layer.edges.length, concepts: new Set(Object.values(layer.concepts).flat()).size, tagged: Object.keys(layer.concepts).length }
    };
  }

  /** Builds or updates the semantic layer for the workspace, with a cancellable progress notification. */
  async buildSemantic() {
    this.show();
    if (!this.index.graph) await this.refreshWorkspace();
    const model = await selectModel();
    if (!model) throw new Error('No language model is available in VS Code (for example GitHub Copilot Chat).');
    const tools = this.graphTools();
    const state = this.context.workspaceState;
    const prev = state && state.get(SEMANTIC_KEY);
    const name = model.name || model.family;
    this.post({ type: 'semanticBuilding', busy: true });
    let result;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Code Graph: tagging concepts', cancellable: true }, async (progress, token) => {
        let reported = 0;
        return buildSemanticLayer(tools, prev, prompt => streamText(model, prompt, token, () => {}), {
          model: name,
          isCancelled: () => token.isCancellationRequested,
          onProgress: (message, done, total) => {
            const pct = total ? (100 * done) / total : 100;
            progress.report({ message, increment: pct - reported });
            reported = pct;
          }
        });
      });
    } finally {
      this.post({ type: 'semanticBuilding', busy: false });
    }
    if (state) await state.update(SEMANTIC_KEY, result.state);
    const graph = this.withSemantic(this.index.graph);
    this.post({ type: 'graph', mode: 'workspace', graph, title: graph.title });
    const s = result.stats;
    const info = graph.semantic || { concepts: 0 };
    let msg = `Code Graph: ${info.concepts} concept${info.concepts === 1 ? '' : 's'} tagged.`;
    if (s.error) msg += ` It stopped early (${s.error}); run it again to continue.`;
    else if (s.cancelled || s.filesLeft) msg += ` ${s.filesLeft} file${s.filesLeft === 1 ? '' : 's'} still to tag; run it again to continue.`;
    vscode.window.showInformationMessage(msg);
    return result;
  }

  // ---- Change impact ------------------------------------------------------------------

  /** Replies to impact {id, changeType} with the predicted impact of changing that node. */
  sendImpact(m) {
    const tools = this.graphTools();
    const result = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
    this.post({ type: 'impactResult', id: m.id, requested: m.changeType, ...result, labels: { relations: RELATION_LABELS, changes: CHANGE_TYPES } });
  }

  /** Replies to impactAI {id, changeType, description}: the model checks the riskiest places. */
  async impactAI(m) {
    const reply = { type: 'impactAIResult', id: m.id, requested: m.changeType };
    const tools = this.graphTools();
    const impact = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
    if (impact.error) return this.post({ ...reply, error: impact.error });
    const model = await selectModel();
    if (!model) return this.post({ ...reply, error: 'No language model is available in VS Code (for example GitHub Copilot Chat).' });
    if (this.impactCancel) this.impactCancel.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.impactCancel = cts;
    try {
      const description = String(m.description || '').trim().slice(0, 500);
      const result = await checkWithModel(tools, impact, description, prompt => streamText(model, prompt, cts.token, () => {}));
      this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, ...result, model: model.name || model.family });
    } catch (err) {
      this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, error: (err && err.message) || String(err) });
    } finally {
      if (this.impactCancel === cts) this.impactCancel = null;
      cts.dispose();
    }
  }

  /**
   * Replies to impactCheck {id, changeType}: predicts from the last commit and
   * compares with what the uncommitted edits actually changed. Only files in the
   * workspace folder are read, with their paths made workspace-relative, so node
   * ids match the graph on screen.
   */
  async impactCheck(m) {
    const reply = { type: 'impactCheckResult', id: m.id, requested: m.changeType };
    try {
      const folders = vscode.workspace.workspaceFolders || [];
      const graph = this.index.graph;
      const node = graph && graph.nodes.find(n => n.id === m.id);
      const file = node ? node.defFile || node.file || '' : '';
      const multiRoot = folders.length > 1;
      const folder = multiRoot ? folders.find(f => file.startsWith(f.name + '/')) || folders[0] : folders[0];
      if (!folder) throw new Error('Open a folder to compare with git.');
      const root = await git.repoRoot(folder.uri.fsPath);
      const rel = path.relative(root, folder.uri.fsPath).split(path.sep).join('/');
      if (rel.startsWith('..')) throw new Error('The workspace folder is not inside its git repository.');
      const repoPrefix = rel ? rel + '/' : '';
      const wsPrefix = multiRoot ? folder.name + '/' : '';
      const cfg = vscode.workspace.getConfiguration('codeGraph');
      const load = async rev =>
        (await git.readRevision(root, rev, cfg.get('exclude'), cfg.get('maxFiles')))
          .filter(s => s.path.startsWith(repoPrefix))
          .map(s => ({ path: wsPrefix + s.path.slice(repoPrefix.length), text: s.text }));
      const [beforeSrc, afterSrc] = await Promise.all([load('HEAD'), load(git.WORKTREE)]);
      const cache = new Map();
      const before = buildGraph(beforeSrc, cache);
      const after = buildGraph(afterSrc, cache);
      if (!before.nodes.some(n => n.id === m.id)) throw new Error('It is not in the last commit, so there is no earlier prediction to check.');
      const result = checkPrediction(new GraphTools(before), diffGraphs(before, after), m.id, m.changeType);
      this.post({ ...reply, ...result, base: 'HEAD' });
    } catch (err) {
      this.post({ ...reply, error: (err && err.message) || String(err) });
    }
  }

  // ---- AI node summaries (cached per workspace until the code changes) ------------

  /** Replies to the webview's getSummary {id, refresh} with a summary of that node. */
  async getSummary(m) {
    const reply = { type: 'summary', id: m.id };
    if (vscode.workspace.getConfiguration('codeGraph').get('aiSummaries') === false) return this.post({ ...reply, disabled: true });
    const tools = this.graphTools();
    if (!tools) return this.post({ ...reply, disabled: true });
    const node = tools.nodes.get(m.id);
    const key = contentKey(tools, node);
    if (!key) return this.post({ ...reply, disabled: true });
    const state = this.context.workspaceState;
    const hit = state && (state.get(SUMMARY_KEY) || {})[m.id];
    if (hit && hit.key === key && !m.refresh) return this.post({ ...reply, summary: hit.summary, model: hit.model, cached: true });

    const model = await selectModel();
    if (!model) return this.post({ ...reply, unavailable: true });
    // Only the latest request runs; the webview asks again for a cancelled one when needed.
    if (this.summaryCancel) this.summaryCancel.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.summaryCancel = cts;
    try {
      const summary = await summarize(tools, node, prompt => streamText(model, prompt, cts.token, () => {}));
      if (cts.token.isCancellationRequested) return this.post({ ...reply, cancelled: true });
      const name = model.name || model.family;
      if (state) {
        const cache = { ...(state.get(SUMMARY_KEY) || {}), [m.id]: { key, summary, model: name, time: Date.now() } };
        const ids = Object.keys(cache);
        if (ids.length > SUMMARY_MAX) ids.sort((a, b) => cache[a].time - cache[b].time).slice(0, ids.length - SUMMARY_MAX).forEach(id => delete cache[id]);
        await state.update(SUMMARY_KEY, cache);
      }
      this.post({ ...reply, summary, model: name });
    } catch (err) {
      this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, error: (err && err.message) || String(err) });
    } finally {
      if (this.summaryCancel === cts) this.summaryCancel = null;
      cts.dispose();
    }
  }

  // ---- AI history (per workspace) -------------------------------------------------

  history() {
    const state = this.context.workspaceState;
    return (state && state.get(HISTORY_KEY)) || [];
  }

  async saveHistory(entries) {
    const state = this.context.workspaceState;
    entries = entries.slice(0, HISTORY_MAX);
    if (state) await state.update(HISTORY_KEY, entries);
    this.postHistory(entries);
  }

  postHistory(entries) {
    this.post({ type: 'aiHistory', entries: entries || this.history() });
  }

  historyEntry(question, mode, result, steps) {
    return {
      id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      time: Date.now(),
      question,
      mode: mode || 'ask',
      answer: result.answer,
      highlight: result.highlight || [],
      path: result.path || [],
      hops: result.hops,
      routes: result.routes,
      evidence: result.evidence,
      confidence: result.confidence,
      confidenceReason: result.confidenceReason,
      model: result.model,
      // Enough of each step to show the timeline and re-highlight its nodes.
      steps: steps.map(s => ({ tool: s.tool, summary: s.summary, note: s.note, nodeIds: (s.nodeIds || []).slice(0, HISTORY_STEP_NODES) }))
    };
  }

  // ---- HTML ----------------------------------------------------------------------

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dist', 'graph.js'));
    const highlightJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'highlight.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Code Graph</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${highlightJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function cancelledResult() {
  return { type: 'aiResult', answer: '_Cancelled._', highlight: [], path: [], cancelled: true };
}

function activate(context) {
  const index = new WorkspaceIndex();
  const panel = new GraphPanel(context, index);

  context.subscriptions.push(
    vscode.commands.registerCommand('codeGraph.open', () => {
      panel.show();
    }),
    vscode.commands.registerCommand('codeGraph.refresh', async () => {
      panel.show();
      await panel.refreshWorkspace();
    }),
    vscode.commands.registerCommand('codeGraph.revealInGraph', () => panel.revealAtCursor().catch(err => panel.error(err))),
    vscode.commands.registerCommand('codeGraph.buildSemantic', () => panel.buildSemantic().catch(err => panel.error(err))),
    vscode.commands.registerCommand('codeGraph.ask', async () => {
      const q = await vscode.window.showInputBox({ title: 'Code Graph: ask about the code', placeHolder: 'e.g. What happens when a shape is drawn?' });
      if (q) await panel.ask(q).catch(err => panel.error(err));
    })
  );

  // Keep the graph current while editing.
  let timer = null;
  const schedule = () => {
    if (!vscode.workspace.getConfiguration('codeGraph').get('autoRefresh')) return;
    if (!panel.panel) return;
    clearTimeout(timer);
    timer = setTimeout(() => panel.refreshWorkspace(true).catch(() => {}), 800);
  };
  const isCpp = doc => doc.languageId === 'c' || doc.languageId === 'cpp' || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i.test(doc.fileName);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (isCpp(doc)) schedule();
    })
  );
  const watcher = vscode.workspace.createFileSystemWatcher(vscode.workspace.getConfiguration('codeGraph').get('include'), false, true, false);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
