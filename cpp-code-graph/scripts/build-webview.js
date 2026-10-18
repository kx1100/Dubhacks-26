// Bundles the webview: media/webview/main.js -> media/dist/graph.js (one IIFE script).
// Usage: node scripts/build-webview.js [--watch] [--minify]
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const options = {
  entryPoints: [path.join(root, 'media', 'webview', 'main.js')],
  outfile: path.join(root, 'media', 'dist', 'graph.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info'
};

/** Builds once, synchronously (used by the tests so they never run a stale bundle). */
function build(extra) {
  esbuild.buildSync({ ...options, logLevel: 'warning', ...extra });
}

module.exports = { build, options };

if (require.main === module) {
  const watch = process.argv.includes('--watch');
  const minify = process.argv.includes('--minify');
  if (watch) esbuild.context({ ...options, minify }).then(ctx => ctx.watch());
  else esbuild.build({ ...options, minify }).catch(() => process.exit(1));
}
