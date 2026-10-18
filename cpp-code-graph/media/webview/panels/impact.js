// Impact view (opened from Details): what else may need to change (see src/ai/impact.js).

import { $ } from '../shell.js';
import { IMPACT_CHANGES, CHANGE_LABELS, CHANGE_TITLES } from '../constants.js';
import { esc } from '../util.js';
import { vscode, S } from '../state.js';
import { impactItems } from '../model.js';
import { nodeChip, bindLinks } from './details.js';
import { renderer } from '../renderer.js';
import { setHighlight, switchTab } from '../main.js';

export function openImpact(id, changeType) {
  S.impact = { target: id, changeType: changeType || (S.impact && S.impact.changeType) || 'signature', busy: true, result: null };
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
  S.highlight = { ids, path: [], label: `Impact: ${CHANGE_LABELS[imp.changeType].toLowerCase()} of ${n ? n.qname || n.label : imp.target}`, source: 'impact', impact: imp };
  renderer.refreshStyle();
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
  const back = '<a class="linkbtn impback" data-back>← Details</a>';
  if (!imp) {
    el.innerHTML = `${back}<p class="muted">Select a function, class or file and choose <b>What if I change this?</b></p>`;
    bindBack(el);
    return;
  }
  const n = S.nodes.get(imp.target);
  const options = IMPACT_CHANGES.map(c => {
    const label = n && n.kind === 'file' && c === 'signature' ? 'Interface' : CHANGE_LABELS[c];
    return `<option value="${c}"${c === imp.changeType ? ' selected' : ''} title="${esc(CHANGE_TITLES[c])}">${label}</option>`;
  }).join('');
  const head = `${back}<div class="imphead">If I change the <select id="impChange" aria-label="Kind of change" title="${esc(CHANGE_TITLES[imp.changeType])}">${options}</select> of ${n ? nodeChip(imp.target) : esc(imp.target)}</div>`;
  const r = imp.result;
  let body;
  if (!r) body = '<p class="muted">Working it out…</p>';
  else if (r.error) body = `<p class="muted">${esc(r.error)}</p>`;
  else {
    const items = impactItems(imp);
    const s = r.summary;
    const name = id => {
      const x = S.nodes.get(id);
      return x ? x.qname || x.label : id;
    };
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.relation)) groups.set(it.relation, []);
      groups.get(it.relation).push(it);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1][0].score - a[1][0].score);
    const list = ordered
      .map(([rel, items], gi) => `<details${gi === 0 ? ' open' : ''}><summary>${esc((r.labels && r.labels.relations[rel]) || rel)} <span class="muted">${items.length}</span></summary><ul class="rel imp">${items
        .map(it => {
          const via = it.depth > 1 && it.via ? ` <span class="muted">via ${esc(name(it.via))}</span>` : '';
          const tags = (it.uncertain ? '<span class="tag uncertain" title="Matched by name only">by name</span>' : '') + (it.test ? '<span class="tag">test</span>' : '');
          const site = it.site ? ` <a class="site" data-open-file="${esc(it.site.file)}" data-open-line="${it.site.line}" data-side="target" title="${esc(it.site.file + ':' + it.site.line)}">↗</a>` : '';
          return `<li class="imp-${it.tier}"><span class="risk" title="Risk ${it.score} of 100 (${it.tier})">${it.score}</span>${nodeChip(it.id)}${via}${tags}${site}</li>`;
        })
        .join('')}</ul></details>`)
      .join('');
    const counts = s.count ? `<span class="impcounts"><span class="imp-high">${s.high} high</span><span class="imp-medium">${s.medium} medium</span><span class="imp-low">${s.low} low</span></span>` : '';
    const notes = s.notes.length ? `<details class="impnotebox"><summary>Notes <span class="muted">${s.notes.length}</span></summary><ul class="impnotes">${s.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
    body = `<div class="impsum"><span class="pill imp-${s.tier}" title="Overall risk ${s.overall} of 100. A prediction from the code graph, not a guarantee: calls through function pointers, macros or templates may be missing, and calls matched by name may be wrong.">${s.tier} risk</span>
        <span>${s.count ? `${s.count} place${s.count === 1 ? '' : 's'} in ${s.files} file${s.files === 1 ? '' : 's'}` : 'Nothing in the graph depends on it'}</span>${counts}
        ${s.count ? '<button id="impShow" class="hltoggle"></button>' : ''}</div>
      ${list}${r.truncated ? '<p class="muted">Only the 300 most affected are listed.</p>' : ''}
      ${notes}`;
  }
  el.innerHTML = head + body;
  $('impChange').onchange = ev => {
    S.impact.changeType = ev.target.value;
    S.impact.result = null;
    requestImpact(false);
  };
  bindBack(el);
  if ($('impShow')) {
    $('impShow').onclick = () => (impactOn() ? setHighlight(null) : applyImpactHighlight());
    syncImpactToggle();
  }
  bindLinks(el);
}

function bindBack(el) {
  el.querySelector('[data-back]').onclick = () => switchTab('details');
}
