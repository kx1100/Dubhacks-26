// Checks src/ai/semantic.js: node test/semantic.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder.ts');
const { GraphTools } = require('../src/ai/graphTools');
const { candidatePairs, buildConceptPrompt, parseConcepts, buildPairPrompt, parsePairs, buildSemanticLayer, currentLayer } = require('../src/ai/semantic');

const root = path.join(__dirname, '..', 'sample');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const toolsFor = srcs => {
  const byPath = new Map(srcs.map(s => [s.path, s.text]));
  return new GraphTools(buildGraph(srcs), { readSource: async f => byPath.get(f) ?? null });
};
const tools = toolsFor(sources);
const id = name => tools.resolve(name).id;

/** A model that answers concept and pair prompts, recording what it was asked. */
function fakeModel(opts = {}) {
  const asked = [];
  const complete = async prompt => {
    asked.push(prompt);
    if (opts.onAsk) opts.onAsk(asked.length);
    if (prompt.startsWith('You are labeling')) {
      const refs = prompt.match(/^E\d+(?= )/gm) || [];
      const out = {};
      for (const ref of refs) {
        const line = prompt.split('\n').find(l => l.startsWith(ref + ' '));
        out[ref] = /log/.test(line) ? ['logging'] : /Canvas|draw|plot|render/.test(line) ? ['rendering'] : ['geometry'];
      }
      return 'Sure:\n' + JSON.stringify(out);
    }
    const refs = prompt.match(/^P\d+(?= )/gm) || [];
    return JSON.stringify(
      refs.map(ref => ({ ref, relation: 'alternative', first: 'A', confidence: 0.9, reason: 'both compute an area', evidence: { element: 'A', line: opts.line || 17, quote: opts.quote || 'double Circle::area() const' } }))
    );
  };
  return { asked, complete };
}

