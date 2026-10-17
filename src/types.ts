// Shared contract between the extension (parser/graph builder) and the webview.
// Both sides code against these types; change them only by agreement.

// ---------------------------------------------------------------------------
// Graph data
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'file'
  | 'function'   // function definition (has a body)
  | 'prototype'  // function declaration without a body, usually in a header
  | 'struct'     // struct or union definition
  | 'typedef'
  | 'enum'
  // C++ (Phase 7)
  | 'class'
  | 'method'
  | 'namespace';

export type EdgeKind =
  | 'include'    // file -> included header (only resolved, non-<system> includes)
  | 'pair'       // header file -> its matching source file (list.h -> list.c)
  | 'proto-def'  // prototype node -> function/method definition node
  | 'type-use'   // function/method -> struct/typedef/class/enum it uses
  | 'call'       // function/method -> function/method it calls (definition if known)
  // C++ (Phase 7)
  | 'inherits';  // derived class -> base class

export type Language = 'c' | 'cpp';

/** Phase 6 (commit diff): set only when comparing two commits. */
export type DiffStatus = 'added' | 'removed' | 'changed';

export interface GraphNode {
  /**
   * Stable, unique ID. Format: `<kind>:<file>[:<name>]`, e.g.
   *   file:test-fixtures/c-demo/list.c
   *   function:test-fixtures/c-demo/list.c:list_free
   *   prototype:test-fixtures/c-demo/list.h:list_free
   *   struct:test-fixtures/c-demo/list.h:Node
   *   method:src/shape.cpp:Shape::area
   */
  id: string;
  kind: NodeKind;
  /** Short display text: file basename for files, symbol name otherwise. */
  label: string;
  /** ID of the containing node: the file for top-level symbols, the class for methods. */
  parent?: string;
  /** Workspace-relative path with forward slashes. */
  file: string;
  /** 1-based line number, for jump-to-source and hover. Omitted for file nodes. */
  line?: number;
  /** File nodes only. */
  fileRole?: 'header' | 'source';
  /** File nodes only. */
  language?: Language;
  /** One-line declaration for hover, e.g. "void list_free(List *list)". */
  signature?: string;
  diff?: DiffStatus;
}

export interface GraphEdge {
  /** Unique ID. Format: `<kind>:<source>-><target>`. */
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  diff?: DiffStatus;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Extension -> webview. */
export type ToWebviewMessage =
  | { type: 'graph'; data: GraphData }
  | { type: 'focus'; nodeId: string }          // codeGraph.revealInGraph
  | { type: 'highlight'; nodeIds: string[]; answer?: string } // codeGraph.ask (Phase 5)
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string };

/** Webview -> extension. */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'openLocation'; file: string; line: number }
  | { type: 'refresh' }
  | { type: 'ask'; question: string };         // Phase 5
