// Webview entry point, bundled by scripts/build-webview.js into media/dist/graph.js.
// Messages from the extension, the actions that change what is shown (expand,
// select, reveal, presets…), toolbar and keyboard bindings.

import { $ } from './shell.js';
import { EDGE_MODES, PRESETS } from './constants.js';
import { vscode, S, persist } from './state.js';
import { canShowCode, codeKey, codeSide, requestSource, onSource, refreshCode } from './code.js';
import { setGraph, rebuildTree, kids, ancestors, nearestInTree, applyPresetSettings, presetExpansion, computeVisible, nodeLabel, descendantsOf } from './model.js';
import { renderViewControls, renderBanner, renderFilters, renderStats, setStatus, renderHighlightBar, runSearch, renderSearchList, gotoMatch } from './panels/toolbar.js';
import { renderDetails } from './panels/details.js';
import { onSummary } from './panels/summary.js';
import { requestImpact, onImpact, renderImpact } from './panels/impact.js';
import { renderSuggestions, ask, setVisited, renderAnswer, renderHistory, renderOpts, applyAiHighlight } from './panels/ask.js';
import { renderer, useRenderer } from './renderer.js';
import { svgRenderer } from './renderer-svg.js';

useRenderer(svgRenderer);
renderer.mount($('canvas'));

// ---------------------------------------------------------------------------
// Loading a graph

export function loadGraph(graph, mode, title, compare) {
  const fresh = setGraph(graph, mode, title, compare);
  $('title').textContent = S.title || 'Code Graph';
  $('title').title = S.title;
  refreshCode();
  renderBanner();
  renderFilters();
  renderViewControls();
  renderStats();
  layoutAndRender(fresh ? 'fit' : S.view ? null : 'fit');
  renderDetails();
  setStatus(mode === 'diff' ? 'Comparison ready. Green = added, red = removed, yellow = modified.' : 'Ready. Double-click a node to expand it, Ctrl+click to open its source.');
}

// ---------------------------------------------------------------------------
// The visible graph

/** Recomputes what is visible (after expand, collapse, filters…) into S.vis. */
function updateVisible() {
  // Expanding a node (for example via Expand all) wins over showing its code.
  for (const id of [...S.codeOpen]) if (S.expanded.has(id)) S.codeOpen.delete(id);
  S.vis = computeVisible();
  const empty = $('empty');
  if (!S.graph.nodes.length) {
    empty.innerHTML = S.mode === 'diff' ? 'No C/C++ files in these revisions.' : 'No C/C++ files were found in this workspace.<br><span class="muted">Check the <code>codeGraph.include</code> and <code>codeGraph.exclude</code> settings.</span>';
    empty.classList.remove('hidden');
  } else if (!S.vis.visible.length) {
    empty.innerHTML = S.mode === 'diff' ? 'No structural changes between these versions.' : 'Nothing to show with the current filters.';
    empty.classList.remove('hidden');
  } else empty.classList.add('hidden');
}

/** Shows the visible graph from scratch; 'fit' fits it to the view. */
export function layoutAndRender(viewAction) {
  updateVisible();
  renderer.setGraph(S.vis, { fit: viewAction === 'fit' });
}

/** Shows a node that was opened or closed, keeping the rest of the view in place. */
function showChange(id, opened) {
  updateVisible();
  if (opened) renderer.open(id);
  else renderer.close(id);
}

// ---------------------------------------------------------------------------
// View presets

export function applyPreset(name) {
  if (!PRESETS[name]) return;
  S.preset = name;
  S.highlight = null;
  applyPresetSettings(name);
  for (const id of [...S.codeOpen]) S.codeOpen.delete(id);
  rebuildTree();
  presetExpansion(name);
  persist();
  renderFilters();
  renderViewControls();
  layoutAndRender('fit');
  setStatus(PRESETS[name].desc);
}

export function setEdgeMode(mode) {
  if (!EDGE_MODES.includes(mode)) return;
  S.edgeMode = mode;
  persist();
  renderViewControls();
  renderer.refreshStyle();
}

export function toggleCode(id, force) {
  const n = S.nodes.get(id);
  if (!canShowCode(n)) return;
  const open = force !== undefined ? force : !S.codeOpen.has(id);
  if (open) {
    // A node is either expanded (its children) or showing its code, not both.
    S.expanded.delete(id);
    for (const d of descendantsOf(id)) S.expanded.delete(d);
    S.codeOpen.add(id);
    requestSource(n);
  } else S.codeOpen.delete(id);
  persist();
  showChange(id, open);
}

// ---------------------------------------------------------------------------
// Actions

