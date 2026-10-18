// Shared contract between the extension (parser/graph builder) and the webview.
// Both sides code against these types; change them only by agreement.

// ---------------------------------------------------------------------------
// Graph data
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'dir'        // folder; chains of folders with one sub-folder and no files are merged into one node
  | 'file'
  | 'function'   // function definition (has a body)
  | 'prototype'  // function declaration with no definition in the workspace, e.g. a library API
  | 'struct'     // struct or union definition
  | 'typedef'
  | 'enum'
  // C++ (Phase 7)
  | 'class'
  | 'method'
  | 'field'      // data member of a class or struct
  | 'namespace';

export type EdgeKind =
  | 'include'    // file -> included header (only resolved, non-<system> includes)
  | 'pair'       // header file -> its matching source file (list.h -> list.c), or declaring file -> defining file
  | 'proto-def'  // prototype node -> function/method definition node (unused: the builder merges a prototype into its definition)
  | 'type-use'   // function/method/type/file -> struct/typedef/class/enum it uses
  | 'call'       // function/method -> function/method it calls (definition if known)
  // C++ (Phase 7)
  | 'inherits'   // derived class -> base class
  | 'overrides'  // method -> base class method it overrides
  // AI layer (src/ai/semantic.js), added by the extension, never by the builder
  | 'semantic';

export type Language = 'c' | 'cpp';

/** Phase 6 (commit diff): set only when comparing two commits. */
export type DiffStatus = 'added' | 'removed' | 'changed';

export interface GraphNode {
  /**
   * Stable, unique ID. Format: `<kind>:<file>[:<qname>]`, e.g.
   *   dir:test-fixtures/c-demo
   *   file:test-fixtures/c-demo/list.c
   *   function:test-fixtures/c-demo/list.c:list_free
   *   prototype:test-fixtures/c-demo/list.h:list_free
   *   struct:test-fixtures/c-demo/list.h:Node
   *   method:src/shape.h:geo::Shape::area
   */
  id: string;
  kind: NodeKind;
  /** Short display text: file or folder name for files and folders, symbol name otherwise. */
  label: string;
  /** Name with its namespaces and classes, e.g. `geo::Circle::area`; the same as label in C. */
  qname?: string;
  /** ID of the containing node: the folder for files, the file for top-level symbols, the class for methods and fields. */
  parent?: string;
  /** Workspace-relative path with forward slashes (the folder itself for dir nodes). */
  file: string;
  /** 1-based line number, for jump-to-source and hover. Omitted for folder nodes. */
  line?: number;
  /** Last line of the symbol where `line` points (its declaration for a method declared in a class). */
  endLine?: number;
  /** Where the body is, when the symbol has one (may be another file than `file`, e.g. a method). */
  defFile?: string;
  defLine?: number;
  defEndLine?: number;
  /** Where a separate declaration is, e.g. the prototype in a header for a function defined in a .c file. */
  declFile?: string;
  declLine?: number;
  declEndLine?: number;
  /** File nodes only. */
  fileRole?: 'header' | 'source';
  /** File nodes only. */
  language?: Language;
  /** One-line declaration for hover, e.g. "void list_free(List *list)". */
  signature?: string;
  isStatic?: boolean;
  isVirtual?: boolean;
  /** `= 0` */
  isPure?: boolean;
  isOverride?: boolean;
  access?: 'public' | 'protected' | 'private';
  /** Hash of the node's text (whole file for file nodes), to tell when it changed. */
  hash?: string;
  diff?: DiffStatus;
}

/** A place in the code an edge comes from, e.g. the line of a call. */
export interface EdgeSite {
  file: string;
  line: number;
}

export interface GraphEdge {
  /** Unique ID. Format: `<kind>:<source>-><target>`. */
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  /** How many times the relationship appears in the code (e.g. number of calls). */
  n?: number;
  /** Up to a few places it appears. */
  sites?: EdgeSite[];
  /** Name resolution found several candidates; this is one of them. */
  uncertain?: boolean;
  // Semantic edges only (src/ai/semantic.js): what the AI says the relationship is.
  relation?: string;
  label?: string;
  symmetric?: boolean;
  confidence?: number;
  reason?: string;
  evidence?: unknown;
  hint?: unknown;
  provenance?: unknown;
  diff?: DiffStatus;
}

