# C/C++ Code Graph

A VS Code extension that draws a C or C++ codebase as an interactive graph of files, classes and functions, connected by calls, `#include`s, inheritance, overrides and type dependencies. It's built for people, especially anyone new to a codebase, rather than for AI to consume.

## Getting started

1. Open a folder containing C or C++ code.
2. Run **Code Graph: Open Code Graph** from the Command Palette, or click the graph icon in a C/C++ editor's title bar.
3. Click a file to open it and see what's inside.

| Action | How |
| --- | --- |
| Open / close a file or class | Click it |
| Show / hide a function's code | Click it (the code opens in a card on the graph) |
| Open the source in the editor | Double-click |
| Fold an open file or class, with everything inside it | Ctrl+click |
| Move a node | Drag it |
| Close all code cards, then clear highlights | Esc |
| Fit the graph in view | **Fit** |
| Open or close everything | **Expand all** / **Collapse all** |
| Show the Details and Ask AI panel | **Panel** |

## Features

### Graph

- **Left to right.** ELK lays files out so that callers and files that `#include` something sit to the left of what they use. Opening a file, a class or a code card makes room around it in place. Closing it puts everything back exactly where it was.
- **Nested boxes.** Files start closed and show how many symbols they hold. An open file shows its functions, types and classes; an open class shows its methods and fields.
- **Relationships:** calls, includes, inheritance, overrides, type uses, and header ↔ source pairs. The legend lists them; include arrows are green.
- **Node size:** the more different nodes something is connected to, the bigger it's drawn. A closed file counts other files. The text stays the same size everywhere, and the tooltip gives the exact count ("Connected to N nodes").
- **Arrows:**
  - **Selected:** only the selected node's arrows.
  - **Bundled** (default): one arrow per pair of files with a count, plus exact arrows inside an open file and for the selected node.
  - **All:** every arrow.
- **Inline code.** A function's syntax-highlighted source opens in a card on the graph; click a line to jump to it in the editor.
- **Show in Code Graph** from the editor's right-click menu focuses the symbol under the cursor.
- **Live updates** when C/C++ files are saved, created or deleted (`codeGraph.autoRefresh`). **Refresh** rescans by hand.

### Side panel

**Panel** in the toolbar opens two tabs next to the graph:

- **Details:** the selected node's signature, location, callers, callees, members and dependencies, its concepts, and an optional AI summary (cached per workspace).
- **Ask AI:** see below.

Highlights from the panel are drawn in the graph: an answer's nodes and path, a trace, a concept, or an impact.

### Ask AI

Ask a question like "What happens when the program starts?" and the answer appears in the panel, with mentioned nodes highlighted and clickable.

- **Modes:**
  - **Ask:** a direct answer.
  - **Trace path:** rebuilds the execution path step by step, including branches and alternative routes such as error paths.
- **Investigation:** with tool-calling models, the AI searches symbols, follows relationships and reads code. Each step appears in a timeline, and its nodes glow in the graph.
- **Evidence:** answers cite clickable source lines and come with a **high / medium / low** confidence, based on what was actually checked.
- **In the graph:** the path is numbered. Dashed lines are inferred steps; dotted lines are name-only matches.
- **History:** the last 30 answers are saved per workspace and can be reopened or rerun.

It uses whatever model VS Code provides, such as GitHub Copilot, through the Language Model API, so no API key is needed. With no model available, it falls back to matching names.

GitHub Copilot must be **signed in** in the window you use. If it isn't, Copilot only offers its "Auto" model, which can't answer requests from extensions, and Ask AI says "The investigation ended without an answer". The Extension Development Host window has its own sign-in.

### Change impact

**What if I change this?** in the Details tab predicts what else may need to change if you change a node's signature, behavior or name, or remove it. Affected places are scored by risk and colored red, orange and yellow.

### Concepts

**Code Graph: Build AI Layer (Concepts and Inferred Links)** tags functions and classes with concepts (e.g. *logging*, *rendering*). Click a concept in the Details tab to highlight everything tagged with it. Results are cached per workspace.

### Not wired up yet