export function toggle(id, force) {
  if (!kids(id).length) return;
  const open = force !== undefined ? force : !S.expanded.has(id);
  if (open) S.expanded.add(id);
  else {
    S.expanded.delete(id);
    // Collapsing also collapses descendants, so re-expanding starts clean.
    const stack = [...kids(id)];
    while (stack.length) {
      const c = stack.pop();
      S.expanded.delete(c);
      stack.push(...kids(c));
    }
  }
  persist();
  showChange(id, open);
}

export function reveal(id, opts) {
  // Expand ancestors so that id becomes visible, select it and center on it.
  let target = nearestInTree(id);
  if (!target) {
    // Hidden by the "changes only" filter or a kind filter; relax filters.
    if (S.mode === 'diff' && S.changesOnly) {
      S.changesOnly = false;
      rebuildTree();
      renderBanner();
    }
    target = nearestInTree(id);
    if (!target) return;
  }
  for (const a of ancestors(target)) S.expanded.add(a);
  S.selected = target;
  S.selectedEdge = null;
  persist();
  layoutAndRender(null);
  if (!opts || opts.center !== false) renderer.centerOn(target, true);
  renderDetails();
  switchTab('details', true);
}

export function select(id) {
  S.selected = id;
  S.selectedEdge = null;
  persist();
  renderer.refreshStyle();
  renderDetails();
}

export function openSource(id, which) {
  const n = S.nodes.get(id);
  if (!n || !n.file) return;
  const useDef = which !== 'decl' && n.defFile;
  // Free functions keep their definition as the node and remember where the prototype is.
  const useProto = which === 'decl' && n.declFile;
  const file = useProto ? n.declFile : useDef ? n.defFile : n.file;
  const line = useProto ? n.declLine : useDef ? n.defLine : n.line;
  vscode.postMessage({ type: 'open', file, line: line || 1, side: n.status === 'removed' ? 'base' : 'target' });
}

export function expandLevel() {
  // Expand every visible collapsed node by one level.
  const { visible } = S.vis;
  let added = 0;
  for (const id of visible) {
    if (!S.expanded.has(id) && kids(id).length) {
      S.expanded.add(id);
      added++;
    }
  }
  if (added) {
    persist();
    layoutAndRender('fit');
  }
}

export function collapseAll() {
  S.expanded = new Set();
  if (S.roots.length === 1) S.expanded.add(S.roots[0]);
  persist();
  layoutAndRender('fit');
}

/**
 * Collapses everything except the neighbourhood of a node: the node itself, the
 * nodes it is connected to (through the arrows currently enabled) and the
 * folders and files that lead to them. Lets you study one area of a big graph.
 */
export function focusArea(id) {
  const target = nearestInTree(id);
  if (!target) return;
  const inside = [id];
  const sub = descendantsOf(id);
  if (sub.length <= 300) inside.push(...sub);
  const insideSet = new Set(inside);
  const keep = new Set([target]);
  for (const u of inside) {
    for (const e of S.out.get(u) || []) if (S.edgeOn[e.kind] && !insideSet.has(e.t)) keep.add(nearestInTree(e.t));
    for (const e of S.inc.get(u) || []) if (S.edgeOn[e.kind] && !insideSet.has(e.s)) keep.add(nearestInTree(e.s));
  }
  const wasOpen = S.expanded.has(target);
  S.expanded = new Set();
  for (const k of keep) if (k) for (const a of ancestors(k)) S.expanded.add(a);
  if (wasOpen) S.expanded.add(target);
  S.codeOpen.delete(target);
  S.selected = target;
  S.selectedEdge = null;
  persist();
  layoutAndRender('fit');
  renderer.centerOn(target, false);
  renderDetails();
  setStatus('Showing only what is connected to ' + nodeLabel(S.nodes.get(target)) + '. Use Expand or Collapse to change this.');
}

