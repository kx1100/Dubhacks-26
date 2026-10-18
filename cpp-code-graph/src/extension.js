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
const { predictImpact, RELATION_LABELS, CHANGE_TYPES } = require('./ai/impact');

const GIT_SCHEME = 'codegraph-git';
const MAX_SNIPPET_LINES = 200; // longest snippet sent to the webview for inline code
const DEFAULT_SNIPPET_LINES = 30; // used when a node has no known end line
const HISTORY_KEY = 'codeGraph.aiHistory';
const HISTORY_MAX = 30; // answers kept per workspace
const HISTORY_STEP_NODES = 40; // node ids kept per investigation step
const SUMMARY_KEY = 'codeGraph.aiSummaries';
const SUMMARY_MAX = 400; // node summaries kept per workspace

/** The single Code Graph webview panel. */
class GraphPanel {
  constructor(context, index) {
    this.context = context;
    this.index = index;
    this.panel = null;
    this.ready = false;
    this.pending = [];
    this.compare = null; // {root, base, target, baseLabel, targetLabel, graph}
    this.aiCancel = null;
    this.summaryCancel = null;
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
    if (this.compare) return; // the user switched to a comparison meanwhile
    this.post({ type: 'graph', mode: 'workspace', graph, title: graph.title });
    if (graph.stats.truncated) {
      this.post({ type: 'status', text: `Only the first ${graph.stats.maxFiles} files were analyzed (codeGraph.maxFiles).` });
    }
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const p of this.pending.splice(0)) this.panel.webview.postMessage(p);
        if (this.compare) this.post({ type: 'graph', mode: 'diff', graph: this.compare.graph, title: this.compare.title });
        else if (this.index.graph) this.post({ type: 'graph', mode: 'workspace', graph: this.index.graph, title: this.index.graph.title });
        else await this.refreshWorkspace();
        this.postHistory();
        break;
      case 'open':
        await this.openSource(m);
        break;
      case 'openDiff':
        await this.openFileDiff(m.file);
        break;
      case 'getSource':
        await this.sendSource(m);
        break;
      case 'refresh':
        if (this.compare) await this.runCompare(this.compare.base, this.compare.target);
        else await this.refreshWorkspace();
        break;
      case 'compare':
        await this.pickAndCompare();
        break;
      case 'exitCompare':
        this.compare = null;
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

  uriFor(file, side) {
    if (!this.compare) return this.index.uriFor(file);
    const rev = side === 'base' ? this.compare.base : this.compare.target;
    if (rev === git.WORKTREE) return vscode.Uri.file(path.join(this.compare.root, file));
    return gitUri(this.compare.root, rev, file);
  }

