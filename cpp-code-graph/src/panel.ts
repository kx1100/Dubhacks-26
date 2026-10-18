// src/panel.ts
// Hosts the webview (media/webview/main.js, bundled to media/dist/graph.js)
// and handles the messages defined in types.ts: source navigation, AI
// questions and their history, node summaries, change impact and the AI
// semantic layer.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { askQuestion } from './ai';
import { GraphTools } from './ai/graphTools';
import { CHANGE_TYPES, predictImpact, RELATION_LABELS } from './ai/impact';
import { selectModel, streamText } from './ai/model';
import { buildSemanticLayer, currentLayer } from './ai/semantic';
import { contentKey, summarize } from './ai/summaries';
import { nodeAt } from './graph/builder';
import type { AiAnswer, AiHistoryEntry, AskMode, FromWebviewMessage, GraphData, NodeSummary, ToWebviewMessage } from './types';
import type { WorkspaceIndex } from './workspaceIndex';

/** Longest snippet sent for a code card; longer ranges are cut and marked `truncated`. */
const MAX_SNIPPET_LINES = 200;
/** Used when a node has no known end line. */
const DEFAULT_SNIPPET_LINES = 30;
const HISTORY_KEY = 'codeGraph.aiHistory';
/** Answers kept per workspace */
const HISTORY_MAX = 30;
/** Node ids kept per investigation step */
const HISTORY_STEP_NODES = 40;
const SUMMARY_KEY = 'codeGraph.aiSummaries';
/** Node summaries kept per workspace */
const SUMMARY_MAX = 400;
const SEMANTIC_KEY = 'codeGraph.semanticLayer';
const NO_MODEL = 'No language model is available in VS Code (for example GitHub Copilot Chat).';

