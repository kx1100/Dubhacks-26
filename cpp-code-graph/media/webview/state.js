// The webview state (S), the VS Code API handle and saving the state between sessions.

import { EDGE_MODES, AI_MODES, PRESETS } from './constants.js';

export const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };

export const saved = vscode.getState() || {};
export const S = {
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
  preset: PRESETS[saved.preset] || saved.preset === 'custom' ? saved.preset : 'structure', // which view preset is active
  edgeMode: EDGE_MODES.includes(saved.edgeMode) ? saved.edgeMode : 'selected', // which arrows are drawn
  direction: saved.direction === 'LR' ? 'LR' : 'TB', // layout direction
  view: saved.view || null, // {x, y, k}
  highlight: null, // {ids:Set, path:[], label}
  search: { q: '', matches: [], index: -1 },
  tab: 'details',
  ai: { busy: false, question: '', answer: '', model: null, steps: [] },
  aiMode: AI_MODES[saved.aiMode] ? saved.aiMode : 'ask',
  visited: null, // Set of node ids the AI investigation is looking at (current or hovered step)
  history: [], // saved AI answers for this workspace, newest first (kept by the extension)
  summaries: new Map(), // node id -> {status: loading|ready|error|unavailable|disabled, summary, model, cached}
  impact: null, // {target, changeType, busy, result} for the Impact tab
  concepts: {}, // node id -> concept tags from the AI layer
  semantic: null, // {model, time, edges, concepts, tagged} when the AI layer is built
  semanticBusy: false,
  historyOpen: false, // the history popover in the Ask AI tab  contextOff: null, // node id the user left out of the question's context (reset by selecting another)
  layout: null, // the SVG renderer's boxes: {vis, abs, width, height}
  vis: null, // the visible graph from computeVisible(): {visible, visibleSet, rep, repOf, edges, bundles}
  savedMode: saved.mode || null
};

export function persist() {
  vscode.setState({
    expanded: [...S.expanded],
    codeOpen: [...S.codeOpen],
    selected: S.selected,
    edgeOn: S.edgeOn,
    showFields: S.showFields,
    showNamespaces: S.showNamespaces,
    showUncertain: S.showUncertain,
    focusMode: S.focusMode,
    preset: S.preset,
    edgeMode: S.edgeMode,
    direction: S.direction,
    view: S.view,
    mode: S.mode,
    aiMode: S.aiMode
  });
}
