// media/main.js
// Webview: renders GraphData (src/types.ts) with Cytoscape.
// Bundled by esbuild to out/webview.js.
//
// - Layout: ELK, left to right; opening a file or a code card grows it in
//   place and pushes the other nodes away (see layout.js).
// - Files start collapsed. Clicking a file opens it into a box with its
//   functions and types; clicking again closes it.
// - Clicking a function or type opens its code in a card on the graph; click
//   it again (or ✕) to close. Double-click opens it in the editor.
// - Ctrl+click folds an open file or class back up, with everything open
//   inside it, or closes a code card. Nodes can be dragged around.
// - Arrows: "Selected" (only the selected node's), "Bundled" (the default: one
//   arrow per pair of files with a count, plus exact arrows inside a file and
//   for the selection) or "All".
// - Side panel: the previous webview's Details tab (with its "What if I change
//   this?" view) and Ask AI tab, from media/webview/panels, connected to this
//   graph through panel-bridge.js. Their highlights (an answer's nodes and
//   path, a trace, a concept, an impact) are drawn here.
// - Compare: the graph of two commits, colored by what was added, removed or changed.

import cytoscape from 'cytoscape';
// highlight.js is loaded by its own <script> tag (src/panel.ts) and sets window.CodeHighlight.
const { highlightLines } = /** @type {any} */ (window).CodeHighlight;
import { arrangeChildren, growInPlace, registerLayouts, runLayout, undoMoves } from './layout.js';
import { connect, renderer, S, setGraph, setHighlight, switchTab, vscode } from './panel-bridge.js';
import { renderDetails } from './webview/panels/details.js';
import { onSummary } from './webview/panels/summary.js';
import { onImpact, requestImpact } from './webview/panels/impact.js';
import { applyAiHighlight, ask, renderAnswer, renderHistory, renderSuggestions, setVisited } from './webview/panels/ask.js';

registerLayouts(cytoscape);

/** @typedef {import('../src/types').GraphData} GraphData */
/** @typedef {import('../src/types').GraphNode} GraphNode */
/** @typedef {import('../src/types').GraphEdge} GraphEdge */
/** @typedef {import('../src/types').ToWebviewMessage} ToWebviewMessage */
/** @typedef {import('../src/types').FromWebviewMessage} FromWebviewMessage */
/** @typedef {'selected' | 'bundled' | 'all'} EdgeMode */

/** @param {FromWebviewMessage} message */
const send = (message) => vscode.postMessage(message);

// ---------------------------------------------------------------------------
// Legend and descriptions
// ---------------------------------------------------------------------------

const EDGE_INFO = {
    includes: { label: 'includes', legend: 'Includes', desc: 'file → header it #includes', color: '--cg-include', dash: '', arrow: true },
    pairs: { label: 'is the header for', legend: 'Header ↔ source', desc: 'header and the source file that implements it', color: '--cg-pair', dash: '6 4', arrow: false },
    uses: { label: 'uses', legend: 'Uses type', desc: 'function → struct/enum/typedef it uses', color: '--cg-type-use', dash: '7 3', arrow: true },
    calls: { label: 'calls', legend: 'Calls', desc: 'function → function it calls', color: '--cg-call', dash: '', arrow: true },
    // Phase 7 (C++)
    inherits: { label: 'inherits from', legend: 'Inherits', desc: 'derived class → base class', color: '--cg-proto', dash: '', arrow: true },
    overrides: { label: 'overrides', legend: 'Overrides', desc: 'method → base-class method it overrides', color: '--cg-proto', dash: '2 3', arrow: true },
    // Inferred by the AI layer (Code Graph: Build AI Layer)
    semantic: { label: 'is related to', legend: 'AI link', desc: 'relationship inferred by the AI layer', color: '--cg-muted', dash: '1 3', arrow: true },
    // Drawn by the webview in Bundled mode: everything between two files in one arrow.
    bundle: { label: 'depends on', legend: 'Bundled', desc: 'several calls/uses between two files, combined', color: '--cg-bundle', dash: '', arrow: true },
};
const LEGEND_EDGES = ['includes', 'pairs', 'uses', 'calls', 'inherits', 'overrides', 'bundle'];
/** Shown in the legend only when the graph has them (C++). */
const OPTIONAL_EDGES = new Set(['inherits', 'overrides']);
/** File-level relationships: never bundled. */
const FILE_EDGES = new Set(['includes', 'pairs']);

const EDGE_MODES = /** @type {const} */ ({
    selected: { label: 'Selected', desc: 'Only the arrows of the selected node' },
    bundled: { label: 'Bundled', desc: 'One arrow per pair of files with a count, plus exact arrows inside a file and for the selected node' },
    all: { label: 'All', desc: 'Every arrow' },
});

const KIND_LABEL = {
    file: 'File',
    function: 'Function',
    struct: 'Struct',
    enum: 'Enum',
    typedef: 'Typedef',
    class: 'Class',
    method: 'Method',
    field: 'Field (data member)',
    namespace: 'Namespace',
};

// Code card geometry, in graph (model) pixels.
const CARD = { header: 26, line: 16, maxLines: 18, char: 7.2, gutter: 52, minW: 240, maxW: 620, pad: 14 };

// Label size of every node, in graph pixels.
const NODE_FONT = 12;

// Padding around a closed node's label: the more nodes it is connected to, the
// bigger it is. 0, 1, 3, 7 and 15+ connections add 0, 7, 14, 21 and 24 px.
const SIZE = { base: 8, fileBase: 10, step: 7, max: 24 };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const saved = vscode.getState() || {};
const state = {
    /** @type {GraphData | null} */
    data: null,
    /** @type {Map<string, GraphNode>} */
    byId: new Map(),
    /** @type {Map<string, number>} file id -> number of symbols */
    childCount: new Map(),
    /** @type {Map<string, number>} box id -> number of symbols inside it, all the way down */
    descCount: new Map(),
    /** @type {Map<string, number>} node id -> how many distinct nodes it is connected to (see connections) */
    degree: new Map(),
    side: { open: saved.sideOpen ?? true },
    /** @type {Set<string>} expanded file ids */
    expanded: new Set(saved.expanded || []),
    /** @type {string | null} */
    selected: saved.selected || null,
    /** @type {EdgeMode} */
    edgeMode: saved.edgeMode in EDGE_MODES ? saved.edgeMode : 'bundled',
    /** @type {Set<string>} nodes whose code card is open */
    openCode: new Set(saved.openCode || []),
    /** @type {Map<string, {status: 'loading' | 'ready' | 'error', file?: string, line?: number, lines?: string[], html?: string[], truncated?: boolean, error?: string}>} */
    code: new Map(),
    /** Node to center on after the next layout */
    focusAfterLayout: /** @type {string | null} */ (null),
    /** @type {Set<string>} nodes the side panel highlights (an AI answer, a trace, a concept, an impact) */
    highlighted: new Set(),
    /** @type {string[]} an AI answer's execution path, in order */
    path: [],
    /** @type {'workspace' | 'diff'} */
    mode: 'workspace',
    /** @type {{baseLabel: string, targetLabel: string} | null} */
    compare: null,
    /** @type {Map<number, string>} getSource request -> node id */
    sourceReqs: new Map(),
    nextReq: 1,
    firstGraph: true,
    layoutRun: 0,
};

