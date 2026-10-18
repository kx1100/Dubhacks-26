// Details panel: the selected node or edge, its relations, dependencies and concepts.

import { $ } from '../shell.js';
import { KIND_INFO, REL_LABELS, EDGE_VERBS, IMPACT_KINDS } from '../constants.js';
import { esc, ago } from '../util.js';
import { vscode, S, persist } from '../state.js';
import { canShowCode } from '../code.js';
import { kids, nearestInTree, findEdge, kidsRaw } from '../model.js';
import { summaryBlock, bindSummary, scheduleSummary } from './summary.js';
import { openImpact } from './impact.js';
import { renderSuggestions, ask, renderOpts } from './ask.js';
import { renderer } from '../renderer.js';
import { toggleCode, toggle, reveal, openSource, trace, revealAll, switchTab } from '../main.js';

// The shape and color each kind of node has in the graph (see stylesheet() in
// media/main.js): [shape, color variable, stroke width].
const ICON_SHAPES = {
  rect: '<rect x="1.5" y="2.5" width="11" height="9"/>',
  round: '<rect x="1.5" y="2.5" width="11" height="9" rx="3"/>',
  cut: '<polygon points="4,2.5 10,2.5 12.5,5 12.5,9 10,11.5 4,11.5 1.5,9 1.5,5"/>',
  hexagon: '<polygon points="4,2 10,2 13,7 10,12 4,12 1,7"/>',
  tag: '<polygon points="1.5,2.5 9,2.5 12.5,7 9,11.5 1.5,11.5"/>'
};
const KIND_ICONS = {
  file: ['rect', '--cg-source', 2],
  header: ['cut', '--cg-header', 2],
  function: ['round', '--cg-function', 1.5],
  prototype: ['round', '--cg-function', 1.5],
  method: ['round', '--cg-function', 1.5],
  struct: ['rect', '--cg-type', 1.5],
  union: ['rect', '--cg-type', 1.5],
  class: ['rect', '--cg-type', 2.2],
  enum: ['hexagon', '--cg-enum', 1.5],
  typedef: ['tag', '--cg-typedef', 1.5],
  field: ['rect', '--cg-typedef', 1],
  variable: ['rect', '--cg-typedef', 1],
  namespace: ['round', '--cg-muted', 1.5],
  dir: ['rect', '--cg-muted', 1.5]
};

/** A node's kind as the graph draws it: its shape and color, dashed when it is only declared. */
export function kindIcon(n, big) {
  const header = n.kind === 'file' && n.fileRole === 'header';
  const [shape, color, width] = KIND_ICONS[header ? 'header' : n.kind] || KIND_ICONS.dir;
  const declOnly = n.kind === 'prototype' || (n.kind === 'method' && !n.defFile && !n.isPure);
  const label = header ? 'Header file' : (KIND_INFO[n.kind] || { label: n.kind }).label;
  return `<svg class="ki${big ? ' big' : ''}" viewBox="0 0 14 14" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><g fill="none" stroke="var(${color})" stroke-width="${width}"${declOnly ? ' stroke-dasharray="2 1.5"' : ''}>${ICON_SHAPES[shape]}</g></svg>`;
}

export function nodeChip(id, extra) {
  const n = S.nodes.get(id);
  if (!n) return `<span class="chip missing">${esc(id)}</span>`;
  const owner = n.kind === 'method' || n.kind === 'field' ? (S.nodes.get(n.parent) || {}).label : null;
  const label = (owner ? owner + '::' : '') + n.label;
  return `<a class="chip k-${n.kind}${n.status ? ' st-' + n.status : ''}" data-goto="${esc(id)}" title="${esc(n.qname || n.file || n.label)}">${kindIcon(n)}${esc(label)}${extra || ''}</a>`;
}

export function locLink(file, line, side, label) {
  return `<a class="loc" data-open-file="${esc(file)}" data-open-line="${line || 1}" data-side="${side || 'target'}">${esc(label || file + ':' + (line || 1))}</a>`;
}

