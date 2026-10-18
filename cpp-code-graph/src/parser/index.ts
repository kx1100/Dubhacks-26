// src/parser/index.ts

// The C/C++ parser: tree-sitter-c for C files, tree-sitter-cpp for C++ files,
// one extractor for both (extract.ts). Everything outside src/parser uses only
// this module.
//
//   await initParsers(context);                 // once, loads the .wasm grammars
//   const lang = languageFor(path, hasCpp);     // which grammar a file needs
//   const parsed = parseSource(path, text, lang);

import { hashString } from '../util/hash';
import { extract } from './extract';
import { parserFor } from './loader';
import type { Language, ParsedFile, Span } from './types';

export { initParsers, type ExtensionPaths } from './loader';
export type * from './types';

const C_SOURCE = /\.c$/;
const CPP_SOURCE = /\.(cc|cpp|cxx|c\+\+|C)$/;
const CPP_HEADER = /\.(hh|hpp|hxx|h\+\+|inl|ipp|tpp|H)$/;
/** Every file the parser reads: C and C++ sources and headers. */
export const SOURCE_FILE = /\.(c|cc|cpp|cxx|c\+\+|C|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|H)$/;

/** True if a set of paths has C++ sources (or C++-only headers), which makes `.h` files C++. */
export function hasCppFiles(paths: Iterable<string>): boolean {
    for (const p of paths) {
        if (CPP_SOURCE.test(p) || CPP_HEADER.test(p)) {
            return true;
        }
    }
    return false;
}

/**
 * The grammar for a file: `.c` is C, C++ extensions are C++, and `.h` is C++
 * in a project that has C++ files (so classes and `extern "C"` in headers
 * parse), otherwise C (C code can use C++ keywords such as `new` as names).
 */
export function languageFor(path: string, hasCpp: boolean): Language {
    if (C_SOURCE.test(path)) {
        return 'c';
    }
    if (CPP_SOURCE.test(path) || CPP_HEADER.test(path)) {
        return 'cpp';
    }
    return hasCpp ? 'cpp' : 'c';
}

/** Parse one file. initParsers must have finished. */
export function parseSource(filePath: string, sourceCode: string, language: Language): ParsedFile {
    const tree = parserFor(language).parse(sourceCode);
    if (!tree) {
        throw new Error(`tree-sitter failed to parse ${filePath}`);
    }
    try {
        return extract(tree.rootNode, filePath, language, hashString(sourceCode));
    } finally {
        tree.delete(); // WASM memory isn't garbage-collected
    }
}

// ---------------------------------------------------------------------------
// Debug output (Code Graph: Dump Parsed Symbols)
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
        const extra = [f.isStatic && 'static', f.isVirtual && 'virtual', f.isPure && 'pure', f.isOverride && 'override', f.access]
            .filter(Boolean)
            .join(', ');
        const qname = f.qname !== f.name ? `  (${f.qname})` : '';
        lines.push(`  ${tag}     ${f.signature}${qname}${extra ? `  [${extra}]` : ''}${L(f)}`);
    }
    for (const t of p.types) {
        const alias = t.aliasText ? ` = ${t.aliasText}` : '';
        const bases = t.bases ? ` : ${t.bases.join(', ')}` : '';
        lines.push(`  type      ${t.kind} ${t.qname}${bases}${alias}${L(t)}`);
    }
    for (const c of p.calls) {
        const callee = c.qualified ?? (c.member ? `${c.receiver ?? '?'}${c.receiverType ? `:${c.receiverType}` : ''}.${c.callee}` : c.callee);
        lines.push(`  call      ${c.caller} -> ${c.ctor ? 'new ' : ''}${callee}${L(c)}`);
    }
    for (const r of p.typeRefs) {
        const from = r.from.kind === 'file' ? 'file' : `${r.from.kind} ${r.from.name}`;
        lines.push(`  uses      ${from} -> ${r.tagged ? 'tag ' : ''}${r.name}${L(r)}`);
    }
    return lines.join('\n');
}