const persist = () =>
    vscode.setState({
        expanded: [...state.expanded],
        selected: state.selected,
        edgeMode: state.edgeMode,
        openCode: [...state.openCode],
        sideOpen: state.side.open,
        aiMode: S.aiMode, // the side panel's
    });

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
app.innerHTML = `
<header class="toolbar">
  <span class="title" id="title">Code Graph</span>
  <button id="fit" title="Fit the whole graph in view">Fit</button>
  <button id="expandAll" title="Show what every file and class holds">Expand all</button>
  <button id="collapseAll" title="Show files only and close all code">Collapse all</button>
  <span class="seg" id="edgeMode" role="group" aria-label="Arrows"><span class="seglabel">Arrows</span></span>
  <span class="spacer"></span>
  <span id="spinner" class="spinner hidden"></span>
  <span id="status" class="status"></span>
  <span id="compareInfo" class="compare-info hidden"></span>
  <button id="compare" title="Compare the graph of two git commits">Compare</button>
  <button id="exitCompare" class="hidden" title="Back to the current workspace">Exit compare</button>
  <button id="sideToggle" title="Show or hide the Details and Ask AI panel">Panel</button>
  <button id="refresh" title="Rescan the workspace">Refresh</button>
</header>
<div class="workspace">
<main class="stage">
  <div id="cy"></div>
  <div id="cards" class="cards"></div>
  <div id="empty" class="empty hidden"></div>
  <div id="hint" class="hint-bar hidden">Select a node to see its arrows, or choose <b>Bundled</b> or <b>All</b>.</div>
  <div id="legend" class="legend"></div>
  <div id="tooltip" class="tooltip hidden"></div>
</main>
<aside id="side" class="side hidden" aria-label="Side panel">
  <div class="tabs">
    <button data-tab="details" class="active">Details</button>
    <button data-tab="ai">Ask AI</button>
    <button id="sideClose" class="tabclose" title="Close the panel">✕</button>
  </div>
  <div id="tab-details" class="tabbody"></div>
  <div id="tab-impact" class="tabbody hidden"></div>
  <div id="tab-ai" class="tabbody hidden">
    <div class="ask">
      <textarea id="question" rows="2" placeholder="Ask about the code…  (Ctrl+Enter)"></textarea>
      <div class="aiopts" id="aiOpts"></div>
      <div id="suggestions" class="suggestions"></div>
    </div>
    <div id="history" class="histpop hidden"></div>
    <div id="answer" class="answer"></div>
  </div>
</aside>
</div>`;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const esc = (/** @type {unknown} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

// ---------------------------------------------------------------------------
// Colors: Cytoscape draws on a canvas, so CSS variables are resolved here.
// ---------------------------------------------------------------------------

function colors() {
    const css = getComputedStyle(document.body);
    const get = (/** @type {string} */ name) => css.getPropertyValue(name).trim() || '#888';
    return {
        bg: get('--cg-bg'),
        fg: get('--cg-fg'),
        muted: get('--cg-muted'),
        nodeBg: get('--cg-node-bg'),
        header: get('--cg-header'),
        source: get('--cg-source'),
        fn: get('--cg-function'),
        type: get('--cg-type'),
        enum: get('--cg-enum'),
        typedef: get('--cg-typedef'),
        focus: get('--cg-focus'),
        added: get('--cg-added'),
        removed: get('--cg-removed'),
        modified: get('--cg-modified'),
        font: css.fontFamily || 'sans-serif',
        edge: Object.fromEntries(Object.entries(EDGE_INFO).map(([k, v]) => [k, get(v.color)])),
    };
}

/** @returns {cytoscape.StylesheetJson} */
function stylesheet() {
    const c = colors();
    /** @type {any[]} */
    const s = [
        {
            selector: 'node',
            style: {
                label: 'data(label)',
                'font-family': c.font,
                // One size for every node, closed or open: a node's size shows
                // how connected it is through its padding, never its text.
                'font-size': NODE_FONT,
                color: c.fg,
                'text-valign': 'center',
                'text-halign': 'center',
                width: 'label',
                height: 'label',
                padding: (/** @type {cytoscape.NodeSingular} */ ele) => `${ele.data('pad') ?? SIZE.base}px`,
                shape: 'round-rectangle',
                'background-color': c.nodeBg,
                'border-width': 1.5,
                'border-color': c.muted,
            },
        },
        // Files: headers and sources differ in color and shape.
        { selector: 'node[kind = "file"]', style: { 'font-weight': 'bold', 'border-width': 2, 'border-color': c.source, shape: 'rectangle' } },
        { selector: 'node[kind = "file"][?header]', style: { 'border-color': c.header, shape: 'cut-rectangle' } },
        {
            selector: 'node[kind = "file"]:parent',
            style: {
                'text-valign': 'top',
                'text-margin-y': -4,
                'background-color': c.source,
                'background-opacity': 0.06,
                padding: '14px',
                shape: 'round-rectangle',
            },
        },
        { selector: 'node[kind = "file"][?header]:parent', style: { 'background-color': c.header } },
        // Symbols
        { selector: 'node[kind = "function"], node[kind = "method"]', style: { 'border-color': c.fn, shape: 'round-rectangle' } },
        // Declared here but defined nowhere in the workspace (e.g. a library API).
        { selector: 'node[?declOnly]', style: { 'border-style': 'dashed', color: c.muted } },
        { selector: 'node[kind = "struct"], node[kind = "class"]', style: { 'border-color': c.type, shape: 'rectangle', 'font-style': 'italic' } },
        { selector: 'node[kind = "class"]', style: { 'font-weight': 'bold', 'border-width': 2 } },
        { selector: 'node[kind = "field"]', style: { 'border-color': c.typedef, 'border-width': 1, shape: 'rectangle', color: c.muted } },
        // An open class (or C++ struct) is a box inside its file's box, holding its methods.
        {
            selector: 'node[kind = "class"]:parent, node[kind = "struct"]:parent',
            style: { 'text-valign': 'top', 'text-margin-y': -4, 'background-color': c.type, 'background-opacity': 0.08, padding: '12px' },
        },
        { selector: 'node[kind = "enum"]', style: { 'border-color': c.enum, shape: 'hexagon', 'font-style': 'italic' } },
        { selector: 'node[kind = "typedef"]', style: { 'border-color': c.typedef, shape: 'tag', 'font-style': 'italic' } },
        // A node with its code open becomes the size of its card (the card's header shows the name).
        {
            selector: 'node.code-open',
            style: { width: 'data(cw)', height: 'data(ch)', padding: '0px', shape: 'round-rectangle', label: '', 'border-width': 2 },
        },
        // Edges
        {
            selector: 'edge',
            style: {
                width: 'mapData(count, 1, 8, 1.5, 4)',
                'curve-style': 'bezier',
                'line-color': c.muted,
                'target-arrow-color': c.muted,
                'target-arrow-shape': 'triangle',
                'arrow-scale': 1,
                opacity: 0.85,
            },
        },
        {
            selector: 'edge[?bundled]',
            style: {
                label: 'data(countLabel)',
                'font-family': c.font,
                'font-size': 10,
                color: c.fg,
                'text-background-color': c.bg,
                'text-background-opacity': 0.85,
                'text-background-padding': '2px',
                width: 'mapData(count, 1, 12, 2, 6)',
            },
        },
        { selector: 'edge[kind = "bundle"]', style: { opacity: 0.6 } },
        // Hidden arrows that exist only while the layout runs (fileLinks).
        { selector: 'edge[kind = "layout"]', style: { opacity: 0, events: 'no' } },
        // Highlighting
        { selector: '.faded', style: { opacity: 0.12 } },
        { selector: 'edge.faded', style: { opacity: 0.05 } },
        { selector: 'edge.hl', style: { opacity: 1, 'z-index': 10 } },
        // Commit comparison: what the newer version added, removed or changed.
        { selector: 'node[status = "added"]', style: { 'border-color': c.added, 'border-width': 3, 'background-color': c.added, 'background-opacity': 0.18 } },
        { selector: 'node[status = "modified"]', style: { 'border-color': c.modified, 'border-width': 3, 'background-color': c.modified, 'background-opacity': 0.18 } },
        { selector: 'node[status = "removed"]', style: { 'border-color': c.removed, 'border-width': 3, 'border-style': 'dashed', color: c.removed, 'background-opacity': 0 } },
        { selector: 'edge[status = "added"]', style: { 'line-color': c.added, 'target-arrow-color': c.added, width: 2.5 } },
        { selector: 'edge[status = "removed"]', style: { 'line-color': c.removed, 'target-arrow-color': c.removed, 'line-style': 'dashed', width: 2.5 } },
        { selector: 'node.chosen', style: { 'border-color': c.focus, 'border-width': 3.5 } },
        // The execution path of an AI answer.
        { selector: 'edge.onpath', style: { width: 5, opacity: 1, 'line-color': c.focus, 'target-arrow-color': c.focus, 'z-index': 20 } },
    ];
    // One rule per edge kind, inserted before the bundle and highlight rules so those win.
    const edgeRules = Object.entries(EDGE_INFO).map(([kind, info]) => ({
        selector: `edge[kind = "${kind}"]`,
        style: {
            'line-color': c.edge[kind],
            'target-arrow-color': c.edge[kind],
            'line-style': info.dash ? 'dashed' : 'solid',
            ...(info.dash ? { 'line-dash-pattern': info.dash.split(' ').map(Number) } : {}),
            'target-arrow-shape': info.arrow ? (kind === 'overrides' ? 'vee' : 'triangle') : 'none',
            ...(kind === 'pairs' ? { width: 2.5 } : {}),
        },
    }));
    s.splice(s.findIndex((r) => r.selector === 'edge[?bundled]'), 0, ...edgeRules);
    return s;
}

