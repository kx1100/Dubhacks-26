// Fixed tables shared by the webview: node and edge kinds, presets, modes, labels.

export const KIND_INFO = {
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
export const EDGE_KINDS = [
  { kind: 'calls', label: 'Calls', desc: 'function → function it calls' },
  { kind: 'inherits', label: 'Inherits', desc: 'derived class → base class' },
  { kind: 'overrides', label: 'Overrides', desc: 'method → base method it overrides' },
  { kind: 'includes', label: 'Includes', desc: 'file → included file' },
  { kind: 'uses', label: 'Uses type', desc: 'code → class/enum it depends on' },
  { kind: 'pairs', label: 'Header ↔ source', desc: 'file that declares something → file that implements it (list.h → list.c)' },
  { kind: 'semantic', label: 'AI-inferred', desc: 'links the AI found by reading the code: alternative implementations, replacements, validators (build the AI layer first)' }
];
export const REL_LABELS = {
  calls: ['Calls', 'Called by'],
  inherits: ['Inherits from', 'Derived classes'],
  overrides: ['Overrides', 'Overridden by'],
  includes: ['Includes', 'Included by'],
  uses: ['Uses types', 'Used by'],
  pairs: ['Implemented in', 'Declares things implemented here'],
  semantic: ['AI-inferred links', 'AI-inferred links to it']
};
export const EDGE_VERBS = { calls: 'calls', inherits: 'inherits from', overrides: 'overrides', includes: 'includes', uses: 'uses type', pairs: 'is implemented in', semantic: 'is linked by the AI to' };
/** The verb for an edge: an AI-inferred one says what kind of link it is. */
export const edgeVerb = e => (e.kind === 'semantic' && e.raw && e.raw[0] && e.raw[0].label) || EDGE_VERBS[e.kind];

// Kinds whose source can be opened inside the node.
export const CODE_KINDS = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'variable', 'field']);

// Which arrows are drawn: only those touching the selection, edges bundled
// between containers (plus the selection's own), or every edge.
export const EDGE_MODES = ['selected', 'bundled', 'all'];
export const EDGE_MODE_INFO = {
  selected: 'Only the arrows connected to the selected node',
  bundled: 'One arrow per pair of containers, plus the selected node\'s own arrows',
  all: 'Every arrow'
};
// Ask AI modes: each changes how the model investigates (see src/ai/agent.js).
export const AI_MODES = {
  ask: { label: 'Ask', desc: 'A direct answer that looks up only what it needs', placeholder: 'Ask about the code…' },
  path: { label: 'Trace', desc: 'Trace: reconstruct the execution path in call order, from main or the selected node', placeholder: 'What to trace, e.g. “What happens when the program starts?”' }
};
// Kinds of execution-path steps (see agent.js), most notable first.
export const ROUTE_KINDS = {
  error: { glyph: '⚠', label: 'error handling' },
  branch: { glyph: '⑂', label: 'branch: only under a condition' },
  callback: { glyph: '↺', label: 'callback or virtual dispatch' },
  return: { glyph: '↩', label: 'returns to the caller' },
  call: { glyph: '→', label: 'call' }
};
export const ROUTE_KIND_ORDER = Object.keys(ROUTE_KINDS);
export const STEP_GLYPHS = { search_symbols: '⌕', get_node: 'ⓘ', neighbors: '⇄', call_paths: '⤳', reach: '⇶', read_code: '‹›', grep: '≡' };

// View presets: each answers one question and sets arrows, filters and depth.
//   edges      relationship kinds to draw
//   fields     show fields and global variables
//   namespaces show namespace boxes
//   expand     node kinds opened at the start (null = default depth)
//   budget     roughly how many nodes may be visible after opening
export const PRESETS = {
  structure: { label: 'Structure', desc: 'The map of the code: folders, files and classes. Select a node to see how it connects.', edges: ['calls', 'inherits', 'overrides', 'includes', 'pairs'], fields: true, namespaces: true, mode: 'selected', direction: 'TB', expand: null },
  includes: { label: 'Includes', desc: 'Which files include which, and which header goes with which source file.', edges: ['includes', 'pairs'], fields: false, namespaces: false, mode: 'all', direction: 'TB', expand: ['dir'], budget: 400 },
  calls: { label: 'Calls', desc: 'Who calls whom, left to right.', edges: ['calls', 'overrides'], fields: false, namespaces: false, mode: 'bundled', direction: 'LR', expand: ['dir', 'file', 'namespace', 'class', 'struct', 'union'], budget: 140 },
  inheritance: { label: 'Inheritance', desc: 'Class hierarchy: who derives from whom and which methods override.', edges: ['inherits', 'overrides'], fields: false, namespaces: false, mode: 'all', direction: 'TB', expand: ['dir', 'file', 'namespace'], budget: 400 }
};

export const SUMMARY_KINDS = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'file', 'variable']);

export const IMPACT_KINDS = new Set(['function', 'method', 'class', 'struct', 'union', 'enum', 'file']);
export const IMPACT_CHANGES = ['signature', 'behavior', 'rename', 'remove'];
export const CHANGE_LABELS = { signature: 'Signature', behavior: 'Behavior', rename: 'Rename', remove: 'Remove' };
export const CHANGE_TITLES = {
  signature: 'Its parameters, return type or public members change',
  behavior: 'What it does changes, but not how it is called',
  rename: 'It gets a new name',
  remove: 'It is deleted'
};
export const TIER_ORDER = { high: 3, medium: 2, low: 1 };

export const VERDICT_LABELS = { breaks: 'breaks', review: 'needs review', fine: 'likely fine' };
