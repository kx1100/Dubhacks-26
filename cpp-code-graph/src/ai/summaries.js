'use strict';

// Plain-language summaries of a single node for the details panel: what it is
// for, a few role tags and notable facts. Built from the node's source and its
// connections, and cached by the extension under contentKey() so a summary is
// recomputed only when the code it describes changes.
// No `vscode` dependency: the model is reached through complete(prompt) -> text.

const { hashString } = require('../parser/cppParser');

const SUMMARIZABLE = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'file', 'variable']);
const CONTAINERS = new Set(['class', 'struct', 'union', 'enum', 'file']);
const SOURCE_LINES = 80;
const NAMES = 12; // names listed per relationship

const PROMPT = `You write short descriptions of code for a developer who is exploring a C/C++ codebase as a graph and may be new to it.
Say what this element is for: its role and responsibility in the program. Do not restate its signature or count its members; the developer already sees those.
Base it on the code and the connections below. If they don't show its purpose, say what can be seen and keep it short.
Reply with only a JSON object, no Markdown:
{"purpose": "1-2 plain sentences: what it does and why it exists",
 "tags": ["1-3 short role tags, e.g. entry point, validation, I/O, rendering, data model, cleanup, error handling"],
 "notes": ["0-3 facts a newcomer should know, under 15 words each: side effects, error behavior, ownership, invariants"]}`;

function canSummarize(n) {
  return !!n && SUMMARIZABLE.has(n.kind) && n.status !== 'removed';
}

/**
 * Changes whenever the code a summary is based on changes: the node's own hash,
 * plus its members' hashes for classes and enums (a class hash covers only its
 * head and fields). Null when the node can't be summarized.
 * @param {import('./graphTools').GraphTools} tools
 */
function contentKey(tools, n) {
  if (!canSummarize(n)) return null;
  let key = n.hash || '';
  if (CONTAINERS.has(n.kind) && n.kind !== 'file') {
    for (const id of tools.children.get(n.id) || []) key += '|' + ((tools.nodes.get(id) || {}).hash || '');
  }
  return key ? hashString(key) : hashString(n.id + '@' + (n.defLine || n.line || 0));
}

/** The prompt for one node: what it is, its connections and its source. */
async function buildPrompt(tools, n) {
  const label = x => (x.kind === 'file' ? x.file : x.qname || x.name);
  const name = id => {
    const x = tools.nodes.get(id);
    return x ? label(x) : id;
  };
  const rel = (list, pick, label) => {
    const names = [...new Set(list.map(pick))].map(name);
    if (!names.length) return '';
    return `${label}: ${names.slice(0, NAMES).join(', ')}${names.length > NAMES ? ` and ${names.length - NAMES} more` : ''}`;
  };
  const out = tools.out.get(n.id) || [];
  const inc = tools.inc.get(n.id) || [];
  const of = (list, kind) => list.filter(e => e.kind === kind);
  const parent = n.parent && tools.nodes.get(n.parent);

  const lines = [`Element: ${label(n)} (${n.kind}${n.kind === 'file' && n.header ? ', header' : ''})`];
  if (parent && parent.kind !== 'dir' && parent.kind !== 'file') lines.push(`Inside: ${parent.qname || parent.name} (${parent.kind})`);
  if (n.signature) lines.push('Signature: ' + n.signature);
  const r = tools.codeRange(n);
  lines.push('Location: ' + r.file + ':' + r.start);
  lines.push(
    rel(of(inc, 'calls'), e => e.s, 'Called by'),
    rel(of(out, 'calls'), e => e.t, 'Calls'),
    rel(of(out, 'uses'), e => e.t, 'Uses types'),
    rel(of(inc, 'uses'), e => e.s, 'Used by'),
    rel(of(out, 'inherits'), e => e.t, 'Derives from'),
    rel(of(inc, 'inherits'), e => e.s, 'Derived classes'),
    rel(of(out, 'overrides'), e => e.t, 'Overrides'),
    rel(of(inc, 'overrides'), e => e.s, 'Overridden by'),
    rel(of(out, 'includes'), e => e.t, 'Includes'),
    rel(of(inc, 'includes'), e => e.s, 'Included by'),
    rel(of(out, 'pairs'), e => e.t, 'Implemented in'),
    rel(of(inc, 'pairs'), e => e.s, 'Implements declarations from')
  );
  const kids = (tools.children.get(n.id) || []).map(id => tools.nodes.get(id)).filter(Boolean);
  if (kids.length) lines.push(`Contains: ${kids.slice(0, 30).map(k => `${k.qname || k.name} (${k.kind})`).join(', ')}${kids.length > 30 ? ` and ${kids.length - 30} more` : ''}`);
  if (n.values && n.values.length) lines.push('Values: ' + n.values.slice(0, 20).join(', '));

  const text = await tools.source(r.file);
  if (text != null) {
    const all = text.split(/\r?\n/);
    const end = n.kind === 'file' ? Math.min(all.length, SOURCE_LINES) : Math.min(all.length, r.end, r.start + SOURCE_LINES - 1);
    const code = all.slice(r.start - 1, end).join('\n');
    const more = (n.kind === 'file' ? all.length : r.end) > end ? '\n// ... (truncated)' : '';
    if (code.trim()) lines.push('Source:\n```cpp\n' + code + more + '\n```');
  }
  return PROMPT + '\n\n' + lines.filter(Boolean).join('\n');
}

/** Reads the model's reply leniently: a JSON object if there is one, else the text as the purpose. */
function parseSummary(text) {
  const strs = (v, max, len) =>
    (Array.isArray(v) ? v : [])
      .map(x => String(x == null ? '' : x).trim())
      .filter(Boolean)
      .slice(0, max)
      .map(s => s.slice(0, len));
  const raw = String(text || '').trim();
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const purpose = String(o.purpose || '').trim();
      if (purpose) return { purpose: purpose.slice(0, 600), tags: strs(o.tags, 3, 30).map(t => t.toLowerCase()), notes: strs(o.notes, 3, 160) };
    } catch {
      // not JSON after all
    }
  }
  const plain = raw.replace(/^```\w*\s*|```$/g, '').trim();
  return { purpose: plain.slice(0, 600) || 'No description was produced.', tags: [], notes: [] };
}

/**
 * @param {import('./graphTools').GraphTools} tools
 * @param {object} node
 * @param {(prompt:string)=>Promise<string>} complete
 */
async function summarize(tools, node, complete) {
  return parseSummary(await complete(await buildPrompt(tools, node)));
}

module.exports = { canSummarize, contentKey, buildPrompt, parseSummary, summarize };
