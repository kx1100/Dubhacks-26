// src/extension.ts
// Registers every command in package.json and keeps the graph current while
// editing. The panel (panel.ts) does the work; the workspace index
// (workspaceIndex.ts) finds, parses and builds.

import * as vscode from 'vscode';
import { GraphPanel } from './panel';
import { formatParsedFile, SOURCE_FILE } from './parser';
import { WorkspaceIndex } from './workspaceIndex';

/** Wait after a save/create/delete before rebuilding, so a burst of changes rebuilds once. */
const AUTO_REFRESH_DELAY_MS = 800;

/** Debug output: dump what the parser extracted for every file. */
async function dumpSymbols(index: WorkspaceIndex, output: vscode.OutputChannel): Promise<void> {
    const graph = await index.scan();
    const parsed = index.parsedFiles();
    output.show(true);
    output.appendLine(`--- Parsed symbols (${parsed.length} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges) ---`);
    for (const p of parsed) {
        output.appendLine(formatParsedFile(p));
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Code Graph');
    const index = new WorkspaceIndex(context);
    const panel = new GraphPanel(context, index);

    const run = (fn: () => Promise<unknown>) => () =>
        fn().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            output.appendLine(`Error: ${message}`);
            panel.error(err);
        });

    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('codeGraph.open', () => panel.show()),
        vscode.commands.registerCommand(
            'codeGraph.refresh',
            run(async () => {
                panel.show();
                await panel.refreshWorkspace();
            }),
        ),
        vscode.commands.registerCommand('codeGraph.revealInGraph', run(() => panel.revealAtCursor())),
        vscode.commands.registerCommand('codeGraph.buildSemantic', run(() => panel.buildSemantic())),
        vscode.commands.registerCommand(
            'codeGraph.ask',
            run(async () => {
                const q = await vscode.window.showInputBox({ title: 'Code Graph: ask about the code', placeHolder: 'e.g. What happens when a shape is drawn?' });
                if (q) {
                    await panel.ask(q);
                }
            }),
        ),
        vscode.commands.registerCommand('codeGraph.dumpSymbols', run(() => dumpSymbols(index, output))),
    );

    // Keep the graph current while editing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (!vscode.workspace.getConfiguration('codeGraph').get('autoRefresh') || !panel.panel) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => panel.refreshWorkspace(true).catch(() => {}), AUTO_REFRESH_DELAY_MS);
    };
    const isSource = (doc: vscode.TextDocument) => doc.languageId === 'c' || doc.languageId === 'cpp' || SOURCE_FILE.test(doc.fileName);
    const watcher = vscode.workspace.createFileSystemWatcher(vscode.workspace.getConfiguration('codeGraph').get<string>('include') || '**/*.{c,h}', false, true, false);
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (isSource(doc)) {
                schedule();
            }
        }),
        watcher,
        watcher.onDidCreate(schedule),
        watcher.onDidDelete(schedule),
        { dispose: () => clearTimeout(timer) },
    );
}

export function deactivate(): void {}
