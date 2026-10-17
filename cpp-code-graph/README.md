# C/C++ Code Graph

See how a C or C++ codebase is put together. The extension draws your project as an interactive graph of folders, files, namespaces, classes and functions. Arrows show how they connect: calls, `#include`s, inheritance, overrides and type dependencies.

Many tools build code graphs for AI to read. This one is meant for people, especially anyone new to a codebase or reading code they did not write.

## Features

- **Nested, expandable graph.** You start at the folder and file level. Double-click any node to open it up: a file shows its classes and functions, a class shows its methods and fields. Relationships of hidden nodes are combined onto the closest visible node, so the picture stays readable at every level.
- **Relationships:**
  - **Calls**: function → function
  - **Includes**: file → header
  - **Inherits**: derived → base
  - **Overrides**: method → base method
  - **Uses type**: code → the class or enum it depends on
  - **Header ↔ source**: the file that declares something → the file that implements it (`list.h` → `list.c`). Built from matching prototypes and out-of-line definitions, and from files that share a name.

  You can switch each kind on or off under **Show ▾**. Calls the extension could not resolve for certain are drawn dashed.
- **Inline code.** Click the `</>` button on a function, method, class, enum or variable (or select it and press **C**) to open its source inside the node. The code is syntax-highlighted, the layout makes room for it, and clicking a line opens that line in the editor. Long bodies scroll inside the card. A function shows its definition; for a free function the details panel also links to its prototype in the header. In a comparison, the card shows the version on the side being viewed.
- **Navigation.** Zoom with the mouse wheel and pan by dragging. Search with `/`, which offers suggestions as you type. **Ctrl+click** (or **Enter**) opens a node's source. Every relationship in the details panel links to the exact call site.
- **Details panel.** Click a node to see a plain-language summary ("A virtual member function of Circle. It calls 3 functions…"). The panel also shows the node's signature and where it is declared and defined. It lists what the node calls, what calls it, its base and derived classes, its members, and which files it depends on.
- **Views.** The **View** buttons in the toolbar pick a layout built around one question:
  - **Structure** (the default): folders, files and classes, with arrows only for the node you select.
  - **Includes**: which files include which, and which header goes with which source file.
  - **Calls**: who calls whom, flowing left to right between folders and files.
  - **Inheritance**: class hierarchy and overridden methods.

  Changing a filter under **Show ▾** switches the view to **Custom**.
- **Arrows.** The **Arrows** buttons control how many arrows are drawn: **Selected** (only the selected node's), **Bundled** (one arrow per pair of folders or files with a count, plus the selected node's own arrows) or **All**. In Bundled mode an arrow that is too long to follow becomes two short stubs with labels such as `ui ×18 →`; click a label to jump to the other end.
- **Collapse others.** Select a node and press **O** (or use the button in the details panel) to close everything except that node, what it is connected to, and the folders and files leading to them.
- **Focus mode.** Selecting a node dims everything that is not connected to it.
- **Trace callers / callees.** Highlights everything a function reaches, directly or indirectly, or everything that leads to it.
- **Show in Code Graph.** Right-click inside a C/C++ editor to jump to the function or class under the cursor.
- **Git commit comparison.** Run **Code Graph: Compare Git Commits** and pick two commits, or a commit and your working tree. Added, removed and modified functions, classes and files are colored green, red and yellow. Added and removed relationships are colored the same way. **Changes only** hides everything that did not change. Modified files can be opened in VS Code's diff view.
- **Ask AI.** Ask a question such as "What happens when the program starts?" The answer appears next to the graph. The nodes it mentions become clickable and are highlighted, and the main execution path is numbered step by step. This uses whichever language model VS Code makes available (for example GitHub Copilot) through the Language Model API, so no API key is needed. Without a model, the extension falls back to matching your question against node names.
- **Stays current.** The graph updates when you save, create or delete C/C++ files. Your expanded nodes, selection and view are kept.

## Getting started

1. Open a folder that contains C or C++ code.
2. Run **Code Graph: Open Code Graph** from the Command Palette, or click the graph icon in the title bar of a C/C++ editor.
3. Double-click nodes to explore. Use **Expand** and **Collapse** in the toolbar to change depth everywhere at once.

