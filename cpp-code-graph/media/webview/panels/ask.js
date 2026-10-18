// Ask AI tab: question, investigation steps, routes, evidence, answer and history.

import { $ } from '../shell.js';
import { KIND_INFO, AI_MODES, ROUTE_KINDS, STEP_GLYPHS } from '../constants.js';
import { esc, ago } from '../util.js';
import { vscode, S, persist } from '../state.js';
import { nodeChip, bindLinks } from './details.js';
import { renderer } from '../renderer.js';
import { hopTitle } from '../tooltip.js';
import { trace, setHighlight, revealAll } from '../main.js';

// Short labels for starter questions: [label, question, mode].
export const SUGGESTIONS = [
  ['Project overview', 'What does this project do, and how is it organized?'],
  ['Where it starts', 'Where does the program start, and what happens next?', 'path'],
  ['How classes relate', 'How do the main classes relate to each other?']
];

/** The selected node, when it goes with the next question as context. */
export function contextNode() {
  const n = S.selected && S.nodes.get(S.selected);
  return n && S.contextOff !== n.id ? n : null;
}

/** Starter questions, shown only while the box is empty and nothing has been asked. */
export function renderSuggestions() {
  const el = $('suggestions');
  const list = SUGGESTIONS.slice();
  if (S.mode === 'diff') list.unshift(['What changed', 'Summarize what changed between these commits and why it matters']);
  const n = S.selected && S.nodes.get(S.selected);
  if (n) list.push([`Explain ${n.name}`, `Explain ${n.kind} ${n.qname || n.name}: what is it responsible for, and how does it interact with the rest of the code?`, 'ask', n.id]);
  const shown = list.length > 3 ? list.slice(0, 2).concat(list.slice(-1)) : list;
  el.innerHTML = `<span class="muted">Try</span>${shown.map(([label, q], i) => `<a class="sugg" data-sugg="${i}" title="${esc(q)}">${esc(label)}</a>`).join('')}`;
  el.querySelectorAll('[data-sugg]').forEach(a => {
    const [, q, mode, focus] = shown[+a.dataset.sugg];
    a.onclick = () => ask(q, mode, focus);
  });
  el.classList.toggle('hidden', !!($('question').value.trim() || S.ai.question));
}

export function ask(q, mode, focusId) {
  q = (q || $('question').value).trim();
  if (!q) return;
  $('question').value = q;
  const ctx = contextNode();
  const focus = focusId || (ctx ? ctx.id : null);
  mode = AI_MODES[mode] ? mode : S.aiMode;
  S.ai = { busy: true, question: q, answer: '', model: null, steps: [], mode };
  S.historyOpen = false;
  renderAnswer();
  vscode.postMessage({ type: 'ask', question: q, focus, mode });
}

/** The row under the question box: Trace, the selection as context, history, and Ask or Stop. */
export function renderOpts() {
  const el = $('aiOpts');
  const trace = S.aiMode === 'path';
  const n = S.selected && S.nodes.get(S.selected);
  let ctx = '';
  if (n) {
    const on = S.contextOff !== n.id;
    const info = KIND_INFO[n.kind] || { glyph: '?' };
    ctx = `<button id="ctxChip" class="opt ctx" aria-pressed="${on}" style="--kc: var(--c-${n.kind})" title="${esc(on ? `${n.qname || n.name} goes with the question as context. Click to leave it out.` : `Click to send ${n.qname || n.name} with the question as context`)}"><span class="g">${info.glyph}</span><span class="lbl">${esc(n.name)}</span>${on ? '<span class="x">✕</span>' : ''}</button>`;
  }
  const count = (S.history || []).length;
  const hist = count ? `<button id="historyBtn" class="iconbtn" aria-expanded="${!!S.historyOpen}" title="Recent questions">⟲ ${count}</button>` : '';
  const go = S.ai.busy ? '<button id="cancelAsk">Stop</button>' : `<button id="askBtn" class="primary" title="${esc(AI_MODES[S.aiMode].desc)} (Ctrl+Enter)">${trace ? 'Trace' : 'Ask'}</button>`;
  el.innerHTML = `<button id="traceChip" class="opt" aria-pressed="${trace}" title="${esc(AI_MODES.path.desc)}">⤳ <span class="lbl">Trace</span></button>${ctx}<span class="spacer"></span>${hist}${go}`;
  $('traceChip').onclick = () => {
    S.aiMode = trace ? 'ask' : 'path';
    persist();
    renderOpts();
  };
  if ($('ctxChip'))
    $('ctxChip').onclick = () => {
      S.contextOff = S.contextOff === n.id ? null : n.id;
      renderOpts();
    };
  if ($('historyBtn'))
    $('historyBtn').onclick = ev => {
      ev.stopPropagation();
      S.historyOpen = !S.historyOpen;
      renderHistory();
    };
  if ($('askBtn')) $('askBtn').onclick = () => ask();
  if ($('cancelAsk')) $('cancelAsk').onclick = () => vscode.postMessage({ type: 'cancelAsk' });
  $('question').placeholder = AI_MODES[S.aiMode].placeholder + '  (Ctrl+Enter)';
}