export function relationSection(title, edges, endpoint, closed) {
  if (!edges.length) return '';
  const seen = new Map();
  for (const e of edges) {
    const other = endpoint === 'target' ? e.target : e.source;
    const cur = seen.get(other);
    if (!cur) seen.set(other, { e, n: e.n || 1, uncertain: e.uncertain, status: e.status });
    else {
      cur.n += e.n || 1;
      cur.uncertain = cur.uncertain && e.uncertain;
    }
  }
  const items = [...seen.entries()].sort((a, b) => (S.nodes.get(a[0]) || {}).label.localeCompare((S.nodes.get(b[0]) || {}).label));
  const shown = items.slice(0, 80);
  const html = shown
    .map(([other, info]) => {
      const site = info.e.sites && info.e.sites[0];
      const extra = (info.n > 1 ? ` <span class="muted">×${info.n}</span>` : '') + (info.uncertain ? ' <span class="muted" title="Target is a best guess">?</span>' : '');
      const st = info.status ? ` <span class="pill sm st-${info.status}">${info.status}</span>` : '';
      const siteLink = site ? ` <a class="site" title="Go to ${esc(site.file + ':' + site.line)}" data-open-file="${esc(site.file)}" data-open-line="${site.line}" data-side="${info.status === 'removed' ? 'base' : 'target'}">↗</a>` : '';
      return `<li>${nodeChip(other, extra)}${st}${siteLink}</li>`;
    })
    .join('');
  const more = items.length > shown.length ? `<li class="muted">… and ${items.length - shown.length} more</li>` : '';
  return `<details${closed ? '' : ' open'}><summary>${esc(title)} <span class="muted">${items.length}</span></summary><ul class="rel">${html}${more}</ul></details>`;
}

export function describeNode(n) {
  // Plain-language summary for newcomers.
  const kids_ = (S.children.get(n.id) || []).map(id => S.nodes.get(id));
  const count = k => kids_.filter(c => c.kind === k).length;
  const out = S.out.get(n.id) || [];
  const inc = S.inc.get(n.id) || [];
  const calls = new Set(out.filter(e => e.kind === 'call').map(e => e.target)).size;
  const callers = new Set(inc.filter(e => e.kind === 'call').map(e => e.source)).size;
  switch (n.kind) {
    case 'dir':
      return `A folder with ${kids_.length} item${kids_.length === 1 ? '' : 's'}.`;
    case 'file': {
      const inclBy = inc.filter(e => e.kind === 'include').length;
      let s = `${n.fileRole === 'header' ? 'A header file' : 'A source file'} defining ${kids_.length} top-level item${kids_.length === 1 ? '' : 's'}${n.fileRole === 'header' ? `, included by ${inclBy} file${inclBy === 1 ? '' : 's'}` : ''}.`;
      const impl = out.filter(e => e.kind === 'pair').map(e => (S.nodes.get(e.target) || {}).label).filter(Boolean);
      const decl = inc.filter(e => e.kind === 'pair').map(e => (S.nodes.get(e.source) || {}).label).filter(Boolean);
      if (impl.length) s += ` Its declarations are implemented in ${impl.map(esc).join(', ')}.`;
      if (decl.length) s += ` It implements declarations from ${decl.map(esc).join(', ')}.`;
      return s;
    }
    case 'class':
    case 'struct':
    case 'union': {
      const bases = out.filter(e => e.kind === 'inherits').length;
      const derived = inc.filter(e => e.kind === 'inherits').length;
      const parts = [`${count('method')} method${count('method') === 1 ? '' : 's'}`, `${count('field')} field${count('field') === 1 ? '' : 's'}`];
      let s = `A ${n.kind} with ${parts.join(' and ')}.`;
      if (bases) s += ` It derives from ${bases} base class${bases === 1 ? '' : 'es'}.`;
      if (derived) s += ` ${derived} class${derived === 1 ? ' derives' : 'es derive'} from it.`;
      return s;
    }
    case 'function':
    case 'method': {
      let s = n.kind === 'method' ? `A ${n.isPure ? 'pure virtual ' : n.isVirtual ? 'virtual ' : n.isStatic ? 'static ' : ''}member function of ${esc((S.nodes.get(n.parent) || {}).label || '?')}.` : `A ${n.isStatic ? 'file-local (static) ' : ''}free function.`;
      if (n.label === 'main') s += ' This is the program entry point.';
      s += ` It calls ${calls} known function${calls === 1 ? '' : 's'} and is called from ${callers} place${callers === 1 ? '' : 's'} in this codebase.`;
      if (!n.defFile && n.kind === 'method') s += ' No definition was found (declared only, defaulted, or defined elsewhere).';
      return s;
    }
    case 'enum':
      return `An enumeration${n.values && n.values.length ? ' with values ' + n.values.slice(0, 8).map(esc).join(', ') + (n.values.length > 8 ? ', …' : '') : ''}.`;
    case 'namespace':
      return `A namespace block containing ${kids_.length} item${kids_.length === 1 ? '' : 's'}.`;
    case 'field':
      return `A data member of ${esc((S.nodes.get(n.parent) || {}).label || '?')}.`;
    case 'variable':
      return 'A global (namespace-scope) variable.';
  }
  return '';
}