| Action | How |
| --- | --- |
| Select a node | Click |
| Expand / collapse | Double-click, the `+`/`−` button, or `→` / `←` |
| Open source | Ctrl+click or Enter |
| Search | `/`, then Enter / Shift+Enter to cycle |
| Show / hide code | `</>` button, or `C` on the selected node |
| Collapse others | `O` on the selected node |
| Fit to view | `F` |
| Clear highlight / selection | Esc |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeGraph.include` | `**/*.{c,cc,cpp,cxx,c++,h,hh,hpp,hxx,h++,inl,ipp,tpp}` | Files to analyze |
| `codeGraph.exclude` | build, vendor and third-party folders | Files and folders to skip |
| `codeGraph.maxFiles` | `3000` | Maximum number of files to analyze |
| `codeGraph.autoRefresh` | `true` | Rebuild the graph when C/C++ files change |

## How it works

The extension has no runtime dependencies and needs no compiler, build system or `compile_commands.json`.

A built-in, error-tolerant parser reads each file. It handles comments, strings, raw strings and preprocessor conditionals (keeping the first branch, so brace structure stays intact). It recognizes:

- namespaces, classes, structs, unions and enums, including base classes and typedef'd anonymous structs
- functions and methods, both inline and out-of-line (`void Foo::bar() {…}`), including constructor initializer lists, operators and destructors
- fields and global variables
- inside function bodies: call sites, local variable types (including `auto x = new T` and `make_unique<T>`) and referenced types

Names are then resolved across the whole project:

- `obj.method()` uses the declared type of `obj` (a local, parameter or member) and searches up the class hierarchy.
- `Class::method()` and unqualified calls are resolved through the enclosing class first, then by namespace.
- Calls that can only be matched by name are marked *uncertain*.

Because there is no preprocessing or template instantiation, calls through macros, function pointers and heavily templated code may be missed or approximate. The graph is a map for understanding the code, not a compiler-exact call graph.

Performance: about 3,000 files, roughly 55 MB of source, are parsed and resolved in about a second.

## Development

The extension is plain JavaScript with no build step.

- `src/parser/`: lexer and structural parser
- `src/graph/builder.js`: name resolution and graph building
- `src/graph/diff.js`: graph comparison
- `src/git.js`: reads source files at any revision using the git CLI
- `src/ai/`: Language Model API integration (`model.js` model access, `context.js` prompt context, `answer.js` answer parsing)
- `src/extension.js`: commands, webview panel and file watching
- `media/graph.js`, `media/graph.css`: the webview (custom SVG renderer with a nested layered layout; no external libraries)
- `media/highlight.js`: the small C/C++ syntax highlighter used by the inline code cards

To develop and test:

- **Run:** open this folder in VS Code and press **F5**. This starts an Extension Development Host on the included `sample/` project.
- **Parser output:** `node test/dump.js <folder>` prints the graph for any folder.
- **Extension host smoke test:** `node test/smoke.js` runs the extension host code against a mocked `vscode` API.
- **UI harness:** `node test/make-fixtures.js`, then `node test/serve.js` and open `http://localhost:5178`. This loads the webview with sample data in a regular browser; add `?diff` to the URL for the comparison view, `?code=name` (repeatable) to open code cards, `?preset=calls` (or `includes`, `inheritance`, `structure`) and `?arrows=all` (or `bundled`, `selected`) to pick a view, and `?large` to load a generated 80-file project (see below).
- **Large project:** `node test/gen-large.js <dir> [modules]` writes a synthetic C project for trying big graphs. `node test/make-fixtures.js <dir> test` then writes `test/fixtures.js`; the browser test builds `test/fixtures-large.js` itself when it needs it.
- **Highlighter test:** `node test/highlight.test.js`.
- **Browser test:** `node test/ui.test.js` drives the harness in headless Chrome or Edge (set `CHROME` to the executable if it is not found). It covers code cards, the header ↔ source edges, the views and arrow modes, bundling, left-to-right layout, long-arrow labels and Collapse others.
- **Package:** `node scripts/package.js` builds a `.vsix` without `vsce`.
