// Checks src/ai/impactCheck.js against sample/: node test/impactCheck.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder');
const { GraphTools } = require('../src/ai/graphTools');
const { predictImpact } = require('../src/ai/impact');
const { buildCheckPrompt, parseVerdicts, blendScore, checkWithModel, MAX_PLACES } = require('../src/ai/impactCheck');

const root = path.join(__dirname, '..', 'sample');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const tools = new GraphTools(buildGraph(sources), {
  readSource: async f => {
    const p = path.join(root, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
});
const id = name => tools.resolve(name).id;

(async () => {
  // Blending: the model's verdict moves the static score.
  assert.strictEqual(blendScore(30, 'breaks'), 85);
  assert.strictEqual(blendScore(100, 'breaks'), 100);
  assert.strictEqual(blendScore(100, 'fine'), 15);
  assert.strictEqual(blendScore(5, 'fine'), 5);
  assert.strictEqual(blendScore(25, 'review'), 40);
  assert.strictEqual(blendScore(100, 'review'), 78);
  assert.strictEqual(blendScore(42, 'unknown'), 42);

  // The prompt: the target's code, the planned change, and each place's code with the call site marked.
  const impact = predictImpact(tools, id('log_message'), 'signature');
  const { prompt, refs } = await buildCheckPrompt(tools, impact, 'add an int error code parameter');
  assert.deepStrictEqual([...refs.keys()], ['A1', 'A2'], 'files are left out');
  assert.deepStrictEqual(new Set([...refs.values()].map(r => tools.nodes.get(r.id).name)), new Set(['render', 'main']));
  assert.match(prompt, /Changed element: log_message \(function\) at c\/logger.c:22/);
  assert.match(prompt, /Signature: void log_message\(log_level level, const char\* msg\)/);
  assert.match(prompt, /Planned change: signature or return type: add an int error code parameter/);
  assert.match(prompt, /Its current code:\n```cpp\n 22  void log_message/);
  assert.match(prompt, /A\d caller method geo::Canvas::render \(src\/canvas.cpp:17\):\n```cpp\n[\s\S]*>17 +log_message\(LOG_INFO, s->name\(\)\.c_str\(\)\);/);
  assert.match(prompt, /A\d caller function main \(src\/main.cpp:18\):\n```cpp\n[\s\S]*>18 +log_message\(LOG_INFO, "done"\);/);
  // Places without a call site show their own code; at most MAX_PLACES are asked about.
  const cls = predictImpact(tools, id('Shape'), 'remove');
  const p2 = await buildCheckPrompt(tools, cls, '');
  assert.ok(p2.refs.size <= MAX_PLACES);
  assert.match(p2.prompt, /derived class geo::Circle \(include\/geo\/shape.h:28\):\n```cpp\n 28  class Circle/);
  assert.match(p2.prompt, /Planned change: remove\n/);

  // Parsing: JSON with chatter, unknown refs and verdicts skipped, duplicates ignored.
  const v = parseVerdicts(
    'Here you go:\n```json\n[{"ref":"A1","verdict":"Breaks","reason":"passes two arguments","line":"17"},{"ref":"A9","verdict":"fine"},{"ref":"A2","verdict":"maybe"},{"ref":"A1","verdict":"fine"}]\n```',
    refs
  );
  assert.strictEqual(v.length, 1);
  assert.deepStrictEqual(v[0], { id: refs.get('A1').id, verdict: 'breaks', reason: 'passes two arguments', file: refs.get('A1').file, line: 17 });
  assert.deepStrictEqual(parseVerdicts('no json here', refs), []);
  assert.deepStrictEqual(parseVerdicts('[not json', refs), []);

  // checkWithModel: one request, verdicts with blended scores and tiers.
  const asked = [];
  const res = await checkWithModel(tools, impact, 'add an int error code parameter', async p => {
    asked.push(p);
    const ref = name => [...refs.entries()].find(([, r]) => tools.nodes.get(r.id).name === name)[0];
    return JSON.stringify([
      { ref: ref('main'), verdict: 'breaks', reason: 'calls it with two arguments', line: 18 },
      { ref: ref('render'), verdict: 'fine', reason: 'a default value keeps the call valid' }
    ]);
  });
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(res.asked, 2);
  const byNode = Object.fromEntries(res.verdicts.map(x => [tools.nodes.get(x.id).name, x]));
  assert.deepStrictEqual([byNode.main.verdict, byNode.main.score, byNode.main.tier], ['breaks', 100, 'high']);
  assert.deepStrictEqual([byNode.render.verdict, byNode.render.score, byNode.render.tier], ['fine', 15, 'low']);
  // Nothing to ask about: no request.
  const none = await checkWithModel(tools, predictImpact(tools, id('main'), 'remove'), '', async () => {
    throw new Error('should not be asked');
  });
  assert.deepStrictEqual(none, { verdicts: [], asked: 0 });

  console.log('impactCheck: ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
