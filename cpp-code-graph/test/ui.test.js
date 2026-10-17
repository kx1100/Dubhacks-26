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
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/test/harness.html` });
    for (let i = 0; i < 50; i++) {
      if (await evaluate('!!(window.__codeGraph && window.__codeGraph.S.graph)').catch(() => false)) break;
      await sleep(100);
    }

    // Helpers run inside the page.
    await evaluate(`
      window.cg = window.__codeGraph;
      window.nodeByName = name => cg.S.graph.nodes.find(n => n.name === name);
      window.fire = (el, type, extra) => el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0, pointerId: 1 }, extra)));
      window.click = el => { fire(el, 'pointerdown'); fire(el, 'pointerup'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
      window.waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
      true`);

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

    console.log('ui: ok');
    ws.close();
  } finally {
    chrome.kill();
    server.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
  }
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