The **Compare** button and the **Code Graph: Compare Git Commits** command are present, but the extension doesn't handle them yet. `src/git.js` (reading files at a commit) is in place for it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeGraph.include` | `**/*.{c,cc,cpp,cxx,c++,h,hh,hpp,hxx,h++,inl,ipp,tpp}` | Files to analyze |
| `codeGraph.exclude` | build, vendor and third-party folders | Files and folders to skip |
| `codeGraph.maxFiles` | `3000` | Maximum number of files to analyze |
| `codeGraph.autoRefresh` | `true` | Rebuild the graph when C/C++ files change |
| `codeGraph.aiSummaries` | `true` | Describe the selected function, type or file with the language model |

## How it works

No compiler, build system or `compile_commands.json` is needed.

- **Parsing:** [tree-sitter](https://tree-sitter.github.io/) (C and C++ grammars, run as WebAssembly) parses each file. It's error-tolerant: a file it can't fully parse, often because of a macro, still gives everything it could read.
- **Resolving names:** names are then resolved project-wide, using declared types and the class hierarchy. Calls that match only by name are marked *uncertain*.

There is no preprocessing or template instantiation, so calls through macros, function pointers or heavy templates may be missed. Treat the graph as a map, not a compiler-exact call graph. For example, the xk teaching kernel (92 files) parses in about 0.1 s.

## Development

- **Extension host:** TypeScript (with the AI modules in JavaScript), bundled with esbuild from `src/extension.ts` into `out/extension.js`. The tree-sitter grammars in `parsers/` are copied to `out/parsers/`.
- **Webview:** bundled from `media/main.js` into `media/dist/graph.js`.
- **Commands:** `npm run build` builds both (`npm run watch` rebuilds on change), and `npm run typecheck` runs `tsc`.

| Path | What it does |
| --- | --- |
| `src/types.ts` | The graph and message types shared by the extension and the webview |
| `src/parser/` | tree-sitter parsing (C and C++ grammars) and extraction |
| `src/graph/builder.ts` | Name resolution and graph building |
| `src/ai/` | Language Model API integration (summaries, Ask AI agent, impact, AI layer) |
| `src/git.js` | Reading files at a git commit (for Compare) |
| `src/workspaceIndex.ts` | Finds, reads and parses the workspace's files |
| `src/panel.ts` | The webview panel and its messages |
| `src/extension.ts` | Commands and file watching |
| `media/main.js` | The graph: Cytoscape rendering, opening and closing, code cards, arrows, legend, tooltips, node size |
| `media/layout.js` | The ELK left-to-right layout and opening things in place |
| `media/style.css` | Webview styles. Graph colors are the `--cg-*` variables |
| `media/panel-bridge.js` | Connects the side panel (`media/webview/panels/`: Details, impact, Ask AI) to the graph in `main.js`. `media/panel.css` styles it |

| Task | Command |
| --- | --- |
| Install | `npm install` (`node_modules/` isn't committed) |
| Build | `npm run build` (`npm run watch` to rebuild on change) |
| Run | Open this `cpp-code-graph` folder in VS Code and press **F5** (see below) |
| All tests | `npm test` |
| Dump parser output | `node test/run.js test/dump.js <folder>` (or the **Dump Parsed Symbols** command) |
| Extension smoke test | `node test/run.js test/smoke.js` |
| Unit tests | `node test/run.js test/<name>.test.js` (`highlight`, `graphTools`, `agent`, `summaries`, `impact`, `semantic`) |
| Large test project | `node test/gen-large.js <dir> [modules]` |
| Package | `node scripts/package.js` |

`test/ui.test.js` and `test/harness.html` were written for the previous SVG webview (`media/webview/renderer-svg.js`), so the UI test fails against the Cytoscape graph until it's updated.

### Running with F5

`.vscode/launch.json` runs **Run Extension (sample project)**:

1. builds everything first (`npm: build`);
2. opens `sample/` in an Extension Development Host;
3. starts that window with `--disable-extensions`, so only this extension loads there.

**If the debug window opens and closes right away:** another extension crashed it. The usual one is **Java (Oracle)**: on F5 it tries to start its Java language server and kills it when that fails. `--disable-extensions` keeps it out of the debug window. If it still happens, disable Java (Oracle) for this workspace, or install a JDK for it.

**If F5 asks you to "Select debugger":** the folder open in VS Code isn't this one. Open `cpp-code-graph` and press F5 again.

The repo root has its own `.vscode/launch.json`, which also builds everything and opens `sample/`, but it doesn't pass `--disable-extensions`.
