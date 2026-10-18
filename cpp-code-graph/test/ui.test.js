// Drives the webview harness in headless Chrome over the DevTools protocol.
//   node test/ui.test.js            (set CHROME to the browser executable if it is not found)
// Checks inline code cards and the header <-> source edges.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!CHROME) {
  console.log('ui: skipped (no Chrome/Edge found; set CHROME)');
  process.exit(0);
}
const HTTP_PORT = 5190 + Math.floor(Math.random() * 50);
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js')], { env: { ...process.env, PORT: String(HTTP_PORT) }, stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        target = (await res.json()).find(t => t.type === 'page');
      } catch {
        await sleep(200);
      }
    }
    assert(target, 'Chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    const send = (method, params) => new Promise((res, rej) => (pending.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params }))));
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Page.enable');
    // Loads the harness (optionally with a query string) and defines helpers inside the page.
    const open = async query => {
      await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/test/harness.html${query || ''}` });
      await sleep(150);
      for (let i = 0; i < 80; i++) {
        if (await evaluate('!!(window.__codeGraph && window.__codeGraph.S.graph && document.querySelector("#layerNodes .node"))').catch(() => false)) break;
        await sleep(100);
      }
      await evaluate(`
      window.cg = window.__codeGraph;
      window.nodeByName = name => cg.S.graph.nodes.find(n => n.name === name);
      window.fire = (el, type, extra) => el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0, pointerId: 1 }, extra)));
      window.click = el => { fire(el, 'pointerdown'); fire(el, 'pointerup'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
      window.waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
      true`);
    };
    await open('');

    // 1. Pairing edges exist in the data and are on by default.
    const pairs = await evaluate(`cg.S.graph.edges.filter(e => e.kind === 'pairs').map(e => e.s.replace('file:', '') + '>' + e.t.replace('file:', '') + ':' + e.n)`);
    assert(pairs.includes('c/logger.h>c/logger.c:3'), 'logger.h pairs with logger.c: ' + pairs);
    assert(pairs.some(p => p.startsWith('include/geo/shape.h>src/shape.cpp')), 'shape.h pairs with shape.cpp');
    assert.strictEqual(await evaluate('cg.S.edgeOn.pairs'), true);

    // 2. A free function remembers where its prototype is.
    const decl = await evaluate(`JSON.stringify((({ declFile, declLine, file, line }) => ({ declFile, declLine, file, line }))(nodeByName('log_init')))`);
    assert.deepStrictEqual(JSON.parse(decl), { declFile: 'c/logger.h', declLine: 15, file: 'c/logger.c', line: 16 });

    // 3. Clicking the </> button opens the code card with highlighted, numbered source.
    await evaluate(`cg.reveal(nodeByName('log_init').id, { center: false }); true`);
    const btn = `document.querySelector('[data-id="' + CSS.escape(nodeByName('log_init').id) + '"] [data-code]')`;
    assert(await evaluate(`!!${btn}`), 'code button is drawn for a function');
    await evaluate(`click(${btn}); true`);
    assert(await evaluate(`waitFor(() => document.querySelectorAll('.codecard .cl[data-line]').length > 0)`), 'code card shows lines');
    const card = JSON.parse(await evaluate(`JSON.stringify({
      first: document.querySelector('.codecard .cl .ln').textContent,
      text: document.querySelector('.codecard').textContent,
      kw: !!document.querySelector('.codecard .tk-kw, .codecard .tk-ty'),
      fn: !!document.querySelector('.codecard .tk-fn'),
      sent: window.__sent.filter(m => m.type === 'getSource').length
    })`));
    assert.strictEqual(card.first, '16');
    assert(card.text.includes('log_init'), 'card text');
    assert(card.kw && card.fn, 'syntax highlighting');
    assert(card.sent >= 1, 'webview asked the host for the source');
    assert(await evaluate(`cg.S.codeOpen.has(nodeByName('log_init').id)`));

    // 4. The card is sized to the node, so later layout is not overlapped.
    const geometry = JSON.parse(await evaluate(`JSON.stringify((() => { const b = cg.S.layout.abs.get(nodeByName('log_init').id); return { code: !!b.code, h: b.h }; })())`));
    assert(geometry.code && geometry.h > 28, 'code box is taller than a plain leaf');

    // 5. Clicking a line asks the extension to open that line.
    await evaluate(`window.__sent.length = 0; document.querySelector('.codecard .cl[data-line="18"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    const opened = await evaluate(`JSON.stringify(window.__sent.find(m => m.type === 'open'))`);
    assert.deepStrictEqual(pick(JSON.parse(opened), ['type', 'file', 'line']), { type: 'open', file: 'c/logger.c', line: 18 });

    // 6. A node cannot be expanded and show code at once.
    await evaluate(`cg.toggleCode(nodeByName('Shape').id, true); cg.toggle(nodeByName('Shape').id, true); true`);
    assert.strictEqual(await evaluate(`cg.S.codeOpen.has(nodeByName('Shape').id) && cg.S.expanded.has(nodeByName('Shape').id)`), false);

    // 7. Hide again.
    await evaluate(`cg.toggleCode(nodeByName('log_init').id, false); true`);
    assert.strictEqual(await evaluate(`!!document.querySelector('[data-id="' + CSS.escape(nodeByName('log_init').id) + '"] .codecard')`), false);

    // 8. Default view: Structure, arrows only for the selection.
    await open('');
    assert.strictEqual(await evaluate('cg.S.preset'), 'structure');
    assert.strictEqual(await evaluate('cg.S.edgeMode'), 'selected');
    assert.strictEqual(await evaluate("document.querySelectorAll('#layerEdges .edge').length"), 0, 'no arrows without a selection');
    assert.strictEqual(await evaluate("!document.getElementById('edgeHint').classList.contains('hidden')"), true, 'hint shown');
    await evaluate(`cg.reveal(nodeByName('log_init').id, { center: false }); true`);
    const selected = JSON.parse(await evaluate(`JSON.stringify({ n: document.querySelectorAll('#layerEdges .edge').length, rel: document.querySelectorAll('#layerEdges .edge.related').length })`));
    assert(selected.n > 0 && selected.n === selected.rel, 'only arrows of the selection are drawn: ' + JSON.stringify(selected));
    await evaluate("cg.setEdgeMode('all'); true");
    const all = await evaluate("document.querySelectorAll('#layerEdges .edge').length");
    assert(all > selected.n, 'All shows more arrows than Selected');

    // 9. Collapse others keeps only the neighbourhood of the node open.
    await evaluate(`cg.focusArea(nodeByName('log_init').id); true`);
    assert.strictEqual(await evaluate("cg.S.expanded.has('file:src/main.cpp')"), true, 'the file of the caller stays open');
    assert.strictEqual(await evaluate("cg.S.expanded.has('file:src/shape.cpp')"), false, 'unrelated files are collapsed');

    // 10. Calls view: left to right, bundled arrows whose counts add up.
    await open('?preset=calls');
    assert(await evaluate("waitFor(() => cg.S.preset === 'calls' && document.querySelectorAll('#layerEdges .edge.bundle').length > 0, 5000)"), 'calls view applied');
    const calls = JSON.parse(await evaluate(`JSON.stringify((() => {
      const L = cg.S.layout; const abs = L.abs;
      return { dir: cg.S.direction, mode: cg.S.edgeMode, srcX: abs.get('dir:src').x, cX: abs.get('dir:c').x,
        bundleSumOk: L.vis.bundles.every(b => b.count === b.members.reduce((n, m) => n + m.count, 0) && b.members.length > 1),
        bundles: L.vis.bundles.length, bundleEls: document.querySelectorAll('#layerEdges .edge.bundle').length };
    })())`));
    assert.strictEqual(calls.dir, 'LR');
    assert.strictEqual(calls.mode, 'bundled');
    assert(calls.srcX < calls.cX, 'callers (src) are left of callees (c): ' + JSON.stringify(calls));
    assert(calls.bundles > 0 && calls.bundleEls >= calls.bundles && calls.bundleSumOk, 'bundles drawn and consistent: ' + JSON.stringify(calls));
    await evaluate("cg.applyPreset('structure'); true");
    assert.strictEqual(await evaluate('cg.S.direction'), 'TB');
    await evaluate("cg.applyPreset('includes'); true");
    assert.deepStrictEqual(JSON.parse(await evaluate("JSON.stringify(Object.keys(cg.S.edgeOn).filter(k => cg.S.edgeOn[k]).sort())")), ['includes', 'pairs']);

    // 11. A hand-made filter change marks the view as Custom.
    await evaluate("document.querySelector('#filtersBtn').click(); document.querySelector('[data-edge-kind=\"uses\"]').click(); true");
    assert.strictEqual(await evaluate('cg.S.preset'), 'custom');

    // 12. On a bigger project long arrows become labelled stubs that jump to the other end.
    ensureLargeFixture();
    await open('?large&preset=calls');
    // The harness applies ?preset after load, so wait for the result.
    assert(await evaluate("waitFor(() => document.querySelectorAll('#layerBadges .badge').length > 0, 5000)"), 'long arrows are drawn as stubs with labels');
    await evaluate(`(() => { const b = document.querySelector('#layerBadges .badge'); window.__badgeTarget = b.dataset.badge; click(b); })()`);
    assert.strictEqual(await evaluate('cg.S.selected'), await evaluate('window.__badgeTarget'), 'clicking a label selects the node it names');

    // 13. Ask AI: the mode chip is sent with the question, steps stream into a timeline,
    //     the current step's nodes are marked, and the answer shows evidence and confidence.
    await open('?ai');
    await evaluate("document.querySelector('.tabs [data-tab=\"ai\"]').click(); true");
    const modes = await evaluate("[...document.querySelectorAll('#aiModes button')].map(b => b.dataset.aiMode + (b.classList.contains('active') ? '*' : ''))");
    assert.deepStrictEqual(modes, ['ask*', 'path']);
    await evaluate("document.querySelector('[data-ai-mode=\"path\"]').click(); true");
    assert.strictEqual(await evaluate('cg.S.aiMode'), 'path');
    assert.match(await evaluate("document.getElementById('question').placeholder"), /What to trace/);
    await evaluate("window.__sent.length = 0; document.getElementById('question').value = 'How are shapes drawn?'; document.getElementById('askBtn').click(); true");
    const askMsg = JSON.parse(await evaluate("JSON.stringify(window.__sent.find(m => m.type === 'ask'))"));
    assert.strictEqual(askMsg.mode, 'path');
    assert(await evaluate("waitFor(() => document.querySelectorAll('#aiSteps .stepi').length === 1)"), 'first step shown');
    const live = JSON.parse(await evaluate(`JSON.stringify({
      liveRow: !!document.querySelector('#aiSteps .stepi.live'),
      visited: document.querySelectorAll('#layerNodes .node.visited').length,
      stop: !!document.getElementById('cancelAsk'),
      text: document.querySelector('#answer .a').textContent
    })`));
    assert(live.liveRow && live.visited > 0 && live.stop, 'live step marks nodes: ' + JSON.stringify(live));
    assert.match(live.text, /Investigating/);
    assert(await evaluate("waitFor(() => !cg.S.ai.busy, 3000)"), 'answer arrives');
    const done = JSON.parse(await evaluate(`JSON.stringify({
      steps: [...document.querySelectorAll('#aiSteps .stepi .st')].map(e => e.textContent),
      live: document.querySelectorAll('#aiSteps .stepi.live').length,
      visited: document.querySelectorAll('#layerNodes .node.visited').length,
      chips: document.querySelectorAll('#answer .a .chip').length,
      evidence: [...document.querySelectorAll('#answer .evidence a.site')].map(a => a.textContent),
      conf: (document.querySelector('#answer .conf') || {}).textContent,
      mode: document.querySelector('#answer .q .pill').textContent,
      path: cg.S.highlight && cg.S.highlight.path.length,
      summary: document.querySelector('#aiSteps summary').textContent
    })`));
    assert.deepStrictEqual(done.steps, ['Searched the question → 3 symbols', 'Outgoing calls of geo::Canvas::render (4)', 'Read the code of geo::Canvas::render']);
    assert.strictEqual(done.live, 0);
    assert.strictEqual(done.visited, 0, 'visited marks clear when the answer arrives');
    assert.strictEqual(done.chips, 4);
    assert.deepStrictEqual(done.evidence, ['canvas.cpp:18', 'main.cpp:15']);
    assert.strictEqual(done.conf, 'high confidence');
    assert.strictEqual(done.mode, 'Trace path');
    assert.strictEqual(done.path, 4, 'answer path is numbered in the graph');
    assert.match(done.summary, /Investigation\s+3 steps/);
    // The question box is cleared once the answer arrives.
    assert.strictEqual(await evaluate("document.getElementById('question').value"), '');
    // The answer's highlight can be switched off and on again, and stays in sync with the banner.
    const toggle = () => evaluate(`JSON.stringify({ on: document.getElementById('aiShow').getAttribute('aria-pressed'), text: document.getElementById('aiShow').textContent, hl: !!cg.S.highlight, path: cg.S.highlight ? cg.S.highlight.path.length : 0 })`).then(JSON.parse);
    let t = await toggle();
    assert.deepStrictEqual([t.on, t.hl, t.path], ['true', true, 4]);
    assert.match(t.text, /Highlighted in graph\s*4/);
    await evaluate("document.getElementById('aiShow').click(); true");
    t = await toggle();
    assert.deepStrictEqual([t.on, t.hl], ['false', false]);
    assert.match(t.text, /^Highlight in graph/);
    await evaluate("document.getElementById('aiShow').click(); true");
    t = await toggle();
    assert.deepStrictEqual([t.on, t.hl, t.path], ['true', true, 4]);
    await evaluate("document.getElementById('hlClear').click(); true");
    t = await toggle();
    assert.deepStrictEqual([t.on, t.hl], ['false', false], 'closing the banner turns the toggle off');
    await evaluate("document.getElementById('aiShow').click(); true");
    assert.strictEqual((await toggle()).on, 'true');
    // Hovering a step marks its nodes; clicking it highlights them.
    await evaluate("document.querySelectorAll('#aiSteps .stepi')[1].dispatchEvent(new MouseEvent('mouseenter')); true");
    assert(await evaluate("document.querySelectorAll('#layerNodes .node.visited').length > 0"), 'hover marks the step nodes');
    await evaluate("document.querySelectorAll('#aiSteps .stepi')[1].dispatchEvent(new MouseEvent('mouseleave')); true");
    assert.strictEqual(await evaluate("document.querySelectorAll('#layerNodes .node.visited').length"), 0);
    await evaluate("document.querySelectorAll('#aiSteps .stepi')[1].click(); true");
    assert.strictEqual(await evaluate('cg.S.highlight.label'), 'Step 2: Outgoing calls of geo::Canvas::render (4)');
    assert.strictEqual((await toggle()).on, 'false', 'a step highlight is not the answer highlight');
    assert.strictEqual(await evaluate('cg.S.highlight.ids.size'), 3);
    // Evidence links open the cited line.
    await evaluate("window.__sent.length = 0; document.querySelector('#answer .evidence a.site').click(); true");
    assert.deepStrictEqual(pick(JSON.parse(await evaluate("JSON.stringify(window.__sent.find(m => m.type === 'open'))")), ['file', 'line']), { file: 'src/canvas.cpp', line: 18 });
    // Explain from the details panel always uses Ask.
    await evaluate(`cg.reveal(nodeByName('log_init').id, { center: false }); window.__sent.length = 0; document.querySelector('.tabs [data-tab="details"]').click(); document.querySelector('[data-act="explain"]').click(); true`);
    assert.strictEqual(JSON.parse(await evaluate("JSON.stringify(window.__sent.find(m => m.type === 'ask'))")).mode, 'ask');

    // 14. History: answers are kept, newest first; an old one comes back with its steps and highlight.
    assert(await evaluate('waitFor(() => !cg.S.ai.busy && cg.S.history.length === 2, 3000)'), 'second answer saved');
    const hist = () => evaluate(`JSON.stringify([...document.querySelectorAll('#history .histi')].map(li => ({ q: li.querySelector('.hq').textContent, g: li.querySelector('.hg').textContent, active: li.classList.contains('active'), disabled: li.classList.contains('disabled') })))`).then(JSON.parse);
    let rows = await hist();
    assert.strictEqual(rows.length, 2);
    assert.match(rows[0].q, /^Explain function log_init/);
    assert.deepStrictEqual([rows[0].g, rows[0].active, rows[1].q, rows[1].g, rows[1].active], ['?', true, 'How are shapes drawn?', '⤳', false]);
    await evaluate("cg.S.highlight = null; document.querySelectorAll('#history .histi')[1].click(); true");
    const restored = JSON.parse(await evaluate(`JSON.stringify({
      q: cg.S.ai.question, from: cg.S.ai.fromHistory, mode: document.querySelector('#answer .q .pill').textContent,
      when: (document.querySelector('#answer .q .when') || {}).textContent,
      steps: document.querySelectorAll('#aiSteps .stepi').length, text: document.querySelector('#answer .a').textContent,
      toggle: document.getElementById('aiShow').getAttribute('aria-pressed'), path: cg.S.highlight && cg.S.highlight.path.length,
      evidence: document.querySelectorAll('#answer .evidence a.site').length, again: !!document.getElementById('aiAgain')
    })`));
    assert.deepStrictEqual(
      [restored.q, restored.from, restored.mode, restored.steps, restored.toggle, restored.path, restored.evidence, restored.again],
      ['How are shapes drawn?', true, 'Trace path', 3, 'true', 4, 2, true]
    );
    assert.match(restored.text, /About “How are shapes drawn\?”/);
    assert.match(restored.when, /just now/);
    rows = await hist();
    assert.deepStrictEqual(rows.map(r => r.active), [false, true]);
    // Ask again re-asks in the saved mode; history rows are disabled until the answer arrives.
    await evaluate("window.__sent.length = 0; document.getElementById('aiAgain').click(); true");
    assert.deepStrictEqual(pick(JSON.parse(await evaluate("JSON.stringify(window.__sent.find(m => m.type === 'ask'))")), ['question', 'mode']), { question: 'How are shapes drawn?', mode: 'path' });
    assert.strictEqual(await evaluate('cg.S.aiMode'), 'path');
    rows = await hist();
    assert(rows.every(r => r.disabled), 'history is disabled while busy');
    await evaluate("document.querySelectorAll('#history .histi')[0].click(); true");
    assert.strictEqual(await evaluate('cg.S.ai.busy'), true, 'clicking history while busy does nothing');
    assert(await evaluate('waitFor(() => !cg.S.ai.busy && cg.S.history.length === 3, 3000)'), 'third answer saved');
    // Delete one, then clear all.
    await evaluate("document.querySelectorAll('#history .histi .hx')[2].click(); true");
    assert(await evaluate('waitFor(() => cg.S.history.length === 2)'), 'entry deleted');
    assert.strictEqual((await hist()).length, 2);
    await evaluate("document.getElementById('historyClear').click(); true");
    assert(await evaluate("waitFor(() => cg.S.history.length === 0 && document.getElementById('history').innerHTML === '')"), 'history cleared');

    // 15. Trace path: routes with step kinds, conditions and hop styles, a route switcher, and "Trace path with AI".
    await open('?ai');
    await evaluate("cg.reveal(nodeByName('render').id, { center: false }); window.__sent.length = 0; document.querySelector('[data-act=\"tracePath\"]').click(); true");
    const traceAsk = JSON.parse(await evaluate("JSON.stringify(window.__sent.find(m => m.type === 'ask'))"));
    assert.deepStrictEqual(pick(traceAsk, ['question', 'mode', 'focus']), { question: 'What happens when geo::Canvas::render runs?', mode: 'path', focus: await evaluate("nodeByName('render').id") });
    assert.strictEqual(await evaluate('cg.S.aiMode'), 'path');
    assert(await evaluate('waitFor(() => !cg.S.ai.busy, 3000)'), 'trace answered');
    await evaluate("document.getElementById('hlReveal') && document.getElementById('hlReveal').click(); true");
    const route = () => evaluate(`JSON.stringify({
      tabs: [...document.querySelectorAll('.routesw [data-route]')].map(b => b.textContent + (b.classList.contains('active') ? '*' : '')),
      kinds: [...document.querySelectorAll('ol.route .rs')].map(li => [...li.classList].find(c => c.startsWith('k-')).slice(2)),
      shared: [...document.querySelectorAll('ol.route .rs')].map(li => li.classList.contains('shared')),
      conds: [...document.querySelectorAll('ol.route .rc')].map(e => e.textContent),
      tags: [...document.querySelectorAll('ol.route .tag')].map(e => e.textContent),
      path: cg.S.highlight.path.map(id => cg.S.nodes.get(id).name),
      label: cg.S.highlight.label,
      segs: [...document.querySelectorAll('#layerPath .exec-path')].map(p => [...p.classList].filter(c => c !== 'exec-path').join(' ')),
      steps: [...document.querySelectorAll('#layerPath .step')].map(g => [...g.classList].filter(c => c !== 'step').join(' ')),
      condLabels: [...document.querySelectorAll('#layerPath .cond text')].map(t => t.textContent)
    })`).then(JSON.parse);
    let r = await route();
    assert.deepStrictEqual(r.tabs, ['main*', 'circle', 'shutdown']);
    assert.deepStrictEqual(r.path, ['main', 'render', 'draw', 'plot']);
    assert.deepStrictEqual(r.kinds, ['call', 'call', 'call', 'call']);
    assert.deepStrictEqual(r.tags, ['by name']);
    assert.strictEqual(r.label, 'AI: What happens when geo::Canvas::render runs? (main)');
    assert.deepStrictEqual(r.segs, ['', 'uncertain', ''], 'segments: call, by-name call, call');
    // An alternative: shares main's first step, branches with a condition, reaches the override.
    await evaluate("document.querySelector('[data-route=\"1\"]').click(); true");
    r = await route();
    assert.deepStrictEqual(r.tabs, ['main', 'circle*', 'shutdown']);
    assert.deepStrictEqual(r.path, ['main', 'render', 'draw', 'plot']);
    assert.strictEqual(await evaluate("cg.S.nodes.get(cg.S.highlight.path[2]).qname"), 'geo::Circle::draw');
    assert.deepStrictEqual(r.kinds, ['call', 'branch', 'callback', 'call']);
    assert.deepStrictEqual(r.shared, [true, false, false, false]);
    assert.deepStrictEqual(r.conds, ['shape is a Circle']);
    assert.deepStrictEqual(r.condLabels, ['shape is a Circle']);
    assert.match(r.label, /\(circle\)$/);
    assert(r.segs[0].includes('shared') && r.steps[0].includes('shared'), 'the shared prefix is faded: ' + JSON.stringify(r));
    assert(r.steps.some(c => c.includes('k-branch')) && r.steps.some(c => c.includes('k-callback')));
    // An error route with an inferred hop.
    await evaluate("document.querySelector('[data-route=\"2\"]').click(); true");
    r = await route();
    assert.deepStrictEqual(r.kinds, ['call', 'error', 'call']);
    assert.deepStrictEqual(r.tags, ['inferred']);
    assert.deepStrictEqual(r.conds, ['if (!g_file)']);
    assert.deepStrictEqual(r.segs, ['', 'inferred']);
    assert(r.steps.some(c => c.includes('k-error')));
    // The highlight switch keeps the chosen route.
    await evaluate("document.getElementById('aiShow').click(); document.getElementById('aiShow').click(); true");
    assert.match(await evaluate('cg.S.highlight.label'), /\(shutdown\)$/);
    // Restoring from history keeps the routes.
    assert(await evaluate('waitFor(() => cg.S.history.length === 1)'));
    await evaluate("cg.S.highlight = null; document.querySelector('#history .histi').click(); true");
    r = await route();
    assert.deepStrictEqual(r.tabs, ['main*', 'circle', 'shutdown']);
    assert.deepStrictEqual(r.path, ['main', 'render', 'draw', 'plot']);
    // An Ask answer with a plain path still lists it as a route.
    await evaluate("document.querySelector('[data-ai-mode=\"ask\"]').click(); document.getElementById('question').value = 'Where does drawing start?'; document.getElementById('askBtn').click(); true");
    assert(await evaluate('waitFor(() => !cg.S.ai.busy && cg.S.history.length === 2, 3000)'));
    r = await route();
    assert.deepStrictEqual([r.tabs, r.path, r.tags], [[], ['main', 'render', 'draw', 'plot'], ['by name']]);

    console.log('ui: ok');
    ws.close();
  } finally {
    chrome.kill();
    server.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
  }
}

// The big fixture is generated (test/gen-large.js); create it when it is missing.
function ensureLargeFixture() {
  const target = path.join(__dirname, 'fixtures-large.js');
  if (fs.existsSync(target)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-large-'));
  const run = (...args) => require('child_process').execFileSync(process.execPath, args, { stdio: 'ignore' });
  run(path.join(__dirname, 'gen-large.js'), path.join(tmp, 'proj'), '40');
  run(path.join(__dirname, 'make-fixtures.js'), path.join(tmp, 'proj'), tmp);
  fs.copyFileSync(path.join(tmp, 'fixtures.js'), target);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map(k => [k, obj[k]]));
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
