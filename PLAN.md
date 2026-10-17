# C/C++ Code Graph: VS Code Extension (DubHacks '26)

Each phase below is sized to be one commit.

> **Status:** the working extension lives in `cpp-code-graph/` and differs from the stack below: plain JavaScript, a hand-written C/C++ parser, and a custom SVG webview, with no TypeScript, tree-sitter or Cytoscape. The phases below remain the feature roadmap. See `cpp-code-graph/README.md` for what is implemented.

`package.json` is the source of truth for command IDs and settings. Every command it contributes is mapped to a phase below:

| Command / setting | Phase |
|---|---|
| `codeGraph.open` ("Open Code Graph") | 1 |
| `codeGraph.refresh` ("Rescan Workspace") | 4 |
| `codeGraph.revealInGraph` ("Show in Code Graph", editor context menu) | 4 |
| `codeGraph.ask` ("Ask a Question About the Code") | 5 |
| `codeGraph.compareCommits` ("Compare Git Commits") | 6 |
| `codeGraph.include` / `exclude` / `maxFiles` settings | 2 (file discovery) |
| `codeGraph.autoRefresh` setting | 8 |

Commands whose phase hasn't shipped yet should still be registered, showing an "available soon" message, so they never fail with "command not found".

## Pitch
- Much code is now written by AI, so developers (beginners most of all) often don't understand how their own codebase is structured.
- Existing code-to-graph tools build graphs for **AIs** to consume. This one is for **humans**.
- It's a VS Code extension that draws a C/C++ codebase as a real graph, with nodes and arrows instead of a text tree.
- It shows the C-family structure: header ↔ source pairing (`.h`/`.c`, `.hpp`/`.cpp`), `#include` chains, where structs/classes are defined vs. used, and prototypes vs. bodies.

## Tech Stack (pick once, don't revisit)
- **Extension**: TypeScript, VS Code Extension API, esbuild. `package.json` `main` points to the bundle at `./dist/extension.js`.
- **Parsing**: `web-tree-sitter` (WASM) + `tree-sitter-c`. No native builds, so it works on Windows. The `tree-sitter-cpp` grammar comes in Phase 7. The graph contract already includes C++ kinds, so adding it won't change the UI contract.
- **Graph UI**: Cytoscape.js + the `cytoscape-elk` layout in a VS Code Webview. It supports compound nodes, which expand/collapse needs.
- **Stretch**: `git` CLI via `child_process`, and the Claude API (`@anthropic-ai/sdk`).

## Layout
```
src/
  types.ts            shared contract: GraphNode/GraphEdge/GraphData + webview messages
  extension.ts        command registration, opens panel
  parser.ts           tree-sitter load + extraction (includes, functions, calls, structs, typedefs)
  graph.ts            graph builder (include resolution, linking), outputs GraphData
  panel.ts            WebviewPanel host + message passing
media/
  main.js, style.css  Cytoscape rendering + interactions (bundled to dist/webview.js)
  mock-graph.json     hand-written GraphData for c-demo; used until graph.ts is ready
dist/                 esbuild output (gitignored)
test-fixtures/c-demo/ small C project used for dev and the live demo
```

---

## MVP (must ship for the demo)

### Phase 0: Plan file + shared contract
- Create `PLAN.md`.
- Create `src/types.ts` (the graph data model and the messages between webview and extension) and `media/mock-graph.json`. Both people code against these.

### Phase 1: Scaffold + webview showing a mock graph
- Add build scripts and dependencies to the existing `package.json`, plus `tsconfig`, esbuild, `.gitignore`, and an F5 launch config.
- Register every command in `package.json`. `codeGraph.open` opens the panel, and the rest show "available soon" until their phase ships.
- Webview panel renders `media/mock-graph.json` with Cytoscape + ELK, with pan/zoom.
- **Verify:** F5 → run "Open Code Graph" → the mock graph shows nodes and arrows.

### Phase 2: Parse C files
- Load the tree-sitter C grammar and extract `#include "..."`, function definitions and prototypes, call expressions, `struct`/`typedef` definitions, and struct type references.
- Create the `test-fixtures/c-demo/` project with `main.c`, `list.h/.c`, and `util.h/.c`.
- **Verify:** a debug command dumps the extracted symbols for the fixture to the Output channel, and the output is correct.