  async openSource(m) {
    const uri = this.uriFor(m.file, m.side);
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
      const uri = this.uriFor(m.file, m.side);
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

  async openFileDiff(file) {
    if (!this.compare) return;
    const left = gitUri(this.compare.root, this.compare.base, file);
    const right = this.compare.target === git.WORKTREE ? vscode.Uri.file(path.join(this.compare.root, file)) : gitUri(this.compare.root, this.compare.target, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (${this.compare.baseLabel} ↔ ${this.compare.targetLabel})`, {
      viewColumn: vscode.ViewColumn.One
    });
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

  // ---- git comparison --------------------------------------------------------

  async repoRoot() {
    const folders = vscode.workspace.workspaceFolders || [];
    const editor = vscode.window.activeTextEditor;
    const candidates = [];
    if (editor && editor.document.uri.scheme === 'file') candidates.push(path.dirname(editor.document.uri.fsPath));
    for (const f of folders) candidates.push(f.uri.fsPath);
    for (const c of candidates) {
      try {
        return await git.repoRoot(c);
      } catch {
        // not a repository
      }
    }
    throw new Error('No git repository found in the workspace.');
  }

  async pickAndCompare() {
    const root = await this.repoRoot();
    const commits = await git.listCommits(root, 300);
    if (!commits.length) throw new Error('The repository has no commits.');
    const items = commits.map(c => ({ label: c.short + '  ' + c.subject, description: c.author + ', ' + c.date, rev: c.hash, short: c.short }));
    const worktree = { label: '$(edit) Working tree', description: 'current files on disk, including uncommitted changes', rev: git.WORKTREE, short: 'working tree' };

    const target = await vscode.window.showQuickPick([worktree, ...items], { title: 'Code Graph: compare — pick the NEWER version', placeHolder: 'Newer version (the graph shows this one)', matchOnDescription: true });
    if (!target) return;
    const olderItems = target.rev === git.WORKTREE ? items : items.slice(items.findIndex(i => i.rev === target.rev) + 1);
    if (!olderItems.length) throw new Error('There is no older commit to compare with.');
    const base = await vscode.window.showQuickPick(olderItems, { title: 'Code Graph: compare — pick the OLDER version', placeHolder: 'Older version (changes are shown relative to this one)', matchOnDescription: true });
    if (!base) return;
    this.show();
    await this.runCompare(base.rev, target.rev, base.short, target.short, root);
  }

  async runCompare(base, target, baseLabel, targetLabel, root) {
    root = root || (this.compare && this.compare.root) || (await this.repoRoot());
    baseLabel = baseLabel || (this.compare && this.compare.baseLabel) || base.slice(0, 7);
    targetLabel = targetLabel || (this.compare && this.compare.targetLabel) || (target === git.WORKTREE ? 'working tree' : target.slice(0, 7));
    this.post({ type: 'status', text: `Building graphs for ${baseLabel} and ${targetLabel}…`, busy: true });
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const exclude = cfg.get('exclude');
    const maxFiles = cfg.get('maxFiles');
    const [baseSrc, targetSrc] = await Promise.all([git.readRevision(root, base, exclude, maxFiles), git.readRevision(root, target, exclude, maxFiles)]);
    // Unchanged files parse identically, so share the parse cache between both builds.
    const cache = new Map();
    const baseGraph = buildGraph(baseSrc, cache);
    const targetGraph = buildGraph(targetSrc, cache);
    const graph = diffGraphs(baseGraph, targetGraph);
    const title = `${path.basename(root)}: ${baseLabel} → ${targetLabel}`;
    this.compare = { root, base, target, baseLabel, targetLabel, graph, title };
    this.post({ type: 'graph', mode: 'diff', graph, title, compare: { baseLabel, targetLabel } });
  }

  // ---- AI ----------------------------------------------------------------------

  async ask(question, focus, mode) {
    question = (question || '').trim();
    if (!question) return;
    this.show();
    const graph = this.compare ? this.compare.graph : this.index.graph || (await this.index.scan());
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

  /** Text of a file in the version the graph shows (the newer side of a comparison). */
  async readTarget(file) {
    const uri = this.uriFor(file, 'target');
    if (!uri) return null;
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  }

  /** GraphTools for the graph on screen, built once per graph. */
  graphTools() {
    const graph = this.compare ? this.compare.graph : this.index.graph;
    if (!graph) return null;
    let tools = this.toolsByGraph.get(graph);
    if (!tools) this.toolsByGraph.set(graph, (tools = new GraphTools(graph, { readSource: file => this.readTarget(file) })));
    return tools;
  }

  // ---- Change impact ------------------------------------------------------------------

  /** Replies to impact {id, changeType} with the predicted impact of changing that node. */
  sendImpact(m) {
    const tools = this.graphTools();
    const result = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
    this.post({ type: 'impactResult', id: m.id, requested: m.changeType, ...result, labels: { relations: RELATION_LABELS, changes: CHANGE_TYPES } });
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
      steps: steps.map(s => ({ tool: s.tool, summary: s.summary, note: s.note, nodeIds: (s.nodeIds || []).slice(0, HISTORY_STEP_NODES) })),
      compare: this.compare ? this.compare.title : undefined
    };
  }

  // ---- HTML ----------------------------------------------------------------------

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
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

function gitUri(root, rev, file) {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + file, query: JSON.stringify({ root, rev }) });
}

function activate(context) {
  const index = new WorkspaceIndex();
  const panel = new GraphPanel(context, index);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      async provideTextDocumentContent(uri) {
        const { root, rev } = JSON.parse(uri.query);
        try {
          return await git.showFile(root, rev, uri.path.replace(/^\//, ''));
        } catch {
          return ''; // the file does not exist at that revision
        }
      }
    }),
    vscode.commands.registerCommand('codeGraph.open', () => {
      panel.show();
    }),
    vscode.commands.registerCommand('codeGraph.refresh', async () => {
      panel.show();
      panel.compare = null;
      await panel.refreshWorkspace();
    }),
    vscode.commands.registerCommand('codeGraph.revealInGraph', () => panel.revealAtCursor().catch(err => panel.error(err))),
    vscode.commands.registerCommand('codeGraph.compareCommits', () => panel.pickAndCompare().catch(err => panel.error(err))),
    vscode.commands.registerCommand('codeGraph.ask', async () => {
      const q = await vscode.window.showInputBox({ title: 'Code Graph: ask about the code', placeHolder: 'e.g. What happens when a shape is drawn?' });
      if (q) await panel.ask(q).catch(err => panel.error(err));
    })
  );

  // Keep the graph current while editing.
  let timer = null;
  const schedule = () => {
    if (!vscode.workspace.getConfiguration('codeGraph').get('autoRefresh')) return;
    if (!panel.panel || panel.compare) return;
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
