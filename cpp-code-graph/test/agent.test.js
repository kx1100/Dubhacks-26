// Checks the investigation loop in src/ai/agent.js with a scripted model: node test/agent.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder');
const { investigate, validate, toolsFor, TOOLS } = require('../src/ai/agent');
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const { GraphTools } = require('../src/ai/graphTools');

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
let reads = 0;
const readSource = async f => {
  reads++;
  const p = path.join(root, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
// Refs are assigned in graph order, so a separate GraphTools gives the same refs the agent uses.
const T = new GraphTools(graph);
const ref = name => T.ref(T.resolve(name).id);
const idOf = name => T.resolve(name).id;

/** A model that replays one reply per round and records what it was sent. */
function scripted(replies) {
  const seen = [];
  let callId = 0;
  return {
    seen,
    name: 'Scripted',
    maxInputTokens: 100000,
    async send(messages, opts) {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
      const r = replies[Math.min(seen.length - 1, replies.length - 1)];
      const reply = typeof r === 'function' ? r(messages, opts) : r;
      return { text: reply.text || '', calls: (reply.calls || []).map(c => ({ id: 'c' + callId++, ...c })) };
    }
  };
}
const call = (name, input) => ({ name, input });

(async () => {
  // 1. A normal investigation: search, follow, read, then finish.
  const steps = [];
  let llm = scripted([
    { text: 'Let me look at rendering.', calls: [call('search_symbols', { query: 'render' }), call('neighbors', { node: ref('render'), direction: 'out', kinds: ['calls'] })] },
    { calls: [call('read_code', { node: ref('render') })] },
    {
      calls: [
        call('finish', {
          answer: `Drawing starts in [[${ref('main')}]], which calls [[${ref('render')}]]. Each shape logs via [[log_message]] and draws itself; [[NoSuchThing]] is not real.`,
          highlight: [ref('main'), 'N9999', ref('render')],
          path: [ref('main'), ref('render'), 'geo::Shape::draw', ref('plot')],
          evidence: [
            { file: 'canvas.cpp', line: 18, claim: 'render calls draw on each shape' },
            { node: ref('main'), claim: 'entry point' },
            { file: 'nowhere/else.cpp', line: 3, claim: 'bogus file' },
            { claim: 'no location at all' }
          ],
          confidence: 'high'
        })
      ]
    }
  ]);
  let res = await investigate(graph, 'How does drawing work?', { llm, readSource, onStep: s => steps.push(s) });

  // The intro names the entry point, the head-start matches and the question.
  const intro = llm.seen[0].messages[0].text;
  assert.match(intro, /Entry point: N\d+ function main/);
  assert.match(intro, /Symbols matching the question:/);
  assert.match(intro, /Question: How does drawing work\?/);
  assert.strictEqual(llm.seen[0].opts.tools.length, TOOLS.length);
  assert.strictEqual(llm.seen[0].opts.forceTool, null);

  // Tool results go back to the model in the next round, keyed by call id.
  const round2 = llm.seen[1].messages;
  assert.strictEqual(round2[1].role, 'assistant');
  assert.strictEqual(round2[1].calls.length, 2);
  assert.deepStrictEqual(round2[2].results.map(r => r.id), round2[1].calls.map(c => c.id));
  assert.match(round2[2].results[1].text, /calls -> N\d+ function log_message/);
  assert.match(llm.seen[2].messages[4].results[0].text, /void Canvas::render/);

  // Steps: the head start plus one per tool call, with readable summaries.
  assert.deepStrictEqual(steps.map(s => s.tool), ['search_symbols', 'search_symbols', 'neighbors', 'read_code']);
  assert.deepStrictEqual(steps.map(s => s.i), [0, 1, 2, 3]);
  assert.match(steps[2].summary, /^Outgoing calls of geo::Canvas::render \(\d+\)$/);
  assert.strictEqual(steps[3].summary, 'Read the code of geo::Canvas::render');
  assert.strictEqual(steps[1].note, 'Let me look at rendering.');
  assert.ok(steps[2].nodeIds.includes(idOf('log_message')));
  assert.strictEqual(res.steps, 4);
  assert.strictEqual(res.model, 'Scripted');

  // Answer refs become node ids; names resolve; unknown refs become code text.
  assert.ok(res.answer.includes('[[' + idOf('main') + ']]'));
  assert.ok(res.answer.includes('[[' + idOf('log_message') + ']]'));
  assert.ok(res.answer.includes('`NoSuchThing`'));
  assert.ok(!/\[\[N\d+\]\]/.test(res.answer));

  // Path: names resolve, hops are checked against call edges.
  assert.deepStrictEqual(res.path, [idOf('main'), idOf('render'), idOf('geo::Shape::draw'), idOf('plot')]);
  assert.deepStrictEqual(res.hops.map(h => [h.inferred, h.uncertain]), [[false, false], [false, true], [false, false]]);
  assert.deepStrictEqual(res.hops[0].site, { file: 'src/main.cpp', line: 15 });

  // Evidence: partial file paths resolve, node-only evidence gets a location, junk is dropped.
  assert.strictEqual(res.evidence.length, 2);
  assert.deepStrictEqual(res.evidence[0], { nodeId: idOf('render'), file: 'src/canvas.cpp', line: 18, claim: 'render calls draw on each shape' });
  assert.deepStrictEqual([res.evidence[1].file, res.evidence[1].line, res.evidence[1].nodeId], ['src/main.cpp', 10, idOf('main')]);

  // Highlight: known nodes only, plus everything referenced, on the path or cited.
  assert.ok(!res.highlight.includes(undefined) && res.highlight.every(id => graph.nodes.some(n => n.id === id)));
  for (const n of ['main', 'render', 'log_message', 'plot', 'geo::Shape::draw']) assert.ok(res.highlight.includes(idOf(n)), 'highlight ' + n);
  assert.strictEqual(res.confidence, 'high');

  // 2. A path hop with no call edge is kept but marked inferred.
  llm = scripted([{ calls: [call('finish', { answer: 'x', path: `${ref('main')} -> ${ref('plot')}`, confidence: 'medium' })] }]);
  res = await investigate(graph, 'q', { llm, readSource });
  assert.deepStrictEqual(res.hops.map(h => h.inferred), [true]);
  assert.strictEqual(res.confidence, 'medium');

  // 3. The step limit forces finish on the last round.
  llm = scripted([
    { calls: [call('get_node', { node: ref('main') })] },
    { calls: [call('get_node', { node: ref('render') })] },
    (messages, opts) => (opts.forceTool === 'finish' ? { calls: [call('finish', { answer: 'forced', confidence: 'nonsense' })] } : { calls: [call('get_node', { node: ref('plot') })] })
  ]);
  res = await investigate(graph, 'q', { llm, readSource, maxSteps: 3 });
  assert.strictEqual(llm.seen.length, 3);
  assert.deepStrictEqual(llm.seen[2].opts.tools.map(t => t.name), ['finish']);
  assert.strictEqual(llm.seen[2].opts.forceTool, 'finish');
  const last = llm.seen[2].messages[llm.seen[2].messages.length - 1];
  assert.ok(last.results && /call finish/.test(last.text), 'stop request rides on the tool results');
  assert.strictEqual(res.answer, 'forced');
  assert.strictEqual(res.confidence, 'low');

  // 4. A plain-text reply without finish is the answer.
  llm = scripted([{ text: `It starts in [[${ref('main')}]].` }]);
  res = await investigate(graph, 'q', { llm, readSource });
  assert.strictEqual(res.answer, `It starts in [[${idOf('main')}]].`);
  assert.deepStrictEqual(res.highlight, [idOf('main')]);
  assert.strictEqual(res.confidence, 'low');

  // 5. Repeated tool calls are answered from the cache; bad tools and bad args don't throw.
  reads = 0;
  llm = scripted([
    { calls: [call('read_code', { node: ref('render') }), call('read_code', { node: ref('render') }), call('frobnicate', {}), call('neighbors', {}), call('read_code', { file: 'c/logger.c', start: 22, end: 26 })] },
    { calls: [call('finish', { answer: 'ok', confidence: 'high' })] }
  ]);
  res = await investigate(graph, 'q', { llm, readSource });
  const results = llm.seen[1].messages[2].results;
  assert.strictEqual(results[0].text, results[1].text);
  assert.match(results[2].text, /Unknown tool/);
  assert.match(results[3].text, /No node matches/);
  assert.match(results[4].text, /fprintf/);
  assert.strictEqual(reads, 2, 'each file is read once');

  // 6. Cancellation stops the loop.
  const token = { isCancellationRequested: false };
  llm = scripted([
    () => {
      token.isCancellationRequested = true;
      return { calls: [call('get_node', { node: ref('main') })] };
    }
  ]);
  res = await investigate(graph, 'q', { llm, readSource, token });
  assert.strictEqual(llm.seen.length, 1);
  assert.strictEqual(res.answer, '_Cancelled._');

  // 7. Path mode: finish takes routes; the intro shows the call tree from the entry point.
  const pathFinish = toolsFor('path').find(t => t.name === 'finish').inputSchema.properties;
  assert.ok(pathFinish.routes && !pathFinish.path);
  assert.ok(toolsFor('ask').find(t => t.name === 'finish').inputSchema.properties.path);
  llm = scripted([
    {
      calls: [
        call('finish', {
          answer: 'Shapes are drawn by render.',
          routes: [
            { label: 'main', steps: [{ node: ref('main') }, { node: ref('render'), note: 'draws every shape' }, { node: 'geo::Shape::draw' }, { node: ref('plot') }] },
            { label: 'circle', steps: [{ node: ref('render'), kind: 'branch', condition: 'if the shape is a Circle' }, { node: 'geo::Circle::draw', kind: 'callback' }, { node: ref('plot') }] },
            { label: 'cleanup', steps: [{ node: ref('main') }, { node: ref('log_close') }, { node: ref('main'), kind: 'return' }, { node: ref('plot') }] },
            { label: 'junk', steps: [{ node: 'NoSuchThing' }] }
          ],
          confidence: 'high'
        })
      ]
    }
  ]);
  res = await investigate(graph, 'How are shapes drawn?', { llm, readSource, mode: 'path', focusId: idOf('render') });
  const pathIntro = llm.seen[0].messages[0].text;
  assert.match(pathIntro, /Calls reachable from N\d+ method geo::Canvas::render @src\/canvas.cpp:15 \(up to 3 levels/);
  assert.match(pathIntro, /d2 N\d+ method geo::Canvas::plot/);
  assert.match(pathIntro, /routes\[0\]/);
  assert.ok(llm.seen[0].opts.tools.find(t => t.name === 'finish').inputSchema.properties.routes);
  assert.deepStrictEqual(res.routes.map(r => r.label), ['main', 'circle', 'cleanup']);
  const [mainRoute, circle, cleanup] = res.routes;
  assert.deepStrictEqual(res.path, mainRoute.steps.map(s => s.id));
  assert.strictEqual(mainRoute.steps[1].note, 'draws every shape');
  assert.deepStrictEqual(mainRoute.steps.map(s => s.kind), ['call', 'call', 'call', 'call']);
  // The alternative gets the shared prefix, and keeps its own kind and condition where it branches.
  assert.deepStrictEqual(circle.steps.map(s => s.id), [idOf('main'), idOf('render'), idOf('geo::Circle::draw'), idOf('plot')]);
  assert.strictEqual(circle.divergeAt, 1);
  assert.deepStrictEqual([circle.steps[1].kind, circle.steps[1].condition], ['branch', 'if the shape is a Circle']);
  assert.strictEqual(circle.steps[2].kind, 'callback');
  // Hops: a real (uncertain) call, a return to the caller, and an inferred jump.
  assert.deepStrictEqual([circle.steps[2].inferred, circle.steps[2].uncertain], [false, true]);
  assert.deepStrictEqual(circle.steps[2].site, { file: 'src/canvas.cpp', line: 18 });
  assert.strictEqual(cleanup.divergeAt, 0);
  assert.deepStrictEqual([cleanup.steps[2].returns, cleanup.steps[2].inferred, cleanup.steps[3].inferred], [true, false, true]);
  assert.ok(res.highlight.includes(idOf('geo::Circle::draw')) && res.highlight.includes(idOf('log_close')), 'alternative routes are highlighted too');

  // 8. Virtual dispatch: a call to the base method reaches an override.
  const vg = {
    nodes: [
      { id: 'fn:run', kind: 'function', name: 'run', qname: 'run', file: 'a.cpp', line: 1 },
      { id: 'fn:Base::go', kind: 'method', name: 'go', qname: 'Base::go', file: 'a.cpp', line: 5 },
      { id: 'fn:Impl::go', kind: 'method', name: 'go', qname: 'Impl::go', file: 'a.cpp', line: 9 }
    ],
    edges: [
      { s: 'fn:run', t: 'fn:Base::go', kind: 'calls', n: 1, sites: [{ file: 'a.cpp', line: 2 }] },
      { s: 'fn:Impl::go', t: 'fn:Base::go', kind: 'overrides', n: 1 }
    ]
  };
  const v = validate(new GraphTools(vg), { answer: '', path: ['run', 'Impl::go'] });
  assert.deepStrictEqual(pick(v.routes[0].steps[1], ['inferred', 'dispatch', 'uncertain', 'site']), { inferred: false, dispatch: true, uncertain: true, site: { file: 'a.cpp', line: 2 } });
  assert.deepStrictEqual(pick(v.hops[0], ['dispatch', 'inferred']), { dispatch: true, inferred: false });

  console.log('agent: ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