export interface GraphStats {
  files: number;
  nodes: number;
  edges: number;
  /** Files tree-sitter couldn't fully parse. */
  errors: Array<{ file: string; error: string }>;
  /** More files matched than codeGraph.maxFiles allows. */
  truncated?: boolean;
  maxFiles?: number;
}

/** What the AI semantic layer adds to a graph sent to the webview. */
export interface SemanticInfo {
  model: string;
  time: number;
  edges: number;
  concepts: number;
  tagged: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats?: GraphStats;
  /** Workspace folder name(s). */
  title?: string;
  /** AI layer: node id -> concept tags. */
  concepts?: Record<string, string[]>;
  semantic?: SemanticInfo;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** 'ask' answers a question; 'path' traces how one thing leads to another. */
export type AskMode = 'ask' | 'path';

/** The AI's answer to a question (src/ai/index.js), also kept in the history. */
export interface AiAnswer {
  answer: string;
  highlight: string[];
  path: string[];
  hops?: unknown[];
  routes?: unknown[];
  evidence?: unknown[];
  confidence?: string;
  confidenceReason?: string;
  /** null when no language model was available */
  model?: string | null;
  error?: boolean;
  cancelled?: boolean;
}

/** One saved answer in the per-workspace AI history. */
export interface AiHistoryEntry extends AiAnswer {
  id: string;
  time: number;
  question: string;
  mode: AskMode;
  steps: Array<{ tool: string; summary?: string; note?: string; nodeIds: string[] }>;
}

/** An AI description of a node (src/ai/summaries.js). */
export interface NodeSummary {
  purpose: string;
  tags: string[];
  notes: string[];
}

/** Kinds of change the impact panel predicts for (CHANGE_TYPES in src/ai/impact.js). */
export type ChangeType = 'signature' | 'behavior' | 'rename' | 'remove';

/** Extension -> webview. */
export type ToWebviewMessage =
  | { type: 'graph'; data: GraphData; title?: string }
  | { type: 'focus'; nodeId: string }          // codeGraph.revealInGraph
  | { type: 'highlight'; nodeIds: string[]; answer?: string }
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
  /** Reply to getSource: lines startLine.. of the file. */
  | { type: 'source'; reqId: number; startLine?: number; lines?: string[]; truncated?: boolean; error?: string }
  // AI questions
  | { type: 'aiStart'; question: string }
  | { type: 'aiPartial'; text: string }
  | { type: 'aiStep'; step: unknown }
  | ({ type: 'aiResult'; entryId?: string; time?: number } & AiAnswer)
  | { type: 'aiHistory'; entries: AiHistoryEntry[] }
  // AI node summaries
  | { type: 'summary'; id: string; summary?: NodeSummary; model?: string; cached?: boolean; disabled?: boolean; unavailable?: boolean; cancelled?: boolean; error?: string }
  // Change impact
  | ({ type: 'impactResult'; id: string; requested?: string } & Record<string, unknown>)
  // AI semantic layer
  | { type: 'semanticBuilding'; busy: boolean };

/** Webview -> extension. */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'openLocation'; file: string; line: number; preserveFocus?: boolean }
  | { type: 'refresh' }
  /** Lines [start, end] of a file for a code card; end 0 = a default length. */
  | { type: 'getSource'; reqId: number; file: string; start: number; end: number }
  | { type: 'ask'; question: string; focus?: string; mode?: AskMode }
  | { type: 'cancelAsk' }
  | { type: 'aiHistoryDelete'; id: string }
  | { type: 'aiHistoryClear' }
  | { type: 'getSummary'; id: string; refresh?: boolean }
  | { type: 'impact'; id: string; changeType: ChangeType }
  | { type: 'buildSemantic' };
