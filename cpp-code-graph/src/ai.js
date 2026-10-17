'use strict';

// AI-assisted exploration. Sends a compact description of the graph (plus the
// source of the most relevant functions) to a language model available through
// VS Code's Language Model API, and asks it to answer the question while
// referencing graph nodes as [[N12]] so the webview can highlight them.
// Without a model, falls back to keyword matching over node names.

const vscode = require('vscode');

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

const SYSTEM = `You help a developer understand a C/C++ codebase that is shown to them as an interactive graph.
You get a list of graph nodes. Each line is: <id> <kind> <qualified name> @<file:line> | <relation>:<target ids>.
Relations: calls, includes, inherits, overrides, uses. Some function bodies are included as source.
Answer the question clearly for someone who may be new to the code. Be concise (under 250 words unless needed).
Whenever you mention a node, reference it inline as [[N12]] (its id in double square brackets) so it can be highlighted.
After the answer, output exactly two final lines:
HIGHLIGHT: comma-separated ids of every node relevant to the answer
PATH: ids of the main execution path in call order joined with " -> " (or "none" if not applicable)`;

/**
 * @param {object} graph
 * @param {string} question
 * @param {{focusId?:string, readSource:(file:string)=>Promise<string|null>, onText:(t:string)=>void, token:vscode.CancellationToken}} opts
 */
async function askQuestion(graph, question, opts) {
  let models = [];
  try {
    models = await vscode.lm.selectChatModels();
  } catch {
    models = [];
  }
  if (!models.length) return keywordFallback(graph, question, 'No language model is available in VS Code (for example GitHub Copilot Chat), so here are the nodes whose names match your question.');

  const preferred = models.find(m => /claude/i.test(m.family || m.id)) || models.find(m => /gpt-4|gpt-5|o\d/i.test(m.family || '')) || models[0];
  const maxTokens = preferred.maxInputTokens || 32000;
  const budget = Math.min(maxTokens * 3, 350000);
  const ctx = buildContext(graph, question, opts.focusId, Math.floor(budget * 0.55));

  // Source of the most relevant functions.
  const snippets = [];
  let snippetChars = 0;
  const snippetBudget = Math.floor(budget * 0.3);
  for (const n of ctx.ranked.slice(0, 40)) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (relevance(n, ctx.qterms) === 0 && n.id !== opts.focusId && n.name !== 'main') continue;
    const code = await readSnippet(opts.readSource, n, 80);
    if (!code) continue;
    const block = `// ${ctx.short.get(n.id)} ${n.qname || n.name} (${n.defFile || n.file}:${n.defLine || n.line})\n${code}`;
    if (snippetChars + block.length > snippetBudget) break;
    snippets.push(block);
    snippetChars += block.length;
    if (snippets.length >= 14) break;
  }

  const focusNode = opts.focusId && graph.nodes.find(n => n.id === opts.focusId);
  const user = [
    `Graph nodes (${ctx.lines.length} shown${ctx.omitted ? ', ' + ctx.omitted + ' less relevant omitted' : ''}):`,
    ctx.lines.join('\n'),
    snippets.length ? '\nSource of relevant functions:\n```cpp\n' + snippets.join('\n\n') + '\n```' : '',
    focusNode ? `\nThe developer currently has ${ctx.short.get(focusNode.id)} (${focusNode.qname || focusNode.name}) selected.` : '',
    '\nQuestion: ' + question
  ].join('\n');

  const messages = [vscode.LanguageModelChatMessage.User(SYSTEM + '\n\n' + user)];
  let text = '';
  try {
    const response = await preferred.sendRequest(messages, { justification: 'Answer questions about the C/C++ code graph.' }, opts.token);
    for await (const chunk of response.text) {
      text += chunk;
      opts.onText(mapRefs(stripTrailer(text), ctx.byShort));
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError || (err && err.code)) {
      return keywordFallback(graph, question, 'The language model request failed (' + (err.message || err.code) + '). Showing name matches instead.');
    }
    throw err;
  }
  return parseAnswer(text, ctx.byShort, preferred.name || preferred.family);
}

function stripTrailer(text) {
  return text.replace(/\n\s*HIGHLIGHT:[\s\S]*$/i, '').replace(/\n\s*PATH:[\s\S]*$/i, '');
}

function parseAnswer(text, byShort, modelName) {
  const ids = s => (s.match(/N\d+/g) || []).map(x => byShort.get(x)).filter(Boolean);
  const hl = /HIGHLIGHT:\s*(.*)/i.exec(text);
  const pm = /PATH:\s*(.*)/i.exec(text);
  let answer = stripTrailer(text).trim();
  const referenced = ids((answer.match(/\[\[N\d+\]\]/g) || []).join(' '));
  answer = mapRefs(answer, byShort);
  const highlight = [...new Set([...(hl ? ids(hl[1]) : []), ...referenced])];
  const path = pm ? ids(pm[1]) : [];
  return { answer, highlight, path, model: modelName };
}

function keywordFallback(graph, question, note) {
  const qterms = terms(question);
  const scored = graph.nodes
    .filter(n => n.kind !== 'dir')
    .map(n => [n, relevance(n, qterms)])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([n]) => n);
  const answer = note + '\n\n' + (scored.length ? scored.slice(0, 12).map(n => '- [[' + n.id + ']]').join('\n') : 'No matching nodes were found.');
  return { answer, highlight: scored.map(n => n.id), path: [], model: null };
}

module.exports = { askQuestion };

function mapRefs(text, byShort) {
  return text.replace(/\[\[(N\d+)\]\]/g, (m, s) => (byShort.has(s) ? '[[' + byShort.get(s) + ']]' : m));
}