export function trace(id, direction) {
  // Highlight everything reachable through call edges (callees or callers).
  const seen = new Set([id]);
  const order = [id];
  let frontier = [id];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next = [];
    for (const u of frontier) {
      const list = direction === 'out' ? S.out.get(u) : S.inc.get(u);
      for (const e of list || []) {
        if (e.kind !== 'calls' && e.kind !== 'overrides') continue;
        const v = direction === 'out' ? e.t : e.s;
        if (!seen.has(v)) {
          seen.add(v);
          order.push(v);
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  const n = S.nodes.get(id);
  setHighlight({ ids: seen, path: [], label: (direction === 'out' ? 'Everything called from ' : 'Everything that calls ') + n.name + ' (' + (seen.size - 1) + ')' });
}

export function setHighlight(h) {
  S.highlight = h && h.ids.size ? h : null;
  renderer.refreshStyle();
}

export function revealAll(ids) {
  let count = 0;
  for (const id of ids) {
    const t = nearestInTree(id);
    if (!t) continue;
    for (const a of ancestors(t)) S.expanded.add(a);
    if (++count > 200) break;
  }
  persist();
  layoutAndRender('fit');
}

export function switchTab(tab, quiet) {
  if (quiet && S.tab === 'ai' && S.ai.busy) return;
  S.tab = tab;
  // Impact is a view of the Details tab.
  const button = tab === 'impact' ? 'details' : tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === button));
  for (const t of ['details', 'ai', 'impact']) $('tab-' + t).classList.toggle('hidden', tab !== t);
  if (tab === 'impact') renderImpact();
}

// ---------------------------------------------------------------------------
// What the user does on the graph (see the events in renderer.js)

renderer.on('select', id => {
  select(id);
  switchTab('details', true);
});
renderer.on('openSource', id => openSource(id));
renderer.on('activate', id => {
  if (kids(id).length) toggle(id);
  else openSource(id);
  renderDetails();
});
renderer.on('toggle', id => {
  toggle(id);
  if (S.selected === id) renderDetails();
});
renderer.on('toggleCode', id => {
  toggleCode(id);
  if (S.selected === id) renderDetails();
});
renderer.on('openLine', (id, line) => {
  const n = S.nodes.get(id);
  const entry = n && S.code.get(codeKey(n));
  if (entry && entry.file) vscode.postMessage({ type: 'open', file: entry.file, line, side: codeSide(n), preserveFocus: false });
});
renderer.on('reveal', id => reveal(id));
renderer.on('edgeSelect', key => {
  S.selectedEdge = key;
  S.selected = null;
  renderer.refreshStyle();
  renderDetails();
  switchTab('details', true);
});
renderer.on('background', () => {
  if (!S.selected && !S.selectedEdge) return;
  S.selected = null;
  S.selectedEdge = null;
  persist();
  renderer.refreshStyle();
  renderDetails();
});
renderer.on('rendered', () => {
  // In "selected" mode an empty canvas of arrows needs a hint, or it looks like there are none.
  $('edgeHint').classList.toggle('hidden', !(S.edgeMode === 'selected' && S.vis.edges.length && !S.selected && !S.selectedEdge && !S.highlight));
  renderHighlightBar();
});

// ---------------------------------------------------------------------------
// Toolbar, search and keyboard

$('fit').onclick = () => renderer.fit(true);
$('zoomIn').onclick = () => renderer.zoom(1.25);
$('zoomOut').onclick = () => renderer.zoom(0.8);
$('expandAll').onclick = expandLevel;
$('collapseAll').onclick = collapseAll;
$('focusMode').checked = S.focusMode;
$('focusMode').onchange = ev => {
  S.focusMode = ev.target.checked;
  persist();
  renderer.refreshStyle();
};
$('filtersBtn').onclick = ev => {
  ev.stopPropagation();
  $('filters').classList.toggle('hidden');
};
document.addEventListener('click', ev => {
  if (!ev.target.closest('#filters') && ev.target.id !== 'filtersBtn') $('filters').classList.add('hidden');
  if (S.aiMenuOpen && ev.target.isConnected && !ev.target.closest('#aiMenu, #aiMore')) {
    S.aiMenuOpen = false;
    renderOpts();
  }
  if (S.historyOpen && ev.target.isConnected && !ev.target.closest('#history, #historyBtn')) {
    S.historyOpen = false;
    renderHistory();
  }
});
$('compareBtn').onclick = () => vscode.postMessage({ type: 'compare' });
$('refreshBtn').onclick = () => {
  setStatus('Rescanning…', true);
  vscode.postMessage({ type: 'refresh' });
};
document.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => switchTab(b.dataset.tab)));
$('question').addEventListener('input', () => $('suggestions').classList.toggle('hidden', !!($('question').value.trim() || S.ai.question)));
$('question').addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    ask();
  }
});

const search = $('search');
let searchTimer = null;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(search.value), 120);
});
search.addEventListener('focus', renderSearchList);
search.addEventListener('blur', () => setTimeout(() => $('searchList').classList.add('hidden'), 100));
search.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (search.value !== S.search.q) runSearch(search.value);
    gotoMatch(S.search.index + (ev.shiftKey ? -1 : 1));
    renderSearchList();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const m = S.search.matches;
    if (!m.length) return;
    S.search.index = (S.search.index + (ev.key === 'ArrowDown' ? 1 : -1) + Math.min(m.length, 60)) % Math.min(m.length, 60);
    renderSearchList();
  } else if (ev.key === 'Escape') {
    search.value = '';
    runSearch('');
    search.blur();
    renderer.focus();
  }
});
$('searchNext').onclick = () => gotoMatch(S.search.index + 1);
$('searchPrev').onclick = () => gotoMatch(S.search.index - 1);

