// Parses each file under a folder separately and reports the slowest ones.
// Usage: node test/run.js test/timing.js <folder> [max files]
const fs = require('fs'), path = require('path');
const { parseSource, languageFor, hasCppFiles } = require('../src/parser');
const root = process.argv[2]; const limit = +process.argv[3] || 2000;
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (files.length >= limit) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(c|cc|cpp|h|hpp)$/i.test(e.name)) files.push(p); } })(root);
const times = []; let total = 0, bytes = 0; const hasCpp = hasCppFiles(files);
for (const f of files) { const t = fs.readFileSync(f, 'utf8'); bytes += t.length; const t0 = process.hrtime.bigint(); const r = parseSource(f, t, languageFor(f, hasCpp)); const ms = Number(process.hrtime.bigint() - t0) / 1e6; total += ms; times.push([ms, t.length, f, r.hasErrors ? 'ERR' : '']); }
times.sort((a, b) => b[0] - a[0]);
console.log(files.length, 'files', (bytes / 1e6).toFixed(1) + 'MB', total.toFixed(0) + 'ms');
for (const t of times.slice(0, 6)) console.log(t[0].toFixed(0) + 'ms', t[1], t[2], t[3]);