/** Marks the nodes an investigation step looked at (null clears). */
export function setVisited(ids) {
  S.visited = ids && ids.length ? new Set(ids.filter(id => S.nodes.has(id))) : null;
  renderer.refreshStyle();
}

export function renderSteps(a) {
  const rows = a.steps
    .map((st, i) => {
      const live = a.busy && i === a.steps.length - 1;
      const n = (st.nodeIds || []).length;
      return `<li class="stepi${live ? ' live' : ''}" data-step="${i}"${st.note ? ` title="${esc(st.note)}"` : ''}><span class="sg">${STEP_GLYPHS[st.tool] || '•'}</span><span class="st">${esc(st.summary || st.tool)}</span>${n ? `<span class="muted">${n}</span>` : ''}</li>`;
    })
    .join('');
  return `<div class="aidrawer steps"><ol id="aiSteps">${rows}</ol></div>`;
}

/** The answer's routes; answers without routes (single prompt, older history) get one from their path. */
export function aiRoutes(a) {
  if (a.routes && a.routes.length) return a.routes;
  if (!a.path || a.path.length < 2) return [];
  const hops = a.hops || [];
  return [{ label: 'main', divergeAt: 0, steps: a.path.map((id, i) => Object.assign({ id, kind: 'call' }, i ? hops[i - 1] || {} : {})) }];
}

export function currentRoute(a) {
  const routes = aiRoutes(a);
  return routes[Math.min(a.routeIdx || 0, routes.length - 1)] || null;
}

/** The answer's route when there is one worth showing (at least two steps). */
export function shownRoute(a) {
  const route = currentRoute(a);
  return route && route.steps.length >= 2 ? route : null;
}

export function renderRoutes(a) {
  const routes = aiRoutes(a);
  const route = shownRoute(a);
  if (!route) return '';
  const idx = routes.indexOf(route);
  const switcher =
    routes.length > 1
      ? `<div class="seg routesw" role="group" aria-label="Route">${routes
          .map((r, i) => `<button data-route="${i}" class="${i === idx ? 'active' : ''}" aria-pressed="${i === idx}" title="${esc(r.label)}: ${r.steps.length} steps">${esc(r.label)}</button>`)
          .join('')}</div>`
      : '';
  const items = route.steps
    .map((st, i) => {
      const k = ROUTE_KINDS[st.kind] || ROUTE_KINDS.call;
      const tags = [];
      if (i && st.inferred) tags.push(`<span class="tag inferred" title="${esc(hopTitle(st))}">inferred</span>`);
      else if (i && st.dispatch) tags.push(`<span class="tag uncertain" title="${esc(hopTitle(st))}">virtual</span>`);
      else if (i && st.uncertain) tags.push(`<span class="tag uncertain" title="${esc(hopTitle(st))}">by name</span>`);
      if (i && st.returns) tags.push('<span class="tag">returns</span>');
      const site = i && st.site ? ` <a class="site" data-open-file="${esc(st.site.file)}" data-open-line="${st.site.line}" data-side="target" title="Call site ${esc(st.site.file + ':' + st.site.line)}">↗</a>` : '';
      const shared = i < (route.divergeAt || 0) ? ' shared' : '';
      return `<li class="rs k-${st.kind}${shared}"><span class="rn">${i + 1}</span><span class="rk" title="${esc(k.label)}">${k.glyph}</span><div class="rb">${nodeChip(st.id)}${tags.join('')}${site}${st.condition ? `<div class="rc">${esc(st.condition)}</div>` : ''}${st.note ? `<div class="muted rnote">${esc(st.note)}</div>` : ''}</div></li>`;
    })
    .join('');
  return `<div class="aidrawer routebox">${switcher}<ol class="route">${items}</ol></div>`;
}