const cy = cytoscape({
    container: $('cy'),
    style: stylesheet(),
    wheelSensitivity: 0.3,
    minZoom: 0.05,
    maxZoom: 4,
    boxSelectionEnabled: false,
    autounselectify: true,
});

// Re-read colors when the VS Code theme changes (it swaps the body class).
new MutationObserver(() => cy.style(stylesheet())).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => {
    cy.resize();
    placeCards();
});

// ---------------------------------------------------------------------------
// Graph -> Cytoscape elements
// ---------------------------------------------------------------------------

// Boxes: a file holds its functions, types and classes; a C++ class holds its
// methods. A node is visible when every box around it is open.

/** Symbols are visible only inside open boxes, all the way up to their file. */
function isVisible(/** @type {GraphNode} */ n) {
    for (let p = n.parent; p !== undefined; p = state.byId.get(p)?.parent) {
        if (!state.expanded.has(p)) return false;
    }
    return true;
}

/** The visible node that stands in for `id`: itself, or the innermost open box around it. */
function representative(/** @type {string} */ id) {
    let n = state.byId.get(id);
    while (n && !isVisible(n)) n = n.parent !== undefined ? state.byId.get(n.parent) : undefined;
    return n?.id ?? null;
}

/** The file a node belongs to (a file is its own file). */
function fileOf(/** @type {string} */ id) {
    let n = state.byId.get(id);
    while (n && n.kind !== 'file' && n.parent !== undefined) n = state.byId.get(n.parent);
    return n?.id ?? id;
}

/** `id` itself or the box around it that sits directly in `boxId`, or null if it is outside `boxId`. */
function childOf(/** @type {string} */ boxId, /** @type {string} */ id) {
    let n = state.byId.get(id);
    while (n && n.parent !== boxId) n = n.parent !== undefined ? state.byId.get(n.parent) : undefined;
    return n?.id ?? null;
}

/** Nodes that open into a box (files and classes with members); clicking them toggles it. */
function isBox(/** @type {string} */ id) {
    return (state.childCount.get(id) || 0) > 0;
}

/** Card size for a node's code, or null if the card is not open (or the code not loaded yet). */
function cardSize(/** @type {string} */ id) {
    if (!state.openCode.has(id)) return null;
    const code = state.code.get(id);
    if (!code || code.status === 'loading') return null;
    const lines = code.lines || [];
    const longest = Math.max(20, ...lines.map((l) => l.replace(/\t/g, '    ').length));
    const shown = Math.max(1, Math.min(CARD.maxLines, lines.length)) + (code.truncated || code.error ? 1 : 0);
    return {
        w: Math.round(Math.min(CARD.maxW, Math.max(CARD.minW, longest * CARD.char + CARD.gutter))),
        h: CARD.header + shown * CARD.line + CARD.pad,
    };
}

/** A box's label: a closed file or class shows how many symbols it holds, all the way down. */
function fileLabel(/** @type {GraphNode} */ n, /** @type {boolean} */ open) {
    const kids = state.descCount.get(n.id) || 0;
    return open || !kids ? n.name : `${n.name}  (+${kids})`;
}

/**
 * How many distinct nodes each node is connected to, by arrows either way. A
 * class counts the nodes outside it connected to it or its members, and a file
 * the other files connected to anything in it (what Bundled draws for it).
 * AI links don't count: they aren't part of the code.
 */
function connections(/** @type {GraphData} */ data) {
    /** @type {Map<string, Set<string>>} */
    const sets = new Map();
    for (const e of data.edges) {
        if (e.kind === 'semantic' || e.s === e.t) continue;
        for (const [from, to] of [
            [e.s, e.t],
            [e.t, e.s],
        ]) {
            const around = new Set([to, ...boxesAround(to)]);
            for (const id of [from, ...boxesAround(from)]) {
                if (around.has(id)) continue; // the other end is inside this box
                const other = state.byId.get(id)?.kind === 'file' ? fileOf(to) : to;
                let s = sets.get(id);
                if (!s) sets.set(id, (s = new Set()));
                s.add(other);
            }
        }
    }
    return new Map([...sets].map(([id, s]) => [id, s.size]));
}

/** Padding around a closed node's label for how connected it is (see SIZE). */
function padFor(/** @type {GraphNode} */ n) {
    const base = n.kind === 'file' ? SIZE.fileBase : SIZE.base;
    return base + Math.round(Math.min(SIZE.max, SIZE.step * Math.log2(1 + (state.degree.get(n.id) || 0))));
}

/** Every file, closed: the layout places files first, then opens them in place. */
function fileElements() {
    return (state.data?.nodes ?? [])
        .filter((n) => n.kind === 'file')
        .map((n) => ({
            group: /** @type {const} */ ('nodes'),
            data: { id: n.id, label: fileLabel(n, false), kind: n.kind, header: !!n.header, status: n.status, pad: padFor(n) },
        }));
}

/** What sits directly in a box: a file's functions, types and classes, a class's methods (see openFile). */
function childElements(/** @type {string} */ boxId) {
    return (state.data?.nodes ?? [])
        .filter((n) => n.kind !== 'file' && n.parent === boxId)
        .map((n) => ({
            group: /** @type {const} */ ('nodes'),
            data: {
                id: n.id,
                label: isBox(n.id) ? fileLabel(n, false) : n.name,
                kind: n.kind,
                parent: boxId,
                status: n.status,
                declOnly: (n.kind === 'function' || n.kind === 'method') && !n.defFile && !n.isPure,
                pad: padFor(n),
            },
        }));
}

/**
 * Arrows that give the layout its left-to-right order. header ↔ source has no
 * direction (and points from a header back to the source that includes it),
 * and links the AI inferred aren't part of the code's structure.
 */
const ORDERING = (/** @type {GraphEdge} */ e) => e.kind !== 'pairs' && e.kind !== 'semantic';

/** One hidden arrow per pair of files, used only while ELK runs. */
function fileLinks() {
    const out = new Map();
    for (const e of state.data?.edges ?? []) {
        if (!ORDERING(e)) continue;
        const s = fileOf(e.s);
        const t = fileOf(e.t);
        if (s !== t && !out.has(`${s}->${t}`)) {
            out.set(`${s}->${t}`, { group: 'edges', data: { id: `layout:${s}->${t}`, source: s, target: t, kind: 'layout', count: 1 } });
        }
    }
    return [...out.values()];
}

/** Arrows between what sits in one box (a class counts for its methods), for arranging the box. */
function innerLinks(/** @type {string} */ boxId) {
    /** @type {Array<[string, string]>} */
    const out = [];
    for (const e of state.data?.edges ?? []) {
        if (!ORDERING(e)) continue;
        const s = childOf(boxId, e.s);
        const t = childOf(boxId, e.t);
        if (s && t && s !== t) out.push([s, t]);
    }
    return out;
}

/** True if raw edge `e` is one of the selected node's own arrows, or links two nodes of an AI answer. */
function touchesSelection(/** @type {GraphEdge} */ e) {
    if (state.highlighted.has(e.s) && state.highlighted.has(e.t)) return true;
    const sel = state.selected;
    if (!sel) return false;
    if (e.s === sel || e.t === sel) return true;
    // A selected file owns the arrows of everything inside it.
    return state.byId.get(sel)?.kind === 'file' && (fileOf(e.s) === sel || fileOf(e.t) === sel);
}

/**
 * Edges to draw for an arrow mode. Every raw edge is attached to the visible
 * nodes standing in for its ends. In Bundled mode, everything going from one
 * file to another becomes a single arrow (drawn as an include or header ↔
 * source arrow when it contains one), except the selected node's own arrows.
 * @param {EdgeMode} mode
 */
