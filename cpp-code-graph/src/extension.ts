// src/extension.ts

// Registers every command in package.json and hosts the webview (media/main.js,
// bundled to out/webview.js). Based on the ask-ai branch's extension.js: the
// graph comes from the tree-sitter parser (workspaceIndex, graph/builder), and
// git comparison and Ask AI use the ask-ai modules (git.js, graph/diff.js, ai/)
// unchanged, since the graph has the shape they expect (see types.ts).

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceIndex, nodeAt } from './workspaceIndex';
import { buildGraph } from './graph/builder';
import { diffGraphs } from './graph/diff';
import * as git from './git';
import { askQuestion } from './ai';
import { selectModel, streamText } from './ai/model';
import { GraphTools } from './ai/graphTools';
import { contentKey, summarize } from './ai/summaries';
import { predictImpact, checkPrediction, RELATION_LABELS, CHANGE_TYPES } from './ai/impact';
import { checkWithModel } from './ai/impactCheck';
import { buildSemanticLayer, currentLayer } from './ai/semantic';
import { formatParsedFile, hasCppFiles, initParsers, languageFor, parseSource, SOURCE_FILE, type ParsedFile } from './parser';
import type { GraphData } from './types';

const GIT_SCHEME = 'codegraph-git';
const MAX_SNIPPET_LINES = 200; // longest snippet sent to the webview for inline code
const DEFAULT_SNIPPET_LINES = 30; // used when a node has no known end line
const HISTORY_KEY = 'codeGraph.aiHistory';
const HISTORY_MAX = 30; // answers kept per workspace
const HISTORY_STEP_NODES = 40; // node ids kept per investigation step
const SUMMARY_KEY = 'codeGraph.aiSummaries';
const SUMMARY_MAX = 400; // node summaries kept per workspace
const SEMANTIC_KEY = 'codeGraph.semanticLayer';


/** The graph on screen; the semantic layer and diff.js add fields (concepts, status). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Graph = GraphData & Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = { type: string; [key: string]: any };

interface Compare {
    root: string;
    base: string;
    target: string;
    baseLabel: string;
    targetLabel: string;
    graph: Graph;
    title: string;
}

interface HistoryEntry {
    id: string;
    time: number;
    [key: string]: unknown;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The single Code Graph webview panel. */