export function renderDetails() {
  // The Ask AI composer offers the selection as context.
  renderOpts();
  renderSuggestions();
  const el = $('tab-details');
  if (S.selectedEdge && S.vis) {
    const e = findEdge(S.selectedEdge);
    if (e) return renderEdgeDetails(el, e);
  }
  const n = S.selected && S.nodes.get(S.selected);
  if (!n) {
    el.innerHTML = `<div class="intro">
      <h3>Explore the code</h3>
      <ul>
        <li><b>Click</b> a node to see what it is and how it connects.</li>
        <li>Clicking a file or class also opens it; clicking a function shows its code.</li>
        <li><b>Double-click</b> to jump to its source.</li>
        <li>Scroll to zoom, drag the background to pan.</li>
      </ul>
      ${entryPoints()}
      ${semanticIntro()}
    </div>`;
    bindLinks(el);
    bindConcepts(el);
    if ($('semBuild')) $('semBuild').onclick = () => vscode.postMessage({ type: 'buildSemantic' });
    return;
  }
  const info = KIND_INFO[n.kind] || { label: n.kind };
  const out = S.out.get(n.id) || [];
  const inc = S.inc.get(n.id) || [];
  const byKind = (list, k) => list.filter(e => e.kind === k);
  const side = n.status === 'removed' ? 'base' : 'target';
  let locs = '';
  if (n.file && n.kind !== 'dir') {
    if (n.declFile) {
      locs += `<div class="kv"><span>Declared</span>${locLink(n.declFile, n.declLine, side)}</div><div class="kv"><span>Defined</span>${locLink(n.defFile || n.file, n.defLine || n.line, side)}</div>`;
    } else if (n.defFile && (n.defFile !== n.file || n.defLine !== n.line)) {
      locs += `<div class="kv"><span>Declared</span>${locLink(n.file, n.line, side)}</div><div class="kv"><span>Defined</span>${locLink(n.defFile, n.defLine, side)}</div>`;
    } else locs += `<div class="kv"><span>Location</span>${locLink(n.file, n.line, side)}</div>`;
  }
  const children = kids(n.id);
  const members = children.length
    ? `<details ${children.length <= 40 ? 'open' : ''}><summary>Contains <span class="muted">${children.length}</span></summary><ul class="rel">${children
        .slice(0, 150)
        .map(c => `<li>${nodeChip(c)}</li>`)
        .join('')}${children.length > 150 ? `<li class="muted">… and ${children.length - 150} more</li>` : ''}</ul></details>`
    : '';
  // Calls are what most people look for first; the other relationships wait under one fold.
  const rels = relationSection(REL_LABELS.call[0], byKind(out, 'call'), 'target') + relationSection(REL_LABELS.call[1], byKind(inc, 'call'), 'source');
  let more = '';
  let moreCount = 0;
  for (const k of ['inherits', 'overrides', 'include', 'type-use', 'pair']) {
    for (const [title, edges, end] of [[REL_LABELS[k][0], byKind(out, k), 'target'], [REL_LABELS[k][1], byKind(inc, k), 'source']]) {
      const sec = relationSection(title, edges, end, true);
      if (sec) moreCount++;
      more += sec;
    }
  }
  if (n.kind === 'file' || n.kind === 'dir' || n.kind === 'namespace' || n.kind === 'class' || n.kind === 'struct') {
    const deps = aggregatedDeps(n.id);
    moreCount += (deps.match(/<details>/g) || []).length;
    more += deps;
  }
  const moreRels = more ? `<details class="morerels"><summary>More relationships <span class="muted">${moreCount}</span></summary>${more}</details>` : '';
  const isFn = n.kind === 'function' || n.kind === 'prototype' || n.kind === 'method';
  const status = n.status ? `<span class="pill st-${n.status}">${n.status}</span>` : '';
  el.innerHTML = `
    <div class="dhead k-${n.kind}">${kindIcon(n, true)}<div><div class="dname">${esc(n.label)} ${status}</div><div class="muted">${esc(info.label)}${n.access ? ' · ' + esc(n.access) : ''}${n.isVirtual ? ' · virtual' : ''}${n.isStatic ? ' · static' : ''}</div></div></div>
    ${n.qname && n.qname !== n.label ? `<div class="qname">${esc(n.qname)}</div>` : ''}
    ${n.signature ? `<pre class="sig">${esc(n.signature)}</pre>` : ''}
    ${summaryBlock(n)}
    <div id="dConcepts"${summaryReady(n) && summaryHasTags(n) ? ' class="hidden"' : ''}>${conceptPills(n.id)}</div>
    <p class="desc${summaryReady(n) ? ' hidden' : ''}" id="dDesc">${describeNode(n)}</p>
    ${locs}
    <div class="actions">
      ${n.file ? '<button data-act="open" class="primary">Open source</button>' : ''}
      <button data-act="explain" title="Ask the AI to explain this">Explain with AI</button>
      ${IMPACT_KINDS.has(n.kind) && n.status !== 'removed' ? '<button data-act="impact" title="Predict what else may need to change if you change this">What if I change this?</button>' : ''}
    </div>
    <details class="moreacts"><summary>More actions</summary><div class="actions">
      ${(n.defFile && n.file && n.defFile !== n.file) || n.declFile ? '<button data-act="openDecl">Declaration</button>' : ''}
      ${canShowCode(n) ? `<button data-act="code" title="Show or hide the source inside the graph node (C)">${S.codeOpen.has(n.id) ? 'Hide code' : 'View code'}</button>` : ''}
      ${children.length ? `<button data-act="toggle">${S.expanded.has(n.id) ? 'Collapse' : 'Expand'}</button>` : ''}
      ${isFn ? '<button data-act="callees" title="Highlight everything this function calls, directly or indirectly">Trace callees</button><button data-act="callers" title="Highlight everything that leads to this function">Trace callers</button>' : ''}
      <button data-act="center">Center</button>
      ${isFn ? '<button data-act="tracePath" title="Ask the AI to reconstruct the execution path starting at this function">Trace path with AI</button>' : ''}
    </div></details>
    ${members}
    ${rels}${moreRels}
    ${rels || moreRels || children.length ? '' : '<p class="muted">No relationships found.</p>'}`;
  el.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'open') openSource(n.id);
      else if (act === 'openDecl') openSource(n.id, 'decl');
      else if (act === 'code') {
        toggleCode(n.id);
        renderDetails();
      } else if (act === 'toggle') {
        toggle(n.id);
        renderDetails();
      } else if (act === 'callees') trace(n.id, 'out');
      else if (act === 'callers') trace(n.id, 'in');
      else if (act === 'center') renderer.centerOn(nearestInTree(n.id) || n.id, true);
      else if (act === 'impact') openImpact(n.id);
      else if (act === 'tracePath') {
        switchTab('ai');
        S.aiMode = 'path';
        persist();
        ask(`What happens when ${n.qname || n.label} runs?`, 'path', n.id);
      } else if (act === 'explain') {
        switchTab('ai');
        ask(`Explain ${n.kind} ${n.qname || n.label}: what is it responsible for, and how does it interact with the rest of the code?`, 'ask');
      }
    };
  });
  bindLinks(el);
  bindConcepts(el);
  bindSummary(n);
  scheduleSummary(n);
}

