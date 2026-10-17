'use strict';

// Merges two graphs (base -> target) into one graph whose nodes and edges carry
// a `status`: 'added' | 'removed' | 'modified' | undefined (unchanged).

function diffGraphs(base, target) {
  const baseNodes = new Map(base.nodes.map(n => [n.id, n]));
  const targetIds = new Set(target.nodes.map(n => n.id));
  const nodes = [];
  const counts = { added: 0, removed: 0, modified: 0 };
  const countable = n => n.kind !== 'dir' && n.kind !== 'namespace';

  for (const n of target.nodes) {
    const b = baseNodes.get(n.id);
    const copy = Object.assign({}, n);
    if (!b) copy.status = 'added';
    else if (n.kind !== 'dir' && n.kind !== 'namespace' && (b.hash || '') !== (n.hash || '')) copy.status = 'modified';
    if (copy.status && countable(copy)) counts[copy.status]++;
    nodes.push(copy);
  }
  for (const n of base.nodes) {
    if (targetIds.has(n.id)) continue;
    const copy = Object.assign({}, n, { status: 'removed' });
    if (countable(copy)) counts.removed++;
    nodes.push(copy);
  }

  const key = e => e.s + '\u0001' + e.t + '\u0001' + e.kind;
  const baseEdges = new Map(base.edges.map(e => [key(e), e]));
  const targetKeys = new Set();
  const edges = [];
  const edgeCounts = { added: 0, removed: 0 };
  for (const e of target.edges) {
    const k = key(e);
    targetKeys.add(k);
    const copy = Object.assign({}, e);
    if (!baseEdges.has(k)) {
      copy.status = 'added';
      edgeCounts.added++;
    }
    edges.push(copy);
  }
  for (const [k, e] of baseEdges) {
    if (targetKeys.has(k)) continue;
    edges.push(Object.assign({}, e, { status: 'removed' }));
    edgeCounts.removed++;
  }

  return {
    nodes,
    edges,
    stats: {
      files: target.stats.files,
      nodes: nodes.length,
      edges: edges.length,
      errors: target.stats.errors,
      diff: { nodes: counts, edges: edgeCounts }
    }
  };
}

module.exports = { diffGraphs };