export function evidenceOf(a) {
  return (a.evidence || []).filter(e => e.file || e.nodeId);
}

export function renderEvidence(a) {
  const ev = evidenceOf(a);
  if (!ev.length) return '';
  const items = ev
    .map(e => {
      const where = e.file
        ? `<a class="site" data-open-file="${esc(e.file)}" data-open-line="${e.line || 1}" data-side="target" title="Open ${esc(e.file + ':' + (e.line || 1))}">${esc(e.file.split('/').pop() + (e.line ? ':' + e.line : ''))}</a>`
        : '';
      return `<li>${e.claim ? esc(e.claim) + ' ' : ''}${e.nodeId && S.nodes.has(e.nodeId) ? nodeChip(e.nodeId) + ' ' : ''}${where}</li>`;
    })
    .join('');
  return `<div class="aidrawer evidence"><ul class="rel">${items}</ul></div>`;
}

export const CONF_TITLES = { high: 'Backed by code the model read', medium: 'Inferred from the graph structure', low: 'Partly guessed; check the evidence' };

export function renderConfidence(a) {
  const why = a.confidenceReason || CONF_TITLES[a.confidence] || '';
  return `<div class="aidrawer confbox"><span class="conf-${a.confidence}">${esc(a.confidence[0].toUpperCase() + a.confidence.slice(1))} confidence.</span> ${esc(why)}${a.model ? `<div class="muted">Answered by ${esc(a.model)}</div>` : ''}</div>`;
}

/** Which drawer under the answer is open: a trace opens its route, anything else starts closed. */
export function openDrawer(a) {
  if (a.open !== undefined) return a.open;
  return a.mode === 'path' && shownRoute(a) ? 'route' : null;
}

/** One strip of small toggles under the answer; each opens its drawer below. */
export function renderStrip(a) {
  const open = openDrawer(a);
  const item = (key, label, cls, title) =>
    `<button class="mi${cls ? ' ' + cls : ''}" data-open="${key}" aria-expanded="${open === key}"${title ? ` title="${esc(title)}"` : ''}>${label} <span class="car">${open === key ? '▴' : '▾'}</span></button>`;
  const route = shownRoute(a);
  const ev = evidenceOf(a).length;
  const n = (a.steps || []).length;
  const items = [];
  if (a.highlight && a.highlight.length) items.push('<button id="aiShow" class="mi hltoggle"></button>');
  if (route) items.push(item('route', `Route ${route.steps.length}`, '', 'The execution path, in call order'));
  if (n) items.push(item('steps', `${n} step${n === 1 ? '' : 's'}`, '', 'How the AI investigated'));
  if (ev) items.push(item('evidence', `${ev} source${ev === 1 ? '' : 's'}`, '', 'The code lines the answer cites'));
  if (a.confidence) {
    const why = a.confidenceReason ? `${a.confidence}: ${a.confidenceReason}` : CONF_TITLES[a.confidence] || '';
    items.push(item('conf', `<span class="dot"></span>${esc(a.confidence)}`, `conf conf-${a.confidence}`, why));
  } else if (a.model) items.push(`<span class="muted">via ${esc(a.model)}</span>`);
  const again = a.fromHistory || a.error ? `<button id="aiAgain" class="mi end" title="Ask this question again with the current code">↻ ${a.error ? 'Try again' : 'Ask again'}</button>` : '';
  if (!items.length && !again) return '';
  const drawers = { route: renderRoutes, steps: renderSteps, evidence: renderEvidence, conf: a.confidence ? renderConfidence : () => '' };
  return `<div class="metastrip">${items.join('<span class="sep">·</span>')}${again}</div>${open && drawers[open] ? drawers[open](a) : ''}`;
}

