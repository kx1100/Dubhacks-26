// media/panel-bridge.js
// Runs the previous webview's side panel (media/webview/panels/*.js: Details,
// the impact view and Ask AI) inside this webview. scripts/build-webview.js
// points the panels' imports of shell.js, state.js, renderer.js and main.js
// here. The panels keep their own state in S, on the extension's graph as it
// arrives (src/types.ts); whatever they ask of the graph is passed on to
// media/main.js, which registers itself with connect().

import { AI_MODES } from './webview/constants.js';
import { push } from './webview/util.js';
import { rebuildTree, nearestInTree } from './webview/model.js';
import { renderImpact, syncImpactToggle } from './webview/panels/impact.js';
import { syncAiToggle } from './webview/panels/ask.js';

// eslint-disable-next-line no-undef
export const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};

export const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

/**
 * What media/main.js does for the panels.
 * @type {{
 *   state: any,
 *   persist: () => void,
 *   focusNode: (id: string) => void,
 *   toggle: (id: string) => void,
 *   toggleCode: (id: string) => void,
 *   center: (id: string) => void,
 *   showHighlight: (h: {ids: Set<string>, path: string[]} | null) => void,
 *   revealHighlight: (ids: string[], path: string[]) => void,
 *   showTab: (tab: string) => void,
 * }}
 */
let ui;

export function connect(/** @type {typeof ui} */ api) {
    ui = api;
}

/** The panels' state (see the previous media/webview/state.js). Selection, open boxes and code cards are the graph's. */
export const S = {
    mode: 'workspace',
    title: '',
    graph: /** @type {any} */ (null),
    nodes: new Map(),
    children: new Map(),
    roots: /** @type {string[]} */ ([]),
    parentOf: new Map(),
    out: new Map(),
    inc: new Map(),
    code: new Map(),
    selectedEdge: null,
    vis: null,
    showFields: true,
    showNamespaces: true,
    showUncertain: true,
    /** @type {any} {ids: Set, path: [], label, source?: 'ai' | 'impact', ...} */
    highlight: null,
    tab: 'details',
    /** @type {any} */
    ai: { busy: false, question: '', answer: '', model: null, steps: [] },
    aiMode: AI_MODES[saved.aiMode] ? saved.aiMode : 'ask',
    /** @type {Set<string> | null} nodes an investigation step looked at (hovered in the step list) */
    visited: null,
    /** @type {any[]} */
    history: [],
    summaries: new Map(),
    /** @type {any} */
    impact: null,
    /** @type {Record<string, string[]>} */
    concepts: {},
    /** @type {any} */
    semantic: null,
    semanticBusy: false,
    historyOpen: false,
    /** @type {string | null} */
    contextOff: null,
    get selected() {
        return ui.state.selected;
    },
    set selected(id) {
        ui.state.selected = id;
    },
    get expanded() {
        return ui.state.expanded;
    },
    get codeOpen() {
        return ui.state.openCode;
    },
};

export function persist() {
    ui.persist();
}

/** Takes the extension's graph (before media/main.js adapts it). */
export function setGraph(/** @type {any} */ graph, /** @type {string | undefined} */ title) {
    // The AI layer's inferred links are not listed; only its concept tags are.
    graph = { ...graph, edges: graph.edges.filter((/** @type {any} */ e) => e.kind !== 'semantic') };
    S.graph = graph;
    S.title = title || '';
    S.nodes = new Map(graph.nodes.map((/** @type {any} */ n) => [n.id, n]));
    S.concepts = graph.concepts || {};
    S.semantic = graph.semantic || null;
    S.out = new Map();
    S.inc = new Map();
    for (const e of graph.edges) {
        push(S.out, e.source, e);
        push(S.inc, e.target, e);
    }
    rebuildTree();
    // The code may have changed: check again (the extension answers from its cache when it hasn't).
    for (const e of S.summaries.values()) e.stale = true;
}

// ---------------------------------------------------------------------------
// renderer.js

export const renderer = {
    /** Show the highlight (or the hovered investigation step) on the graph. */
    refreshStyle() {
        ui.showHighlight(S.visited ? { ids: S.visited, path: [] } : S.highlight);
        syncToggles();
    },
    centerOn(/** @type {string} */ id) {
        ui.center(id);
    },
};

/** The "show on graph" toggles of the answer and the impact view follow the highlight (the old renderer did this after drawing). */
function syncToggles() {
    syncAiToggle();
    syncImpactToggle();
}

// ---------------------------------------------------------------------------
// main.js

export function toggle(/** @type {string} */ id) {
    ui.toggle(id);
}

export function toggleCode(/** @type {string} */ id) {
    ui.toggleCode(id);
}

/** Go to a node: open the boxes around it, select it and center on it. */
export function reveal(/** @type {string} */ id) {
    const target = nearestInTree(id) || id;
    ui.focusNode(target);
    switchTab('details', true);
}

export function openSource(/** @type {string} */ id, /** @type {string | undefined} */ which) {
    const n = S.nodes.get(id);
    if (!n || !n.file) return;
    const useDef = which !== 'decl' && n.defFile;
    // Free functions keep their definition as the node and remember where the prototype is.
    const useProto = which === 'decl' && n.declFile;
    const file = useProto ? n.declFile : useDef ? n.defFile : n.file;
    const line = useProto ? n.declLine : useDef ? n.defLine : n.line;
    vscode.postMessage({ type: 'openLocation', file, line: line || 1 });
}

/** Highlight everything reachable through calls: what a function calls ('out') or what leads to it ('in'). */
export function trace(/** @type {string} */ id, /** @type {'out' | 'in'} */ direction) {
    const seen = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
        const next = [];
        for (const u of frontier) {
            for (const e of (direction === 'out' ? S.out.get(u) : S.inc.get(u)) || []) {
                if (e.kind !== 'call' && e.kind !== 'overrides') continue;
                const v = direction === 'out' ? e.target : e.source;
                if (!seen.has(v)) {
                    seen.add(v);
                    next.push(v);
                }
            }
        }
        frontier = next;
    }
    const n = S.nodes.get(id);
    S.highlight = { ids: seen, path: [], label: `${direction === 'out' ? 'Everything called from ' : 'Everything that calls '}${n.label} (${seen.size - 1})` };
    revealAll(seen);
}

export function setHighlight(/** @type {any} */ h) {
    S.highlight = h && h.ids.size ? h : null;
    renderer.refreshStyle();
}

/** Open the boxes around these nodes and show the highlight (set by the caller). */
export function revealAll(/** @type {Iterable<string>} */ ids) {
    ui.revealHighlight([...ids], S.highlight?.path || []);
    syncToggles();
}

/** Show a tab; 'impact' is a view of the Details tab. `quiet` leaves the Ask AI tab alone while it works. */
export function switchTab(/** @type {string} */ tab, /** @type {boolean | undefined} */ quiet) {
    if (quiet && S.tab === 'ai' && S.ai.busy) return;
    S.tab = tab;
    ui.showTab(tab);
    if (tab === 'impact') renderImpact();
}
