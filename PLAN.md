# C/C++ Codebase Map: VS Code Extension (DubHacks '26)

Each phase below is sized to be one commit.

## Pitch
- Much code is now written by AI, so developers (beginners most of all) often don't understand how their own codebase is structured.
- Existing code-to-graph tools build graphs for **AIs** to consume. This one is for **humans**.
- It's a VS Code extension that draws a C codebase as a real graph, with nodes and arrows instead of a text tree.
- It shows the C-specific structure: `.h` ↔ `.c` pairing, `#include` chains, where structs are defined vs. used, and prototypes vs. bodies.

## Tech Stack (pick once, don't revisit)
- **Extension**: TypeScript, VS Code Extension API, esbuild.
- **Parsing**: `web-tree-sitter` (WASM) + `tree-sitter-c`. No native builds, so it works on Windows. The `tree-sitter-cpp` grammar can be added later.
- **Graph UI**: Cytoscape.js + the `cytoscape-elk` layout in a VS Code Webview. It supports compound nodes, which expand/collapse needs.
- **Stretch**: `git` CLI via `child_process`, and the Claude API (`@anthropic-ai/sdk`).

## Layout
```
src/
  extension.ts        command registration, opens panel
  parser.ts           tree-sitter load + extraction (includes, functions, calls, structs, typedefs)
  graph.ts            Node/Edge model + builder (include resolution, linking)
  panel.ts            WebviewPanel host + message passing
media/
  main.js, style.css  Cytoscape rendering + interactions
test-fixtures/c-demo/ small C project used for dev and the live demo
```

---

## MVP (must ship for the demo)

### Phase 0: Plan file
- Create `plan.md`.

### Phase 1: Scaffold + webview showing a mock graph
- `package.json` with the `Code Map: Open` command, plus `tsconfig`, esbuild, `.gitignore`, and an F5 launch config.
- Webview panel renders a hard-coded mock graph with Cytoscape + ELK, with pan/zoom.
- **Verify:** F5 → run the command → the mock graph shows nodes and arrows.

### Phase 2: Parse C files
- Load the tree-sitter C grammar and extract `#include "..."`, function definitions and prototypes, call expressions, `struct`/`typedef` definitions, and struct type references.
- Create the `test-fixtures/c-demo/` project with `main.c`, `list.h/.c`, and `util.h/.c`.
- **Verify:** a debug command dumps the extracted symbols for the fixture to the Output channel, and the output is correct.

### Phase 3: Build the real graph (core value)
- Nodes: files (`.c` and `.h` styled differently).
- Edges, each with its own style and a legend entry:
  - `#include` (file → header)
  - header ↔ source pairing (`list.h` ↔ `list.c`)
  - prototype in `.h` → definition in `.c`
  - struct use → the header where the struct is defined
  - function → function calls (resolved across files)
- Resolve includes relative to the including file and the workspace root, and skip `<system>` headers.
- **Verify:** the fixture graph shows every edge type correctly.

### Phase 4: Interactions (makes it usable)
- Click a file node to expand or collapse its functions and structs (compound nodes).
- Double-click a symbol to jump to its line in the editor.
- Selecting a node highlights its neighbors and dims everything else.
- Hover shows the signature and file:line.
- A refresh button rebuilds the graph.
- **Verify:** manual walkthrough of the demo script on the fixture.

**MVP done = demoable.** Rehearse the demo here before starting stretch work.

---

## Stretch Goals (in priority order, only if time allows)

### Phase 5: AI question → highlighted path
- An input box in the webview. Send a compact graph summary and the question to Claude.
- Claude returns relevant node IDs, which get highlighted and focused.
- API key is kept in VS Code SecretStorage.
- **Verify:** "What happens when a list is freed?" lights up the correct nodes.

### Phase 6: Commit diff view
- Pick two commits, build both graphs from `git show`, and color the delta: green = added, red = removed, yellow = changed.

### Phase 7: C++ support
- Add the `tree-sitter-cpp` grammar: classes, methods, namespaces, inheritance edges, and `.hpp/.cpp` pairing.

### Phase 8: Polish
- Beginner tooltips that explain headers and includes, filters for edge types, auto-refresh on save, and a README with screenshots.

---

## Out of Scope for the Hackathon
- Full preprocessor/macro expansion and `compile_commands.json` support.
- Huge-repo performance tuning.
- Publishing to the Marketplace.

## Demo Script (about 2 minutes)
1. Problem: AI wrote this C project, and I don't know how it fits together.
2. Open Code Map, which shows the file graph with includes and header pairs.
3. Expand `list.c` to show its functions. Click `struct Node` to see the arrow to `list.h` and every place that uses it.
4. Double-click a function to jump to its code.
5. (Stretch) Ask the AI a question, and the path gets highlighted.