export function mdLite(text) {
  // Minimal, safe markdown: code blocks, inline code, bold, lists, node refs.
  const blocks = String(text).split(/```[a-zA-Z+]*\n?/);
  return blocks
    .map((b, i) => {
      if (i % 2 === 1) return `<pre class="code">${esc(b.replace(/\n$/, ''))}</pre>`;
      // Node references become placeholders first so formatting cannot touch their ids.
      const chips = [];
      let h = esc(
        b.replace(/\[\[([^\]]+)\]\]/g, (m, id) => {
          if (!S.nodes.has(id)) return m;
          chips.push(nodeChip(id));
          return '\u0000' + (chips.length - 1) + '\u0000';
        })
      );
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
      h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      h = h.replace(/^#{1,4} (.*)$/gm, '<b>$1</b>');
      h = h.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
      h = h.replace(/^\s*\d+\. (.*)$/gm, '<li class="num">$1</li>');
      h = h.replace(/(<li( class="num")?>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
      h = h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
      return h.replace(/\u0000(\d+)\u0000/g, (m, i) => chips[+i]);
    })
    .join('');
}

export function renderAnswer() {
  const el = $('answer');
  const a = S.ai;
  renderHistory();
  renderSuggestions();
  if (!a.question) {
    el.innerHTML = '';
    return;
  }
  const trace = a.mode === 'path' ? `<span class="tg" title="${esc(AI_MODES.path.desc)}">⤳</span>` : '';
  const when = a.fromHistory && a.time ? `<span class="muted when">${esc(ago(a.time))}</span>` : '';
  const steps = a.steps || [];
  let body;
  if (a.busy) {
    // While it works: one line for the current step; the full list is one click away.
    const cur = steps[steps.length - 1];
    const open = a.open === 'steps';
    const live = cur
      ? `<div class="ailive" id="aiLive"><span class="sg">${STEP_GLYPHS[cur.tool] || '•'}</span><span class="st">${esc(cur.summary || cur.tool)}…</span><button class="mi" data-open="steps" aria-expanded="${open}" title="How the AI is investigating">${steps.length} step${steps.length === 1 ? '' : 's'} <span class="car">${open ? '▴' : '▾'}</span></button></div>${open ? renderSteps(a) : ''}`
      : '';
    body = `${live}<div class="a">${a.answer ? mdLite(a.answer) : cur ? '' : '<span class="muted">Thinking…</span>'}</div>`;
  } else body = `<div class="a${a.error ? ' err' : ''}">${a.answer ? mdLite(a.answer) : ''}</div>${renderStrip(a)}`;
  el.innerHTML = `<div class="q${trace ? ' trace' : ''}">${trace}<span class="qt">${esc(a.question)}</span>${when}</div>${body}`;
  if ($('aiAgain'))
    $('aiAgain').onclick = () => {
      S.aiMode = AI_MODES[a.mode] ? a.mode : 'ask';
      persist();
      ask(a.question, S.aiMode);
    };
  if ($('aiShow')) {
    $('aiShow').onclick = () => (aiHighlightOn() ? setHighlight(null) : applyAiHighlight(true));
    syncAiToggle();
  }
  el.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => {
      a.open = openDrawer(a) === b.dataset.open ? null : b.dataset.open;
      renderAnswer();
    };
  });
  el.querySelectorAll('[data-route]').forEach(b => {
    b.onclick = () => {
      a.routeIdx = +b.dataset.route;
      renderAnswer();
      applyAiHighlight(false);
    };
  });
  const list = $('aiSteps');
  if (list) {
    list.querySelectorAll('.stepi').forEach(li => {
      const st = a.steps[+li.dataset.step];
      li.onmouseenter = () => setVisited(st.nodeIds);
      li.onmouseleave = () => setVisited(a.busy && a.steps.length ? a.steps[a.steps.length - 1].nodeIds : null);
      li.onclick = () => {
        const ids = new Set((st.nodeIds || []).filter(id => S.nodes.has(id)));
        if (!ids.size) return;
        S.highlight = { ids, path: [], label: `Step ${+li.dataset.step + 1}: ${st.summary || st.tool}` };
        revealAll(ids);
      };
    });
  }
  bindLinks(el);
}

export function renderHistory() {
  const el = $('history');
  const list = S.history || [];
  if (!list.length) S.historyOpen = false;
  el.classList.toggle('hidden', !S.historyOpen);
  renderOpts();
  if (!list.length) {
    el.innerHTML = '';
    return;
  }
  const busy = S.ai.busy;
  const rows = list
    .map(e => {
      const cls = ['histi'];
      if (e.id === S.ai.entryId) cls.push('active');
      if (busy) cls.push('disabled');
      const glyph = e.mode === 'path' ? '⤳' : '?';
      return `<li class="${cls.join(' ')}" data-hist="${esc(e.id)}" title="${esc(busy ? 'Wait for the current answer' : e.question)}"><span class="hg">${glyph}</span><span class="hq">${esc(e.question)}</span>${e.compare ? '<span class="pill sm" title="Asked while comparing commits">diff</span>' : ''}<span class="muted ht">${esc(ago(e.time))}</span><button class="hx" data-hist-del="${esc(e.id)}" title="Remove from history">✕</button></li>`;
    })
    .join('');
  el.innerHTML = `<ul class="hist">${rows}</ul><div class="histfoot"><button id="historyClear" class="linkbtn" title="Delete every saved question in this workspace">Clear history</button></div>`;
  el.querySelectorAll('[data-hist]').forEach(li => {
    li.onclick = ev => {
      ev.stopPropagation();
      if (ev.target.closest('[data-hist-del]') || S.ai.busy) return;
      const e = S.history.find(x => x.id === li.dataset.hist);
      if (!e) return;
      S.historyOpen = false;
      openHistory(e);
    };
  });
  el.querySelectorAll('[data-hist-del]').forEach(b => {
    b.onclick = ev => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'aiHistoryDelete', id: b.dataset.histDel });
    };
  });
  $('historyClear').onclick = () => vscode.postMessage({ type: 'aiHistoryClear' });
}

/** Shows a saved answer again, with its steps, evidence and highlight. */
export function openHistory(e) {
  S.ai = {
    busy: false, question: e.question, mode: e.mode, steps: (e.steps || []).map((s, i) => ({ ...s, i })),
    answer: e.answer, highlight: e.highlight || [], path: e.path || [], hops: e.hops, routes: e.routes, routeIdx: 0, evidence: e.evidence, confidence: e.confidence, confidenceReason: e.confidenceReason,
    model: e.model, entryId: e.id, time: e.time, fromHistory: true
  };
  S.visited = null;
  renderAnswer();
  if (S.ai.highlight.length) applyAiHighlight(false);
  else setHighlight(null);
}

/** Whether the graph currently shows the highlight of the latest AI answer. */
export function aiHighlightOn() {
  return !!(S.highlight && S.highlight.source === 'ai' && S.highlight.answer === S.ai);
}

/** Updates the answer's highlight toggle after anything changed the highlight. */
export function syncAiToggle() {
  const b = $('aiShow');
  if (!b) return;
  const on = aiHighlightOn();
  const n = (S.ai.highlight || []).filter(id => S.nodes.has(id)).length;
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Remove the highlight from the graph' : 'Highlight the nodes from this answer in the graph';
  b.setAttribute('aria-label', `${on ? 'Highlighted' : 'Highlight'} in graph: ${n} node${n === 1 ? '' : 's'}`);
  b.innerHTML = `<span class="sw"></span>${n}`;
}

export function applyAiHighlight(revealToo) {
  const a = S.ai;
  if (!a.highlight || !a.highlight.length) return;
  const route = currentRoute(a);
  // Steps whose node no longer exists are dropped, keeping each step's kind and hop with its node.
  const steps = route ? route.steps.filter(st => S.nodes.has(st.id)) : (a.path || []).filter(id => S.nodes.has(id)).map(id => ({ id, kind: 'call' }));
  const ids = new Set(a.highlight.filter(id => S.nodes.has(id)));
  for (const st of steps) ids.add(st.id);
  const label = 'AI: ' + (a.question.length > 60 ? a.question.slice(0, 57) + '…' : a.question) + (route && aiRoutes(a).length > 1 ? ` (${route.label})` : '');
  S.highlight = { ids, path: steps.map(st => st.id), route: { steps, divergeAt: route ? route.divergeAt || 0 : 0 }, label, source: 'ai', answer: a };
  if (revealToo) revealAll(ids);
  else renderer.refreshStyle();
}
