// The graph model: the effective tree, expansion, presets, the visible graph
// (computeVisible) and the sets derived from selection and highlights.
// No DOM: renderers and panels read what it computes.

import { KIND_INFO, EDGE_KINDS, CODE_KINDS, PRESETS, TIER_ORDER } from './constants.js';
import { push } from './util.js';
import { S } from './state.js';

export const INITIAL_BUDGET = 45;

/**
 * Takes a graph from the extension: indexes it, keeps or resets the expansion
 * and rebuilds the tree. Returns true when the view starts fresh (a new mode
 * with no saved state to restore), so the caller fits it.
 */
export function setGraph(graph, mode, title) {
  const modeChanged = S.mode !== mode || !S.graph;
  const firstLoad = !S.graph;
  // The AI layer's inferred links are not shown; only its concept tags are.
  graph = { ...graph, edges: graph.edges.filter(e => e.kind !== 'semantic') };
  S.graph = graph;
  S.mode = mode;
  S.title = title || '';
  S.nodes = new Map(graph.nodes.map(n => [n.id, n]));
  S.concepts = graph.concepts || {};
  S.semantic = graph.semantic || null;
  S.out = new Map();
  S.inc = new Map();
  for (const e of graph.edges) {
    push(S.out, e.s, e);
    push(S.inc, e.t, e);
  }

  // Expansion state: keep it across refreshes, restore saved state on first
  // load, otherwise pick a sensible starting depth.
  const restore = firstLoad && S.savedMode === mode && S.expanded.size;
  const fresh = modeChanged && !restore;
  if (fresh) {
    S.expanded = new Set();
    S.codeOpen = new Set();
    S.view = null;
    S.highlight = null;
  }
  for (const id of [...S.expanded]) if (!S.nodes.has(id)) S.expanded.delete(id);
  for (const id of [...S.codeOpen]) if (!S.nodes.has(id) || !CODE_KINDS.has(S.nodes.get(id).kind)) S.codeOpen.delete(id);
  if (S.selected && !S.nodes.has(S.selected)) S.selected = null;
  if (fresh) applyPresetSettings(S.preset);
  rebuildTree();
  if (fresh) presetExpansion(S.preset);
  return fresh;
}

export function rebuildTree() {
  const transparent = n => n.kind === 'namespace' && !S.showNamespaces;
  const kindHidden = n => !S.showFields && (n.kind === 'field' || n.kind === 'variable');
  S.kindHidden = id => {
    const n = S.nodes.get(id);
    return n ? kindHidden(n) : false;
  };
  S.children = new Map();
  S.parentOf = new Map();
  S.roots = [];
  for (const n of S.graph.nodes) {
    if (transparent(n) || kindHidden(n)) continue;
    let p = n.parent;
    while (p && S.nodes.has(p) && transparent(S.nodes.get(p))) p = S.nodes.get(p).parent;
    if (p && !S.nodes.has(p)) p = null;
    S.parentOf.set(n.id, p || null);
    if (p) push(S.children, p, n.id);
    else S.roots.push(n.id);
  }
  // Drop nodes whose ancestor chain is hidden.
  const valid = new Set();
  const visit = id => {
    valid.add(id);
    for (const c of S.children.get(id) || []) visit(c);
  };
  S.roots.forEach(visit);
  for (const id of [...S.parentOf.keys()]) if (!valid.has(id)) S.parentOf.delete(id);
  const cmp = (a, b) => {
    const na = S.nodes.get(a);
    const nb = S.nodes.get(b);
    const ra = (KIND_INFO[na.kind] || {}).rank || 9;
    const rb = (KIND_INFO[nb.kind] || {}).rank || 9;
    if (na.kind === 'dir' || na.kind === 'file' || nb.kind === 'dir' || nb.kind === 'file') {
      if (ra !== rb) return ra - rb;
      return na.name.localeCompare(nb.name);
    }
    if (na.file !== nb.file) return (na.file || '').localeCompare(nb.file || '');
    return (na.line || 0) - (nb.line || 0);
  };
  S.roots.sort(cmp);
  for (const arr of S.children.values()) arr.sort(cmp);
}

export function kids(id) {
  return S.children.get(id) || [];
}

export function ancestors(id) {
  // Effective ancestors from the root down to (excluding) id.
  const chain = [];
  let p = S.parentOf.get(id);
  while (p) {
    chain.unshift(p);
    p = S.parentOf.get(p);
  }
  return chain;
}

