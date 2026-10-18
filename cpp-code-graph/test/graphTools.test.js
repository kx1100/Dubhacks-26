// Checks src/ai/graphTools.js against sample/: node test/graphTools.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder.ts');
const { GraphTools, tokenize } = require('../src/ai/graphTools');

const root = path.join(__dirname, '..', 'sample');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const graph = buildGraph(sources);
const reads = [];
const tools = new GraphTools(graph, {
  readSource: async f => {
    reads.push(f);
    const p = path.join(root, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
});
const id = name => tools.resolve(name).id;
const refsIn = text => text.match(/N\d+/g) || [];

(async () => {
  // tokenize splits identifiers and stems words.
  assert.deepStrictEqual(tokenize('pixelCount'), ['pixelcount', 'pixel', 'count']);
  assert.deepStrictEqual(tokenize('log_message'), ['log_message', 'log', 'message']);
  assert.ok(tokenize('messages drawing').includes('message') && tokenize('messages drawing').includes('draw'));

  // resolve accepts refs, ids, qualified names, names and file names.
  const render = graph.nodes.find(n => n.qname === 'geo::Canvas::render');
  const ref = tools.ref(render.id);
  assert.match(ref, /^N\d+$/);
  for (const x of [ref, '[[' + ref + ']]', render.id, 'geo::Canvas::render', 'render', 'geo::Canvas::render()']) assert.strictEqual(tools.resolve(x), render, 'resolve ' + x);
  assert.strictEqual(tools.resolve('main.cpp').kind, 'file');
  assert.strictEqual(tools.resolve('nope_nothing'), null);
  assert.strictEqual(tools.resolve('Canvas').kind, 'class');

  // searchSymbols ranks by name match and supports prefixes.
  let r = tools.searchSymbols('how are log messages written');
  assert.strictEqual(r.nodeIds[0], id('log_message'));
  r = tools.searchSymbols('pixel');
  assert.ok(r.nodeIds.includes(id('pixelCount')) && r.nodeIds.includes(id('geo::Canvas::pixels_')));
  r = tools.searchSymbols('draw', { kinds: ['method'] });
  assert.ok(r.nodeIds.length >= 2 && r.nodeIds.every(x => tools.nodes.get(x).kind === 'method'));
  assert.strictEqual(tools.searchSymbols('the and of').nodeIds.length, 0);
  assert.ok(refsIn(r.text).every(x => tools.byRef.has(x)), 'search text uses known refs');

  // Body tokens only after indexSources.
  assert.strictEqual(tools.searchSymbols('fprintf').nodeIds.length, 0);
  await tools.indexSources();
  assert.strictEqual(tools.searchSymbols('fprintf').nodeIds[0], id('log_message'));

  // getNode describes a node and its members.
  r = tools.getNode('Canvas');
  assert.match(r.text, /class geo::Canvas/);
  assert.match(r.text, /contains \(5\)/);
  assert.match(r.text, /incoming: type-use/);
  r = tools.getNode('log_init');
  assert.match(r.text, /declared: c\/logger.h:15/);
  assert.match(r.text, /defined: c\/logger.c:16/);
  assert.match(tools.getNode('nope_nothing').text, /No node matches/);

  // neighbors: direction, kind filter, call sites and uncertainty.
  r = tools.neighbors('render', { dir: 'out', kinds: ['call'] });
  assert.ok(r.nodeIds.includes(id('log_message')));
  assert.ok(r.rows.every(x => x.outgoing && x.e.kind === 'call'));
  assert.match(r.text, /at src\/canvas.cpp:17/);
  assert.match(r.text, /uncertain/);
  r = tools.neighbors('render', { dir: 'in' });
  assert.deepStrictEqual(r.rows.map(x => x.other), [id('main')]);

  // callPaths finds the shortest chains, and accepts a file as the target.
  r = tools.callPaths('main', 'plot');
  assert.strictEqual(r.paths.length, 2);
  for (const p of r.paths) {
    assert.strictEqual(p[0], id('main'));
    assert.strictEqual(p[p.length - 1], id('plot'));
    assert.strictEqual(p[1], render.id);
    for (let i = 1; i < p.length; i++) assert.ok(graph.edges.some(e => e.kind === 'call' && e.source === p[i - 1] && e.target === p[i]), 'path hop is a real edge');
  }
  assert.match(r.text, /-\?->/, 'uncertain hop is marked');
  r = tools.callPaths('main', 'logger.c', { k: 5 });
  // The three direct calls first, then longer chains such as main -> render -> log_message.
  assert.deepStrictEqual(new Set(r.paths.slice(0, 3).map(p => tools.nodes.get(p[1]).label)), new Set(['log_init', 'log_message', 'log_close']));
  assert.ok(r.paths.slice(0, 3).every(p => p.length === 2));
  assert.ok(r.paths.slice(3).every(p => p.length > 2));
  assert.ok(r.paths.some(p => p[1] === render.id && tools.nodes.get(p[2]).label === 'log_message'));
  r = tools.callPaths('plot', 'main');
  assert.strictEqual(r.paths.length, 0);
  assert.match(r.text, /No call chain/);

  // reach: callers with depth, and the depth limit.
  r = tools.reach('plot', { dir: 'in' });
  const depth = new Map(r.items.map(x => [tools.nodes.get(x.id).label, x.depth]));
  assert.strictEqual(depth.get('line'), 1);
  assert.strictEqual(depth.get('render'), 2);
  assert.strictEqual(depth.get('main'), 3);
  r = tools.reach('plot', { dir: 'in', maxDepth: 1 });
  assert.ok(r.items.every(x => x.depth === 1));
  r = tools.reach('main', { dir: 'out' });
  assert.ok(r.nodeIds.includes(id('plot')) && r.nodeIds.includes(id('level_name')));
  r = tools.reach('Shape', { dir: 'in', kinds: ['inherits'] });
  assert.deepStrictEqual(new Set(r.items.map(x => tools.nodes.get(x.id).label)), new Set(['Circle', 'Rectangle']));

  // readCode: definitions with line numbers, file heads, ranges, truncation.
  r = await tools.readCode('render');
  assert.match(r.text, /^N\d+ method geo::Canvas::render/);
  assert.match(r.text, /\n15 {2}void Canvas::render/);
  assert.match(r.text, /\n20 {2}\}/);
  r = await tools.readCode('main.cpp', { maxLines: 5 });
  assert.strictEqual(r.end, 5);
  assert.match(r.text, /more lines/);
  r = await tools.readCode({ file: 'c/logger.c', start: 22, end: 26 });
  assert.match(r.text, /fprintf/);
  assert.ok(r.nodeIds.includes(id('log_message')));
  assert.match((await tools.readCode({ file: 'missing.c', start: 1 })).text, /not available/);

  // grep maps each hit to its enclosing symbol; bad patterns are searched literally.
  r = await tools.grep('pixels_');
  assert.strictEqual(r.hits.length, 3);
  assert.ok(r.nodeIds.includes(id('plot')) && r.nodeIds.includes(id('pixelCount')));
  r = await tools.grep('fopen(', { file: 'c/' });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].node.label, 'log_init');
  assert.strictEqual((await tools.grep('LOG_', { maxHits: 2 })).hits.length, 2);

  // Source files are read once.
  assert.strictEqual(reads.filter(f => f === 'src/canvas.cpp').length, 1);

  console.log('graphTools: ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
