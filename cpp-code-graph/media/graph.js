// Code Graph webview: renders the graph sent by the extension as a nested,
// expandable, zoomable SVG diagram. No external libraries.
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };

  // ---------------------------------------------------------------------------
  // Constants

  const KIND_INFO = {
    dir: { label: 'Folder', glyph: '▤', rank: 0 },
    file: { label: 'File', glyph: 'F', rank: 1 },
    namespace: { label: 'Namespace', glyph: 'N', rank: 2 },
    class: { label: 'Class', glyph: 'C', rank: 3 },
    struct: { label: 'Struct', glyph: 'S', rank: 3 },
    union: { label: 'Union', glyph: 'U', rank: 3 },
    enum: { label: 'Enum', glyph: 'E', rank: 4 },
    function: { label: 'Function', glyph: 'ƒ', rank: 5 },
    method: { label: 'Method', glyph: 'm', rank: 5 },
    field: { label: 'Field', glyph: '·', rank: 6 },
    variable: { label: 'Global variable', glyph: 'v', rank: 6 }
  };
  const EDGE_KINDS = [
    { kind: 'calls', label: 'Calls', desc: 'function → function it calls' },
    { kind: 'inherits', label: 'Inherits', desc: 'derived class → base class' },
    { kind: 'overrides', label: 'Overrides', desc: 'method → base method it overrides' },
    { kind: 'includes', label: 'Includes', desc: 'file → included file' },
    { kind: 'uses', label: 'Uses type', desc: 'code → class/enum it depends on' },
    { kind: 'pairs', label: 'Header ↔ source', desc: 'file that declares something → file that implements it (list.h → list.c)' }
  ];
  const REL_LABELS = {
    calls: ['Calls', 'Called by'],
    inherits: ['Inherits from', 'Derived classes'],
    overrides: ['Overrides', 'Overridden by'],
    includes: ['Includes', 'Included by'],
    uses: ['Uses types', 'Used by'],
    pairs: ['Implemented in', 'Declares things implemented here']
  };
  const EDGE_VERBS = { calls: 'calls', inherits: 'inherits from', overrides: 'overrides', includes: 'includes', uses: 'uses type', pairs: 'is implemented in' };

  // Kinds whose source can be opened inside the node.
  const CODE_KINDS = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'variable', 'field']);
  const CODE_BTN_W = 28;
  const MAX_CODE_LINES = 18; // taller snippets scroll inside the node
  const CODE_LINE_H = 16;
  const CODE_PAD = 8;
  const CODE_MIN_W = 260;
  const CODE_MAX_W = 640;

  const LEAF_H = 28;
  const HEADER_H = 28;
  const PAD = 14;
  const GAP_X = 28;
  const GAP_Y = 56;
  const MAX_ROW_W = 1500;
  const INITIAL_BUDGET = 45;

  // ---------------------------------------------------------------------------
  // State

  const saved = vscode.getState() || {};
  const S = {
    mode: 'workspace',
    title: '',
    compare: null,
    graph: null,
    nodes: new Map(),
    children: new Map(), // effective tree
    roots: [],
    parentOf: new Map(), // effective parent
    out: new Map(),
    inc: new Map(),
    expanded: new Set(saved.expanded || []),
    codeOpen: new Set(saved.codeOpen || []), // nodes showing their source inline
    code: new Map(), // "id|side" -> {status, lines, html, startLine, file, truncated, error}
    selected: saved.selected || null,
    selectedEdge: null,
    edgeOn: Object.assign({ calls: true, inherits: true, overrides: true, includes: true, uses: false, pairs: true }, saved.edgeOn || {}),
    showFields: saved.showFields !== undefined ? saved.showFields : true,
    showNamespaces: saved.showNamespaces !== undefined ? saved.showNamespaces : true,
    showUncertain: saved.showUncertain !== undefined ? saved.showUncertain : true,
    changesOnly: true,
    focusMode: saved.focusMode !== undefined ? saved.focusMode : true,
    view: saved.view || null, // {x, y, k}
    highlight: null, // {ids:Set, path:[], label}
    search: { q: '', matches: [], index: -1 },
    tab: 'details',
    ai: { busy: false, question: '', answer: '', model: null },
    layout: null,
    savedMode: saved.mode || null
  };

  // ---------------------------------------------------------------------------
  // DOM

  const app = document.getElementById('app');
  app.innerHTML = `
  <header class="toolbar">
    <div class="title" id="title">Code Graph</div>
    <div class="search">
      <input id="search" type="text" placeholder="Search files, classes, functions…  ( / )" spellcheck="false" autocomplete="off">
      <span id="searchCount" class="count"></span>
      <button id="searchPrev" class="icon" title="Previous match (Shift+Enter)">↑</button>
      <button id="searchNext" class="icon" title="Next match (Enter)">↓</button>
      <div id="searchList" class="popup hidden"></div>
    </div>
    <div class="group">
      <button id="fit" title="Fit graph to view (F)">Fit</button>
      <button id="expandAll" title="Expand one more level everywhere">Expand</button>
      <button id="collapseAll" title="Collapse everything to the top level">Collapse</button>
    </div>
    <div class="group menu-anchor">
      <button id="filtersBtn" title="Choose which relationships and nodes to show">Show ▾</button>
      <div id="filters" class="popup hidden"></div>
    </div>
    <div class="group">
      <label class="toggle" title="Dim everything not connected to the selection"><input type="checkbox" id="focusMode"> Focus</label>
    </div>
    <div class="spacer"></div>
    <div class="group">
      <button id="compareBtn" title="Compare two git commits">Compare commits</button>
      <button id="refreshBtn" title="Rescan the workspace">⟳</button>
    </div>
  </header>
  <div id="banner" class="banner hidden"></div>
  <div class="main">
    <div class="canvas" id="canvas">
      <svg id="svg" tabindex="0">
        <defs id="defs"></defs>
        <g id="viewport">
          <g id="layerContainers"></g>
          <g id="layerEdges"></g>
          <g id="layerPath"></g>
          <g id="layerNodes"></g>
        </g>
      </svg>
      <div id="hlBar" class="hlbar hidden"></div>
      <div id="empty" class="empty hidden"></div>
      <div class="zoom">
        <button id="zoomIn" title="Zoom in">+</button>
        <button id="zoomOut" title="Zoom out">−</button>
      </div>
      <div id="legend" class="legend"></div>
      <div id="tooltip" class="tooltip hidden"></div>
    </div>
    <aside class="side">
      <div class="tabs">
        <button data-tab="details" class="active">Details</button>
        <button data-tab="ai">Ask AI</button>
      </div>
      <div id="tab-details" class="tabbody"></div>
      <div id="tab-ai" class="tabbody hidden">
        <div class="ask">
          <textarea id="question" rows="3" placeholder="Ask about the code, e.g. “What happens when the program starts?”  (Ctrl+Enter)"></textarea>
          <div class="askrow">
            <label class="toggle" title="Send the selected node as extra context"><input type="checkbox" id="useSelection" checked> Use selection as context</label>
            <button id="askBtn" class="primary">Ask</button>
          </div>
          <div id="suggestions" class="suggestions"></div>
        </div>
        <div id="answer" class="answer"></div>
      </div>
    </aside>
  </div>
  <footer class="status"><span id="spinner" class="spinner hidden"></span><span id="status">Loading…</span><span class="spacer"></span><span id="stats"></span></footer>`;

  const $ = id => document.getElementById(id);
  const svg = $('svg');
  const viewport = $('viewport');
  const canvasEl = $('canvas');

  const measureCtx = document.createElement('canvas').getContext('2d');
  function textWidth(text, bold) {
    measureCtx.font = (bold ? '600 ' : '') + '12px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
    return measureCtx.measureText(text).width;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function persist() {
    vscode.setState({
      expanded: [...S.expanded],
      codeOpen: [...S.codeOpen],
      selected: S.selected,
      edgeOn: S.edgeOn,
      showFields: S.showFields,
      showNamespaces: S.showNamespaces,
      showUncertain: S.showUncertain,
      focusMode: S.focusMode,
      view: S.view,
      mode: S.mode
    });
  }

  // ---------------------------------------------------------------------------
  // Graph model

  function loadGraph(graph, mode, title, compare) {
    const modeChanged = S.mode !== mode || !S.graph;
    const firstLoad = !S.graph;
    S.graph = graph;
    S.mode = mode;
    S.title = title || '';
    S.compare = compare || (mode === 'diff' ? S.compare : null);
    S.nodes = new Map(graph.nodes.map(n => [n.id, n]));
    S.out = new Map();
    S.inc = new Map();
    for (const e of graph.edges) {
      push(S.out, e.s, e);
      push(S.inc, e.t, e);
    }
    $('title').textContent = S.title || 'Code Graph';
    $('title').title = S.title;

    // Expansion state: keep it across refreshes, restore saved state on first
    // load, otherwise pick a sensible starting depth.
    const restore = firstLoad && S.savedMode === mode && S.expanded.size;
    if (modeChanged && !restore) {
      S.expanded = new Set();
      S.codeOpen = new Set();
      S.view = null;
      S.highlight = null;
    }
    for (const id of [...S.expanded]) if (!S.nodes.has(id)) S.expanded.delete(id);
    for (const id of [...S.codeOpen]) if (!S.nodes.has(id) || !CODE_KINDS.has(S.nodes.get(id).kind)) S.codeOpen.delete(id);
    refreshCode();
    if (S.selected && !S.nodes.has(S.selected)) S.selected = null;
    if (!restore && !firstLoad && !modeChanged) {
      // refresh: keep everything
    }
    rebuildTree();
    if (modeChanged && !restore) initialExpansion();
    renderBanner();
    renderFilters();
    renderStats();
    layoutAndRender(modeChanged && !restore ? 'fit' : S.view ? null : 'fit');
    renderDetails();
    setStatus(mode === 'diff' ? 'Comparison ready. Green = added, red = removed, yellow = modified.' : 'Ready. Double-click a node to expand it, Ctrl+click to open its source.');
  }

  function push(map, k, v) {
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(v);
  }

  function changedKeepSet() {
    // Nodes worth showing in "changes only" mode.
    const keep = new Set();
    const addWithAncestors = id => {
      let cur = id;
      while (cur && !keep.has(cur)) {
        keep.add(cur);
        cur = (S.nodes.get(cur) || {}).parent;
      }
    };
    for (const n of S.graph.nodes) if (n.status) addWithAncestors(n.id);
    for (const e of S.graph.edges) {
      if (e.status) {
        addWithAncestors(e.s);
        addWithAncestors(e.t);
      }
    }
    return keep;
  }

  function rebuildTree() {
    const keep = S.mode === 'diff' && S.changesOnly ? changedKeepSet() : null;
    const transparent = n => n.kind === 'namespace' && !S.showNamespaces;
    const kindHidden = n => !S.showFields && (n.kind === 'field' || n.kind === 'variable');
    S.diffHidden = id => keep && !keep.has(id);
    S.kindHidden = id => {
      const n = S.nodes.get(id);
      return n ? kindHidden(n) : false;
    };
    S.children = new Map();
    S.parentOf = new Map();
    S.roots = [];
    for (const n of S.graph.nodes) {
      if (transparent(n) || kindHidden(n) || (keep && !keep.has(n.id))) continue;
      let p = n.parent;
      while (p && S.nodes.has(p) && transparent(S.nodes.get(p))) p = S.nodes.get(p).parent;
      if (p && !S.nodes.has(p)) p = null;
      S.parentOf.set(n.id, p || null);
      if (p) push(S.children, p, n.id);
      else S.roots.push(n.id);
    }
    // Drop nodes whose ancestor chain is hidden.
    const valid = new Set();
    const visit = id => {
      valid.add(id);
      for (const c of S.children.get(id) || []) visit(c);
    };
    S.roots.forEach(visit);
    for (const id of [...S.parentOf.keys()]) if (!valid.has(id)) S.parentOf.delete(id);
    const cmp = (a, b) => {
      const na = S.nodes.get(a);
      const nb = S.nodes.get(b);
      const ra = (KIND_INFO[na.kind] || {}).rank || 9;
      const rb = (KIND_INFO[nb.kind] || {}).rank || 9;
      if (na.kind === 'dir' || na.kind === 'file' || nb.kind === 'dir' || nb.kind === 'file') {
        if (ra !== rb) return ra - rb;
        return na.name.localeCompare(nb.name);
      }
      if (na.file !== nb.file) return (na.file || '').localeCompare(nb.file || '');
      return (na.line || 0) - (nb.line || 0);
    };
    S.roots.sort(cmp);
    for (const arr of S.children.values()) arr.sort(cmp);
  }

  function kids(id) {
    return S.children.get(id) || [];
  }

  function ancestors(id) {
    // Effective ancestors from the root down to (excluding) id.
    const chain = [];
    let p = S.parentOf.get(id);
    while (p) {
      chain.unshift(p);
      p = S.parentOf.get(p);
    }
    return chain;
  }

  function inTree(id) {
    return S.parentOf.has(id);
  }

  function nearestInTree(id) {
    // For nodes filtered out by kind (e.g. fields), use the closest shown ancestor.
    let cur = id;
    while (cur && !inTree(cur)) {
      if (S.diffHidden(cur)) return null;
      cur = (S.nodes.get(cur) || {}).parent;
    }
    return cur || null;
  }

  function initialExpansion() {
    S.expanded = new Set();
    if (S.mode === 'diff') {
      // Reveal changed entities, as long as the result stays readable.
      const changed = S.graph.nodes.filter(n => n.status && n.kind !== 'dir' && inTree(n.id));
      const leafish = changed.filter(n => n.kind !== 'file' && n.kind !== 'namespace');
      if (leafish.length <= 60) {
        for (const n of leafish) for (const a of ancestors(n.id)) S.expanded.add(a);
        return;
      }
      for (const n of changed) for (const a of ancestors(n.id)) if (S.nodes.get(a).kind === 'dir') S.expanded.add(a);
      return;
    }
    let visible = S.roots.length;
    let level = S.roots.slice();
    while (level.length) {
      const next = [];
      for (const id of level) {
        const n = S.nodes.get(id);
        const c = kids(id);
        if (!c.length || !(n.kind === 'dir' || n.kind === 'file' || n.kind === 'namespace')) continue;
        if (visible + c.length > INITIAL_BUDGET) continue;
        S.expanded.add(id);
        visible += c.length;
        next.push(...c);
      }
      level = next;
    }
    // A single root folder is always worth opening.
    if (S.roots.length === 1) S.expanded.add(S.roots[0]);
  }

  // ---------------------------------------------------------------------------
  // Visible graph: which nodes are shown and how edges are lifted to them

  function computeVisible() {
    const visible = [];
    const rep = new Map();
    const walk = (id, hiddenUnder) => {
      rep.set(id, hiddenUnder || id);
      if (!hiddenUnder) visible.push(id);
      const open = S.expanded.has(id);
      for (const c of kids(id)) walk(c, hiddenUnder || (open ? null : id));
    };
    for (const r of S.roots) walk(r, null);

    const repOf = id => {
      const t = nearestInTree(id);
      return t ? rep.get(t) : undefined;
    };
    const isAncestor = (a, b) => {
      let p = S.parentOf.get(b);
      while (p) {
        if (p === a) return true;
        p = S.parentOf.get(p);
      }
      return false;
    };

    const agg = new Map();
    for (const e of S.graph.edges) {
      if (!S.edgeOn[e.kind]) continue;
      if (e.uncertain && !S.showUncertain) continue;
      const s = repOf(e.s);
      const t = repOf(e.t);
      if (!s || !t || s === t) continue;
      if (isAncestor(s, t) || isAncestor(t, s)) continue;
      const key = s + '\u0001' + t + '\u0001' + e.kind;
      let a = agg.get(key);
      if (!a) {
        a = { key, s, t, kind: e.kind, count: 0, raw: [], uncertain: true, statuses: new Set() };
        agg.set(key, a);
      }
      a.count += e.n || 1;
      a.raw.push(e);
      if (!e.uncertain) a.uncertain = false;
      a.statuses.add(e.status || 'same');
    }
    const edges = [...agg.values()];
    for (const e of edges) {
      e.status = e.statuses.size === 1 ? [...e.statuses][0] : 'mixed';
      if (e.status === 'same') e.status = null;
    }
    return { visible, rep, repOf, edges };
  }

  // ---------------------------------------------------------------------------
  // Layout: each expanded node is a box whose children are laid out inside it
  // with a small layered (Sugiyama-style) algorithm based on the edges between
  // them. Siblings without connections are packed in a grid.

  function nodeLabel(n) {
    return n.name || '(unnamed)';
  }

  // ---------------------------------------------------------------------------
  // Inline code: a node can be opened into a card showing its source. The text
  // comes from the extension (`getSource` / `source`) and is cached per node.

  const highlighter = window.CodeHighlight;
  const sourceRequests = new Map(); // reqId -> {key, id}
  let reqSeq = 0;
  let monoW = 0;

  function codeRange(n) {
    // Prefer the definition (the body) over the declaration.
    if (n.defFile) return { file: n.defFile, start: n.defLine || n.line, end: n.defEndLine || (n.defFile === n.file ? n.endLine : 0) };
    return { file: n.file, start: n.line, end: n.endLine };
  }

  function codeSide(n) {
    return n.status === 'removed' ? 'base' : 'target';
  }

  function codeKey(n) {
    return n.id + '|' + codeSide(n);
  }

  function canShowCode(n) {
    return !!n && CODE_KINDS.has(n.kind) && !!n.file;
  }

  function requestSource(n, force) {
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

  function onSource(m) {
    const req = sourceRequests.get(m.reqId);
    if (!req) return;
    sourceRequests.delete(m.reqId);
    const n = S.nodes.get(req.id);
    if (!n) return;
    if (m.error) S.code.set(req.key, { status: 'error', error: m.error });
    else S.code.set(req.key, { status: 'ready', lines: m.lines, html: highlighter ? highlighter.highlightLines(m.lines) : m.lines.map(l => esc(l)), startLine: m.startLine, file: codeRange(n).file, truncated: !!m.truncated });
    if (S.codeOpen.has(req.id)) relayoutKeeping(req.id);
  }

  function refreshCode() {
    // Keep cached text only for open cards, and re-read those (files may have changed).
    const open = new Set();
    for (const id of S.codeOpen) open.add(codeKey(S.nodes.get(id)));
    for (const key of [...S.code.keys()]) if (!open.has(key)) S.code.delete(key);
    for (const id of S.codeOpen) requestSource(S.nodes.get(id), true);
  }

  function toggleCode(id, force) {
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
    relayoutKeeping(id);
  }

  function descendantsOf(id) {
    const out = [];
    const stack = [...kids(id)];
    while (stack.length) {
      const c = stack.pop();
      out.push(c);
      stack.push(...kids(c));
    }
    return out;
  }

  function codeSize(n, labelW) {
    const e = S.code.get(codeKey(n));
    const lines = e && e.lines ? e.lines : [e && e.status === 'error' ? e.error || 'Source unavailable' : 'Loading…'];
    if (!monoW) {
      const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';
      measureCtx.font = '12px ' + mono;
      monoW = measureCtx.measureText('MMMMMMMMMM').width / 10 || 7.2;
    }
    const longest = lines.reduce((m, l) => Math.max(m, l.replace(/\t/g, '    ').length), 0);
    const digits = String((e && e.startLine ? e.startLine : 1) + lines.length).length;
    const w = Math.max(labelW, Math.min(CODE_MAX_W, Math.max(CODE_MIN_W, (longest + digits + 2) * monoW + 2 * CODE_PAD + 16)));
    const shown = Math.min(lines.length, MAX_CODE_LINES) + (e && e.truncated ? 1 : 0);
    return { w: Math.ceil(w), h: HEADER_H + shown * CODE_LINE_H + 2 * CODE_PAD };
  }

  function codeCardHtml(n) {
    const e = S.code.get(codeKey(n));
    if (!e || e.status === 'loading') return '<div class="codecard"><div class="cl note">Loading…</div></div>';
    if (e.status === 'error') return `<div class="codecard"><div class="cl note">${esc(e.error || 'Source unavailable')}</div></div>`;
    const rows = e.html.map((h, i) => `<div class="cl" data-line="${e.startLine + i}"><span class="ln">${e.startLine + i}</span><span class="ct">${h || ' '}</span></div>`).join('');
    const more = e.truncated ? `<div class="cl note" data-line="${e.startLine + e.lines.length}">… continues in the editor</div>` : '';
    return `<div class="codecard">${rows}${more}</div>`;
  }


  function computeLayout(vis) {
    const box = new Map(); // id -> {w, h, x, y (relative to parent content), container}
    const visibleSet = new Set(vis.visible);

    // Sibling-level edges per container ('' = root).
    const sib = new Map();
    for (const e of vis.edges) {
      const pa = ancestors(e.s).concat([e.s]);
      const pb = ancestors(e.t).concat([e.t]);
      let i = 0;
      while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
      if (i >= pa.length || i >= pb.length) continue;
      const container = i === 0 ? '' : pa[i - 1];
      push(sib, container, [pa[i], pb[i]]);
    }

    const isContainer = id => S.expanded.has(id) && !S.codeOpen.has(id) && kids(id).some(c => visibleSet.has(c));

    const sizeOf = id => {
      const n = S.nodes.get(id);
      const label = nodeLabel(n);
      const hasKids = kids(id).length > 0;
      if (isContainer(id)) {
        const c = kids(id).filter(k => visibleSet.has(k));
        for (const k of c) sizeOf(k);
        const res = layered(c, sib.get(id) || [], box);
        const headerW = textWidth(label, true) + 70;
        const b = { w: Math.max(res.w + 2 * PAD, headerW), h: res.h + HEADER_H + PAD, container: true };
        // center content if header is wider
        const dx = (b.w - 2 * PAD - res.w) / 2;
        for (const k of c) {
          const kb = box.get(k);
          kb.x += PAD + dx;
          kb.y += HEADER_H;
        }
        box.set(id, b);
      } else {
        const w = Math.ceil(textWidth(label, n.kind === 'class' || n.kind === 'struct' || n.kind === 'file' || n.kind === 'dir')) + 44 + (hasKids ? 18 : 0) + (canShowCode(n) ? CODE_BTN_W : 0);
        if (S.codeOpen.has(id)) {
          const size = codeSize(n, w);
          box.set(id, { w: size.w, h: size.h, container: false, code: true });
        } else box.set(id, { w: Math.max(w, 70), h: LEAF_H, container: false });
      }
    };
    const rootNodes = S.roots.filter(r => visibleSet.has(r));
    for (const r of rootNodes) sizeOf(r);
    const top = layered(rootNodes, sib.get('') || [], box);

    // Absolute coordinates.
    const abs = new Map();
    const place = (id, ox, oy) => {
      const b = box.get(id);
      const a = { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h, container: b.container, code: b.code };
      abs.set(id, a);
      if (b.container) for (const k of kids(id)) if (box.has(k) && visibleSet.has(k)) place(k, a.x, a.y);
    };
    for (const r of rootNodes) place(r, 0, 0);
    return { abs, width: top.w, height: top.h };
  }

  function layered(ids, pairs, box) {
    // Sets box.get(id).x/y relative to the content origin; returns {w, h}.
    if (!ids.length) return { w: 0, h: 0 };
    const index = new Map(ids.map((id, i) => [id, i]));
    const outs = ids.map(() => new Set());
    const ins = ids.map(() => new Set());
    for (const [a, b] of pairs) {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      outs[ia].add(ib);
      ins[ib].add(ia);
    }
    const connected = ids.map((_, i) => outs[i].size > 0 || ins[i].size > 0);

    // Break cycles with a DFS; reversed edges become forward edges.
    const dagOut = ids.map(() => []);
    const state = new Array(ids.length).fill(0);
    const dfs = u => {
      state[u] = 1;
      for (const v of outs[u]) {
        if (state[v] === 1) dagOut[v].push(u); // back edge, reverse it
        else {
          dagOut[u].push(v);
          if (state[v] === 0) dfs(v);
        }
      }
      state[u] = 2;
    };
    for (let i = 0; i < ids.length; i++) if (connected[i] && state[i] === 0 && ins[i].size === 0) dfs(i);
    for (let i = 0; i < ids.length; i++) if (connected[i] && state[i] === 0) dfs(i);
    const dagIn = ids.map(() => []);
    dagOut.forEach((vs, u) => vs.forEach(v => dagIn[v].push(u)));

    // Longest-path ranking.
    const rank = new Array(ids.length).fill(0);
    const indeg = dagIn.map(a => a.length);
    const queue = [];
    for (let i = 0; i < ids.length; i++) if (connected[i] && indeg[i] === 0) queue.push(i);
    while (queue.length) {
      const u = queue.shift();
      for (const v of dagOut[u]) {
        rank[v] = Math.max(rank[v], rank[u] + 1);
        if (--indeg[v] === 0) queue.push(v);
      }
    }

    // Rows by rank, ordered by barycenter sweeps.
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
      if (!connected[i]) continue;
      (rows[rank[i]] || (rows[rank[i]] = [])).push(i);
    }
    for (let r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = [];
    const pos = new Array(ids.length).fill(0);
    const setPos = () => rows.forEach(row => row.forEach((u, j) => (pos[u] = j)));
    setPos();
    const bary = (u, nbrs) => (nbrs.length ? nbrs.reduce((s, v) => s + pos[v], 0) / nbrs.length : pos[u]);
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0;
      const order = down ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
      for (const r of order) {
        const row = rows[r];
        const key = new Map(row.map(u => [u, bary(u, down ? dagIn[u] : dagOut[u])]));
        row.sort((a, b) => key.get(a) - key.get(b));
        row.forEach((u, j) => (pos[u] = j));
      }
    }

    // Split rows that are too wide.
    const finalRows = [];
    for (const row of rows) {
      let cur = [];
      let w = 0;
      for (const u of row) {
        const bw = box.get(ids[u]).w;
        if (cur.length && (w + bw > MAX_ROW_W || cur.length >= 14)) {
          finalRows.push(cur);
          cur = [];
          w = 0;
        }
        cur.push(u);
        w += bw + GAP_X;
      }
      if (cur.length) finalRows.push(cur);
    }

    // Initial x: packed and centered; then relax toward neighbors.
    const x = new Array(ids.length).fill(0);
    const rowWidth = row => row.reduce((s, u) => s + box.get(ids[u]).w, 0) + GAP_X * Math.max(0, row.length - 1);
    let maxW = 0;
    for (const row of finalRows) maxW = Math.max(maxW, rowWidth(row));
    for (const row of finalRows) {
      let cx = (maxW - rowWidth(row)) / 2;
      for (const u of row) {
        x[u] = cx;
        cx += box.get(ids[u]).w + GAP_X;
      }
    }
    const center = u => x[u] + box.get(ids[u]).w / 2;
    for (let it = 0; it < 8; it++) {
      for (const row of finalRows) {
        const desired = row.map(u => {
          const nb = [...outs[u], ...ins[u]];
          if (!nb.length) return center(u);
          return nb.reduce((s, v) => s + center(v), 0) / nb.length;
        });
        // Place in order, respecting minimum spacing.
        const nx = [];
        row.forEach((u, j) => {
          const w = box.get(ids[u]).w;
          let left = desired[j] - w / 2;
          if (j > 0) {
            const pu = row[j - 1];
            left = Math.max(left, nx[j - 1] + box.get(ids[pu]).w + GAP_X);
          }
          nx.push(left);
        });
        // Shift the row so that its average offset from the desired positions is zero.
        let shift = 0;
        row.forEach((u, j) => (shift += desired[j] - (nx[j] + box.get(ids[u]).w / 2)));
        shift /= row.length;
        row.forEach((u, j) => (x[u] = nx[j] + shift));
      }
    }
    // Normalize so the minimum x is 0.
    let minX = Infinity;
    let maxX = 0;
    for (const row of finalRows) for (const u of row) {
      minX = Math.min(minX, x[u]);
      maxX = Math.max(maxX, x[u] + box.get(ids[u]).w);
    }
    if (!isFinite(minX)) {
      minX = 0;
      maxX = 0;
    }
    let y = 0;
    for (const row of finalRows) {
      const h = Math.max(...row.map(u => box.get(ids[u]).h));
      for (const u of row) {
        const b = box.get(ids[u]);
        b.x = x[u] - minX;
        b.y = y;
      }
      y += h + GAP_Y;
    }
    let width = maxX - minX;
    let height = finalRows.length ? y - GAP_Y : 0;

    // Grid for unconnected siblings.
    const loose = ids.map((_, i) => i).filter(i => !connected[i]);
    if (loose.length) {
      if (height > 0) height += GAP_Y * 0.6;
      const totalW = loose.reduce((s, u) => s + box.get(ids[u]).w + GAP_X, 0);
      const area = loose.reduce((s, u) => s + (box.get(ids[u]).w + GAP_X) * (box.get(ids[u]).h + 18), 0);
      const target = Math.min(Math.max(width, Math.sqrt(area) * 1.6, 260), Math.max(MAX_ROW_W, width));
      const limit = Math.min(target, totalW);
      let cx = 0;
      let cy = height;
      let rowH = 0;
      let maxRowW = 0;
      for (const u of loose) {
        const b = box.get(ids[u]);
        if (cx > 0 && cx + b.w > limit) {
          cy += rowH + 18;
          cx = 0;
          rowH = 0;
        }
        b.x = cx;
        b.y = cy;
        cx += b.w + GAP_X;
        rowH = Math.max(rowH, b.h);
        maxRowW = Math.max(maxRowW, cx - GAP_X);
      }
      height = cy + rowH;
      width = Math.max(width, maxRowW);
    }
    return { w: width, h: height };
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function layoutAndRender(viewAction) {
    // Expanding a node (for example via Expand all) wins over showing its code.
    for (const id of [...S.codeOpen]) if (S.expanded.has(id)) S.codeOpen.delete(id);
    const vis = computeVisible();
    const lay = computeLayout(vis);
    S.layout = { vis, abs: lay.abs, width: lay.width, height: lay.height };
    render();
    if (viewAction === 'fit' || !S.view) fitView(false);
    else applyView();
    const empty = $('empty');
    if (!S.graph.nodes.length) {
      empty.innerHTML = S.mode === 'diff' ? 'No C/C++ files in these revisions.' : 'No C/C++ files were found in this workspace.<br><span class="muted">Check the <code>codeGraph.include</code> and <code>codeGraph.exclude</code> settings.</span>';
      empty.classList.remove('hidden');
    } else if (!vis.visible.length) {
      empty.innerHTML = S.mode === 'diff' ? 'No structural changes between these versions.' : 'Nothing to show with the current filters.';
      empty.classList.remove('hidden');
    } else empty.classList.add('hidden');
  }

  function edgeMarkers() {
    let s = '';
    for (const k of EDGE_KINDS) {
      const hollow = k.kind === 'inherits';
      s += `<marker id="arrow-${k.kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${hollow ? 11 : 7}" markerHeight="${hollow ? 11 : 7}" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,0 L10,5 L0,10 z" class="arrowhead ek-${k.kind}${hollow ? ' hollow' : ''}"/></marker>`;
    }
    s += `<marker id="arrow-path" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead path"/></marker>`;
    s += `<marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead hl"/></marker>`;
    $('defs').innerHTML = s;
  }

  function clipToBox(cx, cy, tx, ty, b) {
    // Point where the segment from the box center (cx,cy) toward (tx,ty) leaves box b.
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const hw = b.w / 2;
    const hh = b.h / 2;
    const sx = dx ? hw / Math.abs(dx) : Infinity;
    const sy = dy ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return [cx + dx * s, cy + dy * s];
  }

  function anchor(b, toward) {
    // Containers and code cards connect at their header so arrows do not cross their content.
    if (b.container || b.code) {
      const header = { x: b.x, y: b.y, w: b.w, h: HEADER_H };
      return { cx: b.x + b.w / 2, cy: b.y + HEADER_H / 2, box: header };
    }
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, box: b };
  }

  function edgeGeometry(e, abs, bend) {
    const A = abs.get(e.s);
    const B = abs.get(e.t);
    if (!A || !B) return null;
    const a = anchor(A);
    const b = anchor(B);
    const [x1, y1] = clipToBox(a.cx, a.cy, b.cx, b.cy, a.box);
    const [x2, y2] = clipToBox(b.cx, b.cy, a.cx, a.cy, b.box);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const off = bend * Math.min(40, len / 4);
    return { d: `M${x1.toFixed(1)},${y1.toFixed(1)} Q${(mx + nx * off).toFixed(1)},${(my + ny * off).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, mx: mx + (nx * off) / 2, my: my + (ny * off) / 2 };
  }

  function relatedSets() {
    // Nodes/edges connected to the selection (for highlighting and dimming).
    const sel = S.selected;
    const { vis } = S.layout;
    if (!sel) return null;
    const r = vis.repOf(sel);
    if (!r) return null;
    const nodes = new Set([r]);
    const edges = new Set();
    // Include edges touching the selected node or any of its visible descendants.
    const isUnder = id => {
      let cur = id;
      while (cur) {
        if (cur === r) return true;
        cur = S.parentOf.get(cur);
      }
      return false;
    };
    for (const e of vis.edges) {
      if (isUnder(e.s) || isUnder(e.t)) {
        edges.add(e.key);
        nodes.add(e.s);
        nodes.add(e.t);
      }
    }
    // Keep ancestors of related nodes visible as context.
    for (const id of [...nodes]) for (const a of ancestors(id)) nodes.add(a);
    let cur = r;
    const stack = [r];
    while (stack.length) {
      cur = stack.pop();
      nodes.add(cur);
      for (const c of kids(cur)) if (S.layout.abs.has(c)) stack.push(c);
    }
    return { nodes, edges, root: r };
  }

  function highlightReps() {
    if (!S.highlight) return null;
    const set = new Set();
    for (const id of S.highlight.ids) {
      const r = S.layout.vis.repOf(id);
      if (r) set.add(r);
    }
    return set;
  }

  function render() {
    edgeMarkers();
    const { vis, abs } = S.layout;
    const related = relatedSets();
    const hl = highlightReps();
    const dimActive = (S.focusMode && related) || hl;
    const matchSet = new Set(S.search.matches.map(id => vis.repOf(id)).filter(Boolean));
    const changedBelow = S.mode === 'diff' ? changedDescendantCounts() : null;

    // Containers (outer first) and leaves.
    let containers = '';
    let leaves = '';
    const depthOf = id => ancestors(id).length;
    const ordered = vis.visible.slice().sort((a, b) => depthOf(a) - depthOf(b));
    for (const id of ordered) {
      const b = abs.get(id);
      if (!b) continue;
      const n = S.nodes.get(id);
      const info = KIND_INFO[n.kind] || { glyph: '?' };
      const hasKids = kids(id).length > 0;
      const cls = ['node', 'k-' + n.kind];
      if (n.kind === 'file' && n.header) cls.push('header');
      if (b.container) cls.push('container');
      if (id === (related && related.root)) cls.push('selected');
      if (S.selected === id) cls.push('selected');
      if (n.status) cls.push('st-' + n.status);
      if (changedBelow && !n.status && changedBelow.get(id)) cls.push('has-changes');
      if (matchSet.has(id)) cls.push('match');
      if (hl && hl.has(id)) cls.push('hl');
      if (dimActive) {
        const keep = (hl && hl.has(id)) || (S.focusMode && related && related.nodes.has(id)) || (hl && b.container && [...hl].some(h => isDescendant(h, id)));
        if (!keep) cls.push('dim');
      }
      if (n.isPure) cls.push('abstract');
      const label = esc(nodeLabel(n));
      const headH = b.container || b.code ? HEADER_H : b.h;
      const codeable = !b.container && canShowCode(n);
      const codeShift = codeable ? CODE_BTN_W : 0;
      if (b.code) cls.push('has-code');
      const toggle = hasKids
        ? `<g class="toggle" data-toggle="${esc(id)}" transform="translate(${b.w - 20},${headH / 2 - 7})"><rect width="14" height="14" rx="3"/><text x="7" y="11">${S.expanded.has(id) ? '−' : '+'}</text></g>`
        : '';
      const codeBtn = codeable
        ? `<g class="codebtn${b.code ? ' on' : ''}" data-code="${esc(id)}" transform="translate(${b.w - (hasKids ? 26 : 8) - 24},${headH / 2 - 7})"><title>${b.code ? 'Hide code' : 'Show code'}</title><rect width="24" height="14" rx="3"/><text x="12" y="11">&lt;/&gt;</text></g>`
        : '';
      const badge = changedBelow && !n.status && changedBelow.get(id) ? `<circle class="chg-dot" cx="${b.w - (hasKids ? 30 : 10) - codeShift}" cy="${headH / 2}" r="4"/>` : '';
      const countBadge = !b.container && hasKids ? `<text class="kids" x="${b.w - 24 - codeShift}" y="${headH / 2 + 4}" text-anchor="end">${kids(id).length}</text>` : '';
      if (b.code) {
        leaves += `<g class="${cls.join(' ')}" data-id="${esc(id)}" transform="translate(${b.x},${b.y})">
          <rect class="box" width="${b.w}" height="${b.h}" rx="8"/>
          <rect class="head" width="${b.w}" height="${HEADER_H}" rx="8"/>
          <text class="glyph" x="14" y="${HEADER_H / 2 + 4}">${info.glyph}</text>
          <text class="label bold" x="28" y="${HEADER_H / 2 + 4}">${label}</text>${countBadge}${badge}${codeBtn}${toggle}
          <foreignObject class="codefo" x="0" y="${HEADER_H}" width="${b.w}" height="${b.h - HEADER_H}">${codeCardHtml(n)}</foreignObject></g>`;
      } else if (b.container) {
        containers += `<g class="${cls.join(' ')}" data-id="${esc(id)}" transform="translate(${b.x},${b.y})">
          <rect class="box" width="${b.w}" height="${b.h}" rx="8"/>
          <rect class="head" width="${b.w}" height="${HEADER_H}" rx="8"/>
          <text class="glyph" x="14" y="${HEADER_H / 2 + 4}">${info.glyph}</text>
          <text class="label bold" x="28" y="${HEADER_H / 2 + 4}">${label}</text>${badge}${toggle}</g>`;
      } else {
        leaves += `<g class="${cls.join(' ')}" data-id="${esc(id)}" transform="translate(${b.x},${b.y})">
          <rect class="box" width="${b.w}" height="${b.h}" rx="${n.kind === 'function' || n.kind === 'method' ? 14 : 5}"/>
          <text class="glyph" x="14" y="${b.h / 2 + 4}">${info.glyph}</text>
          <text class="label" x="28" y="${b.h / 2 + 4}">${label}</text>${countBadge}${badge}${codeBtn}${toggle}</g>`;
      }
    }
    // Rebuilding the cards would reset their scroll position.
    const scrolls = new Map();
    $('layerNodes').querySelectorAll('.codecard').forEach(el => scrolls.set(el.closest('[data-id]').dataset.id, el.scrollTop));
    $('layerContainers').innerHTML = containers;
    $('layerNodes').innerHTML = leaves;
    if (scrolls.size) {
      $('layerNodes').querySelectorAll('.codecard').forEach(el => {
        const top = scrolls.get(el.closest('[data-id]').dataset.id);
        if (top) el.scrollTop = top;
      });
    }

    // Edges; reciprocal pairs are bent apart.
    const pairCount = new Map();
    for (const e of vis.edges) {
      const k = e.s < e.t ? e.s + '|' + e.t : e.t + '|' + e.s;
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
    }
    const pairSeen = new Map();
    let edgesSvg = '';
    for (const e of vis.edges) {
      const k = e.s < e.t ? e.s + '|' + e.t : e.t + '|' + e.s;
      const total = pairCount.get(k);
      const idx = pairSeen.get(k) || 0;
      pairSeen.set(k, idx + 1);
      let bend = 0;
      if (total > 1) bend = (idx - (total - 1) / 2) * 0.8 * (e.s < e.t ? 1 : -1);
      const g = edgeGeometry(e, abs, bend);
      if (!g) continue;
      e.mid = [g.mx, g.my];
      const cls = ['edge', 'ek-' + e.kind];
      if (e.uncertain) cls.push('uncertain');
      if (e.status) cls.push('st-' + e.status);
      const isRel = related && related.edges.has(e.key);
      const isHl = hl && hl.has(e.s) && hl.has(e.t);
      if (isRel) cls.push('related');
      if (isHl) cls.push('hl');
      if (S.selectedEdge === e.key) cls.push('selected');
      if (dimActive && !isRel && !isHl) cls.push('dim');
      const width = Math.min(4, 1 + Math.log2(e.count));
      edgesSvg += `<g class="${cls.join(' ')}" data-edge="${esc(e.key)}"><path class="hit" d="${g.d}"/><path class="line" d="${g.d}" style="stroke-width:${width.toFixed(2)}px" marker-end="url(#arrow-${e.kind})"/></g>`;
    }
    $('layerEdges').innerHTML = edgesSvg;
    renderPath();
    renderHighlightBar();
  }

  function isDescendant(id, ancestor) {
    let p = S.parentOf.get(id);
    while (p) {
      if (p === ancestor) return true;
      p = S.parentOf.get(p);
    }
    return false;
  }

  function changedDescendantCounts() {
    const counts = new Map();
    for (const n of S.graph.nodes) {
      if (!n.status || !inTree(n.id)) continue;
      for (const a of ancestors(n.id)) counts.set(a, (counts.get(a) || 0) + 1);
    }
    return counts;
  }

  function renderPath() {
    // Numbered execution path (from the AI answer or a trace).
    const layer = $('layerPath');
    if (!S.highlight || !S.highlight.path || S.highlight.path.length < 1) {
      layer.innerHTML = '';
      return;
    }
    const { abs, vis } = S.layout;
    const reps = [];
    for (const id of S.highlight.path) {
      const r = vis.repOf(id);
      if (r && reps[reps.length - 1] !== r) reps.push(r);
    }
    let s = '';
    for (let i = 0; i + 1 < reps.length; i++) {
      const g = edgeGeometry({ s: reps[i], t: reps[i + 1] }, abs, 0.35);
      if (g) s += `<path class="exec-path" d="${g.d}" marker-end="url(#arrow-path)"/>`;
    }
    reps.forEach((r, i) => {
      const b = abs.get(r);
      if (!b) return;
      s += `<g class="step" transform="translate(${b.x - 8},${b.y - 8})"><circle r="10" cx="0" cy="0"/><text x="0" y="4">${i + 1}</text></g>`;
    });
    layer.innerHTML = s;
  }

  // ---------------------------------------------------------------------------
  // View transform

  function applyView() {
    const v = S.view;
    viewport.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
    canvasEl.classList.toggle('far', v.k < 0.45);
  }

  function fitView(animate) {
    const rect = svg.getBoundingClientRect();
    const W = rect.width || 800;
    const H = rect.height || 600;
    const { width, height } = S.layout;
    const k = Math.min(1.2, Math.max(0.05, Math.min((W - 60) / (width || 1), (H - 60) / (height || 1))));
    const target = { k, x: (W - width * k) / 2, y: Math.max(30, (H - height * k) / 2) };
    setView(target, animate);
  }

  function setView(target, animate) {
    if (!animate || !S.view) {
      S.view = target;
      applyView();
      persist();
      return;
    }
    const from = Object.assign({}, S.view);
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / 260);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      S.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      applyView();
      if (t < 1) requestAnimationFrame(step);
      else persist();
    };
    requestAnimationFrame(step);
  }

  function centerOn(id, animate) {
    const b = S.layout.abs.get(id);
    if (!b) return;
    const rect = svg.getBoundingClientRect();
    let k = S.view ? S.view.k : 1;
    if (k < 0.6) k = 0.9;
    if (b.w * k > rect.width * 0.9 || b.h * k > rect.height * 0.9) k = Math.max(0.1, Math.min((rect.width * 0.85) / b.w, (rect.height * 0.85) / b.h));
    setView({ k, x: rect.width / 2 - (b.x + b.w / 2) * k, y: rect.height / 2 - (b.y + Math.min(b.h, 200) / 2) * k }, animate);
  }

  function zoomAt(factor, px, py) {
    const v = S.view;
    const k = Math.min(4, Math.max(0.04, v.k * factor));
    const f = k / v.k;
    S.view = { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    applyView();
    persist();
  }

  // ---------------------------------------------------------------------------
  // Actions

  function toggle(id, force) {
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
    relayoutKeeping(id);
  }

  function relayoutKeeping(anchorId) {
    // Re-layout while keeping the anchor node at the same screen position.
    const before = anchorId && S.layout && S.layout.abs.get(anchorId);
    layoutAndRender(null);
    const after = anchorId && S.layout.abs.get(anchorId);
    if (before && after && S.view) {
      S.view.x += (before.x - after.x) * S.view.k;
      S.view.y += (before.y - after.y) * S.view.k;
      applyView();
      persist();
    }
  }

  function reveal(id, opts) {
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
    if (!opts || opts.center !== false) centerOn(target, true);
    renderDetails();
    switchTab('details', true);
  }

  function select(id) {
    S.selected = id;
    S.selectedEdge = null;
    persist();
    render();
    renderDetails();
  }

  function openSource(id, which) {
    const n = S.nodes.get(id);
    if (!n || !n.file) return;
    const useDef = which !== 'decl' && n.defFile;
    // Free functions keep their definition as the node and remember where the prototype is.
    const useProto = which === 'decl' && n.declFile;
    const file = useProto ? n.declFile : useDef ? n.defFile : n.file;
    const line = useProto ? n.declLine : useDef ? n.defLine : n.line;
    vscode.postMessage({ type: 'open', file, line: line || 1, side: n.status === 'removed' ? 'base' : 'target' });
  }

  function expandLevel() {
    // Expand every visible collapsed node by one level.
    const { visible } = S.layout.vis;
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

  function collapseAll() {
    S.expanded = new Set();
    if (S.roots.length === 1) S.expanded.add(S.roots[0]);
    persist();
    layoutAndRender('fit');
  }

  function trace(id, direction) {
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

  function setHighlight(h) {
    S.highlight = h && h.ids.size ? h : null;
    render();
  }

  function revealAll(ids) {
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

  // ---------------------------------------------------------------------------
  // Toolbar, banner, filters, legend, status

  function renderBanner() {
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

  function renderFilters() {
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
        persist();
        layoutAndRender(null);
        renderLegend();
      };
    });
    $('fUncertain').onchange = ev => {
      S.showUncertain = ev.target.checked;
      persist();
      layoutAndRender(null);
    };
    $('fFields').onchange = ev => {
      S.showFields = ev.target.checked;
      persist();
      rebuildTree();
      layoutAndRender(null);
    };
    $('fNs').onchange = ev => {
      S.showNamespaces = ev.target.checked;
      persist();
      rebuildTree();
      layoutAndRender(null);
    };
    renderLegend();
  }

  function renderLegend() {
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

  function renderStats() {
    const st = S.graph.stats || {};
    const errs = st.errors && st.errors.length ? ` · ${st.errors.length} parse errors` : '';
    $('stats').textContent = `${st.files || 0} files · ${S.graph.nodes.length} nodes · ${S.graph.edges.length} relationships${errs}`;
    $('stats').title = st.errors && st.errors.length ? st.errors.map(e => e.file).join('\n') : '';
  }

  function setStatus(text, busy, error) {
    $('status').textContent = text;
    $('status').classList.toggle('error', !!error);
    $('spinner').classList.toggle('hidden', !busy);
  }

  function renderHighlightBar() {
    const el = $('hlBar');
    if (!S.highlight) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const hidden = [...S.highlight.ids].filter(id => {
      const r = S.layout.vis.repOf(id);
      return r && r !== id;
    }).length;
    el.innerHTML = `<span>${esc(S.highlight.label)}</span>${hidden ? `<button id="hlReveal" title="Expand the graph so every highlighted node is visible">Reveal ${hidden} hidden</button>` : ''}<button id="hlClear" title="Clear highlight (Esc)">✕</button>`;
    if ($('hlReveal')) $('hlReveal').onclick = () => revealAll(S.highlight.ids);
    $('hlClear').onclick = () => setHighlight(null);
  }

  // ---------------------------------------------------------------------------
  // Details panel

  function nodeChip(id, extra) {
    const n = S.nodes.get(id);
    if (!n) return `<span class="chip missing">${esc(id)}</span>`;
    const info = KIND_INFO[n.kind] || { glyph: '?' };
    const owner = n.kind === 'method' || n.kind === 'field' ? (S.nodes.get(n.parent) || {}).name : null;
    const label = (owner ? owner + '::' : '') + n.name;
    return `<a class="chip k-${n.kind}${n.status ? ' st-' + n.status : ''}" data-goto="${esc(id)}" title="${esc(n.qname || n.file || n.name)}"><span class="g">${info.glyph}</span>${esc(label)}${extra || ''}</a>`;
  }

  function locLink(file, line, side, label) {
    return `<a class="loc" data-open-file="${esc(file)}" data-open-line="${line || 1}" data-side="${side || 'target'}">${esc(label || file + ':' + (line || 1))}</a>`;
  }

  function relationSection(title, edges, endpoint) {
    if (!edges.length) return '';
    const seen = new Map();
    for (const e of edges) {
      const other = endpoint === 't' ? e.t : e.s;
      const cur = seen.get(other);
      if (!cur) seen.set(other, { e, n: e.n || 1, uncertain: e.uncertain, status: e.status });
      else {
        cur.n += e.n || 1;
        cur.uncertain = cur.uncertain && e.uncertain;
      }
    }
    const items = [...seen.entries()].sort((a, b) => (S.nodes.get(a[0]) || {}).name.localeCompare((S.nodes.get(b[0]) || {}).name));
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
    return `<details open><summary>${esc(title)} <span class="muted">${items.length}</span></summary><ul class="rel">${html}${more}</ul></details>`;
  }

  function describeNode(n) {
    // Plain-language summary for newcomers.
    const kids_ = (S.children.get(n.id) || []).map(id => S.nodes.get(id));
    const count = k => kids_.filter(c => c.kind === k).length;
    const out = S.out.get(n.id) || [];
    const inc = S.inc.get(n.id) || [];
    const calls = new Set(out.filter(e => e.kind === 'calls').map(e => e.t)).size;
    const callers = new Set(inc.filter(e => e.kind === 'calls').map(e => e.s)).size;
    switch (n.kind) {
      case 'dir':
        return `A folder with ${kids_.length} item${kids_.length === 1 ? '' : 's'}.`;
      case 'file': {
        const inclBy = inc.filter(e => e.kind === 'includes').length;
        let s = `${n.header ? 'A header file' : 'A source file'} defining ${kids_.length} top-level item${kids_.length === 1 ? '' : 's'}${n.header ? `, included by ${inclBy} file${inclBy === 1 ? '' : 's'}` : ''}.`;
        const impl = out.filter(e => e.kind === 'pairs').map(e => (S.nodes.get(e.t) || {}).name).filter(Boolean);
        const decl = inc.filter(e => e.kind === 'pairs').map(e => (S.nodes.get(e.s) || {}).name).filter(Boolean);
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
        let s = n.kind === 'method' ? `A ${n.isPure ? 'pure virtual ' : n.isVirtual ? 'virtual ' : n.isStatic ? 'static ' : ''}member function of ${esc((S.nodes.get(n.parent) || {}).name || '?')}.` : `A ${n.isStatic ? 'file-local (static) ' : ''}free function.`;
        if (n.name === 'main') s += ' This is the program entry point.';
        s += ` It calls ${calls} known function${calls === 1 ? '' : 's'} and is called from ${callers} place${callers === 1 ? '' : 's'} in this codebase.`;
        if (!n.defFile && n.kind === 'method') s += ' No definition was found (declared only, defaulted, or defined elsewhere).';
        return s;
      }
      case 'enum':
        return `An enumeration${n.values && n.values.length ? ' with values ' + n.values.slice(0, 8).map(esc).join(', ') + (n.values.length > 8 ? ', …' : '') : ''}.`;
      case 'namespace':
        return `A namespace block containing ${kids_.length} item${kids_.length === 1 ? '' : 's'}.`;
      case 'field':
        return `A data member of ${esc((S.nodes.get(n.parent) || {}).name || '?')}.`;
      case 'variable':
        return 'A global (namespace-scope) variable.';
    }
    return '';
  }

  function renderDetails() {
    const el = $('tab-details');
    if (S.selectedEdge && S.layout) {
      const e = S.layout.vis.edges.find(x => x.key === S.selectedEdge);
      if (e) return renderEdgeDetails(el, e);
    }
    const n = S.selected && S.nodes.get(S.selected);
    if (!n) {
      el.innerHTML = `<div class="intro">
        <h3>Explore the code</h3>
        <ul>
          <li><b>Click</b> a node to see what it is and how it connects.</li>
          <li><b>Double-click</b> (or press <kbd>+</kbd>) to look inside a folder, file or class.</li>
          <li><b>Ctrl+click</b> to jump to its source.</li>
          <li>Arrows show <b>calls</b>, <b>includes</b>, <b>inheritance</b> and more — choose them under <b>Show ▾</b>.</li>
          <li>Scroll to zoom, drag the background to pan, <kbd>/</kbd> to search.</li>
        </ul>
        ${entryPoints()}
      </div>`;
      bindLinks(el);
      return;
    }
    const info = KIND_INFO[n.kind] || { label: n.kind, glyph: '?' };
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
    let rels = '';
    for (const k of ['calls', 'inherits', 'overrides', 'includes', 'uses', 'pairs']) {
      rels += relationSection(REL_LABELS[k][0], byKind(out, k), 't');
      rels += relationSection(REL_LABELS[k][1], byKind(inc, k), 's');
    }
    if (n.kind === 'file' || n.kind === 'dir' || n.kind === 'namespace' || n.kind === 'class' || n.kind === 'struct') rels += aggregatedDeps(n.id);
    const isFn = n.kind === 'function' || n.kind === 'method';
    const status = n.status ? `<span class="pill st-${n.status}">${n.status}</span>` : '';
    el.innerHTML = `
      <div class="dhead k-${n.kind}"><span class="g big">${info.glyph}</span><div><div class="dname">${esc(n.name)} ${status}</div><div class="muted">${esc(info.label)}${n.access ? ' · ' + esc(n.access) : ''}${n.isVirtual ? ' · virtual' : ''}${n.isStatic ? ' · static' : ''}</div></div></div>
      ${n.qname && n.qname !== n.name ? `<div class="qname">${esc(n.qname)}</div>` : ''}
      ${n.signature ? `<pre class="sig">${esc(n.signature)}</pre>` : ''}
      <p class="desc">${describeNode(n)}</p>
      ${locs}
      <div class="actions">
        ${n.file ? '<button data-act="open" class="primary">Open source</button>' : ''}
        ${(n.defFile && n.file && n.defFile !== n.file) || n.declFile ? '<button data-act="openDecl">Declaration</button>' : ''}
        ${canShowCode(n) ? `<button data-act="code" title="Show or hide the source inside the graph node (C)">${S.codeOpen.has(n.id) ? 'Hide code' : 'View code'}</button>` : ''}
        ${children.length ? `<button data-act="toggle">${S.expanded.has(n.id) ? 'Collapse' : 'Expand'}</button>` : ''}
        ${isFn ? '<button data-act="callees" title="Highlight everything this function calls, directly or indirectly">Trace callees</button><button data-act="callers" title="Highlight everything that leads to this function">Trace callers</button>' : ''}
        <button data-act="center">Center</button>
        <button data-act="explain" title="Ask the AI to explain this">Explain with AI</button>
        ${S.mode === 'diff' && n.kind === 'file' && n.status === 'modified' ? '<button data-act="diff">Show file diff</button>' : ''}
      </div>
      ${members}
      ${rels || (children.length ? '' : '<p class="muted">No relationships found.</p>')}`;
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
        else if (act === 'center') centerOn(nearestInTree(n.id) || n.id, true);
        else if (act === 'diff') vscode.postMessage({ type: 'openDiff', file: n.file });
        else if (act === 'explain') {
          switchTab('ai');
          ask(`Explain ${n.kind} ${n.qname || n.name}: what is it responsible for, and how does it interact with the rest of the code?`);
        }
      };
    });
    bindLinks(el);
  }

  function aggregatedDeps(id) {
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
        if (under.has(e.t) || e.kind === 'includes') continue;
        const f = level(e.t);
        if (f && !under.has(f)) outFiles.set(f, (outFiles.get(f) || 0) + (e.n || 1));
      }
      for (const e of S.inc.get(u) || []) {
        if (under.has(e.s) || e.kind === 'includes') continue;
        const f = level(e.s);
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

  let rawChildren = null;
  function kidsRaw(id) {
    if (!rawChildren || rawChildren.graph !== S.graph) {
      rawChildren = { graph: S.graph, map: new Map() };
      for (const n of S.graph.nodes) if (n.parent) push(rawChildren.map, n.parent, n.id);
    }
    return rawChildren.map.get(id) || [];
  }

  function entryPoints() {
    const mains = S.graph ? S.graph.nodes.filter(n => n.name === 'main' && n.kind === 'function') : [];
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

  function renderEdgeDetails(el, e) {
    const verb = EDGE_VERBS[e.kind];
    const raw = e.raw
      .slice(0, 100)
      .map(r => {
        const site = r.sites && r.sites[0];
        return `<li>${nodeChip(r.s)} <span class="muted">${verb}</span> ${nodeChip(r.t)}${r.uncertain ? ' <span class="muted">?</span>' : ''}${r.status ? ` <span class="pill sm st-${r.status}">${r.status}</span>` : ''}${
          site ? ` <a class="site" data-open-file="${esc(site.file)}" data-open-line="${site.line}" data-side="${r.status === 'removed' ? 'base' : 'target'}" title="${esc(site.file + ':' + site.line)}">↗</a>` : ''
        }</li>`;
      })
      .join('');
    el.innerHTML = `<div class="dhead"><div><div class="dname">${nodeChip(e.s)} <span class="muted">${verb}</span> ${nodeChip(e.t)}</div><div class="muted">${e.raw.length} underlying relationship${e.raw.length === 1 ? '' : 's'}, ${e.count} occurrence${e.count === 1 ? '' : 's'}</div></div></div>
      ${e.uncertain ? '<p class="muted">Uncertain: the call target was matched by name only and may be one of several candidates.</p>' : ''}
      <ul class="rel">${raw}</ul>`;
    bindLinks(el);
  }

  function bindLinks(el) {
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
        vscode.postMessage({ type: 'open', file: a.dataset.openFile, line: +a.dataset.openLine, side: a.dataset.side });
      };
    });
  }

  function switchTab(tab, quiet) {
    if (quiet && S.tab === 'ai' && S.ai.busy) return;
    S.tab = tab;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('tab-details').classList.toggle('hidden', tab !== 'details');
    $('tab-ai').classList.toggle('hidden', tab !== 'ai');
  }

  // ---------------------------------------------------------------------------
  // AI panel

  const SUGGESTIONS = ['What does this project do, and how is it organized?', 'Where does the program start, and what happens next?', 'How do the main classes relate to each other?', 'Explain the selected node and who uses it'];

  function renderSuggestions() {
    const changes = S.mode === 'diff' ? ['Summarize what changed between these commits and why it matters'] : [];
    $('suggestions').innerHTML = changes
      .concat(SUGGESTIONS)
      .map(s => `<button class="sugg">${esc(s)}</button>`)
      .join('');
    $('suggestions').querySelectorAll('.sugg').forEach(b => (b.onclick = () => ask(b.textContent)));
  }

  function ask(q) {
    q = (q || $('question').value).trim();
    if (!q) return;
    $('question').value = q;
    const focus = $('useSelection').checked ? S.selected : null;
    S.ai = { busy: true, question: q, answer: '', model: null };
    renderAnswer();
    vscode.postMessage({ type: 'ask', question: q, focus });
  }

  function mdLite(text) {
    // Minimal, safe markdown: code blocks, inline code, bold, lists, node refs.
    const blocks = String(text).split(/```[a-zA-Z+]*\n?/);
    return blocks
      .map((b, i) => {
        if (i % 2 === 1) return `<pre class="code">${esc(b.replace(/\n$/, ''))}</pre>`;
        // Node references become placeholders first so formatting cannot touch their ids.
        const chips = [];
        let h = esc(
          b.replace(/\[\[([^\]]+)\]\]/g, (m, id) => {
            if (!S.nodes.has(id)) return m;
            chips.push(nodeChip(id));
            return '\u0000' + (chips.length - 1) + '\u0000';
          })
        );
        h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        h = h.replace(/^#{1,4} (.*)$/gm, '<b>$1</b>');
        h = h.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
        h = h.replace(/^\s*\d+\. (.*)$/gm, '<li class="num">$1</li>');
        h = h.replace(/(<li( class="num")?>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
        h = h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
        return h.replace(/\u0000(\d+)\u0000/g, (m, i) => chips[+i]);
      })
      .join('');
  }

  function renderAnswer() {
    const el = $('answer');
    const a = S.ai;
    if (!a.question) {
      el.innerHTML = '<p class="muted">Answers highlight the relevant nodes in the graph and number the execution path when there is one. Uses the language model configured in VS Code (e.g. GitHub Copilot).</p>';
      return;
    }
    el.innerHTML = `<div class="q">${esc(a.question)}</div>
      <div class="a">${a.answer ? mdLite(a.answer) : a.busy ? '<span class="muted">Thinking…</span>' : ''}</div>
      ${a.busy ? '<button id="cancelAsk">Stop</button>' : ''}
      ${!a.busy && a.highlight && a.highlight.length ? `<div class="askrow"><button id="aiShow">Show ${a.highlight.length} nodes in graph</button>${a.model ? `<span class="muted">via ${esc(a.model)}</span>` : ''}</div>` : ''}`;
    if ($('cancelAsk')) $('cancelAsk').onclick = () => vscode.postMessage({ type: 'cancelAsk' });
    if ($('aiShow')) $('aiShow').onclick = () => applyAiHighlight(true);
    bindLinks(el);
  }

  function applyAiHighlight(revealToo) {
    const a = S.ai;
    if (!a.highlight || !a.highlight.length) return;
    const ids = new Set(a.highlight.filter(id => S.nodes.has(id)));
    for (const id of a.path || []) if (S.nodes.has(id)) ids.add(id);
    S.highlight = { ids, path: (a.path || []).filter(id => S.nodes.has(id)), label: 'AI: ' + (a.question.length > 60 ? a.question.slice(0, 57) + '…' : a.question) };
    if (revealToo) revealAll(ids);
    else render();
  }

  // ---------------------------------------------------------------------------
  // Search

  function runSearch(q) {
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
    render();
  }

  function renderSearchList() {
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

  function gotoMatch(i) {
    const m = S.search.matches;
    if (!m.length) return;
    S.search.index = ((i % m.length) + m.length) % m.length;
    $('searchCount').textContent = `${S.search.index + 1}/${m.length}`;
    reveal(m[S.search.index]);
  }

  // ---------------------------------------------------------------------------
  // Events

  function nodeIdFromEvent(ev) {
    const g = ev.target.closest && ev.target.closest('[data-id]');
    return g ? g.dataset.id : null;
  }

  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || !S.view) return;
    if (ev.target.closest && ev.target.closest('.codecard')) return; // code cards scroll and select text
    drag = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y, moved: false, target: ev.target, pointerId: ev.pointerId };
  });
  svg.addEventListener('pointermove', ev => {
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        try {
          svg.setPointerCapture(drag.pointerId);
        } catch {
          // pointer already released
        }
      }
      if (drag.moved) {
        S.view.x = drag.vx + dx;
        S.view.y = drag.vy + dy;
        applyView();
        canvasEl.classList.add('panning');
      }
      hideTooltip();
      return;
    }
    showTooltipFor(ev);
  });
  svg.addEventListener('pointerup', ev => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const target = drag.target;
    drag = null;
    canvasEl.classList.remove('panning');
    if (wasDrag) {
      persist();
      return;
    }
    ev = { target, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey };
    const cb = ev.target.closest && ev.target.closest('[data-code]');
    if (cb) {
      toggleCode(cb.dataset.code);
      if (S.selected === cb.dataset.code) renderDetails();
      return;
    }
    const tg = ev.target.closest && ev.target.closest('[data-toggle]');
    if (tg) {
      toggle(tg.dataset.toggle);
      if (S.selected === tg.dataset.toggle) renderDetails();
      return;
    }
    const id = nodeIdFromEvent(ev);
    if (id) {
      if (ev.ctrlKey || ev.metaKey) openSource(id);
      else {
        select(id);
        switchTab('details', true);
      }
      return;
    }
    const eg = ev.target.closest && ev.target.closest('[data-edge]');
    if (eg) {
      S.selectedEdge = eg.dataset.edge;
      S.selected = null;
      render();
      renderDetails();
      switchTab('details', true);
      return;
    }
    if (S.selected || S.selectedEdge) {
      S.selected = null;
      S.selectedEdge = null;
      persist();
      render();
      renderDetails();
    }
  });
  svg.addEventListener('click', ev => {
    // A line of an open code card: open that line in the editor.
    const line = ev.target.closest && ev.target.closest('.cl[data-line]');
    if (!line || window.getSelection().toString()) return;
    const id = nodeIdFromEvent(ev);
    const n = id && S.nodes.get(id);
    const entry = n && S.code.get(codeKey(n));
    if (entry && entry.file) vscode.postMessage({ type: 'open', file: entry.file, line: +line.dataset.line, side: codeSide(n), preserveFocus: false });
  });
  svg.addEventListener('dblclick', ev => {
    const id = nodeIdFromEvent(ev);
    if (ev.target.closest && ev.target.closest('.codecard')) return;
    if (id && !(ev.target.closest && (ev.target.closest('[data-toggle]') || ev.target.closest('[data-code]')))) {
      if (kids(id).length) toggle(id);
      else openSource(id);
      renderDetails();
    }
  });
  svg.addEventListener(
    'wheel',
    ev => {
      // Over a scrollable code card the wheel scrolls the code; Ctrl+wheel still zooms.
      const card = ev.target.closest && ev.target.closest('.codecard');
      if (card && !ev.ctrlKey && card.scrollHeight > card.clientHeight) return;
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (ev.ctrlKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) {
        const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
        zoomAt(Math.exp(-delta * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - rect.left, ev.clientY - rect.top);
      } else {
        S.view.x -= ev.deltaX;
        applyView();
      }
      hideTooltip();
    },
    { passive: false }
  );
  svg.addEventListener('pointerleave', hideTooltip);

  function showTooltipFor(ev) {
    const tip = $('tooltip');
    if (ev.target.closest && ev.target.closest('.codecard')) return hideTooltip();
    const id = nodeIdFromEvent(ev);
    const eg = !id && ev.target.closest && ev.target.closest('[data-edge]');
    let html = '';
    if (id) {
      const n = S.nodes.get(id);
      const info = KIND_INFO[n.kind] || { label: n.kind };
      html = `<b>${esc(n.name)}</b> <span class="muted">${esc(info.label)}</span>${n.signature ? `<div class="mono">${esc(n.signature)}</div>` : ''}${n.qname && n.qname !== n.name && !n.signature ? `<div class="mono">${esc(n.qname)}</div>` : ''}${
        n.file && n.kind !== 'dir' ? `<div class="muted">${esc(n.defFile || n.file)}:${n.defLine || n.line || 1}</div>` : ''
      }${n.status ? `<div class="pill sm st-${n.status}">${n.status}</div>` : ''}`;
    } else if (eg && S.layout) {
      const e = S.layout.vis.edges.find(x => x.key === eg.dataset.edge);
      if (e) {
        const verb = EDGE_VERBS[e.kind];
        html = `<b>${esc(S.nodes.get(e.s).name)}</b> ${verb} <b>${esc(S.nodes.get(e.t).name)}</b>${e.raw.length > 1 ? `<div class="muted">${e.raw.length} relationships combined (${e.count} occurrences)</div>` : e.count > 1 ? `<div class="muted">${e.count} occurrences</div>` : ''}${e.uncertain ? '<div class="muted">uncertain target</div>' : ''}${e.status ? `<div class="pill sm st-${e.status}">${e.status}</div>` : ''}`;
      }
    }
    if (!html) return hideTooltip();
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const rect = canvasEl.getBoundingClientRect();
    let x = ev.clientX - rect.left + 14;
    let y = ev.clientY - rect.top + 14;
    if (x + tip.offsetWidth > rect.width - 8) x = ev.clientX - rect.left - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > rect.height - 8) y = ev.clientY - rect.top - tip.offsetHeight - 10;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTooltip() {
    $('tooltip').classList.add('hidden');
  }

  $('fit').onclick = () => fitView(true);
  $('zoomIn').onclick = () => {
    const r = svg.getBoundingClientRect();
    zoomAt(1.25, r.width / 2, r.height / 2);
  };
  $('zoomOut').onclick = () => {
    const r = svg.getBoundingClientRect();
    zoomAt(0.8, r.width / 2, r.height / 2);
  };
  $('expandAll').onclick = expandLevel;
  $('collapseAll').onclick = collapseAll;
  $('focusMode').checked = S.focusMode;
  $('focusMode').onchange = ev => {
    S.focusMode = ev.target.checked;
    persist();
    render();
  };
  $('filtersBtn').onclick = ev => {
    ev.stopPropagation();
    $('filters').classList.toggle('hidden');
  };
  document.addEventListener('click', ev => {
    if (!ev.target.closest('#filters') && ev.target.id !== 'filtersBtn') $('filters').classList.add('hidden');
  });
  $('compareBtn').onclick = () => vscode.postMessage({ type: 'compare' });
  $('refreshBtn').onclick = () => {
    setStatus('Rescanning…', true);
    vscode.postMessage({ type: 'refresh' });
  };
  document.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => switchTab(b.dataset.tab)));
  $('askBtn').onclick = () => ask();
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
      svg.focus();
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
    } else if (ev.key === 'f' || ev.key === 'F') fitView(true);
    else if (ev.key === 'Escape') {
      if (S.highlight) setHighlight(null);
      else if (S.selected || S.selectedEdge) {
        S.selected = null;
        S.selectedEdge = null;
        render();
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
    else if ((ev.key === 'c' || ev.key === 'C') && !ev.ctrlKey && !ev.metaKey && S.selected) {
      toggleCode(S.selected);
      renderDetails();
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => S.view && applyView(), 100);
  });

  // ---------------------------------------------------------------------------
  // Messages from the extension

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'graph':
        if (m.compare) S.compare = m.compare;
        loadGraph(m.graph, m.mode, m.title, m.compare);
        renderSuggestions();
        break;
      case 'status':
        setStatus(m.text, m.busy, m.error);
        break;
      case 'source':
        onSource(m);
        break;
      case 'reveal':
        reveal(m.id);
        break;
      case 'aiStart':
        S.ai = { busy: true, question: m.question, answer: '', model: null };
        $('question').value = m.question;
        switchTab('ai');
        renderAnswer();
        break;
      case 'aiPartial':
        S.ai.answer = m.text;
        renderAnswer();
        break;
      case 'aiResult':
        S.ai = { busy: false, question: S.ai.question, answer: m.answer, highlight: m.highlight, path: m.path, model: m.model };
        renderAnswer();
        if (m.highlight && m.highlight.length) applyAiHighlight(false);
        break;
    }
  });

  renderSuggestions();
  renderAnswer();
  setStatus('Scanning C/C++ files…', true);
  vscode.postMessage({ type: 'ready' });

  // Exposed for tests.
  window.__codeGraph = { S, loadGraph, reveal, toggle, toggleCode, trace, centerOn };
})();
