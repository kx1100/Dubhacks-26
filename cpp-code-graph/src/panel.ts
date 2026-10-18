// src/panel.ts
// Hosts the webview (media/main.js, bundled to dist/webview.js) and handles
// the messages defined in types.ts.

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { nodeAt, type BuiltGraph } from './graph';
import type { FromWebviewMessage, ToWebviewMessage } from './types';

/** Longest snippet sent for a code card; longer bodies are cut and marked `truncated`. */
const MAX_CODE_LINES = 200;

/** A graph built from one workspace folder. */
export interface LoadedGraph {
    graph: BuiltGraph;
    /** Absolute path of the workspace folder; GraphNode.file is relative to it */
    root: string;
    /** More files matched than codeGraph.maxFiles allows */
    truncated: boolean;
}

export class GraphPanel {
    private panel: vscode.WebviewPanel | undefined;
    /** Messages wait here until the webview reports `ready`. */
    private queue: ToWebviewMessage[] = [];
    private ready = false;
    private loaded: LoadedGraph | undefined;
    private loading: Promise<LoadedGraph | undefined> | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly load: () => Promise<LoadedGraph>,
        private readonly output: vscode.OutputChannel,
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, true);
            return;
        }
        const ext = this.context.extensionUri;
        const panel = vscode.window.createWebviewPanel('codeGraph', 'Code Graph', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(ext, 'dist'), vscode.Uri.joinPath(ext, 'media')],
        });
        panel.iconPath = vscode.Uri.joinPath(ext, 'media', 'icon.svg');
        panel.webview.html = this.html(panel.webview);
        panel.webview.onDidReceiveMessage((m: FromWebviewMessage) => this.onMessage(m));
        panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queue = [];
        });
        this.panel = panel;
        this.ready = false;
    }

    /** Rebuild the graph from the workspace and send it to the webview. Concurrent calls share one build. */
    refresh(): Promise<LoadedGraph | undefined> {
        if (!this.loading) {
            this.loading = this.rebuild().finally(() => {
                this.loading = undefined;
            });
        }
        return this.loading;
    }

    /** Open the graph focused on the symbol at a 0-based editor line of a document. */
    async revealAt(uri: vscode.Uri, editorLine: number): Promise<void> {
        this.show();
        const loaded = this.loaded ?? (await this.refresh());
        if (!loaded) {
            return;
        }
        const file = path.relative(loaded.root, uri.fsPath).split(path.sep).join('/');
        const node = nodeAt(loaded.graph, file, editorLine + 1);
        if (node) {
            this.post({ type: 'focus', nodeId: node.id });
        } else {
            void vscode.window.showInformationMessage(`Code Graph: ${file} is not part of the graph.`);
        }
    }

    private async rebuild(): Promise<LoadedGraph | undefined> {
        this.post({ type: 'loading', message: 'Scanning C files…' });
        try {
            const loaded = await this.load();
            this.loaded = loaded;
            this.post({ type: 'graph', data: loaded.graph.data });
            if (loaded.truncated) {
                void vscode.window.showWarningMessage('Code Graph: only the first codeGraph.maxFiles files were analyzed.');
            }
            return loaded;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`Error: ${message}`);
            this.post({ type: 'error', message });
            return undefined;
        }
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

    private onMessage(m: FromWebviewMessage): void {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                for (const queued of this.queue.splice(0)) {
                    void this.panel?.webview.postMessage(queued);
                }
                if (this.loaded) {
                    this.post({ type: 'graph', data: this.loaded.graph.data });
                } else if (!this.loading) {
                    void this.refresh();
                }
                break;
            case 'refresh':
                void this.refresh();
                break;
            case 'openLocation':
                void this.open(m.file, m.line);
                break;
            case 'ask':
                // Phase 5
                void vscode.window.showInformationMessage('Code Graph: "Ask a Question About the Code" is available soon.');
                break;
            case 'getCode':
                void this.sendCode(m.nodeId);
                break;
        }
    }

    /** Send a symbol's source lines (from its span) for the webview's code card. */
    private async sendCode(nodeId: string): Promise<void> {
        const loaded = this.loaded;
        const node = loaded?.graph.data.nodes.find((n) => n.id === nodeId);
        const span = loaded?.graph.spans.get(nodeId);
        if (!loaded || !node || !span) {
            this.post({ type: 'code', nodeId, file: node?.file ?? '', line: 1, lines: [], error: 'No source location for this node.' });
            return;
        }
        try {
            // An open editor's unsaved text wins over the file on disk.
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(loaded.root, node.file)));
            const all = doc.getText().split(/\r?\n/);
            const last = Math.min(span.endLine, span.line + MAX_CODE_LINES - 1, all.length);
            this.post({
                type: 'code',
                nodeId,
                file: node.file,
                line: span.line,
                lines: all.slice(span.line - 1, last),
                truncated: last < span.endLine,
            });
        } catch (err) {
            this.post({ type: 'code', nodeId, file: node.file, line: span.line, lines: [], error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** Open a workspace-relative file at a 1-based line. */
    private async open(file: string, line: number): Promise<void> {
        const root = this.loaded?.root;
        if (!root) {
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            await vscode.window.showTextDocument(doc, {
                // Keep the graph visible: open the code in the other editor group.
                viewColumn: this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
                selection: new vscode.Range(pos, pos),
            });
        } catch (err) {
            void vscode.window.showErrorMessage(`Code Graph: could not open ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private html(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const ext = this.context.extensionUri;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'webview.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'style.css'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            // Cytoscape sets a few inline styles on its container.
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
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
