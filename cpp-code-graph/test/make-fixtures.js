// Builds JSON fixtures for the webview harness: the sample graph and its sources.
// Usage: node test/run.js test/make-fixtures.js [<project dir> [<out dir>]]
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder.ts');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'sample');
const exts = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
function read(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.test(e.name)) out.push({ path: path.relative(dir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  })(dir);
  return out;
}
const toMap = list => Object.fromEntries(list.map(s => [s.path, s.text]));
const sources = read(root);
const g = buildGraph(sources);
const outDir = process.argv[3] ? path.resolve(process.argv[3]) : __dirname;
fs.writeFileSync(path.join(outDir, 'fixtures.js'), 'window.__FIXTURES = ' + JSON.stringify({ graph: g, sources: toMap(sources) }) + ';\n');
console.log('nodes', g.nodes.length, 'edges', g.edges.length);