function edgeElements(mode) {
    /** @type {Map<string, {source: string, target: string, kind: string, count: number, kinds?: Map<string, number>, status?: string | null}>} */
    const out = new Map();
    for (const e of state.data?.edges ?? []) {
        const s = representative(e.s);
        const t = representative(e.t);
        if (!s || !t || s === t) continue;
        const own = touchesSelection(e);
        if (mode === 'selected' && !own) continue;
        const fs = fileOf(s);
        const ft = fileOf(t);
        const bundle = mode === 'bundled' && !own && fs !== ft;
        const [src, tgt] = bundle ? [fs, ft] : [s, t];
        if (src === tgt) continue;
        const key = bundle ? `bundle:${src}->${tgt}` : `${e.kind}:${src}->${tgt}`;
        let agg = out.get(key);
        if (!agg) out.set(key, (agg = { source: src, target: tgt, kind: bundle ? 'bundle' : e.kind, count: 0, kinds: bundle ? new Map() : undefined, status: e.status }));
        agg.count += 1;
        agg.kinds?.set(e.kind, (agg.kinds.get(e.kind) || 0) + 1);
        // Colored as added/removed only if everything in it was.
        if (agg.status !== e.status) agg.status = null;
    }
    return [...out].map(([id, e]) => {
        // A bundle that contains the file relationship itself is drawn as that relationship.
        const kind = e.kinds?.has('includes') ? 'includes' : e.kinds?.has('pairs') ? 'pairs' : e.kind;
        // The count is what the bundle adds on top of the file relationship.
        const symbolLinks = e.kinds ? [...e.kinds].filter(([k]) => !FILE_EDGES.has(k)).reduce((sum, [, n]) => sum + n, 0) : 0;
        return {
            group: /** @type {const} */ ('edges'),
            data: {
                id,
                source: e.source,
                target: e.target,
                kind,
                bundled: !!e.kinds,
                status: e.status || undefined,
                count: e.count,
                countLabel: symbolLinks > 1 || (symbolLinks === 1 && kind === 'bundle') ? `×${symbolLinks}` : '',
                breakdown: e.kinds ? [...e.kinds].map(([k, n]) => `${n} ${k}`).join(', ') : '',
            },
        };
    });
}

const MAX_FIT_ZOOM = 1.25;

/** Fit everything in view, but don't blow small graphs up past readable size. */
function fitView() {
    cy.fit(undefined, 30);
    if (cy.zoom() > MAX_FIT_ZOOM) {
        cy.zoom(MAX_FIT_ZOOM);
        cy.center();
    }
    placeCards();
}

/**
 * Rebuild the elements and lay them out: ELK places the files, all closed,
 * then the open files and code cards open in place (see layout.js).
 */
function render(/** @type {{fit?: boolean}} */ opts = {}) {
    const run = ++state.layoutRun;
    const big = (state.data?.nodes.length ?? 0) > 300;
    const before = statusText;
    if (big) setStatus('Laying out the graph…', undefined, true);
    else setBusy(true);
    // Give the status message a frame to paint before the layout starts.
    setTimeout(async () => {
        if (run !== state.layoutRun) return; // a newer render took over
        const old = leafPositions();
        // Remove edges, then child nodes, then the rest. Removing a compound
        // together with its children in one call makes Cytoscape recompute the
        // compound's size from already-removed children and throw
        // "Cannot read properties of undefined (reading 'index')".
        cy.edges().remove();
        cy.nodes().filter((n) => n.isChild()).remove();
        cy.nodes().remove();
        pushes.clear();
        cy.add(fileElements());
        const links = cy.add(fileLinks());
        updateEmpty();
        await runLayout(cy.elements());
        if (run !== state.layoutRun) return; // a newer render took over while ELK ran
        links.remove();
        // Open files open the classes inside them that are open too.
        for (const id of state.expanded) if (state.byId.get(id)?.kind === 'file') openFile(id);
        refreshEdges();
        // Nodes glide from where they were.
        moveFrom(old);
        if (big && statusText.startsWith('Laying out')) setStatus(before, undefined, false);
        else setBusy(false);
        afterLayout(!!opts.fit);
    }, 0);
}

/** For each open box (file or class) or code card: the moves it made to make room, undone when it closes. */
const pushes = new Map();

/**
 * Turn a closed file or class into a box with what it holds, where it was,
 * making room around it. Classes inside that were open, and code cards that
 * were open, open again the way a click opens them, so closing one makes the
 * same moves in reverse.
 */
function openFile(/** @type {string} */ boxId) {
    const box = cy.$id(boxId);
    const n = state.byId.get(boxId);
    if (box.empty() || !n || box.isParent()) return;
    const at = { ...box.position() };
    const moves = growInPlace(box, () => {
        box.data('label', fileLabel(n, true));
        cy.add(childElements(boxId));
        arrangeChildren(box, innerLinks(boxId), at);
    });
    pushes.set(boxId, moves);
    box.children().forEach((k) => {
        if (state.expanded.has(k.id()) && isBox(k.id())) openFile(k.id());
        else if (cardSize(k.id())) sizeForCode(k.id());
    });
}

/** Turn an open file or class back into a single node where it was, and put back what it pushed away. */
function closeFile(/** @type {string} */ boxId) {
    const box = cy.$id(boxId);
    const n = state.byId.get(boxId);
    if (box.empty() || !n || !box.isParent()) return;
    // Open classes inside close first: a class box grows more upward (its
    // label) than downward, so the contents' middle is only right without it.
    box.children().forEach((k) => {
        if (k.isParent()) closeFile(k.id());
    });
    // The middle of the contents (the box also counts its label on top), which
    // is where the box was when it opened. Code cards grow evenly, so they
    // don't move it.
    const bb = box.children().boundingBox();
    // Code cards inside also pushed things when they opened.
    box.children().forEach((k) => {
        undoMoves(cy, pushes.get(k.id()));
        pushes.delete(k.id());
    });
    box.children().remove();
    box.data('label', fileLabel(n, false));
    box.position({ x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 });
    undoMoves(cy, pushes.get(boxId));
    pushes.delete(boxId);
}

/** Give a symbol the size of its code card, making room around it, or its normal size again. */
function sizeForCode(/** @type {string} */ id) {
    const node = cy.$id(id);
    if (node.empty()) return;
    const size = cardSize(id);
    if (size) {
        const moves = growInPlace(node, () => node.data({ cw: size.w, ch: size.h }).addClass('code-open'));
        pushes.set(id, [...(pushes.get(id) ?? []), ...moves]);
    } else {
        node.removeClass('code-open');
        undoMoves(cy, pushes.get(id));
        pushes.delete(id);
    }
}

const MOVE_MS = 250;

/** Apply a change that moves nodes, and animate them there from where they were. */
function animated(/** @type {() => void} */ change) {
    const old = leafPositions();
    change();
    moveFrom(old);
}

/** Where each moving node is headed. */
const moving = new Map();

/**
 * Where every simple node is now, after finishing any running animation.
 * (Cytoscape's stop(…, jumpToEnd) drops animations that haven't had a frame
 * yet, e.g. in a hidden tab, so the targets are applied by hand.)
 */
function leafPositions() {
    cy.nodes().stop(true, false);
    for (const [id, to] of moving) cy.$id(id).position(to);
    moving.clear();
    /** @type {Map<string, {x: number, y: number}>} */
    const old = new Map();
    cy.nodes().forEach((n) => {
        if (!n.isParent()) old.set(n.id(), { ...n.position() });
    });
    return old;
}

/**
 * Animate nodes from their `old` positions to where they are now. Symbols
 * that just appeared grow out of their file's old position; nodes that did
 * not exist before (the first graph) simply appear.
 */
function moveFrom(/** @type {Map<string, {x: number, y: number}>} */ old) {
    cy.nodes().forEach((n) => {
        if (n.isParent()) return;
        const from = old.get(n.id()) ?? old.get(n.parent().id?.() ?? '');
        if (!from) return;
        const to = { ...n.position() };
        if (from.x === to.x && from.y === to.y) return;
        n.position(from);
        moving.set(n.id(), to);
        n.animate({ position: to }, { duration: MOVE_MS, complete: () => moving.delete(n.id()) });
    });
    renderCards();
}

/** Swap in the arrows for the current mode and selection, without moving nodes. */
function refreshEdges() {
    cy.edges().remove();
    cy.add(edgeElements(state.edgeMode));
    applyHighlight();
    $('hint').classList.toggle('hidden', !(state.edgeMode === 'selected' && !state.selected && cy.nodes().nonempty()));
}

function afterLayout(/** @type {boolean} */ fit) {
    if (fit) fitView();
    if (state.focusAfterLayout) {
        const el = cy.$id(state.focusAfterLayout);
        state.focusAfterLayout = null;
        if (el.nonempty()) {
            cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300, complete: placeCards });
        }
    }
    renderCards();
}

