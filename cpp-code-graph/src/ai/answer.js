'use strict';

// Turns model output into what the webview shows: [[N12]] refs become node ids,
// and the HIGHLIGHT / PATH trailer lines become id lists.

const { terms, relevance } = require('./context');

function stripTrailer(text) {
  return text.replace(/\n\s*HIGHLIGHT:[\s\S]*$/i, '').replace(/\n\s*PATH:[\s\S]*$/i, '');
}

function mapRefs(text, byShort) {
  return text.replace(/\[\[(N\d+)\]\]/g, (m, s) => (byShort.has(s) ? '[[' + byShort.get(s) + ']]' : m));
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

module.exports = { stripTrailer, mapRefs, parseAnswer, keywordFallback };
