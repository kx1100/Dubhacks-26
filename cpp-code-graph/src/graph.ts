// src/graph.ts
// Phase 3: turn parsed files into GraphData (see types.ts).
//
// Pure: no vscode imports, so it can be tested with plain Node.
//
// Nodes: one per file, plus its functions, prototypes and types as children.
// Edges: include, pair, proto-def, type-use, call. Names are resolved the way
// a C reader would: first in the same file, then in files it #includes
// (directly or transitively), then anywhere in the workspace if unambiguous.
import * as path from 'path';
import type { FunctionInfo, ParsedFile, Scope, Span } from './parser';
import type { EdgeKind, GraphData, GraphEdge, GraphNode, NodeKind } from './types';
const posix = path.posix;
const HEADER_EXT = /\.(h|hh|hpp|hxx|h\+\+)$/i;
const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+)$/i;
/** GraphData plus what the extension needs but the webview doesn't. */
export interface BuiltGraph {
    data: GraphData;
    /** Line range of every symbol node (GraphNode only carries the start line); used by revealInGraph. */
    spans: Map<string, Span>;
    /** Workspace-relative paths of files tree-sitter couldn't fully parse */
    parseErrors: string[];
}
/** Node ID in the `<kind>:<file>[:<name>]` format from types.ts. */
export function nodeId(kind: NodeKind, file: string, name?: string): string {
    return name === undefined ? `${kind}:${file}` : `${kind}:${file}:${name}`;
}
export function isHeader(file: string): boolean {
    return HEADER_EXT.test(file);
}
function stem(file: string): string {
    return file.replace(/\.[^./]+$/, '');
}
/** A function or prototype as it appears in one file. */
interface FnRecord {
    node: GraphNode;
    file: string;
    info: FunctionInfo;
}
export function buildGraph(files: ParsedFile[]): BuiltGraph {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const spans = new Map<string, Span>();
    const fileSet = new Set(files.map((f) => f.filePath));
    const addEdge = (kind: EdgeKind, source: string, target: string) => {
        const id = `${kind}:${source}->${target}`;
        if (source !== target && !edges.has(id)) {
            edges.set(id, { id, kind, source, target });
        }
    };
    const addSymbol = (node: GraphNode, span: Span) => {
        nodes.set(node.id, node);
        spans.set(node.id, { line: span.line, endLine: span.endLine });
        return node;
    };
    // ---- file nodes ---------------------------------------------------------
    const fileId = (file: string) => nodeId('file', file);
    for (const f of files) {
        nodes.set(fileId(f.filePath), {
            id: fileId(f.filePath),
            kind: 'file',
            label: posix.basename(f.filePath),
            file: f.filePath,
            fileRole: isHeader(f.filePath) ? 'header' : 'source',
            language: f.language,
        });
    }
    // ---- function and prototype nodes ---------------------------------------
    // Per file and name: the definition if there is one, otherwise the prototype.
    // (A forward declaration in the same file as the body adds nothing to the picture.)
    const fnsInFile = new Map<string, Map<string, FnRecord>>();
    const defsByName = new Map<string, FnRecord[]>();
    const protosByName = new Map<string, FnRecord[]>();
    for (const f of files) {
        const local = new Map<string, FnRecord>();
        fnsInFile.set(f.filePath, local);
        const definitionsFirst = [...f.functions].sort((a, b) => Number(b.kind === 'function') - Number(a.kind === 'function'));
        for (const info of definitionsFirst) {
            if (local.has(info.name)) {
                continue;
            }
            const node = addSymbol(
                {
                    id: nodeId(info.kind, f.filePath, info.name),
                    kind: info.kind,
                    label: info.name,
                    parent: fileId(f.filePath),
                    file: f.filePath,
                    line: info.line,
                    signature: info.signature,
                },
                info,
            );
            const rec: FnRecord = { node, file: f.filePath, info };
            local.set(info.name, rec);
            push(info.kind === 'function' ? defsByName : protosByName, info.name, rec);
        }
    }
    // ---- type nodes ---------------------------------------------------------
    // `typedef struct Node {...} Node;` is one node, struct Node: the typedef
    // only renames a struct defined right there.
    const tagIndex = new Map<string, GraphNode[]>(); // struct/union/enum tag -> nodes
    const nameIndex = new Map<string, GraphNode[]>(); // bare type name -> nodes
    const typesInFile = new Map<string, Map<string, GraphNode>>(); // `${kind}:${name}` -> node, per file
    for (const f of files) {
        const local = new Map<string, GraphNode>();
        typesInFile.set(f.filePath, local);
        for (const t of f.types) {
            if (t.kind === 'typedef') {
                continue;
            }
            const id = nodeId(t.kind, f.filePath, t.name);
            const node =
                nodes.get(id) ??
                addSymbol({ id, kind: t.kind, label: t.name, parent: fileId(f.filePath), file: f.filePath, line: t.line, signature: `${t.kind} ${t.name}` }, t);
            local.set(`${t.kind}:${t.name}`, node);
            push(tagIndex, t.name, node);
            push(nameIndex, t.name, node);
        }
        for (const t of f.types) {
            if (t.kind !== 'typedef') {
                continue;
            }
            const renamed = t.aliasOf && local.get(`${t.aliasOf.kind}:${t.aliasOf.name}`);
            let node: GraphNode;
            if (renamed) {
                node = renamed;
                node.signature = `typedef ${t.aliasText ?? `${t.aliasOf!.kind} ${t.aliasOf!.name}`} ${t.name}`;
            } else {
                const id = nodeId('typedef', f.filePath, t.name);
                node =
                    nodes.get(id) ??
                    addSymbol(
                        { id, kind: 'typedef', label: t.name, parent: fileId(f.filePath), file: f.filePath, line: t.line, signature: `typedef ${t.aliasText ?? '?'} ${t.name}` },
                        t,
                    );
            }
            local.set(`typedef:${t.name}`, node);
            if (!nameIndex.get(t.name)?.includes(node)) {
                push(nameIndex, t.name, node);
            }
        }
    }
    // ---- include edges ------------------------------------------------------
    const includes = new Map<string, Set<string>>();
    const byBasename = new Map<string, string[]>();
    for (const file of fileSet) {
        push(byBasename, posix.basename(file), file);
    }
    const resolveInclude = (from: string, inc: string): string | undefined => {
        const candidates = [posix.normalize(posix.join(posix.dirname(from), inc)), posix.normalize(inc)];
        const direct = candidates.find((c) => fileSet.has(c));
        if (direct) {
            return direct;
        }
        // Not relative to the file or the root: accept a unique match by trailing path
        // (projects that pass include directories with -I).
        const matches = (byBasename.get(posix.basename(inc)) ?? []).filter((p) => p === inc || p.endsWith('/' + inc));
        return matches.length === 1 ? matches[0] : undefined;
    };
    for (const f of files) {
        const set = new Set<string>();
        includes.set(f.filePath, set);
        for (const inc of f.includes) {
            if (inc.system) {
                continue;
            }
            const target = resolveInclude(f.filePath, inc.path);
            if (target && target !== f.filePath) {
                set.add(target);
                addEdge('include', fileId(f.filePath), fileId(target));
            }
        }
    }
    // Files whose declarations are visible from each file: itself plus everything it includes, transitively.
    const visibleCache = new Map<string, Set<string>>();
    const visibleFrom = (file: string): Set<string> => {
        let seen = visibleCache.get(file);
        if (!seen) {
            seen = new Set([file]);
            const stack = [file];
            while (stack.length) {
                for (const next of includes.get(stack.pop()!) ?? []) {
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                }
            }
            visibleCache.set(file, seen);
        }
        return seen;
    };
    // ---- pair edges ---------------------------------------------------------
    const pairOf = new Map<string, string>(); // both directions
    const sourcesByStem = new Map<string, string[]>();
    const sourcesByName = new Map<string, string[]>();
    for (const file of fileSet) {
        if (SOURCE_EXT.test(file)) {
            push(sourcesByStem, stem(file), file);
            push(sourcesByName, posix.basename(stem(file)), file);
        }
    }
    for (const header of fileSet) {
        if (!isHeader(header)) {
            continue;
        }
        // Same folder first (list.h + list.c), then a unique match elsewhere (include/list.h + src/list.c).
        let source = sourcesByStem.get(stem(header))?.[0];
        if (!source) {
            const elsewhere = sourcesByName.get(posix.basename(stem(header))) ?? [];
            source = elsewhere.length === 1 ? elsewhere[0] : undefined;
        }
        if (source && !pairOf.has(source)) {
            pairOf.set(header, source);
            pairOf.set(source, header);
            addEdge('pair', fileId(header), fileId(source));
        }
    }
    // ---- proto-def edges ----------------------------------------------------
    for (const protos of protosByName.values()) {
        for (const proto of protos) {
            const defs = (defsByName.get(proto.info.name) ?? []).filter((d) => !d.info.isStatic);
            const def = pickOne(defs, [(d) => d.file === pairOf.get(proto.file), (d) => visibleFrom(d.file).has(proto.file)]);
            if (def) {
                addEdge('proto-def', proto.node.id, def.node.id);
            }
        }
    }
    // ---- call edges ---------------------------------------------------------
    const resolveFunction = (fromFile: string, name: string): FnRecord[] => {
        const local = fnsInFile.get(fromFile)?.get(name);
        if (local?.info.kind === 'function') {
            return [local];
        }
        const visible = visibleFrom(fromFile);
        const defs = (defsByName.get(name) ?? []).filter((d) => !d.info.isStatic);
        if (defs.length) {
            // Prefer the definition behind a header this file can see.
            const behindVisible = defs.filter((d) => {
                const header = pairOf.get(d.file);
                return header !== undefined && visible.has(header);
            });
            return behindVisible.length ? behindVisible : defs;
        }
        // Declared but never defined in the workspace (e.g. a library API): point at the prototype.
        if (local) {
            return [local];
        }
        return (protosByName.get(name) ?? []).filter((p) => visible.has(p.file));
    };
    for (const f of files) {
        const local = fnsInFile.get(f.filePath)!;
        for (const call of f.calls) {
            const caller = local.get(call.caller);
            if (!caller || caller.info.kind !== 'function') {
                continue;
            }
            for (const target of resolveFunction(f.filePath, call.callee)) {
                addEdge('call', caller.node.id, target.node.id);
            }
        }
    }
    // ---- type-use edges -----------------------------------------------------
    const scopeNode = (file: string, scope: Scope): string | undefined => {
        if (scope.kind === 'file') {
            return fileId(file);
        }
        if (scope.kind === 'function' || scope.kind === 'prototype') {
            // A same-file prototype was folded into its definition.
            return fnsInFile.get(file)?.get(scope.name)?.node.id;
        }
        return typesInFile.get(file)?.get(`${scope.kind}:${scope.name}`)?.id;
    };
    const resolveType = (fromFile: string, tagged: boolean, name: string): GraphNode | undefined => {
        const candidates = (tagged ? tagIndex : nameIndex).get(name) ?? [];
        const visible = visibleFrom(fromFile);
        return (
            candidates.find((n) => n.file === fromFile) ??
            candidates.find((n) => visible.has(n.file)) ??
            (candidates.length === 1 ? candidates[0] : undefined)
        );
    };
    for (const f of files) {
        for (const ref of f.typeRefs) {
            const from = scopeNode(f.filePath, ref.from);
            const target = resolveType(f.filePath, ref.tagged, ref.name);
            if (from && target) {
                addEdge('type-use', from, target.id);
            }
        }
    }
    return {
        data: { nodes: [...nodes.values()], edges: [...edges.values()] },
        spans,
        parseErrors: files.filter((f) => f.hasErrors).map((f) => f.filePath),
    };
}
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}
/** The single candidate, or the one matched by the earliest preference that matches exactly one. */
function pickOne<T>(candidates: T[], preferences: Array<(c: T) => boolean>): T | undefined {
    if (candidates.length <= 1) {
        return candidates[0];
    }
    for (const prefer of preferences) {
        const hits = candidates.filter(prefer);
        if (hits.length === 1) {
            return hits[0];
        }
    }
    return undefined;
}
/** The innermost symbol node covering a 1-based line of a file, or the file node itself. */
export function nodeAt(graph: BuiltGraph, file: string, line: number): GraphNode | undefined {
    let best: GraphNode | undefined;
    let bestSize = Infinity;
    for (const n of graph.data.nodes) {
        const span = graph.spans.get(n.id);
        if (n.file !== file || !span || line < span.line || line > span.endLine) {
            continue;
        }
        if (span.endLine - span.line < bestSize) {
            best = n;
            bestSize = span.endLine - span.line;
        }
    }
    return best ?? graph.data.nodes.find((n) => n.kind === 'file' && n.file === file);
}