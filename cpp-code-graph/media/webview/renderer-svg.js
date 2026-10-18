// SVG renderer: lays out the visible graph as nested, expandable boxes and draws
// it as a zoomable SVG diagram, with its pointer, wheel and tooltip handling.
// It implements the interface described in renderer.js.

import { $ } from './shell.js';
import { KIND_INFO, EDGE_KINDS, ROUTE_KIND_ORDER } from './constants.js';
import { measureCtx, textWidth, esc, push } from './util.js';
import { S, persist } from './state.js';
import { canShowCode, codeKey, codeCardHtml } from './code.js';
import { kids, ancestors, nodeLabel, relatedSets, highlightReps, isDescendant, changedDescendantCounts, impactTiers } from './model.js';
import { emitter } from './renderer.js';
import { tooltipHtml, hopTitle } from './tooltip.js';

// ---------------------------------------------------------------------------
// SVG layout sizes

const CODE_BTN_W = 28;
const MAX_CODE_LINES = 18; // taller snippets scroll inside the node
const CODE_LINE_H = 16;
const CODE_PAD = 8;
const CODE_MIN_W = 260;
const CODE_MAX_W = 640;

const LONG_EDGE = 520; // arrows longer than this (in bundled mode) become stubs with labels

const LEAF_H = 28;
const HEADER_H = 28;
const PAD = 14;
const GAP_X = 28;
const GAP_Y = 56;
const MAX_ROW_W = 1500;

// ---------------------------------------------------------------------------
// Canvas elements (set by mount)

let svg = null;
let viewport = null;
let canvasEl = null;
const events = emitter();

const SVG_MARKUP = `<svg id="svg" tabindex="0">
  <defs id="defs"></defs>
  <g id="viewport">
    <g id="layerContainers"></g>
    <g id="layerEdges"></g>
    <g id="layerPath"></g>
    <g id="layerNodes"></g>
    <g id="layerBadges"></g>
  </g>
</svg>`;

// ---------------------------------------------------------------------------
// Inline code: a node can be opened into a card showing its source (the text
// is requested and cached by webview/code.js).

let monoW = 0;

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

// ---------------------------------------------------------------------------
// Layout: each expanded node is a box whose children are laid out inside it
// with a small layered (Sugiyama-style) algorithm based on the edges between
// them. Siblings without connections are packed in a grid.

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
  // Left to right is the top-down layout run on boxes turned on their side:
  // ranks become columns and siblings stack vertically. It is used between
  // folders and files, where the flow of calls matters; inside a file the
  // functions stay top-down, otherwise long call chains make boxes very wide.
  if (!sidewaysAmong(ids)) return layeredTopDown(ids, pairs, box);
  const turned = new Map();
  for (const id of ids) {
    const b = box.get(id);
    turned.set(id, { w: b.h, h: b.w });
  }
  const res = layeredTopDown(ids, pairs, turned);
  for (const id of ids) {
    const b = box.get(id);
    const t = turned.get(id);
    b.x = t.y;
    b.y = t.x;
  }
  return { w: res.h, h: res.w };
}

function sidewaysAmong(ids) {
  // True when siblings are laid out left to right: a left-to-right view and all of them folders or files.
  return S.direction === 'LR' && ids.length > 0 && ids.every(id => {
    const k = (S.nodes.get(id) || {}).kind;
    return k === 'dir' || k === 'file';
  });
}

