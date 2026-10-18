'use strict';

// The semantic layer: what a call graph can't show.
//   concepts  each function or class gets 1-2 concept tags (the feature,
//             workflow or responsibility it serves), one model request per file
//   edges     AI-inferred relationships between candidate pairs found from the
//             graph: "alternative implementation of", "replaces", "validates for"
// Every edge keeps its evidence (a quoted line, checked against the source),
// confidence and provenance (model, time, content keys of both ends). Rebuilds
// only re-ask about files and pairs whose code changed.
// No `vscode` dependency: the model is reached through complete(prompt) -> text.

const { contentKey } = require('./summaries');
const { tokenize } = require('./graphTools');

const TAGGABLE = new Set(['function', 'prototype', 'method', 'class', 'struct', 'union', 'enum']);
const CALLABLE = new Set(['function', 'prototype', 'method']);
const ELEMENTS_PER_REQUEST = 30;
const LINES_PER_ELEMENT = 8;
const PAIRS_PER_REQUEST = 12;
const PAIR_LINES = 20;
const MAX_PAIRS = 40;
const MAX_CONCEPT_REQUESTS = 40; // per build; the rest is tagged by the next build
const MIN_CONFIDENCE = 0.4;

const RELATIONS = {
  alternative: { label: 'alternative implementation of', symmetric: true },
  replaces: { label: 'replaces' },
  validates: { label: 'validates for' }
};

// ---- candidates ---------------------------------------------------------------

// A version or legacy marker, only at a word boundary (parse_old, OldParser, parseV2, parse2),
// so names like oldest, bold or Complex stay whole.
const LEGACY = /^(old|legacy|deprecated|new)_|^(old|legacy|deprecated|new|Old|Legacy|Deprecated|New)(?=[A-Z])|_(old|legacy|deprecated|new|v\d+|ex|impl)$|(?<=[a-z0-9])(Old|Legacy|Deprecated|New|V\d+|Ex|Impl)$|(?<=[A-Za-z]{2})\d+$/;
const VALIDATOR = /^(is|has|can|check|validate|verify|ensure|assert)([A-Z_]|$)|valid/i;

/** The name without legacy/version markers: parse_config_old -> parse_config. */
function baseName(name) {
  let prev;
  let s = name;
  do {
    prev = s;
    s = s.replace(LEGACY, '');
  } while (s !== prev && s);
  return s.toLowerCase();
}

/** Return type and parameter types: "void(constchar*)" for log_init. */
function shapeOf(n) {
  const params = /\(([^)]*)\)/.exec(n.id);
  if (!params || !n.signature) return null;
  const ret = n.signature.split(n.label + '(')[0].trim();
  return ret + '(' + params[1] + ')';
}

/**
 * Pairs that might be related in ways the call graph doesn't show, most promising first.
 * @param {import('./graphTools').GraphTools} tools
 * @returns {{a:string, b:string, hint:string}[]}
 */
