// Impact tab: change impact (see src/ai/impact.js) and the AI check of it.

import { $ } from '../shell.js';
import { IMPACT_KINDS, IMPACT_CHANGES, CHANGE_LABELS, CHANGE_TITLES, VERDICT_LABELS } from '../constants.js';
import { esc } from '../util.js';
import { vscode, S } from '../state.js';
import { impactItems } from '../model.js';
import { nodeChip, bindLinks } from './details.js';
import { render } from '../../graph.js';
import { setHighlight, switchTab } from '../main.js';

export function openImpact(id, changeType) {
  const description = S.impact ? S.impact.description : '';
  S.impact = { target: id, changeType: changeType || (S.impact && S.impact.changeType) || 'signature', busy: true, result: null, ai: null, check: null, description: S.impact && S.impact.target === id ? description : '' };
  switchTab('impact');
  requestImpact(false);
}

export function requestImpact(quiet) {
  S.impact.busy = true;
  if (!quiet) renderImpact();
  vscode.postMessage({ type: 'impact', id: S.impact.target, changeType: S.impact.changeType });
}

export function onImpact(m) {
  const imp = S.impact;
  if (!imp || m.id !== imp.target || m.requested !== imp.changeType) return; // an older request
  const wasOn = impactOn();
  imp.busy = false;
  imp.result = m;
  if (S.tab === 'impact') renderImpact();
  // Show the new result on the graph when it was showing, or when the user is looking at it.
  if (!m.error && (wasOn || S.tab === 'impact' || !S.highlight)) applyImpactHighlight();
  else syncImpactToggle();
}

export function impactOn() {
  return !!(S.highlight && S.highlight.source === 'impact' && S.highlight.impact === S.impact);
}

export function applyImpactHighlight() {
  const imp = S.impact;
  if (!imp || !imp.result || imp.result.error) return;
  const ids = new Set([imp.target, ...imp.result.items.map(i => i.id)].filter(id => S.nodes.has(id)));
  const n = S.nodes.get(imp.target);
  S.highlight = { ids, path: [], label: `Impact: ${CHANGE_LABELS[imp.changeType].toLowerCase()} of ${n ? n.qname || n.name : imp.target}`, source: 'impact', impact: imp };
  render();
}

export function syncImpactToggle() {
  const b = $('impShow');
  if (!b) return;
  const on = impactOn();
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.innerHTML = `<span class="sw"></span>${on ? 'Shown' : 'Show'} on graph`;
}