/** Pan (and zoom out if needed) so that a node, e.g. a freshly opened code card, is fully on screen. */
function bringIntoView(/** @type {string} */ id) {
    const el = cy.$id(id);
    if (el.empty()) return;
    const bb = el.renderedBoundingBox({ includeLabels: true });
    const margin = 24;
    const w = cy.width();
    const h = cy.height();
    if (bb.x1 >= margin && bb.y1 >= margin && bb.x2 <= w - margin && bb.y2 <= h - margin) return;
    // Too big for the view at this zoom: zoom out until it fits.
    const scale = Math.min(1, (w - 2 * margin) / bb.w, (h - 2 * margin) / bb.h);
    const zoom = cy.zoom() * scale;
    cy.animate({ zoom, center: { eles: el } }, { duration: 250, complete: placeCards });
}

function updateEmpty() {
    const empty = $('empty');
    if (state.data && state.data.nodes.length === 0) {
        empty.textContent = 'No C or C++ files found in this workspace. Check the codeGraph.include and codeGraph.exclude settings.';
        empty.classList.remove('hidden');
    } else {
        empty.classList.add('hidden');
    }
}

// ---------------------------------------------------------------------------
// Code cards: HTML on top of the canvas, sized and moved with their node
// ---------------------------------------------------------------------------

const cards = $('cards');

function cardHtml(/** @type {string} */ id) {
    const n = state.byId.get(id);
    const code = state.code.get(id);
    if (!n || !code) return '';
    const head = `<div class="card-head"><span class="card-title">${esc(n.name)}</span><span class="card-where">${esc(`${code.file || n.file}:${code.line || n.line || 1}`)}</span><button class="card-btn" data-act="open" title="Open in the editor">↗</button><button class="card-btn" data-act="close" title="Close the code">✕</button></div>`;
    if (code.status === 'error') return `${head}<div class="card-body"><div class="note">${esc(code.error || 'Could not read the code.')}</div></div>`;
    const first = code.line || 1;
    const rows = (code.html || []).map((h, i) => `<div class="cl" data-line="${first + i}"><span class="ln">${first + i}</span><span class="ct">${h || ' '}</span></div>`).join('');
    const more = code.truncated ? '<div class="note">… longer than shown; ↗ opens the whole function</div>' : '';
    return `${head}<div class="card-body">${rows}${more}</div>`;
}

/** Create a card element for every open code card that has its node on screen. */
function renderCards() {
    cards.innerHTML = '';
    for (const id of state.openCode) {
        const node = cy.$id(id);
        if (node.empty() || !node.hasClass('code-open')) continue;
        const el = document.createElement('div');
        el.className = 'card';
        el.dataset.id = id;
        el.innerHTML = cardHtml(id);
        cards.appendChild(el);
    }
    placeCards();
}

/** Keep cards on top of their nodes through pan, zoom and layout. */
function placeCards() {
    const zoom = cy.zoom();
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (cards.querySelectorAll('.card'))) {
        const node = cy.$id(el.dataset.id || '');
        if (node.empty()) continue;
        const w = node.data('cw');
        const h = node.data('ch');
        const p = node.renderedPosition();
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.transform = `translate(${p.x - (w * zoom) / 2}px, ${p.y - (h * zoom) / 2}px) scale(${zoom})`;
        el.classList.toggle('faded', node.hasClass('faded'));
        el.classList.toggle('chosen', node.hasClass('chosen'));
    }
}

let placeQueued = false;
cy.on('viewport position', () => {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
        placeQueued = false;
        placeCards();
    });
});

cards.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const card = /** @type {HTMLElement | null} */ (target.closest('.card'));
    if (!card) return;
    const id = card.dataset.id || '';
    const act = /** @type {HTMLElement | null} */ (target.closest('[data-act]'))?.dataset.act;
    if (act === 'close') {
        toggleCode(id, false);
        return;
    }
    if (act === 'open') {
        openSource(id);
        return;
    }
    const line = /** @type {HTMLElement | null} */ (target.closest('[data-line]'))?.dataset.line;
    if (line) {
        const code = state.code.get(id);
        const n = state.byId.get(id);
        send({ type: 'openLocation', file: code?.file || codeRange(n)?.file || '', line: Number(line) });
        return;
    }
    select(id);
});

/** Where a node's code is: the body if it has one, otherwise its declaration. */
function codeRange(/** @type {GraphNode | undefined} */ n) {
    if (!n) return null;
    if (n.defFile) return { file: n.defFile, start: n.defLine || 1, end: n.defEndLine || n.endLine || n.defLine || 1 };
    return { file: n.file, start: n.line || 1, end: n.endLine || n.line || 1 };
}

/** Which version of the code a node is in, when comparing commits. */
function sideOf(/** @type {GraphNode | undefined} */ n) {
    return n?.status === 'removed' ? /** @type {const} */ ('base') : /** @type {const} */ ('target');
}

/** Ask the extension for a node's source (answered with a `source` message). */
function requestCode(/** @type {string} */ id) {
    const r = codeRange(state.byId.get(id));
    if (!r) return;
    const reqId = state.nextReq++;
    state.sourceReqs.set(reqId, id);
    state.code.set(id, { status: 'loading', file: r.file, line: r.start });
    send({ type: 'getSource', reqId, file: r.file, start: r.start, end: r.end, side: sideOf(state.byId.get(id)) });
}

/** Open or close a symbol's code card; loads the code first if needed. */
function toggleCode(/** @type {string} */ id, /** @type {boolean | undefined} */ open) {
    const n = state.byId.get(id);
    if (!n || n.kind === 'file') return;
    const want = open ?? !state.openCode.has(id);
    if (want) {
        state.openCode.add(id);
        if (!state.code.has(id)) {
            requestCode(id);
            setStatus(`Loading code of ${n.name}…`, undefined, true);
            persist();
            return; // opened when the code arrives
        }
    } else {
        state.openCode.delete(id);
    }
    persist();
    showCode(id);
}

/** Resize a node for its card (open or closed) in place, and keep a new card on screen. */
function showCode(/** @type {string} */ id) {
    animated(() => sizeForCode(id));
    if (state.openCode.has(id)) setTimeout(() => bringIntoView(id), MOVE_MS);
    if (id === state.selected) renderSelection();
}

/** @param {Extract<ToWebviewMessage, {type: 'source'}>} m */
function receiveCode(m) {
    const id = state.sourceReqs.get(m.reqId);
    state.sourceReqs.delete(m.reqId);
    const asked = id && state.code.get(id);
    if (!id || !asked || asked.status !== 'loading') return; // an older request, or the graph changed
    const lines = m.lines || [];
    state.code.set(id, {
        status: m.error ? 'error' : 'ready',
        file: asked.file,
        line: m.startLine || asked.line,
        lines,
        html: highlightLines(lines),
        truncated: m.truncated,
        error: m.error,
    });
    setStatus('', undefined, false);
    if (state.openCode.has(id)) showCode(id);
}

// ---------------------------------------------------------------------------
// Selection, expand/collapse, focus
// ---------------------------------------------------------------------------

/**
 * Highlight the side panel's nodes (shown by whatever stands in for them) and
 * the edges between them, with an answer's path drawn bold; or else the
 * selected node and everything connected to it. Dim the rest.
 */
function applyHighlight() {
    cy.elements().removeClass('faded hl chosen onpath');
    if (state.highlighted.size) {
        const reps = new Set([...state.highlighted].map(representative));
        const marked = cy.nodes().filter((n) => reps.has(n.id()));
        const keep = marked.union(marked.ancestors()).union(marked.edgesWith(marked));
        cy.elements().not(keep).addClass('faded');
        keep.edges().addClass('hl');
        marked.addClass('chosen');
        // Each step of the path, between whatever stands in for its two ends.
        for (let i = 0; i + 1 < state.path.length; i++) {
            const a = representative(state.path[i]);
            const b = representative(state.path[i + 1]);
            if (a && b && a !== b) cy.$id(a).edgesTo(cy.$id(b)).removeClass('faded').addClass('onpath');
        }
        if (state.selected) cy.$id(state.selected).addClass('chosen');
    } else {
        const el = state.selected ? cy.$id(state.selected) : cy.collection();
        if (el.nonempty()) {
            // A selected (expanded) file also brings in everything connected to its symbols.
            const core = el.union(el.descendants());
            let keep = core.closedNeighborhood();
            keep = keep.union(keep.ancestors());
            cy.elements().not(keep).addClass('faded');
            keep.edges().addClass('hl');
            el.addClass('chosen');
        }
    }
    placeCards();
}