function candidatePairs(tools, max = MAX_PAIRS) {
  const nodes = [...tools.nodes.values()].filter(n => TAGGABLE.has(n.kind) && n.status !== 'removed');
  const label = id => {
    const n = tools.nodes.get(id);
    return n.qname || n.label;
  };
  const linked = (a, b) => (tools.out.get(a) || []).some(e => e.target === b && (e.kind === 'overrides' || e.kind === 'inherits')) || (tools.out.get(b) || []).some(e => e.target === a && (e.kind === 'overrides' || e.kind === 'inherits'));
  const found = new Map();
  const add = (a, b, hint, weight) => {
    if (a === b || linked(a, b)) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = x + '|' + y;
    const prev = found.get(key);
    if (!prev || prev.weight < weight) found.set(key, { a: x, b: y, hint, weight });
  };
  const allPairs = (ids, hint, weight, cap = 6) => {
    const list = ids.slice(0, cap);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], hint, weight);
  };

  for (const n of nodes) {
    const inc = tools.inc.get(n.id) || [];
    // Methods overriding the same base method, classes deriving from the same base.
    const over = inc.filter(e => e.kind === 'overrides').map(e => e.source);
    if (over.length > 1) allPairs(over, 'both override ' + label(n.id), 3);
    const derived = inc.filter(e => e.kind === 'inherits').map(e => e.source);
    if (derived.length > 1) allPairs(derived, 'both derive from ' + label(n.id), 3);
  }
  // Same name apart from legacy or version markers.
  const byBase = new Map();
  for (const n of nodes) {
    const b = baseName(n.label);
    if (b && b !== n.label.toLowerCase()) (byBase.get(b) || byBase.set(b, []).get(b)).push(n.id);
  }
  for (const n of nodes) {
    const group = byBase.get(n.label.toLowerCase());
    if (group) for (const other of group) add(n.id, other, 'names differ only by a version or legacy marker', 3);
  }
  for (const group of byBase.values()) if (group.length > 1) allPairs(group, 'names differ only by a version or legacy marker', 3);
  // Validators and what their callers do next.
  for (const n of nodes) {
    if (!CALLABLE.has(n.kind) || !VALIDATOR.test(n.label)) continue;
    let added = 0;
    for (const e of tools.inc.get(n.id) || []) {
      if (e.kind !== 'call') continue;
      for (const sib of tools.out.get(e.source) || []) {
        if (sib.kind !== 'call' || sib.target === n.id || added >= 3) continue;
        add(n.id, sib.target, `both called by ${label(e.source)}, which checks with ${n.label}`, 2);
        added++;
      }
    }
  }
  // Same parameter and return types (not trivial ones).
  const byShape = new Map();
  for (const n of nodes) {
    if (!CALLABLE.has(n.kind) || n.label.startsWith('~') || (tools.inc.get(n.id) || []).some(e => e.kind === 'overrides') || (tools.out.get(n.id) || []).some(e => e.kind === 'overrides')) continue;
    const s = shapeOf(n);
    if (s && !/\(\s*(const)?\s*\)$/.test(s)) (byShape.get(s) || byShape.set(s, []).get(s)).push(n.id);
  }
  for (const [s, ids] of byShape) if (ids.length > 1 && ids.length <= 6) allPairs(ids, 'same parameter and return types: ' + s, 2);
  // Similar names.
  const callables = nodes.filter(n => CALLABLE.has(n.kind));
  // Word parts only (tokenize also yields the whole name, e.g. load_user_profile).
  const toks = new Map(callables.map(n => [n.id, new Set(tokenize(n.label).filter(t => t.length > 2 && !t.includes('_')))]));
  for (let i = 0; i < callables.length && i < 800; i++) {
    for (let j = i + 1; j < callables.length && j < 800; j++) {
      const A = toks.get(callables[i].id);
      const B = toks.get(callables[j].id);
      if (A.size < 2 || B.size < 2 || callables[i].label === callables[j].label) continue;
      let shared = 0;
      for (const t of A) if (B.has(t)) shared++;
      if (shared / (A.size + B.size - shared) >= 0.5) add(callables[i].id, callables[j].id, 'similar names', 1);
    }
  }
  return [...found.values()].sort((x, y) => y.weight - x.weight).slice(0, max).map(({ a, b, hint }) => ({ a, b, hint }));
}

// ---- prompts --------------------------------------------------------------------

function numbered(text, from, to) {
  const all = text.split(/\r?\n/);
  const b = Math.min(all.length, to);
  const out = [];
  for (let i = Math.max(1, from); i <= b; i++) out.push(String(i).padStart(4) + '  ' + all[i - 1]);
  return out.join('\n');
}

async function codeOf(tools, n, lines) {
  const r = tools.codeRange(n);
  const text = await tools.source(r.file);
  if (text == null) return null;
  return numbered(text, r.start, Math.min(r.end, r.start + lines - 1));
}

/** The file an element is tagged with: where it is defined. */
function homeFile(n) {
  return n.defFile || n.file;
}

