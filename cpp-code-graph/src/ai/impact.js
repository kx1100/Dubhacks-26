'use strict';

// Change-impact prediction: if this function, class or header changes, what
// else might need to change or could break? Walks the code graph from the
// target and scores each affected node. This is a prediction from the graph,
// not a guarantee: calls through function pointers, macros and templates are
// not in the graph, and calls matched by name only may be wrong.
// No `vscode` dependency.

const CHANGE_TYPES = {
  signature: 'Signature or return type',
  behavior: 'Behavior only',
  rename: 'Rename',
  remove: 'Remove'
};

// How strongly each relationship is affected by each kind of change (0-1).
//   caller      calls the target directly
//   indirect    calls it through other functions (weight per extra level is halved)
//   override    overrides the target (a base method); must keep matching it
//   base        the base method the target overrides; the target must keep matching it
//   derived     derives from the target class
//   typeUser    uses the target type (variables, parameters, members)
//   memberCaller calls a member of the target class
//   includer    includes the header declaring the target (it only recompiles,
//               unless it also calls or uses the target, which counts separately)
//   fileIncluder includes the target file itself (its #include line names it)
//   implementation  the source file implementing the target header
// For a file, "signature" means its interface: the declarations it provides.
const WEIGHTS = {
  signature: { caller: 1, indirect: 0.2, override: 1, base: 0.8, derived: 0.7, typeUser: 0.8, memberCaller: 0.6, includer: 0.2, fileIncluder: 0.6, implementation: 0.9 },
  behavior: { caller: 0.6, indirect: 0.45, override: 0.3, base: 0.2, derived: 0.5, typeUser: 0.4, memberCaller: 0.4, includer: 0.05, fileIncluder: 0.15, implementation: 0.3 },
  rename: { caller: 1, indirect: 0.1, override: 1, base: 0.6, derived: 1, typeUser: 1, memberCaller: 0.2, includer: 0.2, fileIncluder: 1, implementation: 0.9 },
  remove: { caller: 1, indirect: 0.3, override: 1, base: 0.6, derived: 1, typeUser: 1, memberCaller: 1, includer: 0.3, fileIncluder: 1, implementation: 1 }
};

const RELATION_LABELS = {
  caller: 'Calls it directly',
  indirect: 'Calls it indirectly',
  override: 'Overrides it',
  base: 'Base method it overrides',
  derived: 'Derived classes',
  typeUser: 'Uses the type',
  memberCaller: 'Calls its members',
  includer: 'Includes its header',
  fileIncluder: 'Includes the file',
  implementation: 'Implements the header'
};

const ELIGIBLE = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'file']);
const CLASSLIKE = new Set(['class', 'struct', 'union', 'enum']);
const MAX_DEPTH = 4;
const MAX_ITEMS = 300;
/** A test file: in a tests/spec folder, named test_x / x_test / x-spec, or CamelCase FooTest. */
function isTestFile(file) {
  if (!file) return false;
  const parts = file.split('/');
  const base = parts.pop().replace(/\.[^.]+$/, '');
  return (
    parts.some(p => /^(tests?|specs?|unittests?)$/i.test(p)) ||
    /^(tests?|specs?)$|^(tests?|specs?)[_.-]|[_.-](tests?|specs?)$/i.test(base) ||
    /[a-z0-9]Tests?$/.test(base)
  );
}

function canPredict(n) {
  return !!n && ELIGIBLE.has(n.kind) && n.status !== 'removed';
}

function tierOf(score) {
  return score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
}

/**
 * @param {import('./graphTools').GraphTools} tools
 * @param {string} targetId
 * @param {'signature'|'behavior'|'rename'|'remove'} changeType
 */