function select(/** @type {string | null} */ id) {
    const changed = state.selected !== id;
    state.selected = id;
    if (id === null) clearPanelHighlight();
    persist();
    renderSelection();
    // The selection's own arrows are drawn exactly in every mode.
    if (changed) refreshEdges();
    else applyHighlight();
}

/** Open or close a file or class box. */
function toggle(/** @type {string} */ boxId) {
    if (!isBox(boxId)) return;
    const open = !state.expanded.has(boxId);
    if (open) state.expanded.add(boxId);
    else state.expanded.delete(boxId);
    // Closing hides the selected symbol; select the box that now stands for it.
    if (state.selected && !isVisible(/** @type {GraphNode} */ (state.byId.get(state.selected)))) state.selected = representative(state.selected);
    persist();
    animated(() => (open ? openFile(boxId) : closeFile(boxId)));
    refreshEdges();
    renderSelection();
}

/** The boxes around a node, outermost (its file) first. */
function boxesAround(/** @type {string} */ id) {
    const out = [];
    for (let p = state.byId.get(id)?.parent; p !== undefined; p = state.byId.get(p)?.parent) out.unshift(p);
    return out;
}

/** Open the boxes around an answer's nodes and highlight them, with its path drawn bold. */
function highlightNodes(/** @type {string[]} */ ids, /** @type {string[]} */ path = []) {
    state.highlighted = new Set([...ids, ...path].filter((id) => state.byId.has(id)));
    state.path = path.filter((id) => state.byId.has(id));
    for (const id of state.highlighted) for (const box of boxesAround(id)) state.expanded.add(box);
    state.selected = null;
    persist();
    renderSelection();
    render({ fit: true });
}

function focusNode(/** @type {string} */ id) {
    const n = state.byId.get(id);
    if (!n) return;
    state.selected = id;
    renderSelection();
    const boxes = boxesAround(id);
    if (cy.$id(fileOf(id)).empty()) {
        // Nothing drawn yet: open the boxes with the next full layout.
        for (const box of boxes) state.expanded.add(box);
        state.focusAfterLayout = id;
        persist();
        render();
        return;
    }
    const closed = boxes.filter((box) => !state.expanded.has(box));
    if (closed.length) {
        for (const box of closed) state.expanded.add(box);
        // Outermost first: opening a file opens the open classes inside it.
        animated(() => closed.forEach((box) => openFile(box)));
    }
    persist();
    refreshEdges();
    setTimeout(() => {
        const el = cy.$id(id);
        if (el.nonempty()) cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300, complete: placeCards });
    }, MOVE_MS);
}

function openSource(/** @type {string} */ id) {
    const n = state.byId.get(id);
    if (!n) return;
    // Comparing commits: a changed file opens as a diff of the two versions.
    if (state.mode === 'diff' && n.kind === 'file' && n.status === 'modified') {
        send({ type: 'openDiff', file: n.file });
        return;
    }
    const r = codeRange(n);
    if (r) send({ type: 'openLocation', file: r.file, line: r.start });
}

/**
 * Ctrl+click: fold an open file or class all the way back into one node,
 * closing the boxes and code cards inside it too (so opening it again starts
 * compact), or close a code card.
 */
function compact(/** @type {string} */ id) {
    if (isBox(id) && state.expanded.has(id)) {
        for (const n of state.data?.nodes ?? []) {
            if (!boxesAround(n.id).includes(id)) continue;
            state.expanded.delete(n.id);
            state.openCode.delete(n.id);
        }
        toggle(id);
    } else if (state.openCode.has(id)) toggleCode(id, false);
}

// One click on a file or class opens or closes it; one click on a symbol
// opens or closes its code. Neither happens when the click turns into a double click,
// which opens the source in the editor instead.
let tapTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);

cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    select(id);
    switchTab('details', true);
    clearTimeout(tapTimer);
    const click = /** @type {MouseEvent | undefined} */ (evt.originalEvent);
    if (click?.ctrlKey || click?.metaKey) {
        compact(id);
        return;
    }
    tapTimer = setTimeout(() => {
        if (isBox(id)) toggle(id);
        else toggleCode(id);
    }, 280);
});
cy.on('dbltap', 'node', (evt) => {
    clearTimeout(tapTimer);
    openSource(evt.target.id());
});
cy.on('tap', (evt) => {
    if (evt.target === cy) select(null);
});

// ---------------------------------------------------------------------------
// Hover tooltip
// ---------------------------------------------------------------------------

const tooltip = $('tooltip');

const STATUS_LABEL = { added: 'Added in the newer version', removed: 'Removed in the newer version', modified: 'Changed in the newer version' };

function nodeTooltip(/** @type {GraphNode} */ n) {
    const where = n.line ? `${n.file}:${n.line}` : n.file;
    const status = n.status ? `<div class="muted">${esc(STATUS_LABEL[n.status])}</div>` : '';
    const summary = S.summaries.get(n.id);
    const about = summary?.status === 'ready' && summary.summary ? `<div>${esc(summary.summary.purpose)}</div>` : '';
    const degree = state.degree.get(n.id) || 0;
    const plural = (/** @type {string} */ word) => `${degree} ${word}${degree === 1 ? '' : 's'}`;
    const linked = `<div class="muted">Connected to ${plural(n.kind === 'file' ? 'other file' : 'node')}</div>`;
    if (n.kind === 'file') {
        const kids = state.childCount.get(n.id) || 0;
        const role = n.header ? 'Header file: declares what other files can use' : 'Source file: contains the code';
        const open = state.mode === 'diff' && n.status === 'modified' ? 'double-click to see the diff' : 'double-click to open the file';
        const hint = kids ? (state.expanded.has(n.id) ? 'Click to close' : `Click to show its ${kids} functions and types`) : '';
        return `<b>${esc(n.file)}</b><div class="muted">${esc(role)}</div>${linked}${status}${about}${hint ? `<div class="hint">${esc(hint)} · ${open}</div>` : ''}`;
    }
    const kind = KIND_LABEL[n.kind] || n.kind;
    const method = n.kind === 'method';
    const extra = [
        n.isStatic ? (method ? 'static method' : 'static: only visible inside this file') : '',
        n.isPure ? 'pure virtual: derived classes implement it' : n.isVirtual ? 'virtual' : '',
        n.isOverride ? 'overrides a base-class method' : '',
        n.access && n.access !== 'public' ? n.access : '',
        n.declFile ? `declared in ${n.declFile}:${n.declLine}` : '',
        method && n.defFile && n.defFile !== n.file ? `defined in ${n.defFile}:${n.defLine}` : '',
        (n.kind === 'function' || method) && !n.defFile && !n.isPure ? 'declared only: defined outside the workspace' : '',
    ].filter(Boolean);
    const members = state.childCount.get(n.id) || 0;
    const hint = members
        ? state.expanded.has(n.id)
            ? 'Click to close'
            : `Click to show its ${members} members`
        : state.openCode.has(n.id)
          ? 'Click to hide the code'
          : 'Click to show the code';
    const shown = n.qname && n.qname !== n.name ? n.qname : n.name;
    return `<b>${esc(shown)}</b> <span class="muted">${esc(kind)}</span>${n.signature ? `<div class="mono">${esc(n.signature)}</div>` : ''}${extra.map((x) => `<div class="muted">${esc(x)}</div>`).join('')}<div class="muted">${esc(where)}</div>${linked}${status}${about}<div class="hint">${hint} · double-click to open in the editor</div>`;
}

function edgeTooltip(/** @type {cytoscape.EdgeSingular} */ edge) {
    const kind = edge.data('kind');
    const info = EDGE_INFO[kind] || { label: kind, desc: '' };
    const s = state.byId.get(edge.data('source'));
    const t = state.byId.get(edge.data('target'));
    if (edge.data('bundled')) {
        return `<b>${esc(s?.name)}</b> → <b>${esc(t?.name)}</b><div class="muted">${esc(edge.data('breakdown'))}</div><div class="hint">Select either file to see the exact arrows</div>`;
    }
    const count = edge.data('count') > 1 ? ` (${edge.data('count')} combined)` : '';
    const status = edge.data('status') ? `<div class="muted">${esc(edge.data('status') === 'added' ? 'Added' : 'Removed')} in the newer version</div>` : '';
    return `<b>${esc(s?.name)}</b> ${esc(info.label)} <b>${esc(t?.name)}</b>${esc(count)}<div class="muted">${esc(info.desc)}</div>${status}`;
}

