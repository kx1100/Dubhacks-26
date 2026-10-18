// Checks src/ai/impact.js against sample/: node test/impact.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder.ts');
const { GraphTools } = require('../src/ai/graphTools');
const { predictImpact, canPredict, isTestFile } = require('../src/ai/impact');

const root = path.join(__dirname, '..', 'sample');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sources.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
})(root);
const tools = new GraphTools(buildGraph(sources));
const id = name => tools.resolve(name).id;
const run = (name, change) => predictImpact(tools, id(name), change);
const byName = r => Object.fromEntries(r.items.map(i => [tools.nodes.get(i.id).qname || tools.nodes.get(i.id).file, i]));

// Eligibility.
assert.ok(canPredict(tools.resolve('render')) && canPredict(tools.resolve('Shape')) && canPredict(tools.resolve('logger.h')));
assert.ok(!canPredict(tools.nodes.get('dir:src')) && !canPredict(tools.resolve('g_logger')));
assert.match(predictImpact(tools, 'dir:src', 'signature').error, /can be predicted for functions/);

// A function's signature: direct callers break, files including its header only recompile.
let r = run('log_message', 'signature');
let m = byName(r);
assert.deepStrictEqual(Object.keys(m).sort(), ['c/logger.c', 'geo::Canvas::render', 'main', 'src/canvas.cpp', 'src/main.cpp']);
assert.deepStrictEqual([m.main.relation, m.main.tier, m.main.depth], ['caller', 'high', 1]);
assert.deepStrictEqual(m['geo::Canvas::render'].site, { file: 'src/canvas.cpp', line: 17 });
assert.deepStrictEqual([m['src/main.cpp'].relation, m['src/main.cpp'].tier], ['includer', 'low']);
assert.ok(r.items[0].score >= r.items[r.items.length - 1].score, 'sorted by score');
assert.match(r.summary.notes[0], /declared in the header c\/logger.h/);
assert.match(r.summary.notes.join(' '), /No tests were found/);
assert.deepStrictEqual([r.summary.count, r.summary.high, r.summary.files], [5, 2, 3]);

// Behavior only: indirect callers matter, weaker with distance; includers don't.
r = run('plot', 'behavior');
m = byName(r);
assert.deepStrictEqual([m['geo::Canvas::line'].relation, m['geo::Canvas::render'].relation, m.main.relation], ['caller', 'indirect', 'indirect']);
assert.deepStrictEqual([m['geo::Canvas::render'].depth, m.main.depth], [2, 3]);
assert.ok(m['geo::Canvas::line'].score > m['geo::Canvas::render'].score && m['geo::Canvas::render'].score > m.main.score);
assert.ok(!r.items.some(i => i.relation === 'includer'));
// A call matched by name only counts for less.
assert.ok(m['geo::Canvas::render'].uncertain);
assert.match(r.summary.notes.join(' '), /1 of these was matched by name only/);

// Signature of an indirect caller's chain is low: only direct callers break.
r = run('geo::Shape::draw', 'signature');
m = byName(r);
assert.deepStrictEqual([m['geo::Circle::draw'].relation, m['geo::Circle::draw'].tier], ['override', 'high']);
assert.deepStrictEqual([m.main.relation, m.main.tier], ['indirect', 'low']);
assert.match(r.summary.notes.join(' '), /virtual: overrides must keep the same signature/);
// From the override's side, the base method is affected.
m = byName(run('geo::Circle::draw', 'signature'));
assert.deepStrictEqual([m['geo::Shape::draw'].relation, m['geo::Shape::draw'].tier], ['base', 'high']);

// Removing a class: derived classes, users of the type and files including its header.
r = run('Shape', 'remove');
m = byName(r);
assert.deepStrictEqual([m['geo::Circle'].relation, m['geo::Rectangle'].relation], ['derived', 'derived']);
for (const user of ['geo::Canvas::render', 'addDefaults', 'main', 'geo::makeShape']) assert.strictEqual(m[user].relation, 'typeUser', user);
assert.strictEqual(m['src/main.cpp'].relation, 'includer');
assert.strictEqual(r.summary.tier, 'high');
// Behavior-only for a class leaves includers out and scores lower.
assert.ok(run('Shape', 'behavior').summary.overall < r.summary.overall);
// Callers of a class's members count when they don't otherwise use it.
m = byName(run('Canvas', 'remove'));
assert.strictEqual(m.main.relation, 'typeUser');
assert.ok(!m['geo::Canvas::line'], 'its own members are not listed');

// A header: renaming breaks every #include of it; behavior barely matters.
r = run('logger.h', 'rename');
m = byName(r);
for (const f of ['src/main.cpp', 'src/canvas.cpp']) assert.deepStrictEqual([m[f].relation, m[f].tier], ['fileIncluder', 'high']);
assert.ok(['implementation', 'fileIncluder'].includes(m['c/logger.c'].relation));
r = run('shape.h', 'behavior');
m = byName(r);
assert.strictEqual(m['src/canvas.cpp'].depth, 2, 'included through canvas.h');
assert.ok(m['src/canvas.cpp'].score < m['src/main.cpp'].score);
assert.strictEqual(r.summary.tier, 'low');

// A file-local function says so.
assert.match(run('level_name', 'signature').summary.notes[0], /file-local \(static\)/);
// Nothing depends on main.
r = run('main', 'remove');
assert.deepStrictEqual([r.items.length, r.summary.tier], [0, 'low']);
assert.match(r.summary.notes.join(' '), /Nothing in the graph depends on it/);
// An unknown change type falls back to signature.
assert.strictEqual(run('plot', 'nonsense').changeType, 'signature');

// Tests: test files are recognized, and code reached from tests says so.
for (const f of ['tests/list_test.c', 'test/foo.cpp', 'src/list_test.cpp', 'spec/a.c', 'src/FooTest.cpp']) assert.ok(isTestFile(f), f);
for (const f of ['src/main.cpp', 'src/latest.cpp', 'src/contest.c']) assert.ok(!isTestFile(f), f);
const tg = {
  nodes: [
    { id: 'file:src/list.c', kind: 'file', label: 'list.c', file: 'src/list.c' },
    { id: 'file:tests/list_test.c', kind: 'file', label: 'list_test.c', file: 'tests/list_test.c' },
    { id: 'fn:push', kind: 'function', label: 'push', qname: 'push', file: 'src/list.c', line: 1, parent: 'file:src/list.c' },
    { id: 'fn:grow', kind: 'function', label: 'grow', qname: 'grow', file: 'src/list.c', line: 9, parent: 'file:src/list.c' },
    { id: 'fn:test_push', kind: 'function', label: 'test_push', qname: 'test_push', file: 'tests/list_test.c', line: 3, parent: 'file:tests/list_test.c' }
  ],
  edges: [
    { source: 'fn:push', target: 'fn:grow', kind: 'call', n: 1 },
    { source: 'fn:test_push', target: 'fn:push', kind: 'call', n: 1 }
  ]
};
const tt = new GraphTools(tg);
r = predictImpact(tt, 'fn:grow', 'behavior');
assert.ok(r.summary.tested);
assert.match(r.summary.notes.join(' '), /Tests reach this code/);
const testItem = r.items.find(i => i.id === 'fn:test_push');
assert.ok(testItem.test && testItem.score < r.items.find(i => i.id === 'fn:push').score, 'a test that would fail is the lowest risk');

console.log('impact: ok');
