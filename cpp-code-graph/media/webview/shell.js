// The webview page: toolbar, canvas, side panel and status bar. Imported first,
// so every other module finds its elements.

export const app = document.getElementById('app');
app.innerHTML = `
<header class="toolbar">
  <div class="title" id="title">Code Graph</div>
  <div class="search">
    <input id="search" type="text" placeholder="Search files, classes, functions…  ( / )" spellcheck="false" autocomplete="off">
    <span id="searchCount" class="count"></span>
    <button id="searchPrev" class="icon" title="Previous match (Shift+Enter)">↑</button>
    <button id="searchNext" class="icon" title="Next match (Enter)">↓</button>
    <div id="searchList" class="popup hidden"></div>
  </div>
  <div class="group">
    <button id="fit" title="Fit graph to view (F)">Fit</button>
    <button id="expandAll" title="Expand one more level everywhere">Expand</button>
    <button id="collapseAll" title="Collapse everything to the top level">Collapse</button>
  </div>
  <div class="group menu-anchor">
    <button id="filtersBtn" title="Choose which relationships and nodes to show">Show ▾</button>
    <div id="filters" class="popup hidden"></div>
  </div>
  <div class="group">
    <label class="toggle" title="Dim everything not connected to the selection"><input type="checkbox" id="focusMode"> Focus</label>
  </div>
  <div class="group seg" id="presetSeg" role="group" aria-label="View"><span class="seglabel">View</span></div>
  <div class="group seg" id="edgeSeg" role="group" aria-label="Arrows"><span class="seglabel">Arrows</span></div>
  <div class="spacer"></div>
  <div class="group">
    <button id="compareBtn" title="Compare two git commits">Compare commits</button>
    <button id="refreshBtn" title="Rescan the workspace">⟳</button>
  </div>
</header>
<div id="banner" class="banner hidden"></div>
<div class="main">
  <div class="canvas" id="canvas">
    <div id="hlBar" class="hlbar hidden"></div>
    <div id="edgeHint" class="edgehint hidden">Select a node to see its connections, or choose <b>Bundled</b> / <b>All</b> under Arrows.</div>
    <div id="empty" class="empty hidden"></div>
    <div class="zoom">
      <button id="zoomIn" title="Zoom in">+</button>
      <button id="zoomOut" title="Zoom out">−</button>
    </div>
    <div id="legend" class="legend"></div>
    <div id="tooltip" class="tooltip hidden"></div>
  </div>
  <aside class="side">
    <div class="tabs">
      <button data-tab="details" class="active">Details</button>
      <button data-tab="ai">Ask AI</button>
    </div>
    <div id="tab-details" class="tabbody"></div>
    <div id="tab-impact" class="tabbody hidden"></div>
    <div id="tab-ai" class="tabbody hidden">
      <div class="ask">
        <textarea id="question" rows="2" placeholder="Ask about the code…  (Ctrl+Enter)"></textarea>
        <div class="aiopts" id="aiOpts"></div>
        <div id="suggestions" class="suggestions"></div>
      </div>
      <div id="history" class="histpop hidden"></div>
      <div id="answer" class="answer"></div>
    </div>
  </aside>
</div>
<footer class="status"><span id="spinner" class="spinner hidden"></span><span id="status">Loading…</span><span class="spacer"></span><span id="stats"></span></footer>`;

export const $ = id => document.getElementById(id);