export function aggregatedDeps(id) {
  // For containers: which other top-level items their contents depend on.
  const under = new Set();
  const stack = [id];
  while (stack.length) {
    const c = stack.pop();
    under.add(c);
    for (const k of S.graph.nodes.length < 50000 ? kidsRaw(c) : []) stack.push(k);
  }
  const level = n => {
    // map to the file containing the node
    let cur = n;
    while (cur) {
      const node = S.nodes.get(cur);
      if (!node) return null;
      if (node.kind === 'file') return cur;
      cur = node.parent;
    }
    return null;
  };
  const outFiles = new Map();
  const inFiles = new Map();
  for (const u of under) {
    for (const e of S.out.get(u) || []) {
      if (under.has(e.target) || e.kind === 'include') continue;
      const f = level(e.target);
      if (f && !under.has(f)) outFiles.set(f, (outFiles.get(f) || 0) + (e.n || 1));
    }
    for (const e of S.inc.get(u) || []) {
      if (under.has(e.source) || e.kind === 'include') continue;
      const f = level(e.source);
      if (f && !under.has(f)) inFiles.set(f, (inFiles.get(f) || 0) + (e.n || 1));
    }
  }
  const list = (m, title) =>
    m.size
      ? `<details><summary>${title} <span class="muted">${m.size}</span></summary><ul class="rel">${[...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 60)
          .map(([f, c]) => `<li>${nodeChip(f, ` <span class="muted">×${c}</span>`)}</li>`)
          .join('')}</ul></details>`
      : '';
  return list(outFiles, 'Depends on files') + list(inFiles, 'Files that depend on this');
}