cy.on('mouseover', 'node, edge', (evt) => {
    const el = evt.target;
    const html = el.isNode() ? nodeTooltip(/** @type {GraphNode} */ (state.byId.get(el.id()))) : edgeTooltip(el);
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    const p = evt.renderedPosition || el.renderedMidpoint?.() || { x: 0, y: 0 };
    const box = $('cy').getBoundingClientRect();
    const x = Math.min(p.x + 14, box.width - tooltip.offsetWidth - 8);
    const y = p.y + 14 + tooltip.offsetHeight > box.height ? p.y - tooltip.offsetHeight - 10 : p.y + 14;
    tooltip.style.left = `${Math.max(4, x)}px`;
    tooltip.style.top = `${Math.max(4, y)}px`;
});
cy.on('mouseout', 'node, edge', () => tooltip.classList.add('hidden'));
cy.on('viewport', () => tooltip.classList.add('hidden'));

// ---------------------------------------------------------------------------
// Legend, toolbar, status
// ---------------------------------------------------------------------------

function renderLegend() {
    const c = colors();
    const present = new Set((state.data?.edges ?? []).map((e) => e.kind));
    const edgeRows = LEGEND_EDGES.filter((kind) => !OPTIONAL_EDGES.has(kind) || present.has(kind)).map((kind) => {
        const info = EDGE_INFO[kind];
        const color = c.edge[kind];
        const arrow = info.arrow ? `<path d="M26,1 L33,5 L26,9 z" fill="${esc(color)}"/>` : '';
        const width = kind === 'bundle' ? 4 : 2;
        return `<div class="row" title="${esc(info.desc)}"><svg width="34" height="10"><line x1="1" y1="5" x2="${info.arrow ? 27 : 33}" y2="5" stroke="${esc(color)}" stroke-width="${width}" stroke-dasharray="${info.dash}"/>${arrow}</svg>${esc(info.legend)}</div>`;
    }).join('');
    const swatch = (/** @type {string} */ cls, /** @type {string} */ label) => `<span class="swatch ${cls}">${esc(label)}</span>`;
    const nodes = [
        swatch('header', '.h header'),
        swatch('source', '.c source'),
        swatch('fn', 'function'),
        swatch('fn proto', 'declared only'),
        swatch('type', 'struct'),
        swatch('enum', 'enum'),
        swatch('typedef', 'typedef'),
        ...((state.data?.nodes ?? []).some((n) => n.kind === 'class') ? [swatch('type cls', 'class')] : []),
        ...(state.mode === 'diff' ? [swatch('added', 'added'), swatch('modified', 'changed'), swatch('removed', 'removed')] : []),
    ].join('');
    const legend = $('legend');
    const open = !legend.classList.contains('collapsed');
    legend.innerHTML = `<div class="head" id="legendHead">Legend ${open ? '▾' : '▸'}</div><div class="body">${edgeRows}<div class="swatches">${nodes}</div><div class="hint">Arrows point left → right. Click a file or class to open it, a function to see its code · double-click to jump to the editor</div></div>`;
    $('legendHead').onclick = () => {
        legend.classList.toggle('collapsed');
        renderLegend();
    };
}

function renderEdgeModes() {
    const seg = $('edgeMode');
    seg.innerHTML =
        '<span class="seglabel">Arrows</span>' +
        Object.entries(EDGE_MODES)
            .map(([k, m]) => `<button data-mode="${k}" class="${k === state.edgeMode ? 'on' : ''}" title="${esc(m.desc)}" aria-pressed="${k === state.edgeMode}">${esc(m.label)}</button>`)
            .join('');
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (seg.querySelectorAll('button'))) {
        b.onclick = () => {
            state.edgeMode = /** @type {EdgeMode} */ (b.dataset.mode);
            persist();
            renderEdgeModes();
            refreshEdges();
        };
    }
}

let busy = false;
let statusText = '';
let statusLevel = /** @type {string | undefined} */ (undefined);
function setStatus(/** @type {string} */ text, /** @type {string | undefined} */ level, /** @type {boolean | undefined} */ isBusy) {
    statusText = text;
    statusLevel = level;
    if (isBusy !== undefined) busy = isBusy;
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', level === 'error');
    $('spinner').classList.toggle('hidden', !busy);
}
function setBusy(/** @type {boolean} */ isBusy) {
    setStatus(statusText, statusLevel, isBusy);
}

$('fit').onclick = fitView;
$('expandAll').onclick = () => {
    state.expanded = new Set([...state.childCount.keys()]);
    persist();
    renderSelection();
    render({ fit: true });
};
$('collapseAll').onclick = () => {
    state.expanded.clear();
    state.openCode.clear();
    const sel = state.selected && state.byId.get(state.selected);
    if (sel && sel.kind !== 'file') state.selected = fileOf(sel.id);
    persist();
    renderSelection();
    render({ fit: true });
};
$('refresh').onclick = () => send({ type: 'refresh' });
$('compare').onclick = () => send({ type: 'compare' });
$('exitCompare').onclick = () => send({ type: 'exitCompare' });
document.addEventListener('keydown', (ev) => {
    // Escape closes the code cards first, then clears the side panel's highlight.
    if (ev.key !== 'Escape') return;
    if (state.openCode.size) {
        const ids = [...state.openCode];
        state.openCode.clear();
        persist();
        animated(() => ids.forEach(sizeForCode));
    } else clearPanelHighlight();
});

// ---------------------------------------------------------------------------
// Side panel: the previous webview's Details tab (with its impact view) and
// Ask AI tab, from media/webview/panels, connected through panel-bridge.js
// ---------------------------------------------------------------------------

/** Show or hide the side panel. */
function setSide(/** @type {boolean} */ open) {
    state.side.open = open;
    $('side').classList.toggle('hidden', !open);
    $('sideToggle').classList.toggle('on', open);
    persist();
    cy.resize();
    placeCards();
    if (open) renderDetails();
}

/** Show a tab of the side panel (opening it); the impact view belongs to the Details tab. */
function showTab(/** @type {string} */ tab) {
    if (!state.side.open) setSide(true);
    const button = tab === 'impact' ? 'details' : tab;
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tabs [data-tab]'))) b.classList.toggle('active', b.dataset.tab === button);
    for (const t of ['details', 'ai', 'impact']) $(`tab-${t}`).classList.toggle('hidden', t !== tab);
}

/** The Details tab follows the selection. */
function renderSelection() {
    renderDetails();
}

/** Mark a highlight from the panel (an answer, a trace, a concept, an impact) on the graph as it is, or clear it. */
function showHighlight(/** @type {{ids: Set<string>, path: string[]} | null} */ h) {
    state.highlighted = new Set(h ? [...h.ids].filter((id) => state.byId.has(id)) : []);
    state.path = h ? h.path.filter((id) => state.byId.has(id)) : [];
    refreshEdges();
}

/** Open the boxes around a highlight's nodes and lay the graph out again to show it. */
function revealHighlight(/** @type {string[]} */ ids, /** @type {string[]} */ path) {
    state.highlighted = new Set([...ids, ...path].filter((id) => state.byId.has(id)));
    state.path = path.filter((id) => state.byId.has(id));
    for (const id of state.highlighted) for (const box of boxesAround(id)) state.expanded.add(box);
    persist();
    render({ fit: true });
}

/** Clear the panel's highlight, e.g. when the background is clicked. */
function clearPanelHighlight() {
    if (S.highlight || state.highlighted.size) setHighlight(null);
}

connect({
    state,
    persist,
    focusNode,
    toggle,
    // A class shows either its members or its code, not both.
    toggleCode: (id) => {
        if (state.expanded.has(id)) toggle(id);
        toggleCode(id);
    },
    center: (id) => {
        const r = representative(id);
        const el = r ? cy.$id(r) : cy.collection();
        if (el.nonempty()) cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300, complete: placeCards });
    },
    showHighlight,
    revealHighlight,
    showTab,
});