function predictImpact(tools, targetId, changeType) {
  const target = tools.nodes.get(targetId);
  if (!canPredict(target)) return { error: 'Impact can be predicted for functions, methods, classes, structs, enums and files.' };
  if (!CHANGE_TYPES[changeType]) changeType = 'signature';
  const W = WEIGHTS[changeType];

  const out = id => tools.out.get(id) || [];
  const inc = id => tools.inc.get(id) || [];
  const fileOf = id => {
    const n = tools.nodes.get(id);
    return n ? (n.kind === 'file' ? n.file : n.defFile || n.file) : null;
  };
  const dirOf = f => (f && f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  const nodeOfFile = f => tools.nodes.get('file:' + f);

  // Collect: id -> best (highest weight) reason.
  const found = new Map();
  const add = (id, relation, depth, via, edge) => {
    if (!id || id === targetId || !tools.nodes.has(id)) return;
    const w = W[relation] * (relation === 'indirect' ? Math.pow(0.5, depth - 2) : 1);
    const prev = found.get(id);
    if (prev && prev.weight >= w) return;
    found.set(id, { id, relation, depth, via, weight: w, uncertain: !!(edge && edge.uncertain), site: (edge && edge.sites && edge.sites[0]) || null });
  };

  /** Callers of `start` (direct, then indirect up to MAX_DEPTH). */
  const callersOf = (start, directRelation) => {
    let frontier = [start];
    const seen = new Set([start, targetId]);
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const e of inc(id)) {
          if (e.kind !== 'calls' || seen.has(e.s)) continue;
          seen.add(e.s);
          add(e.s, depth === 1 ? directRelation : 'indirect', depth === 1 ? 1 : depth, id, e);
          next.push(e.s);
        }
      }
      frontier = next;
    }
  };

  const fn = target.kind === 'function' || target.kind === 'method';
  if (fn) {
    callersOf(targetId, 'caller');
    for (const e of inc(targetId)) if (e.kind === 'overrides') add(e.s, 'override', 1, targetId, e);
    for (const e of out(targetId)) if (e.kind === 'overrides') add(e.t, 'base', 1, targetId, e);
    // The header that declares it, and the files including that header, see the declaration.
    const declFile = target.declFile || (target.defFile && target.defFile !== target.file ? target.file : null);
    if (declFile && changeType !== 'behavior') {
      for (const e of inc('file:' + declFile)) if (e.kind === 'includes') add(e.s, 'includer', 1, 'file:' + declFile, e);
    }
  } else if (CLASSLIKE.has(target.kind)) {
    for (const e of inc(targetId)) if (e.kind === 'uses') add(e.s, 'typeUser', 1, targetId, e);
    // Derived classes, transitively.
    let frontier = [targetId];
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const e of inc(id)) {
          if (e.kind !== 'inherits' || found.has(e.s)) continue;
          add(e.s, 'derived', depth, id, e);
          next.push(e.s);
        }
      }
      frontier = next;
    }
    // Callers of its members (constructors included).
    for (const mid of tools.children.get(targetId) || []) {
      for (const e of inc(mid)) if (e.kind === 'calls' && !(tools.children.get(targetId) || []).includes(e.s)) add(e.s, 'memberCaller', 1, mid, e);
    }
    const headerFile = target.file;
    if (changeType !== 'behavior' && headerFile && nodeOfFile(headerFile) && nodeOfFile(headerFile).header) {
      for (const e of inc('file:' + headerFile)) if (e.kind === 'includes') add(e.s, 'includer', 1, 'file:' + headerFile, e);
    }
  } else if (target.kind === 'file') {
    // Includers, transitively (each level halves the weight).
    let frontier = [targetId];
    const seen = new Set([targetId]);
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const e of inc(id)) {
          if (e.kind !== 'includes' || seen.has(e.s)) continue;
          seen.add(e.s);
          add(e.s, 'fileIncluder', depth, id, e);
          // Only direct includers name the file; deeper ones just see its declarations.
          if (depth > 1) found.get(e.s).weight *= Math.pow(0.5, depth - 1);
          next.push(e.s);
        }
      }
      frontier = next;
    }
    for (const e of out(targetId)) if (e.kind === 'pairs') add(e.t, 'implementation', 1, targetId, e);
  }

  // Tests: does any test file reach the target or an affected node through calls?
  const reachedByTests = id => {
    let frontier = [id];
    const seen = new Set(frontier);
    for (let depth = 0; depth <= MAX_DEPTH + 2 && frontier.length; depth++) {
      const next = [];
      for (const x of frontier) {
        if (isTestFile(fileOf(x))) return true;
        for (const e of inc(x)) if (e.kind === 'calls' && !seen.has(e.s)) (seen.add(e.s), next.push(e.s));
      }
      frontier = next;
    }
    return false;
  };
  const targetTested = reachedByTests(targetId);
  const targetDir = dirOf(fileOf(targetId));

  const items = [];
  for (const f of found.values()) {
    const n = tools.nodes.get(f.id);
    const file = fileOf(f.id);
    const callers = new Set(inc(f.id).filter(e => e.kind === 'calls').map(e => e.s)).size;
    const crossDir = dirOf(file) !== targetDir;
    const test = isTestFile(file);
    let mult = 1;
    if (f.uncertain) mult *= 0.6; // matched by name: may not be affected at all
    if (crossDir) mult *= 1.15;
    mult *= 1 + Math.min(0.3, 0.1 * Math.log2(1 + callers)); // much depends on it
    if (!targetTested && !test) mult *= 1.1; // nothing would catch a mistake
    if (test) mult *= 0.7; // a failing test is the good outcome
    const score = Math.round(Math.min(1, f.weight * mult) * 100);
    items.push({
      id: f.id, kind: n.kind, relation: f.relation, depth: f.depth, via: f.via, site: f.site, uncertain: f.uncertain,
      file, crossDir, test, callers, score, tier: tierOf(score)
    });
  }
  items.sort((a, b) => b.score - a.score || a.depth - b.depth || String(a.file).localeCompare(String(b.file)));
  const truncated = items.length > MAX_ITEMS;
  if (truncated) items.length = MAX_ITEMS;

  // Overall: grows with the number and strength of affected places.
  const total = items.reduce((s, i) => s + i.score, 0);
  const overall = Math.round(100 * (1 - Math.exp(-total / 250)));
  const files = new Set(items.map(i => i.file).filter(Boolean));
  const dirs = new Set([...files].map(dirOf));
  const count = t => items.filter(i => i.tier === t).length;
  const notes = [];
  const header = target.declFile || (target.kind === 'file' && target.header ? target.file : CLASSLIKE.has(target.kind) && nodeOfFile(target.file) && nodeOfFile(target.file).header ? target.file : null);
  if (target.isStatic && target.kind === 'function') notes.push('It is file-local (static), so only code in its own file can call it.');
  else if (header) notes.push(`It is declared in the header ${header}, so other files can depend on it.`);
  if (target.isVirtual || items.some(i => i.relation === 'override')) notes.push('It is virtual: overrides must keep the same signature.');
  const unsure = items.filter(i => i.uncertain).length;
  if (unsure) notes.push(`${unsure} of these ${unsure === 1 ? 'was' : 'were'} matched by name only and may not really be affected.`);
  notes.push(targetTested ? 'Tests reach this code.' : 'No tests were found that reach this code, so a mistake may go unnoticed.');
  if (!items.length) notes.push('Nothing in the graph depends on it. Code the graph misses (function pointers, macros, other projects) could still use it.');

  return {
    target: targetId,
    changeType,
    items,
    truncated,
    summary: { count: items.length, high: count('high'), medium: count('medium'), low: count('low'), files: files.size, dirs: dirs.size, overall, tier: tierOf(overall), tested: targetTested, notes }
  };
}

module.exports = { predictImpact, canPredict, isTestFile, CHANGE_TYPES, RELATION_LABELS, WEIGHTS };