class GraphPanel {
    panel: vscode.WebviewPanel | null = null;
    compare: Compare | null = null;
    private ready = false;
    private pending: Message[] = [];
    private aiCancel: vscode.CancellationTokenSource | null = null;
    private summaryCancel: vscode.CancellationTokenSource | null = null;
    private impactCancel: vscode.CancellationTokenSource | null = null;
    private toolsByGraph = new WeakMap<object, InstanceType<typeof GraphTools>>(); // graph -> GraphTools, for summaries

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly index: WorkspaceIndex,
        private readonly output: vscode.OutputChannel,
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            return;
        }
        const ext = this.context.extensionUri;
        this.panel = vscode.window.createWebviewPanel('codeGraph', 'Code Graph', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(ext, 'out'), vscode.Uri.joinPath(ext, 'media')],
        });
        this.panel.iconPath = vscode.Uri.joinPath(ext, 'media', 'icon.svg');
        this.ready = false;
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.panel = null;
            this.ready = false;
            this.pending = [];
        });
        this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((err) => this.error(err)));
    }

    post(msg: Message): void {
        if (!this.panel) return;
        if (!this.ready) this.pending.push(msg);
        else void this.panel.webview.postMessage(msg);
    }

    error(err: unknown): void {
        const msg = errorText(err);
        this.output.appendLine(`Error: ${msg}`);
        this.post({ type: 'status', text: msg, error: true });
        void vscode.window.showErrorMessage('Code Graph: ' + msg);
    }

    async refreshWorkspace(silent?: boolean): Promise<void> {
        if (!this.panel) return;
        if (!silent) this.post({ type: 'status', text: 'Scanning C/C++ files…', busy: true });
        const started = Date.now();
        const graph = await this.index.scan();
        this.output.appendLine(
            `Graph: ${graph.stats.files} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges in ${Date.now() - started} ms`,
        );
        if (graph.stats.errors.length) {
            this.output.appendLine(`Files with syntax tree-sitter couldn't parse: ${graph.stats.errors.map((e) => e.file).join(', ')}`);
        }
        if (this.compare) return; // the user switched to a comparison meanwhile
        this.post({ type: 'graph', mode: 'workspace', graph: this.withSemantic(graph), title: graph.title });
        if (graph.stats.truncated) {
            this.post({ type: 'status', text: `Only the first ${graph.stats.maxFiles} files were analyzed (codeGraph.maxFiles).` });
        }
    }

    async onMessage(m: Message): Promise<void> {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                for (const p of this.pending.splice(0)) void this.panel?.webview.postMessage(p);
                if (this.compare) this.post({ type: 'graph', mode: 'diff', graph: this.compare.graph, title: this.compare.title });
                else if (this.index.graph) this.post({ type: 'graph', mode: 'workspace', graph: this.withSemantic(this.index.graph), title: this.index.graph.title });
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
                this.aiCancel?.cancel();
                break;
            case 'aiHistoryDelete':
                await this.saveHistory(this.history().filter((e) => e.id !== m.id));
                break;
            case 'aiHistoryClear':
                await this.saveHistory([]);
                break;
        }
    }

    // ---- source navigation ---------------------------------------------------

    uriFor(file: string, side?: string): vscode.Uri | null {
        if (!this.compare) return this.index.uriFor(file);
        const rev = side === 'base' ? this.compare.base : this.compare.target;
        if (rev === git.WORKTREE) return vscode.Uri.file(path.join(this.compare.root, file));
        return gitUri(this.compare.root, rev, file);
    }

    async openSource(m: Message): Promise<void> {
        const uri = this.uriFor(m.file, m.side);
        if (!uri) return;
        const line = Math.max(0, (m.line || 1) - 1);
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
        await vscode.window.showTextDocument(doc, {
            viewColumn: this.panel && this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
            selection: new vscode.Range(pos, pos),
            preserveFocus: !!m.preserveFocus,
        });
    }

    /** Replies to a webview `getSource` request with the lines [start, end] of a file. */
    async sendSource(m: Message): Promise<void> {
        const reply = { type: 'source', reqId: m.reqId };
        try {
            const uri = this.uriFor(m.file, m.side);
            if (!uri) throw new Error('Source is not available.');
            const doc = await vscode.workspace.openTextDocument(uri);
            const first = Math.min(Math.max(1, m.start | 0 || 1), Math.max(1, doc.lineCount));
            const wanted = Math.max(first, m.end | 0 || first + DEFAULT_SNIPPET_LINES - 1);
            const last = Math.min(doc.lineCount, wanted, first + MAX_SNIPPET_LINES - 1);
            const lines: string[] = [];
            for (let i = first; i <= last; i++) lines.push(doc.lineAt(i - 1).text);
            this.post({ ...reply, startLine: first, lines, truncated: wanted > last });
        } catch (err) {
            this.post({ ...reply, error: errorText(err) });
        }
    }

    async openFileDiff(file: string): Promise<void> {
        if (!this.compare) return;
        const left = gitUri(this.compare.root, this.compare.base, file);
        const right =
            this.compare.target === git.WORKTREE
                ? vscode.Uri.file(path.join(this.compare.root, file))
                : gitUri(this.compare.root, this.compare.target, file);
        await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            right,
            `${path.basename(file)} (${this.compare.baseLabel} ↔ ${this.compare.targetLabel})`,
            { viewColumn: vscode.ViewColumn.One },
        );
    }

    async revealAtCursor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        this.show();
        if (!this.index.graph) await this.refreshWorkspace();
        if (!editor || !this.index.graph) return;
        const rel = this.index.relPathOf(editor.document.uri);
        const node = nodeAt(this.index.graph, rel, editor.selection.active.line + 1);
        if (node) this.post({ type: 'reveal', id: node.id });
    }

    // ---- git comparison --------------------------------------------------------

    async repoRoot(): Promise<string> {
        const folders = vscode.workspace.workspaceFolders || [];
        const editor = vscode.window.activeTextEditor;
        const candidates: string[] = [];
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

    async pickAndCompare(): Promise<void> {
        const root = await this.repoRoot();
        const commits: Array<{ hash: string; short: string; subject: string; author: string; date: string }> = await git.listCommits(root, 300);
        if (!commits.length) throw new Error('The repository has no commits.');
        const items = commits.map((c) => ({ label: c.short + '  ' + c.subject, description: c.author + ', ' + c.date, rev: c.hash, short: c.short }));
        const worktree = {
            label: '$(edit) Working tree',
            description: 'current files on disk, including uncommitted changes',
            rev: git.WORKTREE as string,
            short: 'working tree',
        };

        const target = await vscode.window.showQuickPick([worktree, ...items], {
            title: 'Code Graph: compare — pick the NEWER version',
            placeHolder: 'Newer version (the graph shows this one)',
            matchOnDescription: true,
        });
        if (!target) return;
        const olderItems = target.rev === git.WORKTREE ? items : items.slice(items.findIndex((i) => i.rev === target.rev) + 1);
        if (!olderItems.length) throw new Error('There is no older commit to compare with.');
        const base = await vscode.window.showQuickPick(olderItems, {
            title: 'Code Graph: compare — pick the OLDER version',
            placeHolder: 'Older version (changes are shown relative to this one)',
            matchOnDescription: true,
        });
        if (!base) return;
        this.show();
        await this.runCompare(base.rev, target.rev, base.short, target.short, root);
    }

    async runCompare(base: string, target: string, baseLabel?: string, targetLabel?: string, root?: string): Promise<void> {
        root = root || this.compare?.root || (await this.repoRoot());
        baseLabel = baseLabel || this.compare?.baseLabel || base.slice(0, 7);
        targetLabel = targetLabel || this.compare?.targetLabel || (target === git.WORKTREE ? 'working tree' : target.slice(0, 7));
        this.post({ type: 'status', text: `Building graphs for ${baseLabel} and ${targetLabel}…`, busy: true });
        const cfg = vscode.workspace.getConfiguration('codeGraph');
        const exclude = cfg.get<string>('exclude');
        const maxFiles = cfg.get<number>('maxFiles');
        const [baseSrc, targetSrc] = await Promise.all([
            git.readRevision(root, base, exclude, maxFiles),
            git.readRevision(root, target, exclude, maxFiles),
        ]);
        await this.index.ready();
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

    async ask(question: string, focus?: string, mode?: 'ask' | 'path'): Promise<void> {
        question = (question || '').trim();
        if (!question) return;
        this.show();
        const graph = this.compare ? this.compare.graph : this.withSemantic(this.index.graph || (await this.index.scan()));
        this.aiCancel?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.aiCancel = cts;
        this.post({ type: 'aiStart', question });
        const readSource = (file: string) => this.readTarget(file);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const steps: any[] = [];
        try {
            const result = await askQuestion(graph, question, {
                focusId: focus,
                mode,
                readSource,
                token: cts.token,
                onText: (text: string) => this.post({ type: 'aiPartial', text }),
                onStep: (step: unknown) => {
                    steps.push(step);
                    if (!cts.token.isCancellationRequested) this.post({ type: 'aiStep', step });
                },
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
            } else this.post({ type: 'aiResult', answer: 'Error: ' + errorText(err), highlight: [], path: [], error: true });
        } finally {
            if (this.aiCancel === cts) this.aiCancel = null;
            cts.dispose();
        }
    }

    /** Text of a file in the version the graph shows (the newer side of a comparison). */
    async readTarget(file: string): Promise<string | null> {
        const uri = this.uriFor(file, 'target');
        if (!uri) return null;
        const doc = await vscode.workspace.openTextDocument(uri);
        return doc.getText();
    }

    /** GraphTools for the graph on screen, built once per graph. */
    graphTools(): InstanceType<typeof GraphTools> | null {
        const graph = this.compare ? this.compare.graph : this.index.graph;
        if (!graph) return null;
        let tools = this.toolsByGraph.get(graph);
        if (!tools) {
            tools = new GraphTools(graph, { readSource: (file: string) => this.readTarget(file) });
            this.toolsByGraph.set(graph, tools);
        }
        return tools;
    }

    // ---- Semantic layer (AI concepts and inferred relationships) -----------------------

    /**
     * The workspace graph plus the saved semantic layer, keeping only the parts
     * whose code has not changed since they were built. The graph itself is not
     * modified: impact and summaries work on the code's own relationships.
     */
    withSemantic(graph: Graph): Graph {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = this.context.workspaceState.get<any>(SEMANTIC_KEY);
        if (!state || !graph || graph !== this.index.graph) return graph;
        const layer = currentLayer(this.graphTools(), state);
        return {
            ...graph,
            edges: graph.edges.concat(layer.edges),
            concepts: layer.concepts,
            semantic: {
                model: state.model,
                time: state.time,
                edges: layer.edges.length,
                concepts: new Set(Object.values(layer.concepts).flat()).size,
                tagged: Object.keys(layer.concepts).length,
            },
        };
    }

    /** Builds or updates the semantic layer for the workspace, with a cancellable progress notification. */
    async buildSemantic(): Promise<unknown> {
        this.show();
        if (this.compare) throw new Error('Leave the commit comparison first: the AI layer describes the current code.');
        if (!this.index.graph) await this.refreshWorkspace();
        const model = await selectModel();
        if (!model) throw new Error('No language model is available in VS Code (for example GitHub Copilot Chat).');
        const tools = this.graphTools();
        const state = this.context.workspaceState;
        const prev = state.get<object>(SEMANTIC_KEY) ?? null;
        const name = model.name || model.family;
        this.post({ type: 'semanticBuilding', busy: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result: any;
        try {
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Code Graph: building the AI layer', cancellable: true },
                async (progress, token) => {
                    let reported = 0;
                    return buildSemanticLayer(tools, prev, (prompt: unknown) => streamText(model, prompt, token, () => {}), {
                        model: name,
                        isCancelled: () => token.isCancellationRequested,
                        onProgress: (message: string, done: number, total: number) => {
                            const pct = total ? (100 * done) / total : 100;
                            progress.report({ message, increment: pct - reported });
                            reported = pct;
                        },
                    });
                },
            );
        } finally {
            this.post({ type: 'semanticBuilding', busy: false });
        }
        await state.update(SEMANTIC_KEY, result.state);
        const graph = this.withSemantic(this.index.graph!);
        this.post({ type: 'graph', mode: 'workspace', graph, title: graph.title });
        const s = result.stats;
        const info = graph.semantic || { concepts: 0, edges: 0 };
        let msg = `Code Graph: the AI layer has ${info.concepts} concept${info.concepts === 1 ? '' : 's'} and ${info.edges} inferred link${info.edges === 1 ? '' : 's'}.`;
        if (s.error) msg += ` It stopped early (${s.error}); run it again to continue.`;
        else if (s.cancelled || s.filesLeft) msg += ` ${s.filesLeft} file${s.filesLeft === 1 ? '' : 's'} still to tag; run it again to continue.`;
        void vscode.window.showInformationMessage(msg);
        return result;
    }

    // ---- Change impact ------------------------------------------------------------------

    /** Replies to impact {id, changeType} with the predicted impact of changing that node. */
    sendImpact(m: Message): void {
        const tools = this.graphTools();
        const result = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
        this.post({ type: 'impactResult', id: m.id, requested: m.changeType, ...result, labels: { relations: RELATION_LABELS, changes: CHANGE_TYPES } });
    }

    /** Replies to impactAI {id, changeType, description}: the model checks the riskiest places. */
    async impactAI(m: Message): Promise<void> {
        const reply = { type: 'impactAIResult', id: m.id, requested: m.changeType };
        const tools = this.graphTools();
        const impact = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
        if (impact.error) return this.post({ ...reply, error: impact.error });
        const model = await selectModel();
        if (!model) return this.post({ ...reply, error: 'No language model is available in VS Code (for example GitHub Copilot Chat).' });
        this.impactCancel?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.impactCancel = cts;
        try {
            const description = String(m.description || '').trim().slice(0, 500);
            const result = await checkWithModel(tools, impact, description, (prompt: unknown) => streamText(model, prompt, cts.token, () => {}));
            this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, ...result, model: model.name || model.family });
        } catch (err) {
            this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, error: errorText(err) });
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
    async impactCheck(m: Message): Promise<void> {
        const reply = { type: 'impactCheckResult', id: m.id, requested: m.changeType };
        try {
            const folders = vscode.workspace.workspaceFolders || [];
            const graph = this.index.graph;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const node = graph && graph.nodes.find((n: any) => n.id === m.id);
            const file: string = node ? node.defFile || node.file || '' : '';
            const multiRoot = folders.length > 1;
            const folder = multiRoot ? folders.find((f) => file.startsWith(f.name + '/')) || folders[0] : folders[0];
            if (!folder) throw new Error('Open a folder to compare with git.');
            const root = await git.repoRoot(folder.uri.fsPath);
            const rel = path.relative(root, folder.uri.fsPath).split(path.sep).join('/');
            if (rel.startsWith('..')) throw new Error('The workspace folder is not inside its git repository.');
            const repoPrefix = rel ? rel + '/' : '';
            const wsPrefix = multiRoot ? folder.name + '/' : '';
            const cfg = vscode.workspace.getConfiguration('codeGraph');
            const load = async (rev: string) =>
                ((await git.readRevision(root, rev, cfg.get('exclude'), cfg.get('maxFiles'))) as Array<{ path: string; text: string }>)
                    .filter((s) => s.path.startsWith(repoPrefix))
                    .map((s) => ({ path: wsPrefix + s.path.slice(repoPrefix.length), text: s.text }));
            const [beforeSrc, afterSrc] = await Promise.all([load('HEAD'), load(git.WORKTREE)]);
            await this.index.ready();
            const cache = new Map();
            const before = buildGraph(beforeSrc, cache);
            const after = buildGraph(afterSrc, cache);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!before.nodes.some((n: any) => n.id === m.id)) throw new Error('It is not in the last commit, so there is no earlier prediction to check.');
            const result = checkPrediction(new GraphTools(before), diffGraphs(before, after), m.id, m.changeType);
            this.post({ ...reply, ...result, base: 'HEAD' });
        } catch (err) {
            this.post({ ...reply, error: errorText(err) });
        }
    }

    // ---- AI node summaries (cached per workspace until the code changes) ------------

    /** Replies to the webview's getSummary {id, refresh} with a summary of that node. */
    async getSummary(m: Message): Promise<void> {
        const reply = { type: 'summary', id: m.id };
        if (vscode.workspace.getConfiguration('codeGraph').get('aiSummaries') === false) return this.post({ ...reply, disabled: true });
        const tools = this.graphTools();
        if (!tools) return this.post({ ...reply, disabled: true });
        const node = tools.nodes.get(m.id);
        const key = contentKey(tools, node);
        if (!key) return this.post({ ...reply, disabled: true });
        const state = this.context.workspaceState;
        type Summaries = Record<string, { key: string; summary: string; model: string; time: number }>;
        const hit = (state.get<Summaries>(SUMMARY_KEY) || {})[m.id];
        if (hit && hit.key === key && !m.refresh) return this.post({ ...reply, summary: hit.summary, model: hit.model, cached: true });

        const model = await selectModel();
        if (!model) return this.post({ ...reply, unavailable: true });
        // Only the latest request runs; the webview asks again for a cancelled one when needed.
        this.summaryCancel?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.summaryCancel = cts;
        try {
            const summary = await summarize(tools, node, (prompt: unknown) => streamText(model, prompt, cts.token, () => {}));
            if (cts.token.isCancellationRequested) return this.post({ ...reply, cancelled: true });
            const name = model.name || model.family;
            const cache: Summaries = { ...(state.get<Summaries>(SUMMARY_KEY) || {}), [m.id]: { key, summary, model: name, time: Date.now() } };
            const ids = Object.keys(cache);
            if (ids.length > SUMMARY_MAX) {
                ids.sort((a, b) => cache[a].time - cache[b].time)
                    .slice(0, ids.length - SUMMARY_MAX)
                    .forEach((id) => delete cache[id]);
            }
            await state.update(SUMMARY_KEY, cache);
            this.post({ ...reply, summary, model: name });
        } catch (err) {
            this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, error: errorText(err) });
        } finally {
            if (this.summaryCancel === cts) this.summaryCancel = null;
            cts.dispose();
        }
    }

    // ---- AI history (per workspace) -------------------------------------------------

    history(): HistoryEntry[] {
        return this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY) || [];
    }

    async saveHistory(entries: HistoryEntry[]): Promise<void> {
        entries = entries.slice(0, HISTORY_MAX);
        await this.context.workspaceState.update(HISTORY_KEY, entries);
        this.postHistory(entries);
    }

    postHistory(entries?: HistoryEntry[]): void {
        this.post({ type: 'aiHistory', entries: entries || this.history() });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    historyEntry(question: string, mode: string | undefined, result: any, steps: any[]): HistoryEntry {
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
            steps: steps.map((s) => ({ tool: s.tool, summary: s.summary, note: s.note, nodeIds: (s.nodeIds || []).slice(0, HISTORY_STEP_NODES) })),
            compare: this.compare ? this.compare.title : undefined,
        };
    }

    // ---- HTML ----------------------------------------------------------------------

    /** The Cytoscape webview: media/main.js bundled to out/webview.js (highlight.js is bundled in). */
    html(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const ext = this.context.extensionUri;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'out', 'webview.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'style.css'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            // Cytoscape sets a few inline styles on its container.
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Code Graph</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

function cancelledResult(): Message {
    return { type: 'aiResult', answer: '_Cancelled._', highlight: [], path: [], cancelled: true };
}

function gitUri(root: string, rev: string, file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + file, query: JSON.stringify({ root, rev }) });
}

