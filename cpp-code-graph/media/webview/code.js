// Inline code cards: requesting a node's source from the extension and caching it
// (getSource / source), and the card HTML.

import { CODE_KINDS } from './constants.js';
import { esc } from './util.js';
import { vscode, S } from './state.js';

const highlighter = window.CodeHighlight;
const sourceRequests = new Map(); // reqId -> {key, id}
let reqSeq = 0;

export function codeRange(n) {
  // Prefer the definition (the body) over the declaration.
  if (n.defFile) return { file: n.defFile, start: n.defLine || n.line, end: n.defEndLine || (n.defFile === n.file ? n.endLine : 0) };
  return { file: n.file, start: n.line, end: n.endLine };
}

export function codeSide(n) {
  return n.status === 'removed' ? 'base' : 'target';
}

export function codeKey(n) {
  return n.id + '|' + codeSide(n);
}

export function canShowCode(n) {
  return !!n && CODE_KINDS.has(n.kind) && !!n.file;
}

export function requestSource(n, force) {
  const key = codeKey(n);
  const cur = S.code.get(key);
  if (cur && !force && (cur.status === 'ready' || cur.status === 'loading')) return cur;
  const r = codeRange(n);
  if (!r.file) return null;
  const reqId = ++reqSeq;
  sourceRequests.set(reqId, { key, id: n.id });
  // On a refresh the old text stays visible until the new text arrives.
  const entry = cur && cur.status === 'ready' ? Object.assign({}, cur, { refreshing: true }) : { status: 'loading' };
  S.code.set(key, entry);
  vscode.postMessage({ type: 'getSource', reqId, file: r.file, start: r.start || 1, end: r.end || 0, side: codeSide(n) });
  return entry;
}

/** Stores the source the extension sent. Returns the id of the open card to redraw, if any. */
export function onSource(m) {
  const req = sourceRequests.get(m.reqId);
  if (!req) return null;
  sourceRequests.delete(m.reqId);
  const n = S.nodes.get(req.id);
  if (!n) return null;
  if (m.error) S.code.set(req.key, { status: 'error', error: m.error });
  else S.code.set(req.key, { status: 'ready', lines: m.lines, html: highlighter ? highlighter.highlightLines(m.lines) : m.lines.map(l => esc(l)), startLine: m.startLine, file: codeRange(n).file, truncated: !!m.truncated });
  return S.codeOpen.has(req.id) ? req.id : null;
}

export function refreshCode() {
  // Keep cached text only for open cards, and re-read those (files may have changed).
  const open = new Set();
  for (const id of S.codeOpen) open.add(codeKey(S.nodes.get(id)));
  for (const key of [...S.code.keys()]) if (!open.has(key)) S.code.delete(key);
  for (const id of S.codeOpen) requestSource(S.nodes.get(id), true);
}

export function codeCardHtml(n) {
  const e = S.code.get(codeKey(n));
  if (!e || e.status === 'loading') return '<div class="codecard"><div class="cl note">Loading…</div></div>';
  if (e.status === 'error') return `<div class="codecard"><div class="cl note">${esc(e.error || 'Source unavailable')}</div></div>`;
  const rows = e.html.map((h, i) => `<div class="cl" data-line="${e.startLine + i}"><span class="ln">${e.startLine + i}</span><span class="ct">${h || ' '}</span></div>`).join('');
  const more = e.truncated ? `<div class="cl note" data-line="${e.startLine + e.lines.length}">… continues in the editor</div>` : '';
  return `<div class="codecard">${rows}${more}</div>`;
}