export function entryPoints() {
  const mains = S.graph ? S.graph.nodes.filter(n => n.label === 'main' && n.kind === 'function') : [];
  const classes = S.graph
    ? S.graph.nodes
        .filter(n => n.kind === 'class' || n.kind === 'struct')
        .map(n => [n, (S.inc.get(n.id) || []).length + (S.out.get(n.id) || []).length])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([n]) => n)
    : [];
  if (!mains.length && !classes.length) return '';
  return `<h3>Good places to start</h3><ul class="rel">${mains.map(m => `<li>${nodeChip(m.id, ' <span class="muted">entry point</span>')}</li>`).join('')}${classes.map(c => `<li>${nodeChip(c.id)}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// AI layer: concepts (see src/ai/semantic.js)

/** Whether the AI summary of the node is showing (it then replaces the generated description). */
export function summaryReady(n) {
  const e = S.summaries.get(n.id);
  return !!(e && e.status === 'ready' && e.summary);
}

/** Whether the AI summary already shows the node's tags (so the concept pills would repeat them). */
export function summaryHasTags(n) {
  return summaryReady(n) && !!(S.summaries.get(n.id).summary.tags || []).length;
}

/** After the summary arrives: hide what it repeats. */
export function syncSummaryExtras(n) {
  if ($('dConcepts')) $('dConcepts').classList.toggle('hidden', summaryHasTags(n));
  if ($('dDesc')) $('dDesc').classList.toggle('hidden', summaryReady(n));
}

export function conceptPills(id) {
  const tags = S.concepts[id];
  if (!tags || !tags.length) return '';
  return `<div class="concepts"><span class="aibadge" title="Concepts tagged by the AI">AI</span>${tags.map(t => `<a class="concept" data-concept="${esc(t)}" title="Highlight everything tagged ${esc(t)}">${esc(t)}</a>`).join('')}</div>`;
}