export function renderImpact() {
  const el = $('tab-impact');
  const imp = S.impact;
  const sel = S.selected && S.nodes.get(S.selected);
  if (!imp) {
    el.innerHTML = `<div class="intro"><h3>What if I change this?</h3>
      <p>Pick a function, class or file, then choose <b>What if I change this?</b> in its details. You'll see what else may need to change, ranked by risk, and the graph is colored by how strongly each part is affected.</p>
      ${sel && IMPACT_KINDS.has(sel.kind) ? `<button id="impStart" class="primary">What if I change ${esc(sel.name)}?</button>` : ''}</div>`;
    if ($('impStart')) $('impStart').onclick = () => openImpact(sel.id);
    return;
  }
  const n = S.nodes.get(imp.target);
  const tabs = IMPACT_CHANGES.map(c => {
    const label = n && n.kind === 'file' && c === 'signature' ? 'Interface' : CHANGE_LABELS[c];
    return `<button data-change="${c}" class="${c === imp.changeType ? 'active' : ''}" aria-pressed="${c === imp.changeType}" title="${esc(CHANGE_TITLES[c])}">${label}</button>`;
  }).join('');
  const head = `<div class="imphead">${n ? nodeChip(imp.target) : esc(imp.target)}</div>
    <div class="seg impchange" role="group" aria-label="Kind of change">${tabs}</div>
    <p class="predict">A prediction from the code graph, not a guarantee. Calls through function pointers, macros or templates may be missing, and calls matched by name may be wrong.</p>`;
  const r = imp.result;
  let body;
  if (!r) body = '<p class="muted">Working it out…</p>';
  else if (r.error) body = `<p class="muted">${esc(r.error)}</p>`;
  else {
    const items = impactItems(imp);
    const s = { ...r.summary };
    if (imp.ai && imp.ai.verdicts) {
      // Recount with the AI's verdicts.
      for (const t of ['high', 'medium', 'low']) s[t] = items.filter(i => i.tier === t).length;
      s.overall = Math.round(100 * (1 - Math.exp(-items.reduce((a, i) => a + i.score, 0) / 250)));
      s.tier = s.overall >= 60 ? 'high' : s.overall >= 30 ? 'medium' : 'low';
    }
    const name = id => {
      const x = S.nodes.get(id);
      return x ? x.qname || x.name : id;
    };
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.relation)) groups.set(it.relation, []);
      groups.get(it.relation).push(it);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1][0].score - a[1][0].score);
    const list = ordered
      .map(([rel, items]) => `<details open><summary>${esc((r.labels && r.labels.relations[rel]) || rel)} <span class="muted">${items.length}</span></summary><ul class="rel imp">${items
        .map(it => {
          const via = it.depth > 1 && it.via ? ` <span class="muted">via ${esc(name(it.via))}</span>` : '';
          const tags = (it.uncertain ? '<span class="tag uncertain" title="Matched by name only">by name</span>' : '') + (it.test ? '<span class="tag">test</span>' : '');
          const site = it.site ? ` <a class="site" data-open-file="${esc(it.site.file)}" data-open-line="${it.site.line}" data-side="target" title="${esc(it.site.file + ':' + it.site.line)}">↗</a>` : '';
          const v = it.verdict;
          const verdict = v ? `<span class="verdict v-${v.verdict}" title="The AI read this code">${VERDICT_LABELS[v.verdict]}</span>` : '';
          const vline = v && v.file && v.line ? ` <a class="site" data-open-file="${esc(v.file)}" data-open-line="${v.line}" data-side="target" title="${esc(v.file + ':' + v.line)}">line ${v.line}</a>` : '';
          const reason = v && v.reason ? `<div class="vreason">${esc(v.reason)}${vline}</div>` : '';
          return `<li class="imp-${it.tier}"><span class="risk" title="Risk ${it.score} of 100 (${it.tier})${v ? ', adjusted by the AI' : ''}">${it.score}</span>${nodeChip(it.id)}${via}${tags}${verdict}${site}${reason}</li>`;
        })
        .join('')}</ul></details>`)
      .join('');
    body = `<div class="impsum"><span class="pill imp-${s.tier}" title="Overall risk ${s.overall} of 100">${s.tier} risk</span>
        <span>${s.count ? `${s.count} place${s.count === 1 ? '' : 's'} in ${s.files} file${s.files === 1 ? '' : 's'} may need attention` : 'Nothing in the graph depends on it'}</span></div>
      ${s.count ? `<div class="impcounts"><span class="imp-high">${s.high} high</span><span class="imp-medium">${s.medium} medium</span><span class="imp-low">${s.low} low</span></div>` : ''}
      <ul class="impnotes">${s.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${s.count ? '<div class="askrow"><button id="impShow" class="hltoggle"></button></div>' : ''}
      ${s.count ? renderImpactAI(imp, items) : ''}
      ${list}${r.truncated ? '<p class="muted">Only the 300 most affected are listed.</p>' : ''}
      ${renderImpactCheck(imp)}`;
  }
  el.innerHTML = head + body;
  el.querySelectorAll('[data-change]').forEach(b => {
    b.onclick = () => {
      if (S.impact.changeType === b.dataset.change) return;
      S.impact.changeType = b.dataset.change;
      S.impact.result = null;
      S.impact.ai = null;
      S.impact.check = null;
      requestImpact(false);
    };
  });
  if ($('impShow')) {
    $('impShow').onclick = () => (impactOn() ? setHighlight(null) : applyImpactHighlight());
    syncImpactToggle();
  }
  if ($('impDesc')) $('impDesc').oninput = () => (S.impact.description = $('impDesc').value);
  if ($('impAI'))
    $('impAI').onclick = () => {
      S.impact.ai = { busy: true };
      renderImpact();
      vscode.postMessage({ type: 'impactAI', id: S.impact.target, changeType: S.impact.changeType, description: S.impact.description || '' });
    };
  if ($('impCheck'))
    $('impCheck').onclick = () => {
      S.impact.check = { busy: true };
      renderImpact();
      vscode.postMessage({ type: 'impactCheck', id: S.impact.target, changeType: S.impact.changeType });
    };
  bindLinks(el);
}