function layeredTopDown(ids, pairs, box) {
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

function setGraph(vis, opts) {
  const lay = computeLayout(vis);
  S.layout = { vis, abs: lay.abs, width: lay.width, height: lay.height };
  render();
  if ((opts && opts.fit) || !S.view) fitView(false);
  else applyView();
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

function anchor(b) {
  // Containers and code cards connect at their header so arrows do not cross their content.
  if (b.container || b.code) {
    const header = { x: b.x, y: b.y, w: b.w, h: HEADER_H };
    return { cx: b.x + b.w / 2, cy: b.y + HEADER_H / 2, box: header };
  }
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, box: b };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Path of an arrow between two boxes. Arrows leave and enter through the side
 * of a box that faces the other one (bottom to top when the target is below,
 * right to left in a left-to-right layout) and curve smoothly between them,
 * instead of running from centre to centre.
 * Returns {d, x1, y1, x2, y2, mx, my, len}: path, end points, mid point and length.
 */
function edgeGeometry(e, abs, bend) {
  const A = abs.get(e.s);
  const B = abs.get(e.t);
  if (!A || !B) return null;
  const a = anchor(A);
  const b = anchor(B);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const lr = S.direction === 'LR';
  // Which axis the arrow runs along: the layout direction, unless the boxes sit side by side the other way.
  const gapV = Math.max(a.box.y, b.box.y) - Math.min(a.box.y + a.box.h, b.box.y + b.box.h); // > 0 when apart vertically
  const gapH = Math.max(a.box.x, b.box.x) - Math.min(a.box.x + a.box.w, b.box.x + b.box.w); // > 0 when apart horizontally
  const vertical = lr ? gapH <= 0 : gapV > 0 || gapH <= 0;
  let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
  const sway = bend * 22;
  if (vertical) {
    const down = dy >= 0;
    // Container boxes use their full height so arrows leave below their content, not through it.
    const aEdgeY = down ? (A.container || A.code ? A.y + A.h : a.box.y + a.box.h) : a.box.y;
    const bEdgeY = down ? b.box.y : B.container || B.code ? B.y + B.h : b.box.y + b.box.h;
    x1 = clamp(b.cx, a.box.x + 12, a.box.x + a.box.w - 12);
    x2 = clamp(a.cx, b.box.x + 12, b.box.x + b.box.w - 12);
    // Boxes that overlap horizontally get a straight vertical arrow.
    const lo = Math.max(a.box.x, b.box.x) + 8;
    const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - 8;
    if (lo < hi) x1 = x2 = clamp((a.cx + b.cx) / 2, lo, hi);
    y1 = aEdgeY;
    y2 = bEdgeY;
    const k = clamp(Math.abs(y2 - y1) / 2, 14, 70) * (down ? 1 : -1);
    c1x = x1 + sway;
    c1y = y1 + k;
    c2x = x2 + sway;
    c2y = y2 - k;
  } else {
    const right = dx >= 0;
    x1 = right ? a.box.x + a.box.w : a.box.x;
    x2 = right ? b.box.x : b.box.x + b.box.w;
    y1 = clamp(b.cy, a.box.y + 8, a.box.y + a.box.h - 8);
    y2 = clamp(a.cy, b.box.y + 8, b.box.y + b.box.h - 8);
    const k = clamp(Math.abs(x2 - x1) / 2, 14, 90) * (right ? 1 : -1);
    c1x = x1 + k;
    c1y = y1 + sway;
    c2x = x2 - k;
    c2y = y2 + sway;
  }
  const f = v => v.toFixed(1);
  const unit = (ax, ay) => {
    const l = Math.hypot(ax, ay) || 1;
    return [ax / l, ay / l];
  };
  const [ux1, uy1] = unit(c1x - x1, c1y - y1); // direction leaving the source
  const [ux2, uy2] = unit(x2 - c2x, y2 - c2y); // direction entering the target
  return {
    d: `M${f(x1)},${f(y1)} C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(x2)},${f(y2)}`,
    x1, y1, x2, y2, ux1, uy1, ux2, uy2,
    mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    my: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
    len: Math.hypot(x2 - x1, y2 - y1)
  };
}

/**
 * An arrow that is too long to follow, drawn as two short stubs (one leaving the
 * source, one entering the target), each ending in a label naming the other end.
 * Clicking a label jumps to that end (data-badge).
 */
function edgeStubs(e, g, cls, width) {
  const STUB = 30;
  const H = 20;
  const name = id => nodeLabel(S.nodes.get(id) || {});
  const times = e.count > 1 ? ' ×' + e.count : '';
  const badge = (text, x, y, ux, uy, target, hit) => {
    // Place the label at the far end of the stub, on the side the stub points to.
    const w = Math.ceil(textWidth(text)) + 16;
    const horizontal = Math.abs(ux) > Math.abs(uy);
    const bx = horizontal ? (ux > 0 ? x : x - w) : x - w / 2;
    const by = horizontal ? y - H / 2 : uy > 0 ? y : y - H;
    return `<g class="badge ek-${e.kind}${e.status ? ' st-' + e.status : ''}${cls.includes('dim') ? ' dim' : ''}" data-badge="${esc(target)}"><title>Go to ${esc(name(target))}</title><rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w}" height="${H}" rx="10"/><text x="${(bx + w / 2).toFixed(1)}" y="${(by + H / 2 + 4).toFixed(1)}">${esc(text)}</text></g>`;
  };
  const sx = g.x1 + g.ux1 * STUB;
  const sy = g.y1 + g.uy1 * STUB;
  const tx = g.x2 - g.ux2 * STUB;
  const ty = g.y2 - g.uy2 * STUB;
  const styleW = `style="stroke-width:${width.toFixed(2)}px"`;
  return {
    edges:
      `<g class="${cls} stub" data-edge="${esc(e.key)}"><path class="hit" d="M${g.x1.toFixed(1)},${g.y1.toFixed(1)} L${sx.toFixed(1)},${sy.toFixed(1)}"/><path class="line" ${styleW} d="M${g.x1.toFixed(1)},${g.y1.toFixed(1)} L${sx.toFixed(1)},${sy.toFixed(1)}"/></g>` +
      `<g class="${cls} stub" data-edge="${esc(e.key)}"><path class="hit" d="M${tx.toFixed(1)},${ty.toFixed(1)} L${g.x2.toFixed(1)},${g.y2.toFixed(1)}"/><path class="line" ${styleW} d="M${tx.toFixed(1)},${ty.toFixed(1)} L${g.x2.toFixed(1)},${g.y2.toFixed(1)}" marker-end="url(#arrow-${e.kind})"/></g>`,
    badges: badge('→ ' + name(e.t) + times, sx, sy, g.ux1, g.uy1, e.t) + badge(name(e.s) + times + ' →', tx, ty, -g.ux2, -g.uy2, e.s)
  };
}

function render() {
  edgeMarkers();
  const { vis, abs } = S.layout;
  const related = relatedSets();
  const hl = highlightReps();
  const visitedReps = S.visited ? new Set([...S.visited].map(id => vis.repOf(id)).filter(Boolean)) : null;
  const impactReps = impactTiers(vis);
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
    if (visitedReps && visitedReps.has(id)) cls.push('visited');
    if (impactReps && impactReps.has(id)) cls.push('imp-' + impactReps.get(id));
    if (dimActive) {
      const keep = (hl && hl.has(id)) || (visitedReps && visitedReps.has(id)) || (S.focusMode && related && related.nodes.has(id)) || (hl && b.container && [...hl].some(h => isDescendant(h, id)));
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

  // Arrows. Which ones are drawn depends on the arrow mode (see EDGE_MODES): the
  // selection's own arrows are always exact; in "bundled" mode the rest are
  // merged per pair of containers.
  const bundledMode = S.edgeMode === 'bundled';
  const drawn = [];
  for (const e of vis.edges) {
    const isRel = !!(related && related.edges.has(e.key));
    const isHl = !!(hl && hl.has(e.s) && hl.has(e.t));
    const chosen = S.selectedEdge === e.key;
    const show = S.edgeMode === 'all' || isRel || isHl || chosen || (bundledMode && !e.bundleKey);
    if (show) drawn.push({ e, isRel, isHl });
  }
  if (bundledMode) for (const b of vis.bundles) drawn.push({ e: b, isRel: false, isHl: false });
  // Reciprocal pairs are bent apart.
  const pairKey = e => (e.s < e.t ? e.s + '|' + e.t : e.t + '|' + e.s);
  const pairCount = new Map();
  for (const { e } of drawn) pairCount.set(pairKey(e), (pairCount.get(pairKey(e)) || 0) + 1);
  const pairSeen = new Map();
  let edgesSvg = '';
  let badgesSvg = '';
  // Bundles first so exact arrows are drawn on top of them.
  drawn.sort((a, b) => (b.e.bundle ? 1 : 0) - (a.e.bundle ? 1 : 0));
  for (const { e, isRel, isHl } of drawn) {
    const k = pairKey(e);
    const total = pairCount.get(k);
    const idx = pairSeen.get(k) || 0;
    pairSeen.set(k, idx + 1);
    let bend = 0;
    if (total > 1) bend = (idx - (total - 1) / 2) * 0.8 * (e.s < e.t ? 1 : -1);
    const g = edgeGeometry(e, abs, bend);
    if (!g) continue;
    const cls = ['edge', 'ek-' + e.kind];
    if (e.bundle) cls.push('bundle');
    if (e.uncertain) cls.push('uncertain');
    if (e.status) cls.push('st-' + e.status);
    if (isRel) cls.push('related');
    if (isHl) cls.push('hl');
    if (S.selectedEdge === e.key) cls.push('selected');
    if (dimActive && !isRel && !isHl) cls.push('dim');
    const width = Math.min(4, 1 + Math.log2(e.count));
    if (bundledMode && !isRel && !isHl && S.selectedEdge !== e.key && g.len > LONG_EDGE) {
      // Too long to follow: short stubs with a label that jumps to the other end.
      const stub = edgeStubs(e, g, cls.join(' '), width);
      edgesSvg += stub.edges;
      badgesSvg += stub.badges;
      continue;
    }
    const label = e.bundle ? `<g class="blabel"><rect x="${(g.mx - 14).toFixed(1)}" y="${(g.my - 9).toFixed(1)}" width="28" height="18" rx="9"/><text x="${g.mx.toFixed(1)}" y="${(g.my + 4).toFixed(1)}">${e.count}</text></g>` : '';
    edgesSvg += `<g class="${cls.join(' ')}" data-edge="${esc(e.key)}"><path class="hit" d="${g.d}"/><path class="line" d="${g.d}" style="stroke-width:${width.toFixed(2)}px" marker-end="url(#arrow-${e.kind})"/>${label}</g>`;
  }
  $('layerBadges').innerHTML = badgesSvg;
  $('layerEdges').innerHTML = edgesSvg;
  renderPath();
  events.emit('rendered');
}

function renderPath() {
  // Numbered execution path (from the AI answer or a trace).
  const layer = $('layerPath');
  if (!S.highlight || !S.highlight.path || S.highlight.path.length < 1) {
    layer.innerHTML = '';
    return;
  }
  const { abs, vis } = S.layout;
  const route = S.highlight.route;
  // Consecutive steps whose nodes are drawn as the same box form one group.
  const groups = [];
  S.highlight.path.forEach((id, k) => {
    const r = vis.repOf(id);
    if (!r) return;
    const step = (route && route.steps[k]) || { id, kind: 'call' };
    const last = groups[groups.length - 1];
    if (last && last.rep === r) {
      last.to = k;
      last.steps.push(step);
    } else groups.push({ rep: r, from: k, to: k, steps: [step] });
  });
  const divergeAt = route ? route.divergeAt || 0 : 0;
  let s = '';
  let labels = '';
  for (let i = 1; i < groups.length; i++) {
    const g = edgeGeometry({ s: groups[i - 1].rep, t: groups[i].rep }, abs, 0.35);
    if (!g) continue;
    const hop = groups[i].steps[0];
    const cls = ['exec-path'];
    if (hop.inferred) cls.push('inferred');
    else if (hop.returns) cls.push('returns');
    else if (hop.uncertain || hop.dispatch) cls.push('uncertain');
    if (groups[i].from <= divergeAt && divergeAt > 0) cls.push('shared');
    s += `<path class="${cls.join(' ')}" d="${g.d}" marker-end="url(#arrow-path)"><title>${esc(hopTitle(hop))}</title></path>`;
    if (hop.condition) {
      const text = hop.condition.length > 40 ? hop.condition.slice(0, 39) + '…' : hop.condition;
      const w = text.length * 6.4 + 12;
      labels += `<g class="cond k-${hop.kind}" transform="translate(${(g.mx - w / 2).toFixed(1)},${(g.my - 9).toFixed(1)})"><title>${esc(hop.condition)}</title><rect width="${w.toFixed(1)}" height="18" rx="9"/><text x="${(w / 2).toFixed(1)}" y="13">${esc(text)}</text></g>`;
    }
  }
  for (const grp of groups) {
    const b = abs.get(grp.rep);
    if (!b) continue;
    const kind = ROUTE_KIND_ORDER.find(k => grp.steps.some(st => st.kind === k)) || 'call';
    const num = grp.from === grp.to ? String(grp.from + 1) : grp.from + 1 + '–' + (grp.to + 1);
    const r = num.length > 2 ? 13 : 10;
    s += `<g class="step k-${kind}${grp.to < divergeAt ? ' shared' : ''}" transform="translate(${b.x - 8},${b.y - 8})"><circle r="${r}" cx="0" cy="0"/><text x="0" y="4">${num}</text></g>`;
  }
  layer.innerHTML = s + labels;
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

function relayoutKeeping(anchorId) {
  // Re-layout while keeping the anchor node at the same screen position.
  const before = anchorId && S.layout && S.layout.abs.get(anchorId);
  setGraph(S.vis, { fit: false });
  const after = anchorId && S.layout.abs.get(anchorId);
  if (before && after && S.view) {
    S.view.x += (before.x - after.x) * S.view.k;
    S.view.y += (before.y - after.y) * S.view.k;
    applyView();
    persist();
  }
}

// ---------------------------------------------------------------------------
// Events

function nodeIdFromEvent(ev) {
  const g = ev.target.closest && ev.target.closest('[data-id]');
  return g ? g.dataset.id : null;
}

let drag = null;

function listen() {
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
    const closest = sel => target.closest && target.closest(sel);
    const bd = closest('[data-badge]');
    if (bd) return events.emit('reveal', bd.dataset.badge);
    const cb = closest('[data-code]');
    if (cb) return events.emit('toggleCode', cb.dataset.code);
    const tg = closest('[data-toggle]');
    if (tg) return events.emit('toggle', tg.dataset.toggle);
    const id = nodeIdFromEvent({ target });
    if (id) return events.emit(ev.ctrlKey || ev.metaKey ? 'openSource' : 'select', id);
    const eg = closest('[data-edge]');
    if (eg) return events.emit('edgeSelect', eg.dataset.edge);
    events.emit('background');
  });
  svg.addEventListener('click', ev => {
    // A line of an open code card: open that line in the editor.
    const line = ev.target.closest && ev.target.closest('.cl[data-line]');
    if (!line || window.getSelection().toString()) return;
    const id = nodeIdFromEvent(ev);
    if (id) events.emit('openLine', id, +line.dataset.line);
  });
  svg.addEventListener('dblclick', ev => {
    const id = nodeIdFromEvent(ev);
    if (ev.target.closest && ev.target.closest('.codecard')) return;
    if (id && !(ev.target.closest && (ev.target.closest('[data-toggle]') || ev.target.closest('[data-code]')))) events.emit('activate', id);
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

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => S.view && applyView(), 100);
  });
}

function showTooltipFor(ev) {
  const tip = $('tooltip');
  if (ev.target.closest && ev.target.closest('.codecard')) return hideTooltip();
  const id = nodeIdFromEvent(ev);
  const eg = !id && ev.target.closest && ev.target.closest('[data-edge]');
  const html = tooltipHtml(id, eg && eg.dataset.edge);
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

// ---------------------------------------------------------------------------
// The renderer (see renderer.js)

const drawn = (layer, attr, cls) => [...new Set([...svg.querySelectorAll(`#${layer} .${layer === 'layerNodes' ? 'node' : 'edge'}${cls ? '.' + cls : ''}`)].map(g => g.dataset[attr]))];

export const svgRenderer = {
  mount(container) {
    container.insertAdjacentHTML('afterbegin', SVG_MARKUP);
    svg = $('svg');
    viewport = $('viewport');
    canvasEl = container;
    listen();
  },
  setGraph,
  open: relayoutKeeping,
  close: relayoutKeeping,
  setCodeCard: relayoutKeeping,
  refreshStyle() {
    if (S.layout) render();
  },
  centerOn,
  fit: fitView,
  zoom(factor) {
    const r = svg.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  },
  focus() {
    svg.focus();
  },
  on: events.on,
  debug: {
    nodes: cls => drawn('layerNodes', 'id', cls),
    edges: cls => drawn('layerEdges', 'edge', cls)
  }
};
