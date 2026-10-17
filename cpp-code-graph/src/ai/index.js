'use strict';

// AI-assisted exploration. Sends a compact description of the graph (plus the
// source of the most relevant functions) to a language model available through
// VS Code's Language Model API, and asks it to answer the question while
// referencing graph nodes as [[N12]] so the webview can highlight them.
// Without a model, falls back to keyword matching over node names.

const { relevance, buildContext, readSnippet } = require('./context');
const { stripTrailer, mapRefs, parseAnswer, keywordFallback } = require('./answer');
const { selectModel, streamText, isModelError } = require('./model');

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
 * @param {{focusId?:string, readSource:(file:string)=>Promise<string|null>, onText:(t:string)=>void, token:import('vscode').CancellationToken}} opts
 */
async function askQuestion(graph, question, opts) {
  const preferred = await selectModel();
  if (!preferred) return keywordFallback(graph, question, 'No language model is available in VS Code (for example GitHub Copilot Chat), so here are the nodes whose names match your question.');

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

  let text;
  try {
    text = await streamText(preferred, SYSTEM + '\n\n' + user, opts.token, t => opts.onText(mapRefs(stripTrailer(t), ctx.byShort)));
  } catch (err) {
    if (isModelError(err)) {
      return keywordFallback(graph, question, 'The language model request failed (' + (err.message || err.code) + '). Showing name matches instead.');
    }
    throw err;
  }
  return parseAnswer(text, ctx.byShort, preferred.name || preferred.family);
}

module.exports = { askQuestion };