document.addEventListener('keydown', ev => {
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (ev.key === '/' || (ev.key === 'f' && (ev.ctrlKey || ev.metaKey))) {
    ev.preventDefault();
    search.focus();
    search.select();
  } else if (ev.key === 'f' || ev.key === 'F') renderer.fit(true);
  else if (ev.key === 'Escape') {
    if (S.highlight) setHighlight(null);
    else if (S.selected || S.selectedEdge) {
      S.selected = null;
      S.selectedEdge = null;
      renderer.refreshStyle();
      renderDetails();
    }
  } else if ((ev.key === '+' || ev.key === '=' || ev.key === 'ArrowRight') && S.selected) toggle(S.selected, true);
  else if ((ev.key === '-' || ev.key === 'ArrowLeft') && S.selected) {
    if (S.expanded.has(S.selected)) toggle(S.selected, false);
    else if (S.parentOf.get(S.selected)) {
      const p = S.parentOf.get(S.selected);
      toggle(p, false);
      select(p);
    }
  } else if (ev.key === 'Enter' && S.selected) openSource(S.selected);
  else if ((ev.key === 'o' || ev.key === 'O') && !ev.ctrlKey && !ev.metaKey && S.selected) focusArea(S.selected);
  else if ((ev.key === 'c' || ev.key === 'C') && !ev.ctrlKey && !ev.metaKey && S.selected) {
    toggleCode(S.selected);
    renderDetails();
  }
});

// ---------------------------------------------------------------------------
// Messages from the extension

window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'graph':
      // The code may have changed: check again (the extension answers from its cache when it hasn't).
      for (const e of S.summaries.values()) e.stale = true;
      if (S.impact) setTimeout(() => S.impact && requestImpact(true), 0);
      if (m.compare) S.compare = m.compare;
      loadGraph(m.graph, m.mode, m.title, m.compare);
      renderSuggestions();
      break;
    case 'status':
      setStatus(m.text, m.busy, m.error);
      break;
    case 'source': {
      const id = onSource(m);
      if (id) renderer.setCodeCard(id);
      break;
    }
    case 'reveal':
      reveal(m.id);
      break;
    case 'aiStart':
      // Keep the mode when this confirms a question asked from the panel; questions from the command palette use Ask.
      S.ai = { busy: true, question: m.question, answer: '', model: null, steps: [], mode: S.ai.busy && S.ai.question === m.question ? S.ai.mode : 'ask' };
      $('question').value = m.question;
      switchTab('ai');
      renderAnswer();
      break;
    case 'aiPartial':
      S.ai.answer = m.text;
      renderAnswer();
      break;
    case 'summary':
      onSummary(m);
      break;
    case 'impactResult':
      onImpact(m);
      break;
    case 'semanticBuilding':
      S.semanticBusy = !!m.busy;
      if (!S.selected && !S.selectedEdge) renderDetails();
      break;
    case 'aiHistory':
      S.history = m.entries || [];
      renderHistory();
      break;
    case 'aiStep':
      S.ai.steps.push(m.step);
      renderAnswer();
      setVisited(m.step.nodeIds);
      break;
    case 'aiResult':
      S.ai = {
        busy: false, question: S.ai.question, mode: S.ai.mode, steps: S.ai.steps || [], open: S.ai.open === 'how' ? 'how' : undefined, error: !!m.error,
        answer: m.answer, highlight: m.highlight, path: m.path, hops: m.hops, routes: m.routes, routeIdx: 0, evidence: m.evidence, confidence: m.confidence, confidenceReason: m.confidenceReason, model: m.model,
        entryId: m.entryId, time: m.time
      };
      S.visited = null;
      if (!m.error && !m.cancelled) $('question').value = '';
      renderAnswer();
      if (m.highlight && m.highlight.length) applyAiHighlight(false);
      break;
  }
});

renderAnswer();
setStatus('Scanning C/C++ files…', true);
vscode.postMessage({ type: 'ready' });

// Exposed for tests.
window.__codeGraph = { S, renderer, loadGraph, reveal, toggle, toggleCode, trace, centerOn: (id, animate) => renderer.centerOn(id, animate), applyPreset, setEdgeMode, focusArea };