async function buildConceptPrompt(tools, file, elements, known) {
  const refs = new Map();
  const blocks = [];
  for (const [i, n] of elements.entries()) {
    const ref = 'E' + (i + 1);
    refs.set(ref, n.id);
    const code = await codeOf(tools, n, LINES_PER_ELEMENT);
    blocks.push(`${ref} ${n.kind} ${n.qname || n.label}${n.signature ? ' — ' + n.signature : ''}${code ? '\n```cpp\n' + code + '\n```' : ''}`);
  }
  const prompt = `You are labeling the parts of a C/C++ codebase with the concepts they belong to: the feature, workflow or responsibility each one serves, such as "logging", "shape rendering", "config parsing" or "memory management".
Give each element 1 or 2 short lowercase concepts of 1-3 words. Use the same concept for elements that serve the same purpose.${known.length ? '\nPrefer these concepts, already used elsewhere in the codebase, when they fit: ' + known.slice(0, 60).join(', ') + '.' : ''}
Reply with only a JSON object mapping each ref to its concepts, no Markdown: {"E1": ["logging"], "E2": ["shape rendering", "geometry"]}

File: ${file}

${blocks.join('\n\n')}`;
  return { prompt, refs };
}

function parseConcepts(text, refs) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  const out = new Map();
  if (!m) return out;
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return out;
  }
  for (const [ref, v] of Object.entries(o || {})) {
    const id = refs.get(ref.trim());
    if (!id) continue;
    const tags = [...new Set((Array.isArray(v) ? v : [v]).map(t => String(t == null ? '' : t).toLowerCase().replace(/\s+/g, ' ').trim()).filter(t => t && t.length <= 30))].slice(0, 2);
    if (tags.length) out.set(id, tags);
  }
  return out;
}

async function buildPairPrompt(tools, pairs) {
  const refs = new Map();
  const blocks = [];
  for (const [i, p] of pairs.entries()) {
    const ref = 'P' + (i + 1);
    refs.set(ref, p);
    const side = async (letter, id) => {
      const n = tools.nodes.get(id);
      const r = tools.codeRange(n);
      const code = await codeOf(tools, n, PAIR_LINES);
      return `${letter}: ${n.kind} ${n.qname || n.label} @${r.file}:${r.start}${code ? '\n```cpp\n' + code + '\n```' : ''}`;
    };
    blocks.push(`${ref} (candidate because ${p.hint})\n${await side('A', p.a)}\n${await side('B', p.b)}`);
  }
  const prompt = `Below are pairs of elements from a C/C++ codebase that may be related in ways a call graph does not show. For each pair, decide which relationship holds:
- "alternative": they are alternative implementations of the same thing (for example two shapes' draw methods, or two storage backends)
- "replaces": the first appears to be a newer replacement for the second, which looks legacy
- "validates": the first checks a condition or invariant that the second relies on
- "none": none of these, or the code does not show it
Only claim a relationship the code supports. Quote evidence exactly as it appears on one line, without the line number.
Reply with only a JSON array, one entry per pair, no Markdown:
[{"ref": "P1", "relation": "alternative", "first": "A", "confidence": 0.8, "reason": "under 20 words", "evidence": {"element": "A", "line": 12, "quote": "exact code from that line"}}]
"first" is "A" or "B": which element is the first one for replaces and validates.

${blocks.join('\n\n')}`;
  return { prompt, refs };
}

