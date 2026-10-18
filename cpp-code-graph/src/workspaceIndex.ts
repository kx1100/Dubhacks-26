// src/workspaceIndex.ts
// Phase 2 file discovery: scans the workspace for sources (codeGraph.include/
// exclude/maxFiles), builds the graph and keeps the latest one. Same surface
// as the ask-ai branch's workspaceIndex.js.

import * as vscode from 'vscode';
import { buildGraph, nodeAt, type Source } from './graph/builder';
import { initParsers, type ParsedFile } from './parser';
import type { GraphData } from './types';

export { nodeAt };

const decoder = new TextDecoder('utf-8');

export class WorkspaceIndex {
    graph: GraphData | null = null;
    private parsedCache = new Map<string, ParsedFile>();
    private uriByPath = new Map<string, vscode.Uri>();
    private scanning: Promise<GraphData> | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Wait for the tree-sitter parsers; buildGraph needs them loaded. */
    async ready(): Promise<void> {
        await initParsers(this.context);
    }

    /** Rescan the workspace. Concurrent calls share one scan. */
    scan(): Promise<GraphData> {
        if (!this.scanning) {
            this.scanning = this.doScan().finally(() => {
                this.scanning = null;
            });
        }
        return this.scanning;
    }

    private async doScan(): Promise<GraphData> {
        await this.ready();
        const cfg = vscode.workspace.getConfiguration('codeGraph');
        const include = cfg.get<string>('include') || '**/*.{c,h}';
        const exclude = cfg.get<string>('exclude') || null;
        const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            throw new Error('Open a folder that contains C code to see its graph.');
        }
        const uris = await vscode.workspace.findFiles(include, exclude, maxFiles + 1);
        const truncated = uris.length > maxFiles;
        if (truncated) {
            uris.length = maxFiles;
        }

        // Unsaved editor contents win over the file on disk.
        const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
        const sources: Source[] = [];
        this.uriByPath.clear();
        const BATCH = 64;
        for (let i = 0; i < uris.length; i += BATCH) {
            const chunk = uris.slice(i, i + BATCH);
            const texts = await Promise.all(
                chunk.map(async (uri) => {
                    const doc = openDocs.get(uri.toString());
                    if (doc) {
                        return doc.getText();
                    }
                    try {
                        return decoder.decode(await vscode.workspace.fs.readFile(uri));
                    } catch {
                        return null;
                    }
                }),
            );
            chunk.forEach((uri, j) => {
                const text = texts[j];
                if (text === null) {
                    return;
                }
                const rel = this.relPathOf(uri);
                this.uriByPath.set(rel, uri);
                sources.push({ path: rel, text });
            });
        }
        sources.sort((a, b) => a.path.localeCompare(b.path));
        // Forget cached parses of files that disappeared.
        for (const key of this.parsedCache.keys()) {
            if (!this.uriByPath.has(key)) {
                this.parsedCache.delete(key);
            }
        }

        const graph = buildGraph(sources, this.parsedCache);
        graph.stats.truncated = truncated;
        graph.stats.maxFiles = maxFiles;
        graph.title = folders.map((f) => f.name).join(', ');
        this.graph = graph;
        return graph;
    }

    /** The file behind a workspace-relative path (multi-root paths start with the folder name). */
    uriFor(relPath: string): vscode.Uri | null {
        const known = this.uriByPath.get(relPath);
        if (known) {
            return known;
        }
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 1) {
            return vscode.Uri.joinPath(folders[0].uri, relPath);
        }
        for (const f of folders) {
            if (relPath.startsWith(f.name + '/')) {
                return vscode.Uri.joinPath(f.uri, relPath.slice(f.name.length + 1));
            }
        }
        return folders[0] ? vscode.Uri.joinPath(folders[0].uri, relPath) : null;
    }

    relPathOf(uri: vscode.Uri): string {
        const folders = vscode.workspace.workspaceFolders || [];
        return vscode.workspace.asRelativePath(uri, folders.length > 1).replace(/\\/g, '/');
    }
}