/** Highlights every node tagged with a concept. */
export function showConcept(tag) {
  const ids = new Set(Object.keys(S.concepts).filter(id => S.nodes.has(id) && S.concepts[id].includes(tag)));
  if (!ids.size) return;
  S.highlight = { ids, path: [], label: 'Concept: ' + tag + ' (' + ids.size + ')' };
  revealAll(ids);
}

export function bindConcepts(el) {
  el.querySelectorAll('[data-concept]').forEach(a => {
    a.onclick = ev => {
      ev.preventDefault();
      showConcept(a.dataset.concept);
    };
  });
}

/** The AI layer part of the start page: concepts to explore, and building or rebuilding it. */
export function semanticIntro() {
  const busy = S.semanticBusy;
  const btn = `<button id="semBuild" class="${S.semantic ? '' : 'primary'}"${busy ? ' disabled' : ''}>${busy ? 'Tagging…' : S.semantic ? 'Update concepts' : 'Tag concepts with AI'}</button>`;
  if (!S.semantic) {
    return `<h3>Concepts</h3><p class="muted">Let the AI tag every function and class with the concept it serves (logging, rendering, parsing…). Results are saved, and only changed code is looked at again.</p><div class="askrow">${btn}</div>`;
  }
  const counts = new Map();
  for (const tags of Object.values(S.concepts)) for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  const pills = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([t, c]) => `<a class="concept" data-concept="${esc(t)}">${esc(t)} <span class="muted">${c}</span></a>`)
    .join('');
  const s = S.semantic;
  return `<h3>Concepts</h3><div class="concepts">${pills || '<span class="muted">No concepts yet.</span>'}</div>
    <p class="muted">${s.concepts} concept${s.concepts === 1 ? '' : 's'} on ${s.tagged} element${s.tagged === 1 ? '' : 's'}${s.model ? ', by ' + esc(s.model) : ''}${s.time ? ', ' + ago(s.time) : ''}.</p>
    <div class="askrow">${btn}</div>`;
}

export function renderEdgeDetails(el, e) {
  const verb = EDGE_VERBS[e.kind];
  const raw = e.raw
    .slice(0, 100)
    .map(r => {
      const site = r.sites && r.sites[0];
      return `<li>${nodeChip(r.source)} <span class="muted">${verb}</span> ${nodeChip(r.target)}${r.uncertain ? ' <span class="muted">?</span>' : ''}${r.status ? ` <span class="pill sm st-${r.status}">${r.status}</span>` : ''}${
        site ? ` <a class="site" data-open-file="${esc(site.file)}" data-open-line="${site.line}" data-side="${r.status === 'removed' ? 'base' : 'target'}" title="${esc(site.file + ':' + site.line)}">↗</a>` : ''
      }</li>`;
    })
    .join('');
  el.innerHTML = `<div class="dhead"><div><div class="dname">${nodeChip(e.source)} <span class="muted">${verb}</span> ${nodeChip(e.target)}</div><div class="muted">${e.raw.length} underlying relationship${e.raw.length === 1 ? '' : 's'}, ${e.count} occurrence${e.count === 1 ? '' : 's'}</div></div></div>
    ${e.uncertain ? '<p class="muted">Uncertain: the call target was matched by name only and may be one of several candidates.</p>' : ''}
    <ul class="rel">${raw}</ul>`;
  bindLinks(el);
}

export function bindLinks(el) {
  el.querySelectorAll('[data-goto]').forEach(a => {
    a.onclick = ev => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) openSource(a.dataset.goto);
      else reveal(a.dataset.goto);
    };
  });
  el.querySelectorAll('[data-open-file]').forEach(a => {
    a.onclick = ev => {
      ev.preventDefault();
      vscode.postMessage({ type: 'openLocation', file: a.dataset.openFile, line: +a.dataset.openLine });
    };
  });
}