/** Edges from the model's reply. Evidence quotes are checked against the source; a wrong quote is dropped and lowers confidence. */
async function parsePairs(tools, text, refs, provenance) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  const results = new Map(); // ref -> edge or null (checked, nothing found)
  if (!m) return results;
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return results;
  }
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  for (const v of Array.isArray(arr) ? arr : []) {
    if (!v || typeof v !== 'object') continue;
    const ref = String(v.ref || '').trim();
    const pair = refs.get(ref);
    if (!pair || results.has(ref)) continue;
    const relation = String(v.relation || '').toLowerCase().trim();
    let confidence = Math.max(0, Math.min(1, +v.confidence || 0));
    if (!RELATIONS[relation]) {
      results.set(ref, null);
      continue;
    }
    const firstIsB = String(v.first || 'A').trim().toUpperCase() === 'B';
    const [s, t] = firstIsB ? [pair.b, pair.a] : [pair.a, pair.b];
    let evidence = null;
    const ev = v.evidence;
    if (ev && typeof ev === 'object' && ev.quote) {
      const evNode = tools.nodes.get(String(ev.element || 'A').trim().toUpperCase() === 'B' ? pair.b : pair.a);
      const file = tools.codeRange(evNode).file;
      const source = await tools.source(file);
      const line = Math.floor(+ev.line);
      const lines = source == null ? [] : source.split(/\r?\n/);
      const quote = norm(ev.quote);
      // The quote must be on the cited line, or within two lines of it.
      let found = null;
      for (const l of [line, line - 1, line + 1, line - 2, line + 2]) if (l >= 1 && l <= lines.length && quote && norm(lines[l - 1]).includes(quote)) (found = found || l);
      if (found) evidence = { file, line: found, quote: quote.slice(0, 160) };
      else confidence *= 0.7;
    }
    if (confidence < MIN_CONFIDENCE) {
      results.set(ref, null);
      continue;
    }
    results.set(ref, {
      id: `semantic:${s}->${t}`, kind: 'semantic', source: s, target: t, relation, label: RELATIONS[relation].label, symmetric: !!RELATIONS[relation].symmetric,
      confidence: Math.round(confidence * 100) / 100, reason: String(v.reason || '').trim().slice(0, 200), evidence,
      hint: pair.hint, provenance: { ...provenance, sKey: contentKey(tools, tools.nodes.get(s)), tKey: contentKey(tools, tools.nodes.get(t)) }
    });
  }
  return results;
}

// ---- build ---------------------------------------------------------------------

/** Concepts and edges of a saved layer that still match the code. */
function currentLayer(tools, state) {
  const concepts = {};
  const edges = [];
  if (!state) return { concepts, edges };
  for (const [id, c] of Object.entries(state.concepts || {})) {
    const n = tools.nodes.get(id);
    if (n && c.tags.length && contentKey(tools, n) === c.key) concepts[id] = c.tags;
  }
  for (const e of state.edges || []) {
    const s = tools.nodes.get(e.source);
    const t = tools.nodes.get(e.target);
    if (s && t && contentKey(tools, s) === e.provenance.sKey && contentKey(tools, t) === e.provenance.tKey) edges.push(e);
  }
  return { concepts, edges };
}

/**
 * Builds or updates the layer. Files whose elements all kept their content keys
 * reuse their concepts; pairs whose ends kept their keys reuse their result.
 * @param {import('./graphTools').GraphTools} tools
 * @param {object|null} prev  the state saved by the previous build
 * @param {(prompt:string)=>Promise<string>} complete
 * @param {{model?:string, onProgress?:(message:string, done:number, total:number)=>void, isCancelled?:()=>boolean, now?:number}} [opts]
 */
