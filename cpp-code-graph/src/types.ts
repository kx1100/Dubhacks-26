// Shared contract between the extension (parser/graph builder), the AI code
// (src/ai/*.js, from the ask-ai branch) and the webview.

// The graph shape and the message names are the ones the ask-ai code uses, so
// it runs on this graph unchanged. Change them only by agreement.

// ---------------------------------------------------------------------------
// Graph data
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'file'
  | 'function'   // function; its prototype in a header is merged in (declFile/declLine)
  | 'struct'     // struct or union definition
  | 'typedef'
  | 'enum'
  // C++ (Phase 7)
  | 'class'      // C++ class (C++ structs with methods stay 'struct')
  | 'method'     // C++ method; parent is its class
  | 'field'      // C++ data member; parent is its class
  | 'namespace';

export type EdgeKind =
  | 'includes'   // file -> included header (only resolved, non-<system> includes)
  | 'pairs'      // header file -> the source file that implements it (list.h -> list.c)
  | 'uses'       // function/type -> struct/typedef/enum it uses
  | 'calls'      // function -> function it calls (definition if known)
  // C++ (Phase 7)
  | 'inherits'   // derived class -> base class
  | 'overrides'  // method -> base-class method it overrides
  // Added by the AI layer (src/ai/semantic.js)
  | 'semantic';

export type Language = 'c' | 'cpp';

/** Set by src/graph/diff.js when comparing two commits. */
export type DiffStatus = 'added' | 'removed' | 'modified';

export interface GraphNode {
  /**
   * Stable, unique ID. Format: `<kind>:<file>[:<name>]`, e.g.
   *   file:test-fixtures/c-demo/list.c
   *   function:test-fixtures/c-demo/list.c:list_free
   *   struct:test-fixtures/c-demo/list.h:Node
   */
  id: string;
  kind: NodeKind;
  /** Short display text: file basename for files, symbol name otherwise. */
  name: string;
  /** Fully qualified name (`Shape::area` in C++); the same as `name` in C. Not set on files. */
  qname?: string;
  /** ID of the containing node: the file for top-level symbols, the class for methods. */
  parent?: string;
  /** Workspace-relative path with forward slashes. */
  file: string;
  /** 1-based first and last line (file nodes: line 1 only). For methods, where they are declared. */
  line?: number;
  endLine?: number;
  /** Where the body is. For C functions the same as file/line/endLine. */
  defFile?: string;
  defLine?: number;
  defEndLine?: number;
  /** Functions with a prototype elsewhere (usually a header): where it is. */
  declFile?: string;
  declLine?: number;
  declEndLine?: number;
  /** File nodes only: true for headers. */
  header?: boolean;
  /** File nodes only. */
  language?: Language;
  /** One-line declaration for hover, e.g. "void list_free(List *list)". */
  signature?: string;
  isStatic?: boolean;
  /** C++ methods */
  isVirtual?: boolean;
  /** `= 0` */
  isPure?: boolean;
  /** marked `override` */
  isOverride?: boolean;
  access?: 'public' | 'protected' | 'private';
  /** Hash of the symbol's text (files: the whole file); changes when the code does. */
  hash?: string;
  status?: DiffStatus;
}

export interface EdgeSite {
  file: string;
  line: number;
}

export interface GraphEdge {
  /** Source and target node IDs. */
  s: string;
  t: string;
  kind: EdgeKind;
  /** How many times the relationship occurs (e.g. calls in the body). */
  n: number;
  /** Where it happens, up to 8 places (call sites, #include lines). */
  sites?: EdgeSite[];
  /** The name matched several targets and this is one of them. */
  uncertain?: boolean;
  status?: 'added' | 'removed';
}

export interface GraphStats {
  files: number;
  nodes: number;
  edges: number;
  errors: Array<{ file: string; error: string }>;
  truncated?: boolean;
  maxFiles?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  /** Workspace folder name(s), set by WorkspaceIndex. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Messages (the names the ask-ai webview used)
// ---------------------------------------------------------------------------

/** Extension -> webview. */
export type ToWebviewMessage =
  | { type: 'graph'; mode: 'workspace' | 'diff'; graph: GraphData; title?: string; compare?: { baseLabel: string; targetLabel: string } }
  | { type: 'status'; text: string; busy?: boolean; error?: boolean }
  | { type: 'reveal'; id: string }                         // codeGraph.revealInGraph
  /** Answer to `getSource`: lines of a file starting at 1-based `startLine`. */
  | { type: 'source'; reqId: number; startLine?: number; lines?: string[]; truncated?: boolean; error?: string }
  // Ask AI
  | { type: 'aiStart'; question: string }
  | { type: 'aiPartial'; text: string }
  | { type: 'aiStep'; step: { tool: string; summary?: string; note?: string; nodeIds?: string[] } }
  | { type: 'aiResult'; answer: string; highlight: string[]; path: string[]; model?: string | null; error?: boolean; cancelled?: boolean; entryId?: string; time?: number; [key: string]: unknown }
  | { type: 'aiHistory'; entries: Array<{ id: string; time: number; question: string; answer: string; highlight: string[]; path: string[]; [key: string]: unknown }> }
  | { type: 'summary'; id: string; summary?: string; model?: string; cached?: boolean; disabled?: boolean; unavailable?: boolean; cancelled?: boolean; error?: string }
  // Change impact and the AI layer (not shown by the webview yet)
  | { type: 'impactResult' | 'impactAIResult' | 'impactCheckResult'; id: string; requested: string; [key: string]: unknown }
  | { type: 'semanticBuilding'; busy: boolean };

/** Webview -> extension. */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; file: string; line: number; side?: 'base' | 'target'; preserveFocus?: boolean }
  | { type: 'getSource'; reqId: number; file: string; start: number; end: number; side?: 'base' | 'target' }
  // Compare Git Commits
  | { type: 'compare' }
  | { type: 'exitCompare' }
  | { type: 'openDiff'; file: string }
  // Ask AI
  | { type: 'ask'; question: string; focus?: string; mode?: 'ask' | 'path' }
  | { type: 'cancelAsk' }
  | { type: 'getSummary'; id: string; refresh?: boolean }
  | { type: 'aiHistoryDelete'; id: string }
  | { type: 'aiHistoryClear' }
  // Change impact and the AI layer
  | { type: 'impact' | 'impactAI' | 'impactCheck'; id: string; changeType: string; description?: string }
  | { type: 'buildSemantic' };