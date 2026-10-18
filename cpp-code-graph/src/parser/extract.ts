// src/parser/extract.ts
// One walk over a tree-sitter syntax tree that extracts what the graph needs,
// for both grammars: tree-sitter-cpp uses the same node types as tree-sitter-c
// and adds its own (namespaces, classes, methods, qualified names, member
// calls, `new`), which only appear in C++ files.

import type { Node } from 'web-tree-sitter';
import { hashString } from '../util/hash';
import type { CallInfo, FieldInfo, Language, ParsedFile, Scope, Span, SymbolSpan, TypeDefInfo } from './types';

const TAGGED_TYPES = new Set(['struct_specifier', 'union_specifier', 'enum_specifier', 'class_specifier']);

/** The class or struct whose body is being walked (C++). */
interface ClassContext {
    qname: string;
    access: 'public' | 'protected' | 'private';
    info: TypeDefInfo;
}

/** The function definition whose body is being walked. */
interface FunctionContext {
    qname: string;
    /** Parameter and local variable name -> base type name, for member calls. */
    vars: Map<string, string>;
}

interface Context {
    /** Enclosing namespaces (C++) */
    ns: string[];
    cls?: ClassContext;
    fn?: FunctionContext;
}

export function extract(root: Node, filePath: string, language: Language, hash: string): ParsedFile {
    const out: ParsedFile = {
        filePath,
        hash,
        language,
        hasErrors: root.hasError,
        includes: [],
        functions: [],
        calls: [],
        types: [],
        typeRefs: [],
    };
    const cpp = language === 'cpp';

    const seenRefs = new Set<string>();
    const addRef = (from: Scope, name: string, tagged: boolean, node: Node) => {
        const key = `${scopeKey(from)}|${tagged ? 'tag' : 'name'}:${name}`;
        if (seenRefs.has(key)) {
            return;
        }
        seenRefs.add(key);
        out.typeRefs.push({ from, name, tagged, ...span(node) });
    };

    /** A name declared here, with its namespaces and enclosing class. */
    const qualify = (ctx: Context, name: string) => (ctx.cls ? `${ctx.cls.qname}::${name}` : [...ctx.ns, name].join('::'));

    const visitChildren = (node: Node, scope: Scope, ctx: Context) => {
        for (const child of named(node)) {
            visit(child, scope, ctx);
        }
    };

    /** A function definition or a prototype: its name, qname and owner class. */
    const functionNames = (fd: Node, ctx: Context): { name: string; qname: string; owner?: string } | null => {
        const d = fd.childForFieldName('declarator');
        if (!d) {
            return null;
        }
        if (d.type === 'qualified_identifier') {
            // `Circle::area`, `geo::Shape::name` (an out-of-line method, or a function in a namespace)
            const parts = qualifiedParts(d);
            const qname = [...ctx.ns, ...parts].join('::');
            const owner = parts.length > 1 ? [...ctx.ns, ...parts.slice(0, -1)].join('::') : undefined;
            return { name: parts[parts.length - 1], qname, owner };
        }
        const name = simpleName(d);
        if (!name) {
            return null; // e.g. a function-pointer variable `int (*cmp)(int, int);`
        }
        if (ctx.cls) {
            return { name, qname: `${ctx.cls.qname}::${name}`, owner: ctx.cls.qname };
        }
        return { name, qname: qualify(ctx, name) };
    };

    /** Flags of a function or method declared by `node` (a definition, declaration or field_declaration). */
    const flags = (node: Node, fd: Node, ctx: Context) => ({
        isStatic: isStatic(node),
        ...(hasChild(node, 'virtual') ? { isVirtual: true } : {}),
        ...(node.type === 'field_declaration' && node.childForFieldName('default_value')?.text === '0' ? { isPure: true } : {}),
        ...(named(fd).some((c) => c.type === 'virtual_specifier') ? { isOverride: true } : {}),
        ...(ctx.cls ? { access: ctx.cls.access } : {}),
    });

    /** Record a declaration's variables (parameters, locals) with their types, for member calls. */
    const recordVars = (node: Node, ctx: Context) => {
        const type = baseTypeName(node.childForFieldName('type'));
        if (!ctx.fn || !type) {
            return;
        }
        for (const d of fieldNodes(node, 'declarator')) {
            const name = declaratorName(d);
            if (name) {
                ctx.fn.vars.set(name, type);
            }
        }
    };

    const visit = (node: Node, scope: Scope, ctx: Context): void => {
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

            case 'namespace_definition': {
                // `namespace a::b {` and anonymous namespaces (no name) too.
                const name = node.childForFieldName('name')?.text;
                const body = node.childForFieldName('body');
                if (body) {
                    visitChildren(body, scope, { ...ctx, ns: name ? [...ctx.ns, ...name.split('::')] : ctx.ns });
                }
                return;
            }

            case 'function_definition': {
                const fd = findFunctionDeclarator(node.childForFieldName('declarator'));
                const names = fd && functionNames(fd, ctx);
                if (!fd || !names) {
                    break; // e.g. K&R or macro-mangled; just walk it
                }
                out.functions.push({
                    kind: 'function',
                    ...names,
                    signature: signatureOf(node, fd),
                    ...flags(node, fd, ctx),
                    ...symbolSpan(node),
                });
                // Return type, parameters and body all belong to this function. A
                // method body sees its class (for `this->f()` and bare calls).
                const fnScope: Scope = { kind: 'function', name: names.qname };
                const fnCtx: Context = { ns: ctx.ns, cls: ctx.cls, fn: { qname: names.qname, vars: new Map() } };
                visitChildren(node, fnScope, fnCtx);
                return;
            }

            case 'declaration':
            case 'field_declaration': {
                // Inside a function body: a local variable. Remember its type, then walk the initializers.
                if (ctx.fn) {
                    recordVars(node, ctx);
                    break;
                }
                let protoName: string | undefined;
                for (const d of fieldNodes(node, 'declarator')) {
                    const fd = findFunctionDeclarator(d);
                    const names = fd && functionNames(fd, ctx);
                    if (fd && names) {
                        protoName ??= names.qname;
                        out.functions.push({
                            kind: 'prototype',
                            ...names,
                            signature: signatureOf(node, fd),
                            ...flags(node, fd, ctx),
                            ...symbolSpan(node),
                        });
                    } else if (ctx.cls && node.type === 'field_declaration') {
                        const name = declaratorName(d);
                        if (name) {
                            (ctx.cls.info.fields ??= []).push({
                                name,
                                type: baseTypeName(node.childForFieldName('type')),
                                signature: squash(node.text.replace(/;s*$/, '').replace(/s*=.*$/s, '')),
                                isStatic: isStatic(node),
                                access: ctx.cls.access,
                                ...symbolSpan(node),
                            } satisfies FieldInfo);
                        }
                    }
                }
                // Types in a prototype's signature are used by that prototype;
                // types in a variable or field declaration by the file or the class.
                visitChildren(node, protoName ? { kind: 'prototype', name: protoName } : scope, ctx);
                return;
            }

            case 'parameter_declaration':
            case 'optional_parameter_declaration':
                recordVars(node, ctx);
                break;

            case 'access_specifier':
                if (ctx.cls) {
                    const a = node.text.replace(/:$/, '').trim();
                    if (a === 'public' || a === 'protected' || a === 'private') {
                        ctx.cls.access = a;
                    }
                }
                return;

            case 'call_expression': {
                const call = ctx.fn && callOf(node, ctx.fn);
                if (call) {
                    out.calls.push(call);
                }
                break; // keep walking: arguments can contain more calls
            }

            case 'new_expression': {
                const type = node.childForFieldName('type');
                const qualified = baseTypeName(type);
                if (ctx.fn && qualified) {
                    out.calls.push({ caller: ctx.fn.qname, callee: lastPart(qualified), qualified, ctor: true, ...span(node) });
                }
                break;
            }

            case 'class_specifier':
            case 'struct_specifier':
            case 'union_specifier':
            case 'enum_specifier': {
                const kind = tagKind(node);
                const nameNode = node.childForFieldName('name');
                const body = node.childForFieldName('body');
                if (body) {
                    if (nameNode) {
                        const name = lastPart(nameNode.text);
                        const qname = qualify(ctx, name);
                        const info: TypeDefInfo = { kind, name, qname, ...symbolSpan(node) };
                        const bases = named(node)
                            .filter((c) => c.type === 'base_class_clause')
                            .flatMap((c) => named(c).filter((b) => b.type !== 'access_specifier').map((b) => baseTypeName(b)))
                            .filter((b): b is string => !!b);
                        if (bases.length) {
                            info.bases = bases;
                        }
                        out.types.push(info);
                        // Bases become `inherits` arrows (the builder), so they aren't walked as type uses.
                        const memberScope: Scope = { kind, name: qname };
                        // C++ classes and structs hold methods; C structs only fields.
                        const inner: Context =
                            cpp && kind !== 'enum'
                                ? { ns: ctx.ns, cls: { qname, access: node.type === 'class_specifier' ? 'private' : 'public', info } }
                                : { ns: ctx.ns };
                        visitChildren(body, memberScope, inner);
                    } else {
                        // Anonymous body: fields belong to whatever encloses it (e.g. a typedef).
                        visitChildren(body, scope, ctx);
                    }
                } else if (nameNode) {
                    addRef(scope, lastPart(nameNode.text), kind !== 'class', nameNode);
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
                        visit(typeNode, scope, ctx);
                    }
                    return;
                }
                const tagged = typeNode && TAGGED_TYPES.has(typeNode.type) ? typeNode : null;
                const tagName = tagged?.childForFieldName('name')?.text;
                let typedefNames = names;
                let typedefScope: Scope = { kind: 'typedef', name: qualify(ctx, names[0]) };
                const tagAs = (t: Node) => (tagKind(t) === 'enum' ? 'enum' : 'struct');
                let aliasOf: TypeDefInfo['aliasOf'] = tagged && tagName ? { kind: tagAs(tagged), name: tagName } : undefined;
                let aliasTextValue = typeNode ? aliasText(typeNode) : undefined;
                if (tagged && !tagName && tagged.childForFieldName('body')) {
                    // `typedef struct { ... } List;`: the typedef is the struct's only
                    // name, so report it as struct `List`. Extra names alias it.
                    const kind = tagAs(tagged);
                    const qname = qualify(ctx, names[0]);
                    out.types.push({ kind, name: names[0], qname, ...symbolSpan(node) });
                    typedefScope = { kind, name: qname };
                    aliasOf = { kind, name: names[0] };
                    aliasTextValue = `${kind} ${names[0]}`;
                    typedefNames = names.slice(1);
                    const body = tagged.childForFieldName('body');
                    if (body) {
                        visitChildren(body, typedefScope, { ns: ctx.ns });
                    }
                } else if (typeNode) {
                    visit(typeNode, typedefScope, ctx);
                }
                for (const name of typedefNames) {
                    out.types.push({ kind: 'typedef', name, qname: qualify(ctx, name), aliasOf, aliasText: aliasTextValue, ...symbolSpan(node) });
                }
                // Function-pointer typedefs: parameter types are used by the typedef.
                // (Don't walk declarators generically: the new name is itself a type_identifier.)
                for (const d of fieldNodes(node, 'declarator')) {
                    const params = findFunctionDeclarator(d)?.childForFieldName('parameters');
                    if (params) {
                        visit(params, typedefScope, ctx);
                    }
                }
                return;
            }

            case 'alias_declaration': {
                // C++ `using Name = Type;` is a typedef.
                const name = node.childForFieldName('name')?.text;
                const typeNode = node.childForFieldName('type');
                if (!name) {
                    break;
                }
                const qname = qualify(ctx, name);
                out.types.push({ kind: 'typedef', name, qname, aliasText: typeNode ? squash(typeNode.text) : undefined, ...symbolSpan(node) });
                if (typeNode) {
                    visit(typeNode, { kind: 'typedef', name: qname }, ctx);
                }
                return;
            }

            // In `geo::Shape` the walk reaches `Shape` as a type_identifier, so
            // qualified types need no case of their own.
            case 'type_identifier':
                addRef(scope, node.text, false, node);
                return;
        }

        visitChildren(node, scope, ctx);
    };

    /** What a call_expression calls, or null for calls through function pointers and the like. */
    const callOf = (node: Node, fn: FunctionContext): CallInfo | null => {
        const f = node.childForFieldName('function');
        const where = span(node);
        if (!f) {
            return null;
        }
        switch (f.type) {
            case 'identifier':
                return { caller: fn.qname, callee: f.text, ...where };
            case 'template_function': {
                const name = f.childForFieldName('name')?.text;
                return name ? { caller: fn.qname, callee: lastPart(name), ...where } : null;
            }
            case 'qualified_identifier': {
                const qualified = qualifiedParts(f).join('::');
                return { caller: fn.qname, callee: lastPart(qualified), qualified, ...where };
            }
            case 'field_expression': {
                const field = f.childForFieldName('field');
                if (!field) {
                    return null;
                }
                const receiver = receiverName(f.childForFieldName('argument'));
                const call: CallInfo = { caller: fn.qname, callee: lastPart(field.text), member: true, ...where };
                if (receiver) {
                    call.receiver = receiver;
                    const type = fn.vars.get(receiver);
                    if (type) {
                        call.receiverType = type;
                    }
                }
                return call;
            }
        }
        return null;
    };

    visit(root, { kind: 'file' }, { ns: [] });
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