type Msg<T extends FromWebviewMessage['type']> = Extract<FromWebviewMessage, { type: T }>;
type SummaryCache = Record<string, { key: string; summary: NodeSummary; model: string; time: number }>;
type Tools = InstanceType<typeof GraphTools>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class GraphPanel {
    panel: vscode.WebviewPanel | undefined;
    /** Messages wait here until the webview reports `ready`. */
    private queue: ToWebviewMessage[] = [];
    private ready = false;
    private aiCancel: vscode.CancellationTokenSource | undefined;
    private summaryCancel: vscode.CancellationTokenSource | undefined;
    /** GraphTools per graph, built once for summaries, impact and the semantic layer. */
    private toolsByGraph = new WeakMap<GraphData, Tools>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly index: WorkspaceIndex,
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            return;
        }
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel('codeGraph', 'Code Graph', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [media],
        });
        panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
        panel.webview.html = this.html(panel.webview, media);
        panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queue = [];
        });
        panel.webview.onDidReceiveMessage((m: FromWebviewMessage) => this.onMessage(m).catch((err) => this.error(err)));
        this.panel = panel;
        this.ready = false;
    }

    private post(message: ToWebviewMessage): void {
        if (!this.panel) {
            return;
        }
        if (this.ready) {
            void this.panel.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }

    error(err: unknown): void {
        const message = errorText(err);
        this.post({ type: 'error', message });
        void vscode.window.showErrorMessage('Code Graph: ' + message);
    }

    /** Rescan the workspace and send the graph. `silent` skips the "Scanning" status (auto-refresh). */
    async refreshWorkspace(silent = false): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (!silent) {
            this.post({ type: 'loading', message: 'Scanning C/C++ files…' });
        }
        const graph = await this.index.scan();
        this.postGraph(graph);
        if (graph.stats?.truncated) {
            void vscode.window.showWarningMessage(`Code Graph: only the first ${graph.stats.maxFiles} files were analyzed (codeGraph.maxFiles).`);
        }
    }

    private postGraph(graph: GraphData): void {
        this.post({ type: 'graph', data: this.withSemantic(graph), title: graph.title });
    }

    private async onMessage(m: FromWebviewMessage): Promise<void> {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                for (const queued of this.queue.splice(0)) {
                    void this.panel?.webview.postMessage(queued);
                }
                if (this.index.graph) {
                    this.postGraph(this.index.graph);
                } else {
                    await this.refreshWorkspace();
                }
                this.postHistory();
                break;
            case 'openLocation':
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
            case 'buildSemantic':
                await this.buildSemantic();
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

    /** Open a workspace-relative file at a 1-based line, beside the graph. */
    private async openSource(m: Msg<'openLocation'>): Promise<void> {
        const uri = this.index.uriFor(m.file);
        if (!uri) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(Math.min(Math.max(0, (m.line || 1) - 1), doc.lineCount - 1), 0);
        await vscode.window.showTextDocument(doc, {
            // Keep the graph visible: open the code in the other editor group.
            viewColumn: this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
            selection: new vscode.Range(pos, pos),
            preserveFocus: !!m.preserveFocus,
        });
    }

    /** Replies to getSource with the lines [start, end] of a file. An open editor's unsaved text wins. */
    private async sendSource(m: Msg<'getSource'>): Promise<void> {
        const reply = { type: 'source', reqId: m.reqId } as const;
        try {
            const uri = this.index.uriFor(m.file);
            if (!uri) {
                throw new Error('Source is not available.');
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const first = Math.min(Math.max(1, m.start | 0 || 1), Math.max(1, doc.lineCount));
            const wanted = Math.max(first, m.end | 0 || first + DEFAULT_SNIPPET_LINES - 1);
            const last = Math.min(doc.lineCount, wanted, first + MAX_SNIPPET_LINES - 1);
            const lines: string[] = [];
            for (let i = first; i <= last; i++) {
                lines.push(doc.lineAt(i - 1).text);
            }
            this.post({ ...reply, startLine: first, lines, truncated: wanted > last });
        } catch (err) {
            this.post({ ...reply, error: errorText(err) });
        }
    }

    /** Open the graph focused on the symbol at the editor's cursor. */
    async revealAtCursor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        this.show();
        if (!this.index.graph) {
            await this.refreshWorkspace();
        }
        if (!editor || !this.index.graph) {
            return;
        }
        const file = this.index.relPathOf(editor.document.uri);
        const node = nodeAt(this.index.graph, file, editor.selection.active.line + 1);
        if (node) {
            this.post({ type: 'focus', nodeId: node.id });
        } else {
            void vscode.window.showInformationMessage(`Code Graph: ${file} is not part of the graph.`);
        }
    }

    // ---- AI questions ------------------------------------------------------------

    async ask(question: string, focus?: string, mode?: AskMode): Promise<void> {
        question = (question || '').trim();
        if (!question) {
            return;
        }
        this.show();
        const graph = this.withSemantic(this.index.graph ?? (await this.index.scan()));
        this.aiCancel?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.aiCancel = cts;
        this.post({ type: 'aiStart', question });
        const steps: any[] = [];
        try {
            const result: AiAnswer = await askQuestion(graph, question, {
                focusId: focus,
                mode,
                readSource: (file: string) => this.readTarget(file),
                token: cts.token,
                onText: (text: string) => this.post({ type: 'aiPartial', text }),
                onStep: (step: any) => {
                    steps.push(step);
                    if (!cts.token.isCancellationRequested) {
                        this.post({ type: 'aiStep', step });
                    }
                },
            });
            if (!cts.token.isCancellationRequested) {
                const entry = historyEntry(question, mode, result, steps);
                this.post({ type: 'aiResult', ...result, entryId: entry.id, time: entry.time });
                await this.saveHistory([entry, ...this.history()]);
            } else if (this.aiCancel === cts) {
                this.post(cancelledResult());
            }
        } catch (err) {
            // A question replaced by a newer one reports nothing, so it can't overwrite the newer answer.
            if (cts.token.isCancellationRequested) {
                if (this.aiCancel === cts) {
                    this.post(cancelledResult());
                }
            } else {
                this.post({ type: 'aiResult', answer: 'Error: ' + errorText(err), highlight: [], path: [], error: true });
            }
        } finally {
            if (this.aiCancel === cts) {
                this.aiCancel = undefined;
            }
            cts.dispose();
        }
    }

    /** Text of a file in the workspace. */
    private async readTarget(file: string): Promise<string | null> {
        const uri = this.index.uriFor(file);
        if (!uri) {
            return null;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        return doc.getText();
    }

    /** GraphTools for the graph on screen, built once per graph. */
    private graphTools(): Tools | undefined {
        const graph = this.index.graph;
        if (!graph) {
            return undefined;
        }
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
    private withSemantic(graph: GraphData): GraphData {
        const state = this.context.workspaceState?.get<any>(SEMANTIC_KEY);
        if (!state || !graph || graph !== this.index.graph) {
            return graph;
        }
        const layer = currentLayer(this.graphTools(), state);
        return {
            ...graph,
            edges: graph.edges.concat(layer.edges),
            concepts: layer.concepts,
            semantic: {
                model: state.model,
                time: state.time,
                edges: layer.edges.length,
                concepts: new Set(Object.values(layer.concepts as Record<string, string[]>).flat()).size,
                tagged: Object.keys(layer.concepts).length,
            },
        };
    }

    /** Builds or updates the semantic layer for the workspace, with a cancellable progress notification. */
    async buildSemantic(): Promise<void> {
        this.show();
        if (!this.index.graph) {
            await this.refreshWorkspace();
        }
        const model = await selectModel();
        if (!model) {
            throw new Error(NO_MODEL);
        }
        const tools = this.graphTools();
        const state = this.context.workspaceState;
        const prev = state?.get<any>(SEMANTIC_KEY);
        const name = model.name || model.family;
        this.post({ type: 'semanticBuilding', busy: true });
        let result;
        try {
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Code Graph: tagging concepts', cancellable: true },
                async (progress, token) => {
                    let reported = 0;
                    return buildSemanticLayer(tools, prev, (prompt: string) => streamText(model, prompt, token, () => {}), {
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
        await state?.update(SEMANTIC_KEY, result.state);
        const graph = this.withSemantic(this.index.graph!);
        this.post({ type: 'graph', data: graph, title: graph.title });
        // buildSemanticLayer adds `error` when the model fails part way.
        const s: typeof result.stats & { error?: string } = result.stats;
        const concepts = graph.semantic?.concepts ?? 0;
        let msg = `Code Graph: ${concepts} concept${concepts === 1 ? '' : 's'} tagged.`;
        if (s.error) {
            msg += ` It stopped early (${s.error}); run it again to continue.`;
        } else if (s.cancelled || s.filesLeft) {
            msg += ` ${s.filesLeft} file${s.filesLeft === 1 ? '' : 's'} still to tag; run it again to continue.`;
        }
        void vscode.window.showInformationMessage(msg);
    }

    // ---- Change impact ------------------------------------------------------------------

    /** Replies to impact {id, changeType} with the predicted impact of changing that node. */
    private sendImpact(m: Msg<'impact'>): void {
        const tools = this.graphTools();
        const result = tools ? predictImpact(tools, m.id, m.changeType) : { error: 'The graph is not ready yet.' };
        this.post({ type: 'impactResult', id: m.id, requested: m.changeType, ...result, labels: { relations: RELATION_LABELS, changes: CHANGE_TYPES } });
    }

    // ---- AI node summaries (cached per workspace until the code changes) ------------

    /** Replies to getSummary {id, refresh} with a summary of that node. */
    private async getSummary(m: Msg<'getSummary'>): Promise<void> {
        const reply = { type: 'summary', id: m.id } as const;
        if (vscode.workspace.getConfiguration('codeGraph').get('aiSummaries') === false) {
            return this.post({ ...reply, disabled: true });
        }
        const tools = this.graphTools();
        if (!tools) {
            return this.post({ ...reply, disabled: true });
        }
        const node = tools.nodes.get(m.id);
        const key = contentKey(tools, node);
        if (!key) {
            return this.post({ ...reply, disabled: true });
        }
        const state = this.context.workspaceState;
        const hit = state?.get<SummaryCache>(SUMMARY_KEY)?.[m.id];
        if (hit && hit.key === key && !m.refresh) {
            return this.post({ ...reply, summary: hit.summary, model: hit.model, cached: true });
        }

        const model = await selectModel();
        if (!model) {
            return this.post({ ...reply, unavailable: true });
        }
        // Only the latest request runs; the webview asks again for a cancelled one when needed.
        this.summaryCancel?.cancel();
        const cts = new vscode.CancellationTokenSource();
        this.summaryCancel = cts;
        try {
            const summary: NodeSummary = await summarize(tools, node, (prompt: string) => streamText(model, prompt, cts.token, () => {}));
            if (cts.token.isCancellationRequested) {
                return this.post({ ...reply, cancelled: true });
            }
            const name = model.name || model.family;
            if (state) {
                const cache: SummaryCache = { ...state.get<SummaryCache>(SUMMARY_KEY), [m.id]: { key, summary, model: name, time: Date.now() } };
                const ids = Object.keys(cache);
                if (ids.length > SUMMARY_MAX) {
                    ids.sort((a, b) => cache[a].time - cache[b].time)
                        .slice(0, ids.length - SUMMARY_MAX)
                        .forEach((id) => delete cache[id]);
                }
                await state.update(SUMMARY_KEY, cache);
            }
            this.post({ ...reply, summary, model: name });
        } catch (err) {
            this.post(cts.token.isCancellationRequested ? { ...reply, cancelled: true } : { ...reply, error: errorText(err) });
        } finally {
            if (this.summaryCancel === cts) {
                this.summaryCancel = undefined;
            }
            cts.dispose();
        }
    }

    // ---- AI history (per workspace) -------------------------------------------------

    private history(): AiHistoryEntry[] {
        return this.context.workspaceState?.get<AiHistoryEntry[]>(HISTORY_KEY) ?? [];
    }

    private async saveHistory(entries: AiHistoryEntry[]): Promise<void> {
        entries = entries.slice(0, HISTORY_MAX);
        await this.context.workspaceState?.update(HISTORY_KEY, entries);
        this.postHistory(entries);
    }

    private postHistory(entries?: AiHistoryEntry[]): void {
        this.post({ type: 'aiHistory', entries: entries ?? this.history() });
    }

    // ---- HTML ----------------------------------------------------------------------

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dist', 'graph.js'));
        const highlightJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'highlight.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
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

function historyEntry(question: string, mode: AskMode | undefined, result: AiAnswer, steps: any[]): AiHistoryEntry {
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
    };
}

function cancelledResult(): ToWebviewMessage {
    return { type: 'aiResult', answer: '_Cancelled._', highlight: [], path: [], cancelled: true };
}
