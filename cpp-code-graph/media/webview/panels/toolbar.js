// Toolbar and canvas furniture: view and arrow controls, banner, filters, legend,
// stats, status line, highlight bar and search.

import { $ } from '../shell.js';
import { KIND_INFO, EDGE_KINDS, EDGE_MODES, EDGE_MODE_INFO, PRESETS } from '../constants.js';
import { esc } from '../util.js';
import { vscode, S, persist } from '../state.js';
import { rebuildTree, initialExpansion } from '../model.js';
import { syncImpactToggle } from './impact.js';
import { syncAiToggle } from './ask.js';
import { renderer } from '../renderer.js';
import { layoutAndRender, applyPreset, setEdgeMode, reveal, setHighlight, revealAll } from '../main.js';

export function markCustom() {
  // Changing a filter by hand means the view no longer matches its preset.
  if (S.preset === 'custom') return;
  S.preset = 'custom';
  renderViewControls();
}

export function renderViewControls() {
  const seg = (el, items, current, attr) => {
    for (const b of [...el.querySelectorAll('button')]) b.remove();
    for (const [value, label, title] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.dataset[attr] = value;
      b.setAttribute('aria-pressed', String(value === current));
      b.classList.toggle('active', value === current);
      el.appendChild(b);
    }
  };
  seg($('presetSeg'), Object.entries(PRESETS).map(([k, p]) => [k, p.label, p.desc]).concat(S.preset === 'custom' ? [['custom', 'Custom', 'Filters changed by hand under Show']] : []), S.preset, 'preset');
  seg($('edgeSeg'), EDGE_MODES.map(m => [m, m[0].toUpperCase() + m.slice(1), EDGE_MODE_INFO[m]]), S.edgeMode, 'edgemode');
  $('presetSeg').querySelectorAll('button').forEach(b => (b.onclick = () => (b.dataset.preset === 'custom' ? null : applyPreset(b.dataset.preset))));
  $('edgeSeg').querySelectorAll('button').forEach(b => (b.onclick = () => setEdgeMode(b.dataset.edgemode)));
}

export function renderBanner() {
  const el = $('banner');
  if (S.mode !== 'diff') {
    el.classList.add('hidden');
    return;
  }
  const d = (S.graph.stats && S.graph.stats.diff) || { nodes: {}, edges: {} };
  el.classList.remove('hidden');
  el.innerHTML = `<span class="b-title">Comparing <b>${esc(S.compare ? S.compare.baseLabel : '')}</b> → <b>${esc(S.compare ? S.compare.targetLabel : '')}</b></span>
    <span class="pill st-added">+${d.nodes.added || 0} added</span>
    <span class="pill st-removed">−${d.nodes.removed || 0} removed</span>
    <span class="pill st-modified">~${d.nodes.modified || 0} modified</span>
    <span class="muted">relationships: +${d.edges.added || 0} / −${d.edges.removed || 0}</span>
    <span class="spacer"></span>
    <label class="toggle"><input type="checkbox" id="changesOnly" ${S.changesOnly ? 'checked' : ''}> Changes only</label>
    <button id="exitCompare">Exit comparison</button>`;
  $('changesOnly').onchange = ev => {
    S.changesOnly = ev.target.checked;
    rebuildTree();
    initialExpansion();
    layoutAndRender('fit');
  };
  $('exitCompare').onclick = () => {
    setStatus('Switching back to the workspace…', true);
    vscode.postMessage({ type: 'exitCompare' });
  };
}

export function renderFilters() {
  const el = $('filters');
  el.innerHTML =
    '<div class="ph">Relationships</div>' +
    EDGE_KINDS.map(k => `<label class="row" title="${esc(k.desc)}"><input type="checkbox" data-edge-kind="${k.kind}" ${S.edgeOn[k.kind] ? 'checked' : ''}><svg width="26" height="10"><line x1="1" y1="5" x2="24" y2="5" class="legend-line ek-${k.kind}"/></svg>${esc(k.label)}</label>`).join('') +
    `<label class="row" title="Calls whose target could not be determined exactly"><input type="checkbox" id="fUncertain" ${S.showUncertain ? 'checked' : ''}> Include uncertain calls</label>` +
    '<div class="ph">Nodes</div>' +
    `<label class="row"><input type="checkbox" id="fFields" ${S.showFields ? 'checked' : ''}> Fields &amp; global variables</label>` +
    `<label class="row"><input type="checkbox" id="fNs" ${S.showNamespaces ? 'checked' : ''}> Namespaces</label>`;
  el.querySelectorAll('[data-edge-kind]').forEach(cb => {
    cb.onchange = () => {
      S.edgeOn[cb.dataset.edgeKind] = cb.checked;
      markCustom();
      persist();
      layoutAndRender(null);
      renderLegend();
    };
  });
  $('fUncertain').onchange = ev => {
    S.showUncertain = ev.target.checked;
    markCustom();
    persist();
    layoutAndRender(null);
  };
  $('fFields').onchange = ev => {
    S.showFields = ev.target.checked;
    markCustom();
    persist();
    rebuildTree();
    layoutAndRender(null);
  };
  $('fNs').onchange = ev => {
    S.showNamespaces = ev.target.checked;
    markCustom();
    persist();
    rebuildTree();
    layoutAndRender(null);
  };
  renderLegend();
}

