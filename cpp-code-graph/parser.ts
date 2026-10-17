// src/parser.ts

// Phase 2: load tree-sitter-c (WASM) and extract the C structure graph.ts needs:
// #includes, function definitions + prototypes, calls, struct/union/enum/typedef
// definitions, and type references.
//
// Kinds use the NodeKind names from types.ts, so graph.ts can turn a symbol into
// a node ID (`<kind>:<file>:<name>`) without translating. Unions are reported
// as 'struct', as in types.ts
//
// All line numbers are 1-based, the same as GraphNode.line.

import type * as vscode from 'vscode';
import { Parser, Language as Grammar, Node } from 'web-tree-sitter';
import type { Language, NodeKind } from './types';

// ---------------------------------------------------------------------------
// Output types (parser -> graph.ts). Not part of the webview contract in types.ts.
// ---------------------------------------------------------------------------

/** 1-based, inclusive line range. */
export interface Span {
    line: number;
    endLine: number;
}

export interface IncludeInfo extends Span {
    /** Path as written, without quotes/brackets: `#include "list.h"` -> `list.h` */
    path: string;
    /** true for `<stdio.h>`; graph.ts skips these */
    system: boolean;
}

export type FunctionKind = Extract<NodeKind, 'function' | 'prototype'>;

export interface FunctionInfo extends Span {
    /** 'function' = definition with a body, 'prototype' = declaration without one */
    kind: FunctionKind;
    name: string;
    /** e.g. `static Node *list_new(int value)` (whitespace collapsed, no body) */
    signature: string;
    isStatic: boolean;
}

export interface CallInfo extends Span {
    /** Name of the function definition the call is in */
    caller: string;
    callee: string;
}

/** Type kinds as they appear in the graph: unions are 'struct'. */
export type TypeNodeKind = Extract<NodeKind, 'struct' | 'enum' | 'typedef'>;

export interface TypeDefInfo extends Span {
    kind: TypeNodeKind;
    name: string;
    /**
     * typedefs only: the struct/enum the name stands for when it has a tag,
     * e.g. `typedef struct Node Node;` -> { kind: 'struct', name: 'Node' }.
     * (`typedef struct { ... } List;` has no tag, so it is reported as struct `List` instead.)
     */
    aliasOf?: { kind: Extract<TypeNodeKind, 'struct' | 'enum'>; name: string };
    /** typedefs only: the aliased type as written, e.g. `struct Node`, `int`, `unsigned long` */
    aliasText?: string;
}

/**
 * Where something appears. For symbols, `kind` + `name` identify the node in the
 * same file: a function's signature or body, a prototype, a struct/enum's fields,
 * or a typedef. 'file' is file level (global variables).
 */
export type Scope =
    | { kind: 'file' }
    | { kind: Extract<NodeKind, 'function' | 'prototype' | 'struct' | 'enum' | 'typedef'>; name: string };

export interface TypeRefInfo extends Span {
    from: Scope;
    name: string;
    /**
     * true when written with a keyword (`struct Node`, `enum Color`): look the
     * name up among struct/union/enum tags. false for a bare name (`Node`,
     * `size_t`): look it up among typedefs. graph.ts drops names it can't
     * resolve to a workspace type.
     */
    tagged: boolean;
}

export interface ParsedFile {
    filePath: string;
    /** Always 'c' for now; tree-sitter-cpp comes in Phase 7. */
    language: Language;
    /** tree-sitter hit syntax it couldn't parse (often macros); results may be partial */
    hasErrors: boolean;
    includes: IncludeInfo[];
    functions: FunctionInfo[];
    calls: CallInfo[];
    types: TypeDefInfo[];
    /** De-duplicated per (from, tagged, name); the span is the first occurrence. */
    typeRefs: TypeRefInfo[];
}

// ---------------------------------------------------------------------------
// Parser loading (once per extension host)
// ---------------------------------------------------------------------------

let parserPromise: Promise<Parser> | undefined;

/**
 * Expects these files in the extension's `parsers/` folder:
 *   - web-tree-sitter.wasm  (copied from node_modules/web-tree-sitter/)
 *   - tree-sitter-c.wasm
 */
export function getCParser(context: vscode.ExtensionContext): Promise<Parser> {
    if (!parserPromise) {
        parserPromise = (async () => {
            // After esbuild bundling, web-tree-sitter can't find its own runtime
            // .wasm next to the bundle, so point it at parsers/ explicitly.
            await Parser.init({
                locateFile: (file: string) => context.asAbsolutePath(`parsers/${file}`),
            });
            const parser = new Parser();
            const grammar = await Grammar.load(
                context.asAbsolutePath('parsers/tree-sitter-c.wasm'),
            );
            parser.setLanguage(grammar);
            return parser;
        })();
        // If loading fails, allow a later call to retry instead of caching the rejection.
        parserPromise.catch(() => {
            parserPromise = undefined;
        });
    }
    return parserPromise;
}

/** Parse one C/H file and extract everything graph.ts needs. */
export async function parseCFile(
    context: vscode.ExtensionContext,
    filePath: string,
    sourceCode: string,
): Promise<ParsedFile> {
    const parser = await getCParser(context);
    return parseWith(parser, filePath, sourceCode);
}

