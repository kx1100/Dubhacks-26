const fs = require('fs'), path = require('path');
const root = process.argv[2]; const limit = +process.argv[3] || 2000;
const sources = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (sources.length >= limit) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(c|cc|cpp|h|hpp)$/i.test(e.name)) sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }); } })(root);
const { buildGraph } = require('../src/graph/builder');
const t0 = Date.now(); const g = buildGraph(sources); console.log(sources.length, 'files', Date.now() - t0, 'ms', g.nodes.length, 'nodes', g.edges.length, 'edges', (JSON.stringify(g).length / 1e6).toFixed(1) + 'MB json');
