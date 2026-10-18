// Bundles the webview: media/main.js -> media/dist/graph.js (one IIFE script).
// (The previous webview's entry point, media/webview/main.js, is no longer
// built; only its side panel is, see panelBridge below.)
// Usage: node scripts/build-webview.js [--watch] [--minify]
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const oldWebview = path.join(root, 'media', 'webview');
const bridge = path.join(root, 'media', 'panel-bridge.js');

// The side panel comes from the previous webview (media/webview/panels). Its
// imports of the old page, state, renderer and entry point go to
// media/panel-bridge.js, which connects the panel to this webview's graph.
const panelBridge = {
  name: 'panel-bridge',
  setup(build) {
    build.onResolve({ filter: /(^|\/)(shell|state|renderer|main)\.js$/ }, args =>
      args.importer.startsWith(oldWebview) ? { path: bridge } : undefined
    );
  }
};

const options = {
  entryPoints: [path.join(root, 'media', 'main.js')],
  outfile: path.join(root, 'media', 'dist', 'graph.js'),
  plugins: [panelBridge],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info'
};

/**
 * Builds once, synchronously (used by the tests so they never run a stale
 * bundle). buildSync can't run plugins, so the build runs in a child process.
 */
function build(extra) {
  require('child_process').execFileSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, BUILD_WEBVIEW_OPTIONS: JSON.stringify({ logLevel: 'warning', ...extra }) }
  });
}

module.exports = { build, options };

if (require.main === module) {
  const watch = process.argv.includes('--watch');
  const minify = process.argv.includes('--minify');
  const extra = JSON.parse(process.env.BUILD_WEBVIEW_OPTIONS || '{}');
  if (watch) esbuild.context({ ...options, minify }).then(ctx => ctx.watch());
  else esbuild.build({ ...options, minify, ...extra }).catch(() => process.exit(1));
}