$('sideToggle').onclick = () => setSide(!state.side.open);
$('sideClose').onclick = () => setSide(false);
for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tabs [data-tab]'))) b.onclick = () => switchTab(b.dataset.tab || 'details');
$('question').addEventListener('input', () =>
    $('suggestions').classList.toggle('hidden', !!(/** @type {HTMLTextAreaElement} */ ($('question')).value.trim() || S.ai.question)),
);
$('question').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ask();
    }
});
document.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    if (S.historyOpen && target.isConnected && !target.closest('#history, #historyBtn')) {
        S.historyOpen = false;
        renderHistory();
    }
});

// ---------------------------------------------------------------------------
// Messages from the extension
// ---------------------------------------------------------------------------

/** Longest folder prefix shared by all paths, e.g. `test-fixtures/c-demo`. */
function commonFolder(/** @type {string[]} */ paths) {
    if (!paths.length) return '';
    let parts = paths[0].split('/').slice(0, -1);
    for (const p of paths) {
        const other = p.split('/');
        let i = 0;
        while (i < parts.length && parts[i] === other[i]) i++;
        parts = parts.slice(0, i);
    }
    return parts.join('/');
}

// The extension's graph (src/types.ts) names things differently from this webview.
const EDGE_KIND = { include: 'includes', pair: 'pairs', call: 'calls', 'type-use': 'uses' };
const DIFF_STATUS = { added: 'added', removed: 'removed', changed: 'modified' };

/** Converts the extension's GraphData to the shape this webview reads. */
function adaptGraph(/** @type {any} */ data) {
    const nodes = data.nodes
        .filter((/** @type {any} */ n) => n.kind !== 'dir') // folders aren't drawn; files are the top level
        .map((/** @type {any} */ n) => {
            const out = { ...n, name: n.name ?? n.label, status: n.status ?? DIFF_STATUS[n.diff] };
            if (n.kind === 'file') {
                out.header = n.header ?? n.fileRole === 'header';
                delete out.parent;
            } else if (n.kind === 'prototype') {
                out.kind = 'function'; // a declaration with no body in the workspace (drawn dashed)
            } else if (n.kind === 'function' && !n.defFile) {
                Object.assign(out, { defFile: n.file, defLine: n.line, defEndLine: n.endLine });
            }
            return out;
        });
    const edges = data.edges
        .filter((/** @type {any} */ e) => e.kind !== 'proto-def')
        .map((/** @type {any} */ e) => ({
            ...e,
            s: e.s ?? e.source,
            t: e.t ?? e.target,
            kind: EDGE_KIND[e.kind] ?? e.kind,
            status: e.status ?? DIFF_STATUS[e.diff],
        }));
    return { ...data, nodes, edges };
}

/** @param {Extract<ToWebviewMessage, {type: 'graph'}>} m */
function loadGraph(m) {
    const data = adaptGraph(m.data);
    const mode = m.mode || 'workspace';
    const modeChanged = state.mode !== mode;
    state.mode = mode;
    state.compare = mode === 'diff' ? m.compare ?? state.compare : null;
    state.data = data;
    state.byId = new Map(data.nodes.map((n) => [n.id, n]));
    state.childCount = new Map();
    state.descCount = new Map();
    for (const n of data.nodes) {
        if (n.kind === 'file' || !n.parent) continue;
        state.childCount.set(n.parent, (state.childCount.get(n.parent) || 0) + 1);
        for (const box of boxesAround(n.id)) state.descCount.set(box, (state.descCount.get(box) || 0) + 1);
    }
    state.degree = connections(data);
    // The side panel reads the graph as the extension sent it.
    setGraph(m.data, m.title);
    if (S.impact) setTimeout(() => S.impact && requestImpact(true), 0);
    for (const id of [...state.expanded]) if (!state.byId.has(id)) state.expanded.delete(id);
    if (state.selected && !state.byId.has(state.selected)) state.selected = null;
    for (const id of [...state.highlighted]) if (!state.byId.has(id)) state.highlighted.delete(id);
    state.path = state.path.filter((id) => state.byId.has(id));
    // Code may have changed: drop cached snippets and reload the open cards.
    state.code.clear();
    state.sourceReqs.clear();
    for (const id of [...state.openCode]) {
        if (!state.byId.has(id)) state.openCode.delete(id);
        else requestCode(id);
    }
    // Without a title (the browser harness), show the folder all files share.
    const files = data.nodes.filter((n) => n.kind === 'file').map((n) => n.file);
    const title = m.title || data.title || commonFolder(files);
    $('title').textContent = title ? `Code Graph · ${title}` : 'Code Graph';
    $('title').title = `${files.length} files`;
    renderCompare();
    renderLegend();
    renderSelection();
    renderSuggestions();
    setStatus('');
    // Fit on the first graph and when switching to or from a comparison; refreshes keep the view.
    render({ fit: state.firstGraph || modeChanged });
    state.firstGraph = false;
}

/** Toolbar in compare mode: the two versions and how much changed. */
function renderCompare() {
    const diff = state.mode === 'diff';
    $('compare').classList.add('hidden'); // the extension has no compare command any more
    $('exitCompare').classList.toggle('hidden', !diff);
    const info = $('compareInfo');
    info.classList.toggle('hidden', !diff);
    if (!diff) return;
    const count = (/** @type {string} */ status) => (state.data?.nodes ?? []).filter((n) => n.status === status).length;
    const labels = state.compare ? `${esc(state.compare.baseLabel)} → ${esc(state.compare.targetLabel)}: ` : '';
    info.innerHTML = `${labels}<span class="added">+${count('added')}</span> <span class="modified">~${count('modified')}</span> <span class="removed">−${count('removed')}</span>`;
    info.title = 'Added, changed and removed files and symbols. Double-click a changed file to see its diff.';
}

window.addEventListener('message', (event) => {
    /** @type {ToWebviewMessage} */
    const m = event.data;
    switch (m.type) {
        case 'graph':
            loadGraph(m);
            break;
        case 'focus':
            focusNode(m.nodeId);
            switchTab('details', true);
            break;
        case 'loading':
            setStatus(m.message, undefined, true);
            break;
        case 'error':
            setStatus(m.message, 'error', false);
            break;
        case 'source':
            receiveCode(m);
            break;
        case 'aiStart':
            // Keep the mode when this confirms a question asked from the panel; questions from the command palette use Ask.
            S.ai = { busy: true, question: m.question, answer: '', model: null, steps: [], mode: S.ai.busy && S.ai.question === m.question ? S.ai.mode : 'ask' };
            /** @type {HTMLTextAreaElement} */ ($('question')).value = m.question;
            switchTab('ai');
            renderAnswer();
            break;
        case 'aiPartial':
            S.ai.answer = m.text;
            renderAnswer();
            break;
        case 'aiStep':
            S.ai.steps.push(m.step);
            renderAnswer();
            setVisited(/** @type {any} */ (m.step).nodeIds);
            break;
        case 'aiResult':
            S.ai = {
                busy: false,
                question: S.ai.question,
                mode: S.ai.mode,
                steps: S.ai.steps || [],
                open: S.ai.open === 'how' ? 'how' : undefined,
                error: !!m.error,
                answer: m.answer,
                highlight: m.highlight,
                path: m.path,
                hops: m.hops,
                routes: m.routes,
                routeIdx: 0,
                evidence: m.evidence,
                confidence: m.confidence,
                confidenceReason: m.confidenceReason,
                model: m.model,
                entryId: m.entryId,
                time: m.time,
            };
            S.visited = null;
            if (!m.error && !m.cancelled) /** @type {HTMLTextAreaElement} */ ($('question')).value = '';
            renderAnswer();
            // Files start closed here, so the answer's nodes are opened up to be seen.
            if (m.highlight?.length) applyAiHighlight(true);
            else renderer.refreshStyle();
            break;
        case 'aiHistory':
            S.history = m.entries || [];
            renderHistory();
            break;
        case 'summary':
            onSummary(m);
            break;
        case 'impactResult':
            onImpact(m);
            break;
        case 'semanticBuilding':
            S.semanticBusy = !!m.busy;
            if (!state.selected) renderDetails();
            break;
    }
});

// Used by test/harness.html to inspect the graph.
Object.assign(window, { __codeGraph: { cy, state, S, focusNode, toggle, toggleCode, select, highlightNodes, finishMoves: leafPositions } });

renderLegend();
renderEdgeModes();
renderAnswer();
setSide(state.side.open);
setStatus('Loading…', undefined, true);
send({ type: 'ready' });