(async () => {
  // Candidates on the sample: siblings of the same base.
  const pairs = candidatePairs(tools);
  assert.deepStrictEqual(
    pairs.map(p => [p.a, p.b, p.hint]),
    [
      [id('Circle'), id('Rectangle'), 'both derive from geo::Shape'],
      [id('geo::Circle::area'), id('geo::Rectangle::area'), 'both override geo::Shape::area']
    ]
  );
  // Synthetic: legacy names, validators, same shape, similar names; pairs already linked are skipped.
  const fn = (name, extra) => ({ id: 'fn:' + name, kind: 'function', label: name, qname: name, file: 'a.c', line: 1, ...extra });
  const sg = {
    nodes: [
      fn('parse_config', { signature: 'int parse_config(const char* p)', id: 'fn:parse_config(constchar*)' }),
      fn('parse_config_old', { signature: 'int parse_config_old(const char* p)', id: 'fn:parse_config_old(constchar*)' }),
      fn('is_valid_order'),
      fn('ship_order'),
      fn('handle'),
      fn('load_user_profile'),
      fn('save_user_profile'),
      fn('oldest'),
      fn('est')
    ],
    edges: [
      { source: 'fn:handle', target: 'fn:is_valid_order', kind: 'call', n: 1 },
      { source: 'fn:handle', target: 'fn:ship_order', kind: 'call', n: 1 }
    ]
  };
  const sp = candidatePairs(new GraphTools(sg)).map(p => [p.a.slice(3), p.b.slice(3), p.hint]);
  assert.deepStrictEqual(sp, [
    ['parse_config(constchar*)', 'parse_config_old(constchar*)', 'names differ only by a version or legacy marker'],
    ['is_valid_order', 'ship_order', 'both called by handle, which checks with is_valid_order'],
    ['load_user_profile', 'save_user_profile', 'similar names']
  ]);

  // Concept prompt and parsing.
  const loggerFns = [...tools.nodes.values()].filter(n => n.kind === 'function' && (n.defFile || n.file) === 'c/logger.c');
  const cp = await buildConceptPrompt(tools, 'c/logger.c', loggerFns, ['rendering']);
  assert.match(cp.prompt, /Prefer these concepts, already used elsewhere in the codebase, when they fit: rendering\./);
  assert.match(cp.prompt, /File: c\/logger.c/);
  assert.match(cp.prompt, /E\d+ function log_init — void log_init\(const char\* path\)\n```cpp\n {2}16  void log_init/);
  const cmap = parseConcepts('```json\n{"E1": ["Logging", "Text  Formatting", "third"], "E2": "logging", "E99": ["x"], "E3": [""]}\n```', cp.refs);
  assert.deepStrictEqual(cmap.get(cp.refs.get('E1')), ['logging', 'text formatting']);
  assert.deepStrictEqual(cmap.get(cp.refs.get('E2')), ['logging']);
  assert.ok(!cmap.has(cp.refs.get('E3')));
  assert.strictEqual(parseConcepts('nope', cp.refs).size, 0);

  // Pair prompt and parsing: evidence is checked against the source.
  const pp = await buildPairPrompt(tools, pairs);
  assert.match(pp.prompt, /P2 \(candidate because both override geo::Shape::area\)\nA: method geo::Circle::area @src\/shape.cpp:17\n```cpp\n {2}17  double Circle::area\(\) const/);
  const prov = { model: 'Fake', time: 1 };
  let res = await parsePairs(
    tools,
    JSON.stringify([
      { ref: 'P2', relation: 'alternative', first: 'B', confidence: 0.85, reason: 'both compute an area', evidence: { element: 'A', line: 18, quote: 'double Circle::area() const' } },
      { ref: 'P1', relation: 'none', confidence: 0.9 }
    ]),
    pp.refs,
    prov
  );
  const e = res.get('P2');
  assert.deepStrictEqual([e.source, e.target, e.label, e.symmetric, e.confidence], [id('geo::Rectangle::area'), id('geo::Circle::area'), 'alternative implementation of', true, 0.85]);
  assert.deepStrictEqual(e.evidence, { file: 'src/shape.cpp', line: 17, quote: 'double Circle::area() const' }, 'a quote one line off is found');
  assert.deepStrictEqual([e.provenance.model, e.provenance.time, typeof e.provenance.sKey], ['Fake', 1, 'string']);
  assert.strictEqual(res.get('P1'), null, 'checked, nothing found');
  // A made-up quote is dropped and lowers confidence, below the threshold here.
  res = await parsePairs(tools, JSON.stringify([{ ref: 'P2', relation: 'replaces', confidence: 0.5, evidence: { element: 'A', line: 17, quote: 'return legacyArea();' } }]), pp.refs, prov);
  assert.strictEqual(res.get('P2'), null);
  res = await parsePairs(tools, JSON.stringify([{ ref: 'P2', relation: 'replaces', confidence: 0.9, evidence: { element: 'A', line: 17, quote: 'return legacyArea();' } }]), pp.refs, prov);
  assert.deepStrictEqual([res.get('P2').evidence, res.get('P2').confidence, res.get('P2').label], [null, 0.63, 'replaces']);

  // A full build: one request per file with elements, one for the pairs.
  let model = fakeModel();
  const first = await buildSemanticLayer(tools, null, model.complete, { model: 'Fake', now: 5 });
  const files = new Set([...tools.nodes.values()].filter(n => ['function', 'method', 'class', 'struct', 'union', 'enum'].includes(n.kind)).map(n => n.defFile || n.file));
  assert.strictEqual(model.asked.length, files.size + 1);
  assert.deepStrictEqual(first.stats, { filesTagged: files.size, filesReused: 0, filesLeft: 0, pairsAsked: 2, pairsReused: 0, requests: files.size + 1, cancelled: false });
  assert.deepStrictEqual(first.state.concepts[id('log_init')].tags, ['logging']);
  assert.deepStrictEqual(first.state.concepts[id('render')].tags, ['rendering']);
  assert.ok(model.asked.slice(1).some(p => /Prefer these concepts.*logging/.test(p)), 'later files reuse earlier concepts');
  assert.strictEqual(first.state.edges.length, 2);
  assert.ok(first.state.edges.every(x => x.provenance.model === 'Fake' && x.provenance.time === 5));
  const layer = currentLayer(tools, first.state);
  assert.strictEqual(layer.edges.length, 2);
  assert.deepStrictEqual(layer.concepts[id('log_close')], ['logging']);

  // Rebuilding unchanged code asks nothing.
  model = fakeModel();
  const again = await buildSemanticLayer(tools, first.state, model.complete, { model: 'Fake' });
  assert.strictEqual(model.asked.length, 0);
  assert.deepStrictEqual([again.stats.filesReused, again.stats.pairsReused, again.state.edges.length], [files.size, 2, 2]);

  // After an edit, only the changed file and the pairs touching it are asked about again.
  const edited = sources.map(s => (s.path === 'src/shape.cpp' ? { ...s, text: s.text.replace('return M_PI * radius_ * radius_;', 'return M_PI * radius_ * radius_ * 1.0;') } : s));
  assert.notStrictEqual(edited.find(s => s.path === 'src/shape.cpp').text, sources.find(s => s.path === 'src/shape.cpp').text, 'the edit applied');
  const tools2 = toolsFor(edited);
  // Stale results are filtered out until rebuilt. A class's key covers its members, so both edges are stale.
  assert.strictEqual(currentLayer(tools2, first.state).edges.length, 0);
  model = fakeModel();
  const third = await buildSemanticLayer(tools2, first.state, model.complete, { model: 'Fake' });
  assert.strictEqual(model.asked.length, 3, 'shape.cpp, shape.h (Circle) and one request for both pairs');
  assert.match(model.asked[0], /File: include\/geo\/shape.h/);
  assert.match(model.asked[1], /File: src\/shape.cpp/);
  assert.match(model.asked[2], /both derive from[\s\S]*both override geo::Shape::area/);
  assert.deepStrictEqual([third.stats.filesTagged, third.stats.filesReused, third.stats.pairsAsked, third.stats.pairsReused, third.state.edges.length], [2, files.size - 2, 2, 0, 2]);
  // An edit elsewhere leaves the pairs alone.
  const logEdit = sources.map(s => (s.path === 'c/logger.c' ? { ...s, text: s.text.replace('if (g_file) fclose(g_file);', 'if (g_file != NULL) fclose(g_file);') } : s));
  model = fakeModel();
  const fourth = await buildSemanticLayer(toolsFor(logEdit), first.state, model.complete, {});
  assert.strictEqual(model.asked.length, 1);
  assert.match(model.asked[0], /File: c\/logger.c/);
  assert.deepStrictEqual([fourth.stats.pairsReused, fourth.state.edges.length], [2, 2]);

  // Cancelling stops between requests and keeps what was done.
  let stop = false;
  model = fakeModel({ onAsk: n => (stop = n >= 2) });
  const part = await buildSemanticLayer(tools, null, model.complete, { isCancelled: () => stop });
  assert.strictEqual(model.asked.length, 2);
  assert.ok(part.stats.cancelled && part.stats.filesLeft > 0 && part.stats.pairsAsked === 0);
  assert.strictEqual(Object.values(part.state.concepts).filter(c => c.tags.length).length > 0, true);
  // The next build carries on from there.
  model = fakeModel();
  const rest = await buildSemanticLayer(tools, part.state, model.complete, {});
  assert.strictEqual(rest.stats.filesReused, 2);
  assert.strictEqual(model.asked.length, files.size - 2 + 1);

  // A failed request stops the build and keeps what was done.
  let calls = 0;
  const failing = await buildSemanticLayer(tools, null, async prompt => {
    if (++calls === 3) throw new Error('rate limited');
    return fakeModel().complete(prompt);
  });
  assert.strictEqual(failing.stats.error, 'rate limited');
  assert.strictEqual(failing.stats.filesTagged, 2);
  assert.strictEqual(failing.stats.filesLeft, files.size - 2);
  assert.strictEqual(failing.stats.pairsAsked, 0);
  assert.strictEqual(calls, 3, 'no requests after the failure');

  // The agent's tools use the layer: concepts are searchable and shown, inferred links are labelled.
  const layered = new GraphTools({ ...tools.graph, edges: tools.graph.edges.concat(first.state.edges), concepts: { [id('log_init')]: ['configuration'] } });
  assert.strictEqual(layered.searchSymbols('configuration').nodeIds[0], id('log_init'));
  assert.match(layered.getNode('log_init').text, /concepts \(AI-tagged\): configuration/);
  assert.match(layered.neighbors('geo::Circle::area', { kinds: ['semantic'] }).text, /\nalternative implementation of \[AI-inferred, 90%\] -> N\d+ method geo::Rectangle::area/);

  console.log('semantic: ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
