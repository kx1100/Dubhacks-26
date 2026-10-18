// src/extension.ts
// Registers every command in package.json and wires file discovery + parsing
// (Phase 2) and graph building (Phase 3) into the panel.

import * as path from 'path';
import * as vscode from 'vscode';
import { buildGraph } from './graph';
import { GraphPanel, type LoadedGraph } from './panel';
import { formatParsedFile, parseCFile, type ParsedFile } from './parser';

/** C files only until Phase 7 adds tree-sitter-cpp. (`.C`/`.H` are C++ by convention.) */
const C_FILE = /\.(c|h)$/;

interface WorkspaceSources {
    root: vscode.WorkspaceFolder;
    files: Array<{ relPath: string; uri: vscode.Uri }>;
    truncated: boolean;
}

/** Phase 2 file discovery, driven by the codeGraph.include/exclude/maxFiles settings. */
async function findSources(): Promise<WorkspaceSources | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const include = cfg.get<string>('include') || '**/*.{c,h}';
    const exclude = cfg.get<string>('exclude') || null;
    const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, include), exclude, maxFiles + 1);
    const truncated = uris.length > maxFiles;
    const files = uris
        .slice(0, maxFiles)
        .map((uri) => ({ uri, relPath: path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join('/') }))
        .filter((f) => C_FILE.test(f.relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { root, files, truncated };
}

async function readText(uri: vscode.Uri): Promise<string> {
    // Unsaved editor contents win over the file on disk.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

async function parseWorkspace(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<{ sources: WorkspaceSources; parsed: ParsedFile[] }> {
    const sources = await findSources();
    if (!sources) {
        throw new Error('Open a folder that contains C code to see its graph.');
    }
    const parsed: ParsedFile[] = [];
    for (const f of sources.files) {
        try {
            parsed.push(await parseCFile(context, f.relPath, await readText(f.uri)));
        } catch (err) {
            output.appendLine(`Skipped ${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { sources, parsed };
}

async function loadGraph(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<LoadedGraph> {
    const started = Date.now();
    const { sources, parsed } = await parseWorkspace(context, output);
    const graph = buildGraph(parsed);
    const { nodes, edges } = graph.data;
    const byKind = new Map<string, number>();
    for (const e of edges) {
        byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    }
    output.appendLine(
        `Graph: ${parsed.length} files, ${nodes.length} nodes, ${edges.length} edges ` +
            `(${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) in ${Date.now() - started} ms`,
    );
    if (graph.parseErrors.length) {
        output.appendLine(`Files with syntax tree-sitter couldn't parse: ${graph.parseErrors.join(', ')}`);
    }
    return { graph, root: sources.root.uri.fsPath, truncated: sources.truncated };
}

/** Phase 2 verify step: dump what the parser extracted for every file. */
async function dumpSymbols(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
    const { parsed } = await parseWorkspace(context, output);
    output.show(true);
    output.appendLine(`--- Parsed symbols (${parsed.length} files) ---`);
    for (const p of parsed) {
        output.appendLine(formatParsedFile(p));
    }
}

function availableSoon(title: string): () => void {
    return () => {
        void vscode.window.showInformationMessage(`Code Graph: "${title}" is available soon.`);
    };
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Code Graph');
    const panel = new GraphPanel(context, () => loadGraph(context, output), output);

    const run = (fn: () => Promise<unknown>) => () =>
        fn().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            output.appendLine(`Error: ${message}`);
            void vscode.window.showErrorMessage(`Code Graph: ${message}`);
        });

    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('codeGraph.open', () => panel.show()),
        vscode.commands.registerCommand(
            'codeGraph.refresh',
            run(async () => {
                panel.show();
                await panel.refresh();
            }),
        ),
        vscode.commands.registerCommand(
            'codeGraph.revealInGraph',
            run(async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    panel.show();
                    return;
                }
                await panel.revealAt(editor.document.uri, editor.selection.active.line);
            }),
        ),
        vscode.commands.registerCommand('codeGraph.dumpSymbols', run(() => dumpSymbols(context, output))),
        vscode.commands.registerCommand('codeGraph.ask', availableSoon('Ask a Question About the Code')),
        vscode.commands.registerCommand('codeGraph.compareCommits', availableSoon('Compare Git Commits')),
    );
}

export function deactivate(): void {}