async function buildSemanticLayer(tools, prev, complete, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const provenance = { model: opts.model || null, time: opts.now || Date.now() };
  const prevConcepts = (prev && prev.concepts) || {};
  const state = { concepts: {}, edges: [], checked: {}, model: provenance.model, time: provenance.time };
  const stats = { filesTagged: 0, filesReused: 0, filesLeft: 0, pairsAsked: 0, pairsReused: 0, requests: 0, cancelled: false };
  // A failed request stops the build; what was done so far is kept.
  const ask = async prompt => {
    try {
      return await complete(prompt);
    } catch (err) {
      stats.error = (err && err.message) || String(err);
      return null;
    }
  };
  const stopped = () => stats.cancelled || !!stats.error || (cancelled() && (stats.cancelled = true));

  // Concepts, file by file.
  const byFile = new Map();
  for (const n of tools.nodes.values()) {
    if (!TAGGABLE.has(n.kind) || n.status === 'removed') continue;
    const f = homeFile(n);
    (byFile.get(f) || byFile.set(f, []).get(f)).push(n);
  }
  const files = [...byFile.keys()].sort();
  const pairs = candidatePairs(tools);
  const toTag = files.filter(f => !byFile.get(f).every(n => prevConcepts[n.id] && prevConcepts[n.id].key === contentKey(tools, n)));
  const pairKey = p => p.a + '|' + p.b;
  const keysOf = p => contentKey(tools, tools.nodes.get(p.a)) + '|' + contentKey(tools, tools.nodes.get(p.b));
  const toAsk = pairs.filter(p => !(prev && prev.checked && prev.checked[pairKey(p)] === keysOf(p)));
  const conceptRequests = toTag.reduce((s, f) => s + Math.ceil(byFile.get(f).length / ELEMENTS_PER_REQUEST), 0);
  const total = Math.min(conceptRequests, MAX_CONCEPT_REQUESTS) + Math.ceil(toAsk.length / PAIRS_PER_REQUEST);
  let done = 0;

  for (const f of files) {
    if (!toTag.includes(f)) {
      for (const n of byFile.get(f)) state.concepts[n.id] = prevConcepts[n.id];
      stats.filesReused++;
    }
  }
  const known = () => [...new Set(Object.values(state.concepts).flatMap(c => c.tags))].sort();
  for (const f of toTag) {
    const elements = byFile.get(f);
    if (stopped() || stats.requests >= MAX_CONCEPT_REQUESTS) {
      stats.filesLeft++;
      continue;
    }
    let finished = true;
    for (let i = 0; i < elements.length; i += ELEMENTS_PER_REQUEST) {
      const chunk = elements.slice(i, i + ELEMENTS_PER_REQUEST);
      onProgress(`Tagging concepts in ${f}`, done, total);
      const { prompt, refs } = await buildConceptPrompt(tools, f, chunk, known());
      const reply = await ask(prompt);
      if (reply == null) {
        finished = false;
        break;
      }
      const tags = parseConcepts(reply, refs);
      stats.requests++;
      done++;
      // Untagged elements are remembered too, so the file isn't asked about again until it changes.
      for (const n of chunk) state.concepts[n.id] = { tags: tags.get(n.id) || [], key: contentKey(tools, n) };
    }
    if (finished) stats.filesTagged++;
    else stats.filesLeft++;
  }

  // Inferred relationships between candidate pairs.
  const prevEdges = currentLayer(tools, prev).edges;
  const askKeys = new Set(toAsk.map(pairKey));
  for (const p of pairs) {
    if (askKeys.has(pairKey(p))) continue;
    state.checked[pairKey(p)] = keysOf(p);
    stats.pairsReused++;
  }
  for (const e of prevEdges) {
    const key = e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source;
    if (!askKeys.has(key)) state.edges.push(e);
  }
  for (let i = 0; i < toAsk.length; i += PAIRS_PER_REQUEST) {
    if (stopped()) break;
    const chunk = toAsk.slice(i, i + PAIRS_PER_REQUEST);
    onProgress(`Comparing ${chunk.length} pair${chunk.length === 1 ? '' : 's'} of related code`, done, total);
    const { prompt, refs } = await buildPairPrompt(tools, chunk);
    const reply = await ask(prompt);
    if (reply == null) break;
    const results = await parsePairs(tools, reply, refs, provenance);
    stats.requests++;
    done++;
    for (const [ref, p] of refs) {
      if (!results.has(ref)) continue; // not answered: ask again next time
      state.checked[pairKey(p)] = keysOf(p);
      stats.pairsAsked++;
      const edge = results.get(ref);
      if (edge) state.edges.push(edge);
    }
  }
  onProgress('Done', total, total);
  return { state, stats };
}

module.exports = { candidatePairs, baseName, buildConceptPrompt, parseConcepts, buildPairPrompt, parsePairs, buildSemanticLayer, currentLayer, RELATIONS };