export function inTree(id) {
  return S.parentOf.has(id);
}

export function nearestInTree(id) {
  // For nodes filtered out by kind (e.g. fields), use the closest shown ancestor.
  let cur = id;
  while (cur && !inTree(cur)) {
    cur = (S.nodes.get(cur) || {}).parent;
  }
  return cur || null;
}

export function initialExpansion() {
  S.expanded = new Set();
  openLevels(['dir', 'file', 'namespace'], INITIAL_BUDGET);
  // A single root folder is always worth opening.
  if (S.roots.length === 1) S.expanded.add(S.roots[0]);
}

export function openLevels(kinds, budget) {
  // Open nodes of the given kinds level by level while the visible count stays within budget.
  const open = new Set(kinds);
  let visible = S.roots.length;
  let level = S.roots.slice();
  while (level.length) {
    const next = [];
    for (const id of level) {
      const n = S.nodes.get(id);
      const c = kids(id);
      if (!c.length || !open.has(n.kind)) continue;
      if (visible + c.length > budget) continue;
      S.expanded.add(id);
      visible += c.length;
      next.push(...c);
    }
    level = next;
  }
}

export function applyPresetSettings(name) {
  const p = PRESETS[name];
  if (!p) return;
  const on = new Set(p.edges);
  S.edgeOn = Object.fromEntries(EDGE_KINDS.map(k => [k.kind, on.has(k.kind)]));
  S.showFields = p.fields;
  S.showNamespaces = p.namespaces;
  S.edgeMode = p.mode;
  S.direction = p.direction;
}

export function presetExpansion(name) {
  const p = PRESETS[name];
  if (!p || !p.expand) return initialExpansion();
  S.expanded = new Set();
  openLevels(p.expand, p.budget);
  if (S.roots.length === 1) S.expanded.add(S.roots[0]);
}

export function computeVisible() {
  const visible = [];
  const rep = new Map();
  const walk = (id, hiddenUnder) => {
    rep.set(id, hiddenUnder || id);
    if (!hiddenUnder) visible.push(id);
    const open = S.expanded.has(id);
    for (const c of kids(id)) walk(c, hiddenUnder || (open ? null : id));
  };
  for (const r of S.roots) walk(r, null);

  const repOf = id => {
    const t = nearestInTree(id);
    return t ? rep.get(t) : undefined;
  };
  const isAncestor = (a, b) => {
    let p = S.parentOf.get(b);
    while (p) {
      if (p === a) return true;
      p = S.parentOf.get(p);
    }
    return false;
  };

  const agg = new Map();
  for (const e of S.graph.edges) {
    if (!S.edgeOn[e.kind]) continue;
    if (e.uncertain && !S.showUncertain) continue;
    const s = repOf(e.s);
    const t = repOf(e.t);
    if (!s || !t || s === t) continue;
    if (isAncestor(s, t) || isAncestor(t, s)) continue;
    const key = s + '\u0001' + t + '\u0001' + e.kind;
    let a = agg.get(key);
    if (!a) {
      a = { key, s, t, kind: e.kind, count: 0, raw: [], uncertain: true, statuses: new Set() };
      agg.set(key, a);
    }
    a.count += e.n || 1;
    a.raw.push(e);
    if (!e.uncertain) a.uncertain = false;
    a.statuses.add(e.status || 'same');
  }
  const edges = [...agg.values()];
  for (const e of edges) {
    e.status = e.statuses.size === 1 ? [...e.statuses][0] : 'mixed';
    if (e.status === 'same') e.status = null;
  }
  return { visible, visibleSet: new Set(visible), rep, repOf, edges, bundles: bundleEdges(edges) };
}

/**
 * Groups edges that run between nested nodes of two different containers into
 * one bundle per (container, container, kind). An edge between siblings is
 * drawn as is, so it is left out. Each edge gets `bundleKey` (or null).
 * A bundle looks like an edge (s, t, kind, count, raw ...) so the details
 * panel and tooltips can treat both the same way.
 */
