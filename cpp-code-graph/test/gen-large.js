// Writes a synthetic C project for looking at big graphs and timing the layout:
//   node test/gen-large.js [dir] [modules]     (default: test/large, 40 modules)
// Then: node test/make-fixtures.js <dir> test   and open the harness with ?large.
// Modules are spread over folders; each calls a few functions of other modules.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(__dirname, 'large'));
const count = +process.argv[3] || 40;
const folders = ['core', 'net', 'storage', 'ui', 'util', 'plugins'];
const FUNCS = 5;

// Small deterministic pseudo-random numbers so the output is the same every run.
let seed = 12345;
const rand = n => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >> 16) % n; // the low bits of this generator are not random
};

const modules = Array.from({ length: count }, (_, i) => ({ i, name: 'mod' + i, folder: folders[i % folders.length] }));
fs.rmSync(dir, { recursive: true, force: true });
for (const m of modules) {
  fs.mkdirSync(path.join(dir, m.folder), { recursive: true });
  let h = `#ifndef ${m.name.toUpperCase()}_H\n#define ${m.name.toUpperCase()}_H\n\n`;
  for (let f = 0; f < FUNCS; f++) h += `int ${m.name}_f${f}(int a);\n`;
  h += '\n#endif\n';
  const others = new Set();
  while (others.size < 3) {
    const o = modules[rand(count)];
    if (o !== m) others.add(o);
  }
  let c = `#include "${m.name}.h"\n` + [...others].map(o => `#include "../${o.folder}/${o.name}.h"\n`).join('') + '\n';
  for (let f = 0; f < FUNCS; f++) {
    const calls = [...others].map(o => `${o.name}_f${rand(FUNCS)}(a)`);
    c += `int ${m.name}_f${f}(int a) {\n  return a + ${f}${f ? ' + ' + m.name + '_f' + (f - 1) + '(a)' : ''}${rand(2) ? ' + ' + calls.join(' + ') : ''};\n}\n\n`;
  }
  fs.writeFileSync(path.join(dir, m.folder, m.name + '.h'), h);
  fs.writeFileSync(path.join(dir, m.folder, m.name + '.c'), c);
}
console.log(`wrote ${count * 2} files to ${dir}`);
