// Checks src/ai/summaries.js against sample/: node test/summaries.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder');
const { GraphTools } = require('../src/ai/graphTools');
const { canSummarize, contentKey, buildPrompt, parseSummary, summarize } = require('../src/ai/summaries');

const root = path.join(__dirname, '..', 'sample');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const readSource = async f => {
  const p = path.join(root, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const graph = buildGraph(sources);
const tools = new GraphTools(graph, { readSource });
const node = name => tools.resolve(name);

(async () => {
  // Which nodes get summaries.
  assert.ok(canSummarize(node('render')) && canSummarize(node('Canvas')) && canSummarize(node('main.cpp')) && canSummarize(node('log_level')));
  assert.ok(!canSummarize(tools.nodes.get('dir:src')) && !canSummarize(graph.nodes.find(n => n.kind === 'namespace')));
  assert.ok(!canSummarize({ ...node('render'), status: 'removed' }));
  assert.strictEqual(contentKey(tools, tools.nodes.get('dir:src')), null);

  // The key follows the code: a method's own change, and a member change for its class.
  const keyOf = (src, name) => {
    const g = buildGraph(src);
    const t = new GraphTools(g);
    return contentKey(t, t.resolve(name));
  };
  const edit = (file, from, to) => sources.map(s => (s.path === file ? { ...s, text: s.text.replace(from, to) } : s));
  const pixelEdit = edit('src/canvas.cpp', 'pixels_.size()', 'pixels_.size() + 0');
  assert.strictEqual(keyOf(sources, 'render'), contentKey(tools, node('render')), 'stable across rebuilds');
  assert.strictEqual(keyOf(pixelEdit, 'render'), keyOf(sources, 'render'), 'unrelated edit keeps the key');
  assert.notStrictEqual(keyOf(pixelEdit, 'pixelCount'), keyOf(sources, 'pixelCount'), 'own edit changes the key');
  assert.notStrictEqual(keyOf(pixelEdit, 'Canvas'), keyOf(sources, 'Canvas'), 'a member edit changes the class key');
  assert.strictEqual(keyOf(pixelEdit, 'Shape'), keyOf(sources, 'Shape'), 'other classes keep theirs');

  // The prompt: what it is, its connections and its source.
  let p = await buildPrompt(tools, node('render'));
  assert.match(p, /Reply with only a JSON object/);
  assert.match(p, /Element: geo::Canvas::render \(method\)/);
  assert.match(p, /Inside: geo::Canvas \(class\)/);
  assert.match(p, /Called by: main\n/);
  assert.match(p, /Calls: log_message, geo::Shape::name, geo::Shape::draw, geo::Circle::draw/);
  assert.match(p, /Location: src\/canvas.cpp:15/);
  assert.match(p, /```cpp\nvoid Canvas::render[\s\S]*s->draw\(\*this\);[\s\S]*\n```/);
  p = await buildPrompt(tools, node('Shape'));
  assert.match(p, /Derived classes: geo::Circle, geo::Rectangle/);
  assert.match(p, /Contains: .*geo::Shape::draw \(method\)/);
  p = await buildPrompt(tools, node('logger.h'));
  assert.match(p, /Element: c\/logger.h \(file, header\)/);
  assert.match(p, /Included by: c\/logger.c, src\/canvas.cpp, src\/main.cpp/);
  assert.match(p, /Implemented in: c\/logger.c/);
  assert.match(p, /#include|#ifndef|#pragma/);

  // Parsing replies: JSON (also inside fences or with chatter), limits, and plain text.
  assert.deepStrictEqual(parseSummary('{"purpose":"Draws shapes.","tags":["Rendering","x","y","z"],"notes":["a","b","c","d"]}'), { purpose: 'Draws shapes.', tags: ['rendering', 'x', 'y'], notes: ['a', 'b', 'c'] });
  assert.strictEqual(parseSummary('Sure!\n```json\n{"purpose": "Opens the log."}\n```').purpose, 'Opens the log.');
  assert.deepStrictEqual(parseSummary('{"purpose": "", "tags": []}'), { purpose: '{"purpose": "", "tags": []}', tags: [], notes: [] });
  assert.deepStrictEqual(parseSummary('It opens the log file.'), { purpose: 'It opens the log file.', tags: [], notes: [] });
  assert.strictEqual(parseSummary('').purpose, 'No description was produced.');

  // summarize: one request, parsed.
  const prompts = [];
  const s = await summarize(tools, node('log_init'), async prompt => {
    prompts.push(prompt);
    return '{"purpose": "Opens the log file.", "tags": ["I/O"], "notes": ["Sets fd to -1 on failure."]}';
  });
  assert.strictEqual(prompts.length, 1);
  assert.match(prompts[0], /fopen\(path, "w"\)/);
  assert.deepStrictEqual(s, { purpose: 'Opens the log file.', tags: ['i/o'], notes: ['Sets fd to -1 on failure.'] });

  console.log('summaries: ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