### Phase 3: Build the real graph (core value)
- Nodes: files (`.c` and `.h` styled differently).
- Edges, each with its own style and a legend entry (`EdgeKind` in `src/types.ts`):
  - `include`: file → header
  - `pair`: header ↔ source pairing (`list.h` ↔ `list.c`)
  - `proto-def`: prototype in `.h` → definition in `.c`
  - `type-use`: function → the struct/typedef/enum it uses (that node sits inside its defining header)
  - `call`: function → function calls (resolved across files)
- Resolve includes relative to the including file and the workspace root, and skip `<system>` headers.
- **Verify:** the fixture graph shows every edge type correctly.

### Phase 4: Interactions (makes it usable)
- Click a file node to expand or collapse its functions and structs (compound nodes).
- Double-click a symbol to jump to its line in the editor.
- Selecting a node highlights its neighbors and dims everything else.
- Hover shows the signature and file:line.
- A refresh button (and `codeGraph.refresh`) rebuilds the graph.
- `codeGraph.revealInGraph`: right-click in the editor → opens the graph and focuses the symbol at the cursor.
- **Verify:** manual walkthrough of the demo script on the fixture.

**MVP done = demoable.** Rehearse the demo here before starting stretch work.

---

## Stretch Goals (in priority order, only if time allows)

### Phase 5: AI question → highlighted path
- An input box in the webview. Send a compact graph summary and the question to the model.
- The model returns relevant node IDs, which get highlighted and focused.
- **Done:** single-shot version in `cpp-code-graph/src/ai/`. It uses VS Code's Language Model API (no API key) and falls back to keyword matching.
- **Verify:** "What happens when a list is freed?" lights up the correct nodes.

Phase 5 continues as one engine, a bounded tool-calling agent over deterministic graph queries, with each feature as a mode on top of it. One commit each:
- **5a** Split `ai.js` into `src/ai/` (model, context, answer). No behavior change.
- **5b** Graph query toolkit (`graphTools.js`): symbol search, neighbors, call paths, transitive reach and source reads, with unit tests.
- **5c** Agent loop: `vscode.lm` tool calling, step and token bounds, a `finish` tool with cited evidence, and validation of ids and path edges against the graph.
- **5d** Visible investigation: a timeline of agent steps in the AI tab, nodes highlighted per step, an evidence list and mode chips.
- **5e** Execution-path reconstruction: a path schema with branches, conditions, inferred hops and alternatives (success, failure, retry), plus "Trace from here".
- **5f** AI node descriptions in the details panel, cached by node content hash.
- **5g** Change-impact simulator (static): transitive callers, overrides, type users and includers, with a risk score and heatmap. Labelled as a prediction.
- **5h** Change impact with the LLM: classification of each affected site, and a check of the prediction against the actual git diff.
- **5i** Semantic layer: AI-inferred edges and concept tags, each with evidence, confidence and provenance, shown as an optional edge kind.

### Phase 6: Commit diff view
- Pick two commits, build both graphs from `git show`, and color the delta: green = added, red = removed, yellow = changed.

### Phase 7: C++ support
- Add the `tree-sitter-cpp` grammar: classes, methods, namespaces, inheritance edges, and `.hpp/.cpp` pairing. These node/edge kinds already exist in `src/types.ts`; this phase only fills them in (plus their styles).

### Phase 8: Polish
- Beginner tooltips that explain headers and includes, filters for edge types, auto-refresh on save, and a README with screenshots.

---

## Out of Scope for the Hackathon
- Full preprocessor/macro expansion and `compile_commands.json` support.
- Huge-repo performance tuning.
- Publishing to the Marketplace.

## Demo Script (about 2 minutes)
1. Problem: AI wrote this C project, and I don't know how it fits together.
2. Open Code Graph, which shows the file graph with includes and header pairs.
3. Expand `list.c` to show its functions. Click `struct Node` to see the arrow to `list.h` and every place that uses it.
4. Double-click a function to jump to its code.
5. (Stretch) Ask the AI a question, and the path gets highlighted.