export function renderImpactAI(imp, items) {
  const ai = imp.ai;
  const places = Math.min(10, items.filter(i => i.kind !== 'file').length);
  if (!places) return '';
  let status = `<span class="muted">The AI reads the code at the ${places} riskiest place${places === 1 ? '' : 's'}.</span>`;
  if (ai && ai.busy) status = `<span class="muted busy">Reading ${places} place${places === 1 ? '' : 's'}…</span>`;
  else if (ai && ai.error) status = `<span class="muted">The AI check failed: ${esc(ai.error)}</span>`;
  else if (ai && ai.verdicts) {
    const c = k => [...ai.verdicts.values()].filter(v => v.verdict === k).length;
    status = `<span class="muted">Checked ${ai.asked} place${ai.asked === 1 ? '' : 's'}${ai.model ? ' via ' + esc(ai.model) : ''}: ${c('breaks')} break, ${c('review')} need review, ${c('fine')} likely fine.</span>`;
  }
  return `<div class="impai">
    <textarea id="impDesc" rows="2" placeholder="Describe the change (optional), e.g. “add an int error code parameter”">${esc(imp.description || '')}</textarea>
    <div class="askrow"><button id="impAI" class="primary"${ai && ai.busy ? ' disabled' : ''}>${ai && ai.verdicts ? 'Check again with AI' : 'Check with AI'}</button>${status}</div>
  </div>`;
}

export function renderImpactCheck(imp) {
  const c = imp.check;
  const intro = '<p class="muted">After making the change, compare this prediction, made from your last commit, with what your uncommitted edits actually changed.</p>';
  const btn = `<button id="impCheck"${c && c.busy ? ' disabled' : ''}>${c && c.busy ? 'Comparing…' : c && c.result ? 'Check again' : 'Check against my edits'}</button>`;
  let body = '';
  const r = c && c.result;
  if (r && r.error) body = `<p class="muted">${esc(r.error)}</p>`;
  else if (r) {
    const pct = x => (x == null ? '–' : Math.round(x * 100) + '%');
    const what = r.compared === 'files' ? 'file' : 'place';
    const chips = (list, extra) => (list.length ? `<ul class="rel">${list.map(x => `<li>${nodeChip(x.id)}${extra ? extra(x) : ''}</li>`).join('')}</ul>` : '');
    const statusTag = x => (x.status ? ` <span class="pill sm st-${x.status}">${x.status}</span>` : '');
    const target = r.targetChanged ? `It was ${r.targetChanged === 'removed' ? 'removed or its signature changed' : r.targetChanged}.` : 'It has not changed yet.';
    if (!r.changedCount && !r.targetChanged) body = '<p class="muted">There are no uncommitted changes to compare with yet.</p>';
    else {
      const related = r.missed.filter(x => x.related);
      const unrelated = r.missed.filter(x => !x.related);
      body = `<p>${target} ${r.changedCount} other ${what}${r.changedCount === 1 ? '' : 's'} changed.</p>
        <div class="impscore"><span title="Of the places predicted as high or medium risk, how many changed">Precision <b>${pct(r.precision)}</b></span><span title="Of the changed places connected to it, how many were predicted">Recall <b>${pct(r.recall)}</b></span></div>
        <details open><summary>Predicted and changed <span class="muted">${r.hits.length}</span></summary>${chips(r.hits, statusTag)}</details>
        <details${r.falseAlarms.length ? ' open' : ''}><summary>Predicted, not changed <span class="muted">${r.falseAlarms.length}</span></summary>${chips(r.falseAlarms, x => ` <span class="muted">${x.tier}</span>`)}</details>
        <details${related.length ? ' open' : ''}><summary>Changed, not predicted <span class="muted">${related.length}</span></summary>${chips(related, statusTag)}</details>
        ${unrelated.length ? `<details><summary>Other changes, probably unrelated <span class="muted">${unrelated.length}</span></summary>${chips(unrelated, statusTag)}</details>` : ''}`;
    }
  }
  return `<details class="impcheck" open><summary>Check against my edits</summary>${intro}<div class="askrow">${btn}</div>${body}</details>`;
}
