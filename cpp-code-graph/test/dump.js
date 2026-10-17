// Usage: node test/dump.js <folder>   — parses a folder and prints the graph summary.
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'sample'));
const exts = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.test(e.name)) sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const t0 = Date.now();
const g = buildGraph(sources);
const ms = Date.now() - t0;
if (process.argv.includes('--json')) { console.log(JSON.stringify(g, null, 1)); return; }
const byId = new Map(g.nodes.map(n => [n.id, n]));
const depth = n => { let d = 0; while (n.parent) { n = byId.get(n.parent); d++; } return d; };
if (!process.argv.includes('--quiet')) {
  for (const n of g.nodes) console.log('  '.repeat(depth(n)) + `${n.kind} ${n.name}  [${n.id}] ${n.file || ''}:${n.line || ''}${n.defFile && n.defFile !== n.file ? ' def ' + n.defFile + ':' + n.defLine : ''}`);
  console.log('--- edges');
  for (const e of g.edges) console.log(`${e.kind.padEnd(9)} ${byId.get(e.s).name} -> ${byId.get(e.t).name}${e.uncertain ? ' (?)' : ''} x${e.n}`);
}
console.log(JSON.stringify(g.stats), ms + 'ms');
