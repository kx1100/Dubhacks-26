// Bundles the extension host: src/extension.ts (with src/ai/*.js and
// web-tree-sitter) -> out/extension.js, and copies the tree-sitter runtime and
// grammars (parsers/*.wasm) to out/parsers/, where src/parser/loader.ts looks.
// Usage: node scripts/build-extension.js [--watch] [--minify]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');
const options = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(out, 'extension.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  // web-tree-sitter's ESM build reads import.meta.url, which a CommonJS bundle doesn't have.
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': 'importMetaUrl' },
  sourcemap: true,
  logLevel: 'info'
};

function copyParsers() {
  const dest = path.join(out, 'parsers');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, 'parsers'))) {
    if (f.endsWith('.wasm')) fs.copyFileSync(path.join(root, 'parsers', f), path.join(dest, f));
  }
}

/** Builds once, synchronously (used by the tests so they never run a stale bundle). */
function build(extra) {
  esbuild.buildSync({ ...options, logLevel: 'warning', ...extra });
  copyParsers();
}

module.exports = { build, options, copyParsers };

if (require.main === module) {
  const watch = process.argv.includes('--watch');
  const minify = process.argv.includes('--minify');
  copyParsers();
  if (watch) esbuild.context({ ...options, minify }).then(ctx => ctx.watch());
  else esbuild.build({ ...options, minify }).catch(() => process.exit(1));
}
