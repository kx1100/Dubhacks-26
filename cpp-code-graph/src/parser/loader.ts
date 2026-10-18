// src/parser/loader.ts

// Loads the tree-sitter runtime and the C and C++ grammars (WASM), once per
// extension host. esbuild.mjs copies the three .wasm files into out/parsers/.

import { Parser, Language as Grammar } from 'web-tree-sitter';
import type { Language } from './types';
// resolves a path inside the extension folder (vscode.ExtensionContext.asAbsolutePath)
export interface ExtensionPaths {
    asAbsolutePath(relativePath: string): string;
}

const GRAMMAR_FILE: Record<Language, string> = {
    c: 'out/parsers/tree-sitter-c.wasm',
    cpp: 'out/parsers/tree-sitter-cpp.wasm',
};

let loading: Promise<void> | undefined;
let parsers: Record<Language, Parser> | undefined;

// initialize parsers, load both grammars (c/c++)
export function initParsers(paths: ExtensionPaths): Promise<void> {
    if (!loading) {
        loading = (async () => {
            // after esbuild bundling, web-tree-sitter can't find its own runtime
            // .wasm next to the bundle, so point it at out/parsers/ explicitly.
            await Parser.init({ locateFile: (file: string) => paths.asAbsolutePath(`out/parsers/${file}`) });
            const make = async (lang: Language) => {
                const parser = new Parser();
                parser.setLanguage(await Grammar.load(paths.asAbsolutePath(GRAMMAR_FILE[lang])));
                return parser;
            };
            const [c, cpp] = await Promise.all([make('c'), make('cpp')]);
            parsers = { c, cpp };
        })();
        // if loading fails, allow a later call to retry instead of caching the rejection.
        loading.catch(() => {
            loading = undefined;
        });
    }
    return loading;
}

// the parser for a language, throws an error if initParsers hasn't finished
export function parserFor(lang: Language): Parser {
    if (!parsers) {
        throw new Error('The C/C++ parsers are not loaded yet (await initParsers first).');
    }
    return parsers[lang];
}
