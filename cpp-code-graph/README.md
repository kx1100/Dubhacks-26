# C/C++ Code Graph

A VS Code extension that draws a C or C++ codebase as an interactive graph of folders, files, namespaces, classes and functions, connected by calls, `#include`s, inheritance, overrides and type dependencies. It's built for people, especially anyone new to a codebase, rather than for AI to consume.

## Getting started

1. Open a folder containing C or C++ code.
2. Run **Code Graph: Open Code Graph** from the Command Palette, or click the graph icon in a C/C++ editor's title bar.
3. Double-click nodes to expand them.

| Action | How |
| --- | --- |
| Select a node | Click |
| Expand / collapse | Double-click, `+`/`−`, or `→` / `←` |
| Open source | Ctrl+click or Enter |
| Search | `/`, then Enter / Shift+Enter to cycle |
| Show / hide code | `</>` button or `C` |
| Collapse others | `O` |
| Fit to view | `F` |
| Clear highlight / selection | Esc |

## Features

### Graph

- **Nested graph.** Starts at folders and files; expand to see classes, functions, methods and fields. Edges of hidden nodes are merged onto the nearest visible one.
- **Relationships:** calls, includes, inheritance, overrides, type uses, and header ↔ source pairs. Toggle each under **Show ▾**. Uncertain calls are dashed.
- **Views:** **Structure** (default), **Includes**, **Calls** and **Inheritance**.
- **Arrows:** show only the selected node's (**Selected**), one bundled arrow per file/folder pair (**Bundled**), or **All**.
- **Inline code.** Open a symbol's syntax-highlighted source inside its node; click a line to jump to it in the editor.
- **Details panel.** A node's signature, location, callers, callees, members and dependencies, plus an optional AI summary (cached per workspace).
- **Exploring:** focus mode, collapse others, trace callers/callees, and **Show in Code Graph** from the editor's right-click menu.
- **Git comparison.** **Code Graph: Compare Git Commits** colors added, removed and modified code green, red and yellow.
- **Live updates** when C/C++ files are saved, created or deleted.

### Ask AI

Ask a question like "What happens when the program starts?" and the answer appears next to the graph, with mentioned nodes highlighted and clickable.

- **Modes:** **Ask** for a direct answer, or **Trace path** to rebuild the execution path step by step, including branches and alternative routes (such as error paths).
- **Investigation:** with tool-calling models, the AI searches symbols, follows relationships and reads code. Each step appears in a timeline and its nodes glow in the graph.
- **Evidence:** answers cite clickable source lines and come with a **high / medium / low** confidence based on what was actually checked.
- **In the graph:** the path is numbered. Dashed lines are inferred steps; dotted lines are name-only matches.
- **History:** the last 30 answers are saved per workspace and can be reopened or rerun.

It uses whatever model VS Code provides (e.g. GitHub Copilot) through the Language Model API, so no API key is needed. With no model available, it falls back to matching names.

### Change impact

**What if I change this?** in the details panel predicts what else may need to change if you change a node's signature, behavior or name, or remove it. Affected places are scored by risk and colored red, orange and yellow.

- **Check with AI** has the model review the ten riskiest places and mark each one *breaks*, *needs review* or *likely fine*.
- **Check against my edits** compares the prediction with your uncommitted changes and reports precision and recall.

### AI layer

**Code Graph: Build AI Layer** tags functions and classes with concepts (e.g. *logging*, *rendering*) and infers links the structure doesn't show, such as alternative implementations, legacy replacements and validators. Inferred links appear as dotted purple arrows (off by default under **Show ▾**). Results are cached per workspace.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeGraph.include` | `**/*.{c,cc,cpp,cxx,c++,h,hh,hpp,hxx,h++,inl,ipp,tpp}` | Files to analyze |
| `codeGraph.exclude` | build, vendor and third-party folders | Files and folders to skip |
| `codeGraph.maxFiles` | `3000` | Maximum number of files to analyze |
| `codeGraph.autoRefresh` | `true` | Rebuild the graph when C/C++ files change |
| `codeGraph.aiSummaries` | `true` | Show AI summaries in the details panel |

## How it works

There are no runtime dependencies, and no compiler, build system or `compile_commands.json` is needed. A built-in, error-tolerant parser extracts declarations and call sites, then names are resolved project-wide using declared types and the class hierarchy. Calls that match only by name are marked *uncertain*.

There is no preprocessing or template instantiation, so calls through macros, function pointers or heavy templates may be missed. Treat the graph as a map, not a compiler-exact call graph. About 3,000 files (~55 MB) are processed in roughly a second.

## Development

Plain JavaScript, no build step.

- `src/parser/`: lexer and parser
- `src/graph/`: name resolution, graph building and diffing
- `src/ai/`: Language Model API integration (summaries, Ask AI agent, impact, AI layer)
- `src/extension.js`: commands, webview and file watching
- `media/`: the webview (custom SVG renderer, no external libraries)

| Task | Command |
| --- | --- |
| Run | Open this folder in VS Code and press **F5** (uses `sample/`) |
| Dump parser output | `node test/dump.js <folder>` |
| Extension smoke test | `node test/smoke.js` |
| Unit tests | `node test/<name>.test.js` (`highlight`, `graphTools`, `agent`, `summaries`, `impact`, `impactCheck`, `semantic`) |
| UI harness | `node test/make-fixtures.js`, then `node test/serve.js` and open `http://localhost:5178` |
| Browser test | `node test/ui.test.js` (set `CHROME` if Chrome/Edge isn't found) |
| Large test project | `node test/gen-large.js <dir> [modules]` |
| Package | `node scripts/package.js` |

UI harness URL options: `?diff`, `?code=name`, `?preset=calls|includes|inheritance|structure`, `?arrows=all|bundled|selected`, `?ai`, `?semantic`, `?large`.
