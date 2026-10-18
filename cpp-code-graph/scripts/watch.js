// Rebuilds the extension host and the webview bundles on every change.
// Usage: node scripts/watch.js
const esbuild = require('esbuild');
const extension = require('./build-extension');
const webview = require('./build-webview');

extension.copyParsers();
for (const options of [extension.options, webview.options]) esbuild.context(options).then(ctx => ctx.watch());
