'use strict';

// Picks the parts of the graph that are worth sending to the model: ranks nodes
// by how well their names match the question and lists them compactly with short
// ids (N12) so answers can reference them.

const STOP_WORDS = new Set(('a an the is are was were be been of to in on for and or not with how what where which who why does do did ' +
  'this that these those it its from by as at into about between when there here can could should would will me my i you your ' +
  'code function functions class classes file files method methods call calls called work works happen happens get show explain').split(' '));

function terms(question) {
  return [...new Set(question.toLowerCase().split(/[^a-z0-9_~]+/).filter(t => t.length > 2 && !STOP_WORDS.has(t)))];
}

function relevance(n, qterms) {
  const name = (n.name || '').toLowerCase();
  const q = (n.qname || n.file || '').toLowerCase();
  let s = 0;
  for (const t of qterms) {
    if (name === t) s += 6;
    else if (name.includes(t)) s += 3;
    else if (q.includes(t)) s += 1;
    // camelCase / snake_case parts
    else if (name.replace(/_/g, '').includes(t.replace(/_/g, ''))) s += 2;
  }
  return s;
}

function buildContext(graph, question, focusId, budgetChars) {
  const qterms = terms(question);
  const listed = graph.nodes.filter(n => n.kind !== 'dir' && n.kind !== 'namespace' && n.kind !== 'field' && n.kind !== 'variable');
  const short = new Map();
  const byShort = new Map();
  listed.forEach((n, i) => {
    short.set(n.id, 'N' + i);
    byShort.set('N' + i, n.id);
  });
  const out = new Map();
  for (const e of graph.edges) {
    if (e.status === 'removed') continue;
    if (!short.has(e.s) || !short.has(e.t)) continue;
    let m = out.get(e.s);
    if (!m) out.set(e.s, (m = {}));
    (m[e.kind] || (m[e.kind] = [])).push(short.get(e.t));
  }
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.s, (degree.get(e.s) || 0) + 1);
    degree.set(e.t, (degree.get(e.t) || 0) + 1);
  }
  const score = n => relevance(n, qterms) * 10 + Math.min(5, (degree.get(n.id) || 0) / 4) + (n.id === focusId ? 100 : 0) + (n.name === 'main' ? 3 : 0);
  const ranked = listed.slice().sort((a, b) => score(b) - score(a));

  const line = n => {
    const rels = out.get(n.id) || {};
    const relText = Object.entries(rels)
      .map(([k, v]) => k + ':' + v.slice(0, 40).join(','))
      .join(' ');
    const loc = (n.defFile || n.file || '') + ':' + (n.defLine || n.line || 1);
    const status = n.status ? ' [' + n.status + ']' : '';
    return short.get(n.id) + ' ' + n.kind + ' ' + (n.qname || n.name) + status + ' @' + loc + (relText ? ' | ' + relText : '');
  };
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const n of ranked) {
    const l = line(n);
    if (used + l.length > budgetChars) {
      omitted++;
      continue;
    }
    lines.push(l);
    used += l.length + 1;
  }
  return { lines, omitted, short, byShort, ranked, qterms };
}

async function readSnippet(readSource, n, maxLines) {
  const file = n.defFile || n.file;
  const start = n.defLine || n.line || 1;
  const end = n.defFile ? n.defEndLine || n.endLine || start : n.endLine || start;
  try {
    const text = await readSource(file);
    if (text == null) return null;
    const all = text.split(/\r?\n/);
    const slice = all.slice(start - 1, Math.min(end, start - 1 + maxLines));
    return slice.join('\n') + (end - start + 1 > maxLines ? '\n// ... (truncated)' : '');
  } catch {
    return null;
  }
}

module.exports = { terms, relevance, buildContext, readSnippet };
