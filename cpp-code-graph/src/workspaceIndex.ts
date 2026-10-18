// src/workspaceIndex.ts

// Finds the workspace's C/C++ files (codeGraph.include/exclude/maxFiles),
// parses them and keeps the latest graph. Unchanged files keep their parse
// between scans.

import * as vscode from 'vscode';
import { buildGraph, type Source } from './graph/builder';
import { initParsers, type ExtensionPaths, type ParsedFile } from './parser';
import type { GraphData } from './types';

/** Files read at once while scanning. */
const READ_BATCH = 64;

const decoder = new TextDecoder('utf-8');

export class WorkspaceIndex {
    graph: GraphData | undefined;
    private readonly parsedCache = new Map<string, ParsedFile>();
    private readonly uriByPath = new Map<string, vscode.Uri>();
    private scanning: Promise<GraphData> | undefined;

    constructor(private readonly paths: ExtensionPaths) {}

    /** Rescan the workspace. Concurrent calls share one scan. */
    scan(): Promise<GraphData> {
        if (!this.scanning) {
            this.scanning = this.doScan().finally(() => {
                this.scanning = undefined;
            });
        }
        return this.scanning;
    }

    private async doScan(): Promise<GraphData> {
        await initParsers(this.paths);
        const cfg = vscode.workspace.getConfiguration('codeGraph');
        const include = cfg.get<string>('include') || '**/*.{c,h}';
        const exclude = cfg.get<string>('exclude') || null;
        const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);
        const folders = vscode.workspace.workspaceFolders ?? [];
        const uris = await vscode.workspace.findFiles(include, exclude, maxFiles + 1);
        const truncated = uris.length > maxFiles;
        if (truncated) {
            uris.length = maxFiles;
        }
        uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        // Unsaved editor contents win over the file on disk.
        const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
        const sources: Source[] = [];
        this.uriByPath.clear();
        const multiRoot = folders.length > 1;
        for (let i = 0; i < uris.length; i += READ_BATCH) {
            const chunk = uris.slice(i, i + READ_BATCH);
            const texts = await Promise.all(
                chunk.map(async (uri) => {
                    const doc = openDocs.get(uri.toString());
                    if (doc) {
                        return doc.getText();
                    }
                    try {
                        return decoder.decode(await vscode.workspace.fs.readFile(uri));
                    } catch {
                        return undefined;
                    }
                }),
            );
            chunk.forEach((uri, j) => {
                const text = texts[j];
                if (text === undefined) {
                    return;
                }
                const rel = vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
                this.uriByPath.set(rel, uri);
                sources.push({ path: rel, text });
            });
        }
        // Forget cached parses of files that disappeared.
        for (const key of this.parsedCache.keys()) {
            if (!this.uriByPath.has(key)) {
                this.parsedCache.delete(key);
            }
        }

        const graph = buildGraph(sources, this.parsedCache);
        graph.stats = { ...graph.stats!, truncated, maxFiles };
        graph.title = folders.length ? folders.map((f) => f.name).join(', ') : 'Workspace';
        this.graph = graph;
        return graph;
    }

    /** What the parser extracted from each file in the last scan, by path. */
    parsedFiles(): ParsedFile[] {
        return [...this.parsedCache.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
    }

    /** The file a workspace-relative path (as in GraphNode.file) means. */
    uriFor(relPath: string): vscode.Uri | undefined {
        const known = this.uriByPath.get(relPath);
        if (known) {
            return known;
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) {
            return vscode.Uri.joinPath(folders[0].uri, relPath);
        }
        for (const f of folders) {
            if (relPath.startsWith(f.name + '/')) {
                return vscode.Uri.joinPath(f.uri, relPath.slice(f.name.length + 1));
            }
        }
        return folders[0] ? vscode.Uri.joinPath(folders[0].uri, relPath) : undefined;
    }

    /** The workspace-relative path of a file, as in GraphNode.file. */
    relPathOf(uri: vscode.Uri): string {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return vscode.workspace.asRelativePath(uri, folders.length > 1).replace(/\\/g, '/');
    }
}
