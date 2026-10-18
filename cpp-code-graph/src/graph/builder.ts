// src/graph/builder.ts

// turn C/C++ source files into GraphData (types.ts), the graph the webview
// and the ask-ai code (src/ai/*.js) work on.

// different from the tree-sitter parser: no vscode imports, initParsers must have finished before buildGraph runs.

// Nodes:
//  - one per folder (chains of folders with one sub-folder and no files merged), with its files as children
//  - one per file
//  - its functions and types as children
//  - C++ classes with their methods and fields as children
//  - a prototype (function declaration) is merged into the function it declares (declFile/declLine);
//    one with no definition in the workspace is a 'prototype' node
//  - node ID now contains the full path to resolve possible collisions

// Edges:
//  - include, pair, type-use, call, inherits, overrides
//  - names are resolved the way a reader would: the same file first, then files it #includes
//    (directly or transitively), then anywhere in the workspace if unambiguous.

import * as path from 'path';
import { hashString } from '../util/hash';
import {
    hasCppFiles,
    languageFor,
    parseSource,
    SOURCE_FILE,
    type CallInfo,
    type FieldInfo,
    type FunctionInfo,
    type ParsedFile,
    type Scope,
    type TypeDefInfo,
} from '../parser';
import type { EdgeKind, EdgeSite, GraphData, GraphEdge, GraphNode, NodeKind } from '../types';

const posix = path.posix;

const HEADER_EXT = /\.(h|hh|hpp|hxx|h\+\+|H)$/;
const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+|C)$/;
// places kept per edge, as in the ask-ai builder
const EDGE_SITE_LIMIT = 8;

// source file to build from: workspace-relative path with '/' separators
export interface Source {
    path: string;
    text: string;
}

// node ID in the `<kind>:<file>[:<qname>]` format from types.ts
export function nodeId(kind: NodeKind, file: string, name?: string): string {
    return name === undefined ? `${kind}:${file}` : `${kind}:${file}:${name}`;
}

export function isHeader(file: string): boolean {
    return HEADER_EXT.test(file);
}

function stem(file: string): string {
    return file.replace(/\.[^./]+$/, '');
}

const lastPart = (qname: string) => qname.split('::').pop() ?? qname;
// `a::b::C` is in namespace/class `a::b`
const parentOf = (qname: string) => qname.split('::').slice(0, -1).join('::');

// function, prototype or method as it appears in one file; `node` is what it stands for in the graph
interface FnRecord {
    node: GraphNode;
    file: string;
    info: FunctionInfo;
}

// class or struct with a body (C++ types can have methods and bases)
interface ClassRecord {
    node: GraphNode;
    info: TypeDefInfo;
    file: string;
    // short method name -> its nodes
    methods: Map<string, GraphNode[]>;
    fields: Map<string, FieldInfo>;
    bases: ClassRecord[];
}

// Parse `sources` and build the graph. Files that aren't C or C++ are skipped.
// `cache` (path -> parse) skips files whose text and grammar haven't changed;
// pass the same map to several builds, e.g. both sides of a commit comparison.
export function buildGraph(sources: Source[], cache?: Map<string, ParsedFile>): GraphData {
    const wanted = sources.filter((s) => SOURCE_FILE.test(s.path));
    const hasCpp = hasCppFiles(wanted.map((s) => s.path));
    const files: ParsedFile[] = [];
    for (const src of wanted) {
        const lang = languageFor(src.path, hasCpp);
        let parsed = cache?.get(src.path);
        if (!parsed || parsed.hash !== hashString(src.text) || parsed.language !== lang) {
            parsed = parseSource(src.path, src.text, lang);
            cache?.set(src.path, parsed);
        }
        files.push(parsed);
    }
    return buildFromParsed(files);
}