function hasChild(node: Node, type: string): boolean {
    return node.children.some((c) => c?.type === type);
}

function span(node: Node): Span {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
}

function symbolSpan(node: Node): SymbolSpan {
    return { ...span(node), hash: hashString(node.text) };
}

function scopeKey(scope: Scope): string {
    return scope.kind === 'file' ? 'file' : `${scope.kind}:${scope.name}`;
}

/** class_specifier -> 'class', struct/union -> 'struct' (types.ts has no union kind), enum -> 'enum' */
function tagKind(node: Node): 'class' | 'struct' | 'enum' {
    return node.type === 'enum_specifier' ? 'enum' : node.type === 'class_specifier' ? 'class' : 'struct';
}

function squash(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function lastPart(qname: string): string {
    return qname.split('::').pop() ?? qname;
}

/** `geo::Shape::name` -> ['geo', 'Shape', 'name'] (template arguments dropped). */
function qualifiedParts(node: Node): string[] {
    const parts: string[] = [];
    let n: Node | null = node;
    while (n && n.type === 'qualified_identifier') {
        const scope = n.childForFieldName('scope');
        if (scope) {
            parts.push(scope.type === 'template_type' ? (scope.childForFieldName('name')?.text ?? scope.text) : scope.text);
        }
        n = n.childForFieldName('name');
    }
    if (n) {
        parts.push(n.type === 'template_function' || n.type === 'template_type' ? (n.childForFieldName('name')?.text ?? n.text) : n.text);
    }
    return parts.filter(Boolean);
}

/** The type a declaration names, without qualifiers, pointers or template arguments: `geo::Circle`, `Node`. */
function baseTypeName(type: Node | null | undefined): string | undefined {
    if (!type) {
        return undefined;
    }
    switch (type.type) {
        case 'type_identifier':
            return type.text;
        case 'qualified_identifier':
            return qualifiedParts(type).join('::');
        case 'template_type':
            return type.childForFieldName('name')?.text;
        case 'struct_specifier':
        case 'class_specifier':
        case 'union_specifier':
        case 'enum_specifier':
            return type.childForFieldName('name')?.text;
    }
    return undefined;
}

/** The plain name a member call is made on: `obj` in `obj.f()`, `shapes` in `shapes[i]->f()`, `this`. */
function receiverName(node: Node | null): string | undefined {
    while (node) {
        if (node.type === 'identifier' || node.type === 'field_identifier') {
            return node.text;
        }
        if (node.type === 'this') {
            return 'this';
        }
        if (node.type === 'subscript_expression' || node.type === 'pointer_expression' || node.type === 'parenthesized_expression') {
            node = node.childForFieldName('argument') ?? named(node)[0] ?? null;
            continue;
        }
        return undefined;
    }
    return undefined;
}

const DECLARATOR_WRAPPERS = new Set(['pointer_declarator', 'reference_declarator', 'attributed_declarator', 'init_declarator']);

/** `Node *list_new(int)` wraps the function_declarator in a pointer_declarator; unwrap it. */
function findFunctionDeclarator(node: Node | null): Node | null {
    while (node) {
        if (node.type === 'function_declarator') {
            return node;
        }
        if (!DECLARATOR_WRAPPERS.has(node.type)) {
            return null;
        }
        // reference_declarator has no `declarator` field: its declarator is its only named child.
        node = node.childForFieldName('declarator') ?? (node.type === 'reference_declarator' ? named(node)[0] ?? null : null);
    }
    return null;
}

/**
 * Name of a real function or method. Returns null for function-pointer
 * variables like `int (*cmp)(int, int);`, whose inner declarator is parenthesized.
 */
function simpleName(d: Node): string | null {
    switch (d.type) {
        case 'identifier':
        case 'field_identifier':
        case 'operator_name':
            return d.text;
        case 'destructor_name':
            return squash(d.text);
    }
    return null;
}

/** Innermost name of any declarator: `*NodePtr`, `(*cmp_fn)(...)`, `x = 3`, `&ref`, ... */
function declaratorName(node: Node | null): string | null {
    while (node) {
        if (node.type === 'type_identifier' || node.type === 'identifier' || node.type === 'field_identifier') {
            return node.text;
        }
        node =
            node.type === 'parenthesized_declarator' || node.type === 'reference_declarator'
                ? named(node)[0] ?? null
                : node.childForFieldName('declarator');
    }
    return null;
}

function isStatic(node: Node): boolean {
    return named(node).some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
}

/** Everything from the start of the declaration through the parameter list (and `const`). */
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
