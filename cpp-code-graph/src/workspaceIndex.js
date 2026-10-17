'use strict';

const vscode = require('vscode');
const { buildGraph } = require('./graph/builder');

const decoder = new TextDecoder('utf-8');

/** Scans the workspace for C/C++ sources and keeps the latest graph. */
class WorkspaceIndex {
  constructor() {
    this.parsedCache = new Map();
    this.uriByPath = new Map();
    this.graph = null;
    this.scanning = null;
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async _scan() {
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const include = cfg.get('include');
    const exclude = cfg.get('exclude');
    const maxFiles = cfg.get('maxFiles') || 3000;
    const folders = vscode.workspace.workspaceFolders || [];
    const uris = await vscode.workspace.findFiles(include, exclude, maxFiles + 1);
    const truncated = uris.length > maxFiles;
    if (truncated) uris.length = maxFiles;
    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    const openDocs = new Map(vscode.workspace.textDocuments.map(d => [d.uri.toString(), d]));
    const sources = [];
    this.uriByPath.clear();
    const multiRoot = folders.length > 1;
    const BATCH = 64;
    for (let i = 0; i < uris.length; i += BATCH) {
      const chunk = uris.slice(i, i + BATCH);
      const texts = await Promise.all(
        chunk.map(async uri => {
          const doc = openDocs.get(uri.toString());
          if (doc) return doc.getText();
          try {
            return decoder.decode(await vscode.workspace.fs.readFile(uri));
          } catch {
            return null;
          }
        })
      );
      chunk.forEach((uri, j) => {
        if (texts[j] == null) return;
        const rel = vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
        this.uriByPath.set(rel, uri);
        sources.push({ path: rel, text: texts[j] });
      });
    }
    // Forget cached parses of files that disappeared.
    for (const key of this.parsedCache.keys()) if (!this.uriByPath.has(key)) this.parsedCache.delete(key);

    const graph = buildGraph(sources, this.parsedCache);
    graph.stats.truncated = truncated;
    graph.stats.maxFiles = maxFiles;
    graph.title = folders.length ? folders.map(f => f.name).join(', ') : 'Workspace';
    this.graph = graph;
    return graph;
  }

  uriFor(relPath) {
    const known = this.uriByPath.get(relPath);
    if (known) return known;
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) return vscode.Uri.joinPath(folders[0].uri, relPath);
    for (const f of folders) {
      if (relPath.startsWith(f.name + '/')) return vscode.Uri.joinPath(f.uri, relPath.slice(f.name.length + 1));
    }
    return folders[0] ? vscode.Uri.joinPath(folders[0].uri, relPath) : null;
  }

  relPathOf(uri) {
    const folders = vscode.workspace.workspaceFolders || [];
    return vscode.workspace.asRelativePath(uri, folders.length > 1).replace(/\\/g, '/');
  }
}

/** Finds the innermost graph node that covers a given file line. */
function nodeAt(graph, relPath, line) {
  let best = null;
  let bestSpan = Infinity;
  for (const n of graph.nodes) {
    const ranges = [];
    if (n.file === relPath && n.line) ranges.push([n.line, n.endLine || n.line]);
    if (n.defFile === relPath && n.defLine) ranges.push([n.defLine, n.defEndLine || n.endLine || n.defLine]);
    for (const [a, b] of ranges) {
      if (line >= a && line <= b && n.kind !== 'file' && n.kind !== 'dir') {
        const span = b - a;
        if (span < bestSpan) {
          best = n;
          bestSpan = span;
        }
      }
    }
  }
  if (!best) best = graph.nodes.find(n => n.kind === 'file' && n.file === relPath) || null;
  return best;
}

module.exports = { WorkspaceIndex, nodeAt };
