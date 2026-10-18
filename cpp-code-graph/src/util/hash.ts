// src/util/hash.ts

// Short, fast, non-cryptographic hash (djb2) of a string, in base 36. Used to
// tell when a file or symbol's text changed (parse cache, AI summary cache).
export function hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
