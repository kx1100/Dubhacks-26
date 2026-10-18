// AI summary of the selected node (see src/ai/summaries.js). Requested a moment
// after selection, so clicking through nodes doesn't ask for each of them.

import { $ } from '../shell.js';
import { SUMMARY_KINDS } from '../constants.js';
import { esc } from '../util.js';
import { vscode, S } from '../state.js';
import { syncSummaryExtras } from './details.js';

let summaryTimer = null;

export function wantsSummary(n) {
  return !!n && SUMMARY_KINDS.has(n.kind) && n.status !== 'removed';
}

export function summaryBlock(n) {
  if (!wantsSummary(n)) return '';
  const e = S.summaries.get(n.id);
  if (e && (e.status === 'disabled' || e.status === 'unavailable')) return '';
  if (!e || e.status === 'loading') return '<div class="aisum loading" id="aiSum"><span class="aibadge">AI</span><span class="muted">Summarizing…</span></div>';
  if (e.status === 'error') return `<div class="aisum err" id="aiSum"><span class="aibadge">AI</span><span class="muted">The summary failed: ${esc(e.error)}</span> <button class="linkbtn" data-sum-refresh>Retry</button></div>`;
  const s = e.summary;
  const tags = (s.tags || []).map(t => `<span class="pill sm">${esc(t)}</span>`).join(' ');
  const notes = (s.notes || []).length ? `<ul>${s.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const who = `Written by ${e.model || 'the language model'}${e.cached ? ', saved earlier' : ''}. It may be wrong; check the code.`;
  return `<div class="aisum" id="aiSum"><div class="aihead"><span class="aibadge" title="${esc(who)}">AI</span>${tags}<button class="icon" data-sum-refresh title="Write a new summary">↻</button></div><p>${esc(s.purpose)}</p>${notes}</div>`;
}

export function bindSummary(n) {
  const b = document.querySelector('#aiSum [data-sum-refresh]');
  if (b) b.onclick = () => requestSummary(n.id, true);
}

export function needsSummary(id) {
  const e = S.summaries.get(id);
  return !e || e.stale;
}

export function scheduleSummary(n) {
  if (!wantsSummary(n) || !needsSummary(n.id)) return;
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    if (S.selected === n.id && needsSummary(n.id)) requestSummary(n.id, false);
  }, 300);
}

export function requestSummary(id, refresh) {
  const e = S.summaries.get(id);
  // After a rescan, keep showing the old summary while the extension checks whether the code changed.
  if (!refresh && e && e.stale) e.stale = false;
  else {
    S.summaries.set(id, { status: 'loading' });
    updateSummaryBlock(id);
  }
  vscode.postMessage({ type: 'getSummary', id, refresh });
}

/** Redraws only the summary block, so the details panel keeps its scroll position. */
export function updateSummaryBlock(id) {
  const el = $('aiSum');
  const n = S.nodes.get(id);
  if (!el || S.selected !== id || !n) return;
  el.outerHTML = summaryBlock(n) || '<span id="aiSum"></span>';
  bindSummary(n);
  syncSummaryExtras(n);
}

export function onSummary(m) {
  if (m.cancelled) {
    // Replaced by a request for another node; ask again if this one is still selected.
    S.summaries.delete(m.id);
    const n = S.nodes.get(m.id);
    if (n && S.selected === m.id) scheduleSummary(n);
    return;
  }
  const status = m.disabled ? 'disabled' : m.unavailable ? 'unavailable' : m.error ? 'error' : 'ready';
  S.summaries.set(m.id, { status, summary: m.summary, model: m.model, cached: !!m.cached, error: m.error });
  updateSummaryBlock(m.id);
}