// ---- parser debug dump --------------------------------------------------------------

async function readText(uri: vscode.Uri): Promise<string> {
    // Unsaved editor contents win over the file on disk.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

/** Code Graph: Dump Parsed Symbols — what the parser extracted from every C/C++ file. */
async function dumpSymbols(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) throw new Error('Open a folder that contains C or C++ code to see its graph.');
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const include = cfg.get<string>('include') || '**/*.{c,h}';
    const exclude = cfg.get<string>('exclude') || null;
    const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, include), exclude, maxFiles);
    const files = uris
        .map((uri) => ({ uri, relPath: path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join('/') }))
        .filter((f) => SOURCE_FILE.test(f.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
    await initParsers(context);
    const hasCpp = hasCppFiles(files.map((f) => f.relPath));
    const parsed: ParsedFile[] = [];
    for (const f of files) {
        try {
            parsed.push(parseSource(f.relPath, await readText(f.uri), languageFor(f.relPath, hasCpp)));
        } catch (err) {
            output.appendLine(`Skipped ${f.relPath}: ${errorText(err)}`);
        }
    }
    output.show(true);
    output.appendLine(`--- Parsed symbols (${parsed.length} files) ---`);
    for (const p of parsed) output.appendLine(formatParsedFile(p));
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Code Graph');
    const index = new WorkspaceIndex(context);
    const panel = new GraphPanel(context, index, output);

    const run = (fn: () => Promise<unknown>) => () => fn().catch((err) => panel.error(err));

    context.subscriptions.push(
        output,
        vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
            async provideTextDocumentContent(uri) {
                const { root, rev } = JSON.parse(uri.query);
                try {
                    return await git.showFile(root, rev, uri.path.replace(/^\//, ''));
                } catch {
                    return ''; // the file does not exist at that revision
                }
            },
        }),
        vscode.commands.registerCommand('codeGraph.open', () => panel.show()),
        vscode.commands.registerCommand(
            'codeGraph.refresh',
            run(async () => {
                panel.show();
                panel.compare = null;
                await panel.refreshWorkspace();
            }),
        ),
        vscode.commands.registerCommand('codeGraph.revealInGraph', run(() => panel.revealAtCursor())),
        vscode.commands.registerCommand('codeGraph.compareCommits', run(() => panel.pickAndCompare())),
        vscode.commands.registerCommand('codeGraph.buildSemantic', run(() => panel.buildSemantic())),
        vscode.commands.registerCommand(
            'codeGraph.ask',
            run(async () => {
                const q = await vscode.window.showInputBox({
                    title: 'Code Graph: ask about the code',
                    placeHolder: 'e.g. What happens when a shape is drawn?',
                });
                if (q) await panel.ask(q);
            }),
        ),
        vscode.commands.registerCommand('codeGraph.dumpSymbols', run(() => dumpSymbols(context, output))),
    );

    // Keep the graph current while editing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (!vscode.workspace.getConfiguration('codeGraph').get('autoRefresh')) return;
        if (!panel.panel || panel.compare) return;
        clearTimeout(timer);
        timer = setTimeout(() => panel.refreshWorkspace(true).catch(() => {}), 800);
    };
    const isCpp = (doc: vscode.TextDocument) =>
        doc.languageId === 'c' || doc.languageId === 'cpp' || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i.test(doc.fileName);
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (isCpp(doc)) schedule();
        }),
    );
    const include = vscode.workspace.getConfiguration('codeGraph').get<string>('include') || '**/*.{c,h}';
    const watcher = vscode.workspace.createFileSystemWatcher(include, false, true, false);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) });
}

export function deactivate(): void {}