export function renderLegend() {
  const el = $('legend');
  const edges = EDGE_KINDS.filter(k => S.edgeOn[k.kind])
    .map(k => `<div class="lrow"><svg width="30" height="10"><line x1="1" y1="5" x2="22" y2="5" class="legend-line ek-${k.kind}"/><path d="M22,1 L29,5 L22,9 z" class="arrowhead ek-${k.kind}${k.kind === 'inherits' ? ' hollow' : ''}"/></svg>${esc(k.label)}</div>`)
    .join('');
  const kindsShown = ['file', 'class', 'struct', 'function', 'method', 'enum', 'namespace', 'field'];
  const nodes = kindsShown.map(k => `<span class="lnode k-${k}"><span class="g">${KIND_INFO[k].glyph}</span>${KIND_INFO[k].label}</span>`).join('');
  const diff = S.mode === 'diff' ? '<div class="lrow"><span class="lnode st-added">added</span><span class="lnode st-removed">removed</span><span class="lnode st-modified">modified</span></div>' : '';
  el.innerHTML = `<div class="lhead" id="legendToggle">Legend ${el.classList.contains('collapsed') ? '▸' : '▾'}</div><div class="lbody">${edges}<div class="lnodes">${nodes}</div>${diff}<div class="hint">Dashed = uncertain call · double-click to expand · &lt;/&gt; shows code · Ctrl+click opens source</div></div>`;
  $('legendToggle').onclick = () => {
    el.classList.toggle('collapsed');
    renderLegend();
  };
}

export function renderStats() {
  const st = S.graph.stats || {};
  const errs = st.errors && st.errors.length ? ` · ${st.errors.length} parse errors` : '';
  $('stats').textContent = `${st.files || 0} files · ${S.graph.nodes.length} nodes · ${S.graph.edges.length} relationships${errs}`;
  $('stats').title = st.errors && st.errors.length ? st.errors.map(e => e.file).join('\n') : '';
}

export function setStatus(text, busy, error) {
  $('status').textContent = text;
  $('status').classList.toggle('error', !!error);
  $('spinner').classList.toggle('hidden', !busy);
}

export function renderHighlightBar() {
  syncAiToggle();
  syncImpactToggle();
  const el = $('hlBar');
  if (!S.highlight) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const hidden = [...S.highlight.ids].filter(id => {
    const r = S.vis.repOf(id);
    return r && r !== id;
  }).length;
  el.innerHTML = `<span>${esc(S.highlight.label)}</span>${hidden ? `<button id="hlReveal" title="Expand the graph so every highlighted node is visible">Reveal ${hidden} hidden</button>` : ''}<button id="hlClear" title="Clear highlight (Esc)">✕</button>`;
  if ($('hlReveal')) $('hlReveal').onclick = () => revealAll(S.highlight.ids);
  $('hlClear').onclick = () => setHighlight(null);
}

export function runSearch(q) {
  S.search.q = q;
  const ql = q.trim().toLowerCase();
  if (!ql) {
    S.search.matches = [];
    S.search.index = -1;
  } else {
    const scored = [];
    for (const n of S.graph.nodes) {
      const name = (n.name || '').toLowerCase();
      const qn = (n.qname || n.file || '').toLowerCase();
      let s = 0;
      if (name === ql) s = 4;
      else if (name.startsWith(ql)) s = 3;
      else if (name.includes(ql)) s = 2;
      else if (qn.includes(ql)) s = 1;
      if (s) scored.push([n, s]);
    }
    scored.sort((a, b) => b[1] - a[1] || ((KIND_INFO[a[0].kind] || {}).rank || 9) - ((KIND_INFO[b[0].kind] || {}).rank || 9) || a[0].name.localeCompare(b[0].name));
    S.search.matches = scored.map(([n]) => n.id);
    S.search.index = -1;
  }
  $('searchCount').textContent = ql ? (S.search.matches.length ? `${S.search.matches.length}` : 'none') : '';
  renderSearchList();
  renderer.refreshStyle();
}

export function renderSearchList() {
  const el = $('searchList');
  const m = S.search.matches.slice(0, 60);
  if (!S.search.q.trim() || !m.length || document.activeElement !== $('search')) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = m
    .map((id, i) => {
      const n = S.nodes.get(id);
      const info = KIND_INFO[n.kind] || { glyph: '?' };
      return `<div class="sitem${i === S.search.index ? ' active' : ''}" data-i="${i}"><span class="chip k-${n.kind}"><span class="g">${info.glyph}</span>${esc(n.name)}</span><span class="muted">${esc(n.qname && n.qname !== n.name ? n.qname : '')} ${esc(n.file || '')}${n.line ? ':' + n.line : ''}</span></div>`;
    })
    .join('');
  el.querySelectorAll('.sitem').forEach(it => {
    it.onmousedown = ev => {
      ev.preventDefault();
      gotoMatch(+it.dataset.i);
      $('search').blur();
      el.classList.add('hidden');
    };
  });
}

export function gotoMatch(i) {
  const m = S.search.matches;
  if (!m.length) return;
  S.search.index = ((i % m.length) + m.length) % m.length;
  $('searchCount').textContent = `${S.search.index + 1}/${m.length}`;
  reveal(m[S.search.index]);
}