// build the graph from files that are already parsed
export function buildFromParsed(files: ParsedFile[]): GraphData {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const fileSet = new Set(files.map((f) => f.filePath));

    const addEdge = (kind: EdgeKind, source: string, target: string, site?: EdgeSite, uncertain?: boolean) => {
        if (source === target) {
            return;
        }
        const id = `${kind}:${source}->${target}`;
        let e = edges.get(id);
        if (!e) {
            e = { id, kind, source, target, n: 0 };
            if (uncertain) {
                e.uncertain = true;
            }
            edges.set(id, e);
        } else if (e.uncertain && !uncertain) {
            delete e.uncertain;
        }
        e.n = (e.n ?? 0) + 1;
        if (site && (e.sites ??= []).length < EDGE_SITE_LIMIT) {
            e.sites.push(site);
        }
    };
    const addNode = (node: GraphNode) => {
        nodes.set(node.id, node);
        return node;
    };

    // ---- folder nodes -------------------------------------------------------
    // A chain of folders that hold exactly one sub-folder and no files is one
    // node (`src/core` instead of `src` > `core`).
    const dirOf = (p: string) => (p.includes('/') ? posix.dirname(p) : '');
    const dirs = new Set<string>();
    for (const file of fileSet) {
        for (let d = dirOf(file); d; d = dirOf(d)) {
            dirs.add(d);
        }
    }
    const childDirs = new Map<string, string[]>();
    for (const d of dirs) {
        push(childDirs, dirOf(d), d);
    }
    const hasFiles = new Set([...fileSet].map(dirOf));
    const dirNode = new Map<string, string | undefined>(); // folder path -> id of the node it is part of ('' = root)
    const visitDir = (d: string, parent: string | undefined, labelPrefix: string) => {
        const kids = (childDirs.get(d) ?? []).sort();
        if (d && kids.length === 1 && !hasFiles.has(d)) {
            visitDir(kids[0], parent, labelPrefix + posix.basename(d) + '/');
            dirNode.set(d, dirNode.get(kids[0]));
            return;
        }
        let id = parent;
        if (d) {
            id = nodeId('dir', d);
            addNode({ id, kind: 'dir', label: labelPrefix + posix.basename(d), parent, file: d });
        }
        dirNode.set(d, id);
        for (const k of kids) {
            visitDir(k, id, '');
        }
    };
    visitDir('', undefined, '');

    // ---- file nodes ---------------------------------------------------------
    const fileId = (file: string) => nodeId('file', file);
    for (const f of files) {
        addNode({
            id: fileId(f.filePath),
            kind: 'file',
            label: posix.basename(f.filePath),
            parent: dirNode.get(dirOf(f.filePath)),
            file: f.filePath,
            line: 1,
            fileRole: isHeader(f.filePath) ? 'header' : 'source',
            language: f.language,
            hash: f.hash,
        });
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
                addEdge('include', fileId(f.filePath), fileId(target), { file: f.filePath, line: inc.line });
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

    // ---- pair edges (header -> source with the same name) --------------------
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
            addEdge('pair', fileId(header), fileId(source), { file: header, line: 1 });
        }
    }

    // ---- type nodes: structs, unions, enums, typedefs, classes ----------------
    // `typedef struct Node {...} Node;` is one node, struct Node: the typedef
    // only renames a struct defined right there.
    const tagIndex = new Map<string, GraphNode[]>(); // struct/union/enum/class tag -> nodes
    const nameIndex = new Map<string, GraphNode[]>(); // bare type name (typedefs, classes) -> nodes
    const typesInFile = new Map<string, Map<string, GraphNode>>(); // `${kind}:${qname}` -> node, per file
    const classes: ClassRecord[] = [];
    const classByNode = new Map<string, ClassRecord>();
    for (const f of files) {
        const local = new Map<string, GraphNode>();
        typesInFile.set(f.filePath, local);
        const symbol = (t: TypeDefInfo, signature: string): GraphNode =>
            nodes.get(nodeId(t.kind, f.filePath, t.qname)) ??
            addNode({
                id: nodeId(t.kind, f.filePath, t.qname),
                kind: t.kind,
                label: t.name,
                qname: t.qname,
                parent: fileId(f.filePath),
                file: f.filePath,
                line: t.line,
                endLine: t.endLine,
                signature,
                hash: t.hash,
            });
        for (const t of f.types) {
            if (t.kind === 'typedef') {
                continue;
            }
            const node = symbol(t, `${t.kind} ${t.qname}`);
            local.set(`${t.kind}:${t.qname}`, node);
            push(tagIndex, t.name, node);
            push(nameIndex, t.name, node);
            if (f.language === 'cpp' && t.kind !== 'enum' && !classByNode.has(node.id)) {
                const rec: ClassRecord = {
                    node,
                    info: t,
                    file: f.filePath,
                    methods: new Map(),
                    fields: new Map((t.fields ?? []).map((x) => [x.name, x])),
                    bases: [],
                };
                classes.push(rec);
                classByNode.set(node.id, rec);
            }
        }
        for (const t of f.types) {
            if (t.kind !== 'typedef') {
                continue;
            }
            const ns = parentOf(t.qname);
            const renamed =
                t.aliasOf &&
                (local.get(`${t.aliasOf.kind}:${ns ? `${ns}::` : ''}${t.aliasOf.name}`) ?? local.get(`${t.aliasOf.kind}:${t.aliasOf.name}`));
            let node: GraphNode;
            if (renamed) {
                node = renamed;
                node.signature = `typedef ${t.aliasText ?? `${t.aliasOf!.kind} ${t.aliasOf!.name}`} ${t.name}`;
            } else {
                node = symbol(t, `typedef ${t.aliasText ?? '?'} ${t.name}`);
            }
            local.set(`typedef:${t.qname}`, node);
            if (!nameIndex.get(t.name)?.includes(node)) {
                push(nameIndex, t.name, node);
            }
        }
    }

    /** The class a (possibly qualified) name means, seen from `fromFile` inside namespace/class `context`. */
    const resolveClass = (name: string, fromFile: string, context = ''): ClassRecord | undefined => {
        const candidates = classes.filter((c) => c.info.name === lastPart(name));
        if (candidates.length <= 1) {
            return candidates[0];
        }
        // The innermost enclosing namespace first: `Shape` inside `geo` means `geo::Shape`.
        const scopes = context ? context.split('::') : [];
        for (let i = scopes.length; i >= 0; i--) {
            const qn = [...scopes.slice(0, i), name].join('::');
            const exact = candidates.filter((c) => c.info.qname === qn);
            if (exact.length) {
                return exact.find((c) => visibleFrom(fromFile).has(c.file)) ?? exact[0];
            }
        }
        const suffix = candidates.filter((c) => c.info.qname.endsWith('::' + name) || c.info.qname === name);
        const visible = suffix.filter((c) => visibleFrom(fromFile).has(c.file));
        return visible.length === 1 ? visible[0] : suffix.length === 1 ? suffix[0] : undefined;
    };

    // ---- field nodes (C++ data members) ----------------------------------------
    for (const c of classes) {
        for (const field of c.info.fields ?? []) {
            const qname = `${c.info.qname}::${field.name}`;
            addNode({
                id: nodeId('field', c.file, qname),
                kind: 'field',
                label: field.name,
                qname,
                parent: c.node.id,
                file: c.file,
                line: field.line,
                endLine: field.endLine,
                signature: field.signature,
                isStatic: field.isStatic || undefined,
                access: field.access,
                hash: field.hash,
            });
        }
    }

    // ---- inherits edges -------------------------------------------------------
    for (const c of classes) {
        for (const baseName of c.info.bases ?? []) {
            const base = resolveClass(baseName, c.file, parentOf(c.info.qname));
            if (base && base !== c) {
                c.bases.push(base);
                addEdge('inherits', c.node.id, base.node.id, { file: c.file, line: c.info.line });
            }
        }
    }

    // ---- functions and methods ------------------------------------------------
    // Free functions: per file and qname, the definition if there is one,
    // otherwise the prototype (a forward declaration in the same file as the
    // body adds nothing). Methods: one node per class and name, wherever its
    // declaration and body are.
    const fnsInFile = new Map<string, Map<string, FnRecord>>(); // file -> qname -> record
    const defsByName = new Map<string, FnRecord[]>(); // free function definitions by short name
    const protos: FnRecord[] = [];
    const methodRecords: FnRecord[] = [];
    for (const f of files) {
        const local = new Map<string, FnRecord>();
        fnsInFile.set(f.filePath, local);
        const definitionsFirst = [...f.functions].sort((a, b) => Number(b.kind === 'function') - Number(a.kind === 'function'));
        for (const info of definitionsFirst) {
            if (local.has(info.qname)) {
                continue;
            }
            const rec: FnRecord = { node: undefined as unknown as GraphNode, file: f.filePath, info };
            local.set(info.qname, rec);
            if (info.owner) {
                methodRecords.push(rec);
            } else if (info.kind === 'prototype') {
                protos.push(rec); // becomes a node of its own only if no definition claims it (below)
            } else {
                rec.node = addNode({
                    id: nodeId('function', f.filePath, info.qname),
                    kind: 'function',
                    label: info.name,
                    qname: info.qname,
                    parent: fileId(f.filePath),
                    file: f.filePath,
                    line: info.line,
                    endLine: info.endLine,
                    defFile: f.filePath,
                    defLine: info.line,
                    defEndLine: info.endLine,
                    signature: info.signature,
                    isStatic: info.isStatic || undefined,
                    hash: info.hash,
                });
                push(defsByName, info.name, rec);
            }
        }
    }

    // Methods, grouped by class and name: the in-class declaration gives the
    // node its place, the body its defFile.
    const methodGroups = new Map<string, { cls?: ClassRecord; recs: FnRecord[] }>();
    for (const rec of methodRecords) {
        const cls = resolveClass(rec.info.owner!, rec.file, parentOf(rec.info.owner!));
        const key = cls ? `${cls.node.id}|${rec.info.name}` : `${rec.file}|${rec.info.qname}`;
        const group = methodGroups.get(key) ?? { cls, recs: [] };
        group.recs.push(rec);
        methodGroups.set(key, group);
    }
    for (const { cls, recs } of methodGroups.values()) {
        const decl = recs.find((r) => r.info.kind === 'prototype' && cls && r.file === cls.file) ?? recs.find((r) => r.info.kind === 'prototype');
        const def = recs.find((r) => r.info.kind === 'function');
        const home = decl ?? def!;
        const qname = cls ? `${cls.info.qname}::${home.info.name}` : home.info.qname;
        const any = (key: 'isVirtual' | 'isPure' | 'isOverride' | 'isStatic') => recs.some((r) => r.info[key]) || undefined;
        const node = addNode({
            id: nodeId('method', cls ? cls.file : home.file, qname),
            kind: 'method',
            label: home.info.name,
            qname,
            parent: cls ? cls.node.id : fileId(home.file),
            file: home.file,
            line: home.info.line,
            endLine: home.info.endLine,
            ...(def ? { defFile: def.file, defLine: def.info.line, defEndLine: def.info.endLine } : {}),
            signature: (decl ?? def)!.info.signature,
            isStatic: any('isStatic'),
            isVirtual: any('isVirtual'),
            isPure: any('isPure'),
            isOverride: any('isOverride'),
            access: decl?.info.access ?? def?.info.access,
            hash: def?.info.hash ?? home.info.hash,
        });
        for (const r of recs) {
            r.node = node;
        }
        if (cls) {
            push(cls.methods, node.label, node);
        }
        // A class whose methods are defined in another file pairs its header with that file.
        if (def && decl && def.file !== decl.file) {
            addEdge('pair', fileId(decl.file), fileId(def.file), { file: decl.file, line: decl.info.line });
        }
    }

    // ---- prototypes ---------------------------------------------------------
    // Merged into the definition they declare; one without a definition in the
    // workspace (e.g. a library API) is a prototype node in its own file.
    for (const proto of protos) {
        const defs = (defsByName.get(proto.info.name) ?? []).filter((d) => !d.info.isStatic && d.info.qname === proto.info.qname);
        const def = pickOne(defs, [(d) => d.file === pairOf.get(proto.file), (d) => visibleFrom(d.file).has(proto.file)]);
        if (def) {
            proto.node = def.node;
            if (!def.node.declFile) {
                def.node.declFile = proto.file;
                def.node.declLine = proto.info.line;
                def.node.declEndLine = proto.info.endLine;
            }
            addEdge('pair', fileId(proto.file), fileId(def.file), { file: proto.file, line: proto.info.line });
            continue;
        }
        proto.node = addNode({
            id: nodeId('prototype', proto.file, proto.info.qname),
            kind: 'prototype',
            label: proto.info.name,
            qname: proto.info.qname,
            parent: fileId(proto.file),
            file: proto.file,
            line: proto.info.line,
            endLine: proto.info.endLine,
            signature: proto.info.signature,
            isStatic: proto.info.isStatic || undefined,
            hash: proto.info.hash,
        });
    }

    // ---- overrides edges ------------------------------------------------------
    // A method of `cls` or its bases (nearest first) with this name
    const findMethod = (cls: ClassRecord, name: string, seen = new Set<ClassRecord>()): GraphNode[] => {
        if (seen.has(cls)) {
            return [];
        }
        seen.add(cls);
        const own = cls.methods.get(name);
        if (own?.length) {
            return own;
        }
        for (const b of cls.bases) {
            const found = findMethod(b, name, seen);
            if (found.length) {
                return found;
            }
        }
        return [];
    };
    for (const c of classes) {
        for (const [name, ms] of c.methods) {
            if (name === c.info.name || name.startsWith('~')) {
                continue; // constructors and destructors don't override by name
            }
            for (const m of ms) {
                for (const b of c.bases) {
                    for (const target of findMethod(b, name)) {
                        if (target.isVirtual || m.isOverride || m.isVirtual) {
                            addEdge('overrides', m.id, target.id, { file: m.file, line: m.line ?? 1 });
                        }
                    }
                }
            }
        }
    }

    // ---- call edges ---------------------------------------------------------
    const protosByName = new Map<string, FnRecord[]>();
    for (const p of protos) {
        push(protosByName, p.info.name, p);
    }
    const allMethodsByName = new Map<string, GraphNode[]>();
    for (const c of classes) {
        for (const [name, ms] of c.methods) {
            for (const m of ms) {
                push(allMethodsByName, name, m);
            }
        }
    }
    const resolveFunction = (fromFile: string, name: string, qname: string): GraphNode[] => {
        const local = fnsInFile.get(fromFile)?.get(qname) ?? fnsInFile.get(fromFile)?.get(name);
        if (local && !local.info.owner && local.info.kind === 'function') {
            return [local.node];
        }
        const visible = visibleFrom(fromFile);
        let defs = (defsByName.get(name) ?? []).filter((d) => !d.info.isStatic);
        // In a namespace, a bare name means that namespace's function first.
        const sameNs = defs.filter((d) => d.info.qname === qname);
        if (sameNs.length) {
            defs = sameNs;
        }
        if (defs.length) {
            // Prefer the definition behind a header this file can see.
            const behindVisible = defs.filter((d) => {
                const header = pairOf.get(d.file);
                return header !== undefined && visible.has(header);
            });
            return (behindVisible.length ? behindVisible : defs).map((d) => d.node);
        }
        // Declared but never defined in the workspace (e.g. a library API): point at the prototype.
        if (local && !local.info.owner) {
            return [local.node];
        }
        return [...new Set((protosByName.get(name) ?? []).filter((p) => visible.has(p.file)).map((p) => p.node))];
    };
    // The class of the method a call is made from, if it is a method
    const classOfCaller = (caller: GraphNode): ClassRecord | undefined =>
        caller.kind === 'method' && caller.parent ? classByNode.get(caller.parent) : undefined;
    // What a call can mean: the targets, and whether they are a guess
    const resolveCall = (f: ParsedFile, call: CallInfo, caller: GraphNode): { targets: GraphNode[]; uses?: GraphNode } => {
        const callerClass = classOfCaller(caller);
        const context = parentOf(caller.qname ?? caller.label);
        if (call.ctor) {
            const cls = resolveClass(call.qualified ?? call.callee, f.filePath, context);
            const ctor = cls?.methods.get(cls.info.name);
            return ctor?.length ? { targets: ctor } : { targets: [], uses: cls?.node };
        }
        if (call.member) {
            let cls: ClassRecord | undefined;
            if (call.receiver === 'this') {
                cls = callerClass;
            } else if (call.receiverType) {
                cls = resolveClass(call.receiverType, f.filePath, context);
            } else if (call.receiver && callerClass) {
                // A data member of the calling method's class.
                const field = callerClass.fields.get(call.receiver);
                cls = field?.type ? resolveClass(field.type, callerClass.file, parentOf(callerClass.info.qname)) : undefined;
            }
            if (cls) {
                const found = findMethod(cls, call.callee);
                if (found.length) {
                    return { targets: found };
                }
            }
            return { targets: allMethodsByName.get(call.callee) ?? [] };
        }
        if (call.qualified) {
            // `ns::f()` or `Cls::f()`
            const q = call.qualified;
            const named = [
                ...(defsByName.get(call.callee) ?? []).map((d) => d.node),
                ...(protosByName.get(call.callee) ?? []).map((p) => p.node),
                ...(allMethodsByName.get(call.callee) ?? []),
            ];
            const matches = [...new Set(named)].filter((n) => n.qname === q || n.qname?.endsWith('::' + q));
            if (matches.length) {
                return { targets: matches };
            }
            const cls = resolveClass(parentOf(q), f.filePath, context);
            return { targets: cls ? findMethod(cls, call.callee) : [] };
        }
        // A bare name in a method: its own class's methods (and inherited ones) first.
        if (callerClass) {
            const found = findMethod(callerClass, call.callee);
            if (found.length) {
                return { targets: found };
            }
        }
        const ns = callerClass ? parentOf(callerClass.info.qname) : context;
        return { targets: resolveFunction(f.filePath, call.callee, ns ? `${ns}::${call.callee}` : call.callee) };
    };
    for (const f of files) {
        const local = fnsInFile.get(f.filePath)!;
        for (const call of f.calls) {
            const caller = local.get(call.caller);
            if (!caller || caller.info.kind !== 'function' || !caller.node) {
                continue;
            }
            const site = { file: f.filePath, line: call.line };
            const { targets, uses } = resolveCall(f, call, caller.node);
            for (const target of new Set(targets)) {
                addEdge('call', caller.node.id, target.id, site, targets.length > 1);
            }
            if (uses) {
                addEdge('type-use', caller.node.id, uses.id, site);
            }
        }
    }

    // ---- type-use edges -----------------------------------------------------
    const scopeNode = (file: string, scope: Scope): string | undefined => {
        if (scope.kind === 'file') {
            return fileId(file);
        }
        if (scope.kind === 'function' || scope.kind === 'prototype') {
            // A prototype's types are used by the function it declares.
            return fnsInFile.get(file)?.get(scope.name)?.node?.id;
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
            // A class's own name inside its methods isn't worth an arrow.
            if (from && target && nodes.get(from)?.parent !== target.id) {
                addEdge('type-use', from, target.id, { file: f.filePath, line: ref.line });
            }
        }
    }

    const nodeList = [...nodes.values()];
    const edgeList = [...edges.values()];
    return {
        nodes: nodeList,
        edges: edgeList,
        stats: {
            files: files.length,
            nodes: nodeList.length,
            edges: edgeList.length,
            errors: files.filter((f) => f.hasErrors).map((f) => ({ file: f.filePath, error: "tree-sitter couldn't parse part of this file (often a macro)" })),
        },
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

// The single candidate, or the one matched by the earliest preference that matches exactly one
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

// The innermost symbol covering a 1-based line of a file (its body, or its
// declaration elsewhere), or the file node itself.
export function nodeAt(graph: GraphData, file: string, line: number): GraphNode | undefined {
    let best: GraphNode | undefined;
    let bestSize = Infinity;
    for (const n of graph.nodes) {
        if (n.kind === 'file' || n.kind === 'dir') {
            continue;
        }
        const ranges: Array<[string | undefined, number | undefined, number | undefined]> = [
            [n.file, n.line, n.endLine],
            [n.defFile, n.defLine, n.defEndLine],
            [n.declFile, n.declLine, n.declEndLine],
        ];
        for (const [f, a, b = a] of ranges) {
            if (f !== file || a === undefined || b === undefined || line < a || line > b) {
                continue;
            }
            if (b - a < bestSize) {
                best = n;
                bestSize = b - a;
            }
        }
    }
    return best ?? graph.nodes.find((n) => n.kind === 'file' && n.file === file);
}