/** Same as parseCFile but with an already-loaded parser (handy for tests). */
export function parseWith(parser: Parser, filePath: string, sourceCode: string): ParsedFile {
    const tree = parser.parse(sourceCode);
    if (!tree) {
        throw new Error(`tree-sitter failed to parse ${filePath}`);
    }
    try {
        return extract(tree.rootNode, filePath);
    } finally {
        tree.delete(); // WASM memory isn't garbage-collected
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const TAGGED_TYPES = new Set(['struct_specifier', 'union_specifier', 'enum_specifier']);

function extract(root: Node, filePath: string): ParsedFile {
    const out: ParsedFile = {
        filePath,
        language: 'c',
        hasErrors: root.hasError,
        includes: [],
        functions: [],
        calls: [],
        types: [],
        typeRefs: [],
    };

    const seenRefs = new Set<string>();
    const addRef = (from: Scope, name: string, tagged: boolean, node: Node) => {
        const key = `${scopeKey(from)}|${tagged ? 'tag' : 'name'}:${name}`;
        if (seenRefs.has(key)) {
            return;
        }
        seenRefs.add(key);
        out.typeRefs.push({ from, name, tagged, ...span(node) });
    };

    const visitChildren = (node: Node, scope: Scope) => {
        for (const child of named(node)) {
            visit(child, scope);
        }
    };

    const visit = (node: Node, scope: Scope): void => {
        switch (node.type) {
            case 'preproc_include': {
                const p = node.childForFieldName('path');
                if (p) {
                    out.includes.push({
                        path: p.text.replace(/^["<]|[">]$/g, ''),
                        system: p.type === 'system_lib_string',
                        ...span(node),
                    });
                }
                return;
            }

            case 'function_definition': {
                const fd = findFunctionDeclarator(node.childForFieldName('declarator'));
                const name = fd && functionName(fd);
                if (!fd || !name) {
                    break; // e.g. K&R or macro-mangled; just walk it
                }
                out.functions.push({
                    kind: 'function',
                    name,
                    signature: signatureOf(node, fd),
                    isStatic: isStatic(node),
                    ...span(node),
                });
                // Return type, parameters and body all belong to this function.
                visitChildren(node, { kind: 'function', name });
                return;
            }

            case 'declaration': {
                // Prototypes only count at file level (not local declarations in bodies).
                if (scope.kind !== 'file') {
                    break;
                }
                let protoName: string | undefined;
                for (const d of fieldNodes(node, 'declarator')) {
                    const fd = findFunctionDeclarator(d);
                    const name = fd && functionName(fd);
                    if (fd && name) {
                        protoName ??= name;
                        out.functions.push({
                            kind: 'prototype',
                            name,
                            signature: signatureOf(node, fd),
                            isStatic: isStatic(node),
                            ...span(node),
                        });
                    }
                }
                // Types in a prototype's signature are used by that prototype;
                // types in a global variable declaration are used at file level.
                visitChildren(node, protoName ? { kind: 'prototype', name: protoName } : scope);
                return;
            }

            case 'call_expression': {
                const callee = node.childForFieldName('function');
                // Only direct calls `foo(...)`; skip function pointers / `obj->fn(...)`.
                if (scope.kind === 'function' && callee?.type === 'identifier') {
                    out.calls.push({ caller: scope.name, callee: callee.text, ...span(node) });
                }
                break; // keep walking: arguments can contain more calls
            }

            case 'struct_specifier':
            case 'union_specifier':
            case 'enum_specifier': {
                const kind = tagKind(node);
                const nameNode = node.childForFieldName('name');
                const body = node.childForFieldName('body');
                if (body) {
                    if (nameNode) {
                        out.types.push({ kind, name: nameNode.text, ...span(node) });
                        // Field types are used by this struct.
                        visitChildren(body, { kind, name: nameNode.text });
                    } else {
                        // Anonymous body: fields belong to whatever encloses it (e.g. a typedef).
                        visitChildren(body, scope);
                    }
                } else if (nameNode) {
                    addRef(scope, nameNode.text, true, nameNode);
                }
                return;
            }

            case 'type_definition': {
                const typeNode = node.childForFieldName('type');
                const names = fieldNodes(node, 'declarator')
                    .map(declaratorName)
                    .filter((n): n is string => n !== null);
                if (!names.length) {
                    if (typeNode) {
                        visit(typeNode, scope);
                    }
                    return;
                }
                const tagged = typeNode && TAGGED_TYPES.has(typeNode.type) ? typeNode : null;
                const tagName = tagged?.childForFieldName('name')?.text;
                let typedefNames = names;
                let typedefScope: Scope = { kind: 'typedef', name: names[0] };
                let aliasOf: TypeDefInfo['aliasOf'] = tagged && tagName ? { kind: tagKind(tagged), name: tagName } : undefined;
                let aliasTextValue = typeNode ? aliasText(typeNode) : undefined;
                if (tagged && !tagName && tagged.childForFieldName('body')) {
                    // `typedef struct { ... } List;`: the typedef is the struct's only
                    // name, so report it as struct `List`. Extra names alias it.
                    const kind = tagKind(tagged);
                    out.types.push({ kind, name: names[0], ...span(node) });
                    typedefScope = { kind, name: names[0] };
                    aliasOf = { kind, name: names[0] };
                    aliasTextValue = `${kind} ${names[0]}`;
                    typedefNames = names.slice(1);
                }
                for (const name of typedefNames) {
                    out.types.push({ kind: 'typedef', name, aliasOf, aliasText: aliasTextValue, ...span(node) });
                }
                if (typeNode) {
                    visit(typeNode, typedefScope);
                }
                // Function-pointer typedefs: parameter types are used by the typedef.
                // (Don't walk declarators generically: the new name is itself a type_identifier.)
                for (const d of fieldNodes(node, 'declarator')) {
                    const params = findFunctionDeclarator(d)?.childForFieldName('parameters');
                    if (params) {
                        visit(params, typedefScope);
                    }
                }
                return;
            }

            case 'type_identifier':
                addRef(scope, node.text, false, node);
                return;
        }

        visitChildren(node, scope);
    };

    visit(root, { kind: 'file' });
    return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function named(node: Node): Node[] {
    return node.namedChildren.filter((c): c is Node => c !== null);
}

function fieldNodes(node: Node, field: string): Node[] {
    return node.childrenForFieldName(field).filter((c): c is Node => c !== null);
}

function span(node: Node): Span {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
}

function scopeKey(scope: Scope): string {
    return scope.kind === 'file' ? 'file' : `${scope.kind}:${scope.name}`;
}

/** struct_specifier/union_specifier -> 'struct' (types.ts has no union kind), enum_specifier -> 'enum' */
function tagKind(node: Node): 'struct' | 'enum' {
    return node.type === 'enum_specifier' ? 'enum' : 'struct';
}

function squash(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

const DECLARATOR_WRAPPERS = new Set(['pointer_declarator', 'attributed_declarator', 'init_declarator']);

/** `Node *list_new(int)` wraps the function_declarator in a pointer_declarator; unwrap it. */
function findFunctionDeclarator(node: Node | null): Node | null {
    while (node) {
        if (node.type === 'function_declarator') {
            return node;
        }
        if (!DECLARATOR_WRAPPERS.has(node.type)) {
            return null;
        }
        node = node.childForFieldName('declarator');
    }
    return null;
}

/**
 * Name of a real function. Returns null for function-pointer variables like
 * `int (*cmp)(int, int);`, whose inner declarator is parenthesized.
 */
function functionName(fd: Node): string | null {
    const d = fd.childForFieldName('declarator');
    return d?.type === 'identifier' ? d.text : null;
}

/** Innermost name of any declarator: `*NodePtr`, `(*cmp_fn)(...)`, `x = 3`, ... */
function declaratorName(node: Node | null): string | null {
    while (node) {
        if (node.type === 'type_identifier' || node.type === 'identifier') {
            return node.text;
        }
        node = node.type === 'parenthesized_declarator'
            ? named(node)[0] ?? null
            : node.childForFieldName('declarator');
    }
    return null;
}

function isStatic(node: Node): boolean {
    return named(node).some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
}

/** Everything from the start of the declaration through the parameter list. */
function signatureOf(node: Node, fd: Node): string {
    return squash(node.text.slice(0, fd.endIndex - node.startIndex));
}

function aliasText(typeNode: Node): string {
    if (TAGGED_TYPES.has(typeNode.type)) {
        const n = typeNode.childForFieldName('name');
        const keyword = typeNode.type.split('_')[0]; // keep `union` as written
        return `${keyword} ${n ? n.text : '(anonymous)'}`;
    }
    return squash(typeNode.text);
}

// ---------------------------------------------------------------------------
// Debug output (Phase 2 verify step)
// ---------------------------------------------------------------------------

/** Human-readable dump for the Output channel. */
export function formatParsedFile(p: ParsedFile): string {
    const L = (s: Span) => `:${s.line}`;
    const lines: string[] = [`=== ${p.filePath} (${p.language})${p.hasErrors ? '  (parse errors)' : ''}`];

    for (const i of p.includes) {
        lines.push(`  include   ${i.system ? `<${i.path}>` : `"${i.path}"`}${L(i)}`);
    }
    for (const f of p.functions) {
        const tag = f.kind === 'function' ? 'def  ' : 'proto';
        lines.push(`  ${tag}     ${f.signature}${f.isStatic ? '  [static]' : ''}${L(f)}`);
    }
    for (const t of p.types) {
        const alias = t.aliasText ? ` = ${t.aliasText}` : '';
        lines.push(`  type      ${t.kind} ${t.name}${alias}${L(t)}`);
    }
    for (const c of p.calls) {
        lines.push(`  call      ${c.caller} -> ${c.callee}${L(c)}`);
    }
    for (const r of p.typeRefs) {
        const from = r.from.kind === 'file' ? 'file' : `${r.from.kind} ${r.from.name}`;
        lines.push(`  uses      ${from} -> ${r.tagged ? 'tag ' : ''}${r.name}${L(r)}`);
    }
    return lines.join('\n');
}
