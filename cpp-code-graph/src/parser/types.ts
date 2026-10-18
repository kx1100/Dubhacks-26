// src/parser/types.ts
// What the parser extracts from one file (parser -> graph/builder.ts). Not
// part of the webview contract in src/types.ts.
//
// All line numbers are 1-based, the same as GraphNode.line. Names come in two
// forms: `name` as written (`area`) and `qname` with its namespaces and classes
// (`geo::Circle::area`); in C the two are the same.

import type { Language } from '../types';

export type { Language };

/** 1-based, inclusive line range. */
export interface Span {
    line: number;
    endLine: number;
}

/** A symbol's span plus a hash of its text, so a changed symbol can be told apart. */
export interface SymbolSpan extends Span {
    hash: string;
}

export interface IncludeInfo extends Span {
    /** Path as written, without quotes/brackets: `#include "list.h"` -> `list.h` */
    path: string;
    /** true for `<stdio.h>`; the builder skips these */
    system: boolean;
}

/** 'function' has a body, 'prototype' is a declaration without one (the builder merges them). */
export type FunctionKind = 'function' | 'prototype';

export interface FunctionInfo extends SymbolSpan {
    kind: FunctionKind;
    name: string;
    qname: string;
    /** Methods: qname of the class, e.g. `geo::Circle` (in the class body or from `Circle::area`). */
    owner?: string;
    /** e.g. `static Node *list_new(int value)` (whitespace collapsed, no body) */
    signature: string;
    isStatic: boolean;
    isVirtual?: boolean;
    /** `= 0` */
    isPure?: boolean;
    /** marked `override` (or `final`) */
    isOverride?: boolean;
    /** Methods declared in a class body */
    access?: 'public' | 'protected' | 'private';
}

export interface CallInfo extends Span {
    /** qname of the function definition the call is in */
    caller: string;
    /** The called name as written last: `f` in `f()`, `ns::f()`, `obj.f()` */
    callee: string;
    /** `ns::f()`, `Cls::f()`: the whole qualified name (`ns::f`) */
    qualified?: string;
    /** `obj.f()` / `p->f()` / `this->f()` */
    member?: boolean;
    /** The object of a member call when it is a plain name (`obj`, `this`). */
    receiver?: string;
    /** Its declared type, when it is a parameter or local of the calling function. */
    receiverType?: string;
    /** `new T(...)`: callee and qualified name the type */
    ctor?: boolean;
}

/** Type kinds as they appear in the graph: unions are 'struct'. */
export type TypeNodeKind = 'struct' | 'enum' | 'typedef' | 'class';

export interface FieldInfo extends SymbolSpan {
    name: string;
    /** Base type name, e.g. `Canvas` for `Canvas *canvas_` */
    type?: string;
    /** The declaration as written, e.g. `std::vector<int> pixels_` */
    signature: string;
    isStatic: boolean;
    access?: 'public' | 'protected' | 'private';
}

export interface TypeDefInfo extends SymbolSpan {
    kind: TypeNodeKind;
    name: string;
    qname: string;
    /**
     * typedefs only: the struct/enum the name stands for when it has a tag,
     * e.g. `typedef struct Node Node;` -> { kind: 'struct', name: 'Node' }.
     * (`typedef struct { ... } List;` has no tag, so it is reported as struct `List` instead.)
     */
    aliasOf?: { kind: 'struct' | 'enum'; name: string };
    /** typedefs only: the aliased type as written, e.g. `struct Node`, `int`, `unsigned long` */
    aliasText?: string;
    /** C++ classes and structs: base classes as written (`Shape`, `geo::Shape`) */
    bases?: string[];
    /** C++ classes and structs: data members, for resolving `member_.f()` calls */
    fields?: FieldInfo[];
}

/**
 * Where something appears. For symbols, `kind` + `name` (the qname) identify
 * the node in the same file: a function's signature or body, a prototype, a
 * type's members, or a typedef. 'file' is file level (global variables).
 */
export type Scope = { kind: 'file' } | { kind: FunctionKind | TypeNodeKind; name: string };

export interface TypeRefInfo extends Span {
    from: Scope;
    name: string;
    /**
     * true when written with a keyword (`struct Node`, `enum Color`): look the
     * name up among struct/union/enum tags. false for a bare name (`Node`,
     * `size_t`): look it up among typedefs and classes. The builder drops names
     * it can't resolve to a workspace type.
     */
    tagged: boolean;
}

export interface ParsedFile {
    filePath: string;
    /** hashString of the whole text */
    hash: string;
    /** The grammar it was parsed with. */
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