export function bundleEdges(edges) {
  const groups = new Map();
  for (const e of edges) {
    e.bundleKey = null;
    const pa = ancestors(e.s).concat([e.s]);
    const pb = ancestors(e.t).concat([e.t]);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    if (i >= pa.length || i >= pb.length) continue;
    const cs = pa[i];
    const ct = pb[i];
    if (cs === e.s && ct === e.t) continue; // siblings: nothing to bundle
    const key = 'bundle' + '\u0001' + cs + '\u0001' + ct + '\u0001' + e.kind;
    let b = groups.get(key);
    if (!b) {
      b = { key, s: cs, t: ct, kind: e.kind, count: 0, raw: [], members: [], uncertain: true, statuses: new Set(), bundle: true };
      groups.set(key, b);
    }
    b.count += e.count;
    b.raw.push(...e.raw);
    b.members.push(e);
    if (!e.uncertain) b.uncertain = false;
    b.statuses.add(e.status || 'same');
    e.bundleKey = key;
  }
  const bundles = [];
  for (const b of groups.values()) {
    // A bundle of one edge is just that edge.
    if (b.members.length === 1) {
      b.members[0].bundleKey = null;
      continue;
    }
    b.status = b.statuses.size === 1 ? [...b.statuses][0] : 'mixed';
    if (b.status === 'same') b.status = null;
    bundles.push(b);
  }
  return bundles;
}

export function findEdge(key) {
  // An edge or a bundle of the visible graph by its key.
  const vis = S.vis;
  if (!vis) return null;
  return vis.edges.find(x => x.key === key) || vis.bundles.find(x => x.key === key) || null;
}

export function nodeLabel(n) {
  return n.name || '(unnamed)';
}

export function descendantsOf(id) {
  const out = [];
  const stack = [...kids(id)];
  while (stack.length) {
    const c = stack.pop();
    out.push(c);
    stack.push(...kids(c));
  }
  return out;
}

export function relatedSets() {
  // Nodes/edges connected to the selection (for highlighting and dimming).
  const sel = S.selected;
  const vis = S.vis;
  if (!sel) return null;
  const r = vis.repOf(sel);
  if (!r) return null;
  const nodes = new Set([r]);
  const edges = new Set();
  // Include edges touching the selected node or any of its visible descendants.
  const isUnder = id => {
    let cur = id;
    while (cur) {
      if (cur === r) return true;
      cur = S.parentOf.get(cur);
    }
    return false;
  };
  for (const e of vis.edges) {
    if (isUnder(e.s) || isUnder(e.t)) {
      edges.add(e.key);
      nodes.add(e.s);
      nodes.add(e.t);
    }
  }
  // Keep ancestors of related nodes visible as context.
  for (const id of [...nodes]) for (const a of ancestors(id)) nodes.add(a);
  let cur = r;
  const stack = [r];
  while (stack.length) {
    cur = stack.pop();
    nodes.add(cur);
    for (const c of kids(cur)) if (vis.visibleSet.has(c)) stack.push(c);
  }
  return { nodes, edges, root: r };
}

export function highlightReps() {
  if (!S.highlight) return null;
  const set = new Set();
  for (const id of S.highlight.ids) {
    const r = S.vis.repOf(id);
    if (r) set.add(r);
  }
  return set;
}

export function isDescendant(id, ancestor) {
  let p = S.parentOf.get(id);
  while (p) {
    if (p === ancestor) return true;
    p = S.parentOf.get(p);
  }
  return false;
}

export function changedDescendantCounts() {
  const counts = new Map();
  for (const n of S.graph.nodes) {
    if (!n.status || !inTree(n.id)) continue;
    for (const a of ancestors(n.id)) counts.set(a, (counts.get(a) || 0) + 1);
  }
  return counts;
}

/** The predicted items, riskiest first. */
export function impactItems(imp) {
  return imp.result.items;
}

/** Visible node -> worst tier of the affected nodes it stands for ('target' for the changed node). */
export function impactTiers(vis) {
  if (!S.highlight || S.highlight.source !== 'impact') return null;
  const imp = S.highlight.impact;
  if (!imp.result || imp.result.error) return null; // a new kind of change is being worked out
  const tiers = new Map();
  for (const it of impactItems(imp)) {
    const r = vis.repOf(it.id);
    if (r && (TIER_ORDER[it.tier] || 0) > (TIER_ORDER[tiers.get(r)] || 0)) tiers.set(r, it.tier);
  }
  const t = vis.repOf(imp.target);
  if (t) tiers.set(t, 'target');
  return tiers;
}

let rawChildren = null;
export function kidsRaw(id) {
  if (!rawChildren || rawChildren.graph !== S.graph) {
    rawChildren = { graph: S.graph, map: new Map() };
    for (const n of S.graph.nodes) if (n.parent) push(rawChildren.map, n.parent, n.id);
  }
  return rawChildren.map.get(id) || [];
}
