'use strict';

// Investigation agent: a bounded tool-calling loop over GraphTools. The model
// looks things up step by step (search, follow relationships, read code) and
// ends by calling `finish` with an answer, highlighted nodes, an execution path
// and cited evidence. Everything it returns is checked against the graph.
//
// No `vscode` dependency: the model is reached through an adapter
//   llm.send(messages, {tools, forceTool}, token) -> {text, calls:[{id, name, input}]}
// where messages are plain objects:
//   {role:'user', text} | {role:'assistant', text, calls} | {role:'user', results:[{id, text}]}

const { GraphTools } = require('./graphTools');

const MAX_STEPS = 12;
const PRELOAD_MAX = 5; // functions whose source is given up front
const PRELOAD_LINES = 60; // lines of each
const RESULT_CHARS = 6000; // longest tool result sent back to the model
const EDGE_KINDS = ['calls', 'includes', 'inherits', 'overrides', 'uses', 'pairs'];

const nodeArg = { type: 'string', description: 'Node ref such as N12 (preferred), or a qualified name such as geo::Canvas::render, or a file name.' };
const kindsArg = { type: 'array', items: { type: 'string', enum: EDGE_KINDS }, description: 'Relationship kinds to follow. Omit for all.' };

const TOOLS = [
  {
    name: 'search_symbols',
    description: 'Find functions, methods, classes, enums, variables and files whose names, signatures or bodies match the words. Use first to locate the code a question is about.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or identifiers, e.g. "log message" or "pixelCount".' },
        kinds: { type: 'array', items: { type: 'string', enum: ['function', 'method', 'class', 'struct', 'union', 'enum', 'variable', 'field', 'file', 'namespace'] } },
        k: { type: 'number', description: 'Maximum results (default 10).' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_node',
    description: 'Details of one node: signature, where it is declared and defined, what it contains and how many relationships it has.',
    inputSchema: { type: 'object', properties: { node: nodeArg }, required: ['node'] }
  },
  {
    name: 'neighbors',
    description: 'Direct relationships of a node, with the file:line of each call site. direction "out" = what it calls/includes/uses, "in" = what calls/includes/uses it.',
    inputSchema: {
      type: 'object',
      properties: { node: nodeArg, direction: { type: 'string', enum: ['out', 'in', 'both'] }, kinds: kindsArg },
      required: ['node']
    }
  },
  {
    name: 'call_paths',
    description: 'The shortest call chains from one node to another. Either end may be a class or file, meaning any function in it. Use to check how one piece of code reaches another.',
    inputSchema: {
      type: 'object',
      properties: { from: nodeArg, to: nodeArg, max_depth: { type: 'number', description: 'Longest chain in calls (default 8).' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'reach',
    description: 'Everything a node reaches transitively (direction "out", e.g. all callees) or everything that reaches it (direction "in", e.g. all callers), with the distance.',
    inputSchema: {
      type: 'object',
      properties: { node: nodeArg, direction: { type: 'string', enum: ['out', 'in'] }, kinds: kindsArg, max_depth: { type: 'number', description: 'Default 6.' } },
      required: ['node', 'direction']
    }
  },
  {
    name: 'read_code',
    description: 'Source code with line numbers: the definition of a node, or a line range of a file. Read code before making claims about what it does.',
    inputSchema: {
      type: 'object',
      properties: {
        node: nodeArg,
        file: { type: 'string', description: 'Workspace-relative file path, when reading a range instead of a node.' },
        start: { type: 'number' },
        end: { type: 'number' }
      }
    }
  },
  {
    name: 'grep',
    description: 'Search all source lines for a regular expression (case-insensitive). Each hit names the function or class that contains it. Use for things the graph does not model: macros, function pointers, string literals, comments.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, file: { type: 'string', description: 'Only files whose path contains this text.' } },
      required: ['pattern']
    }
  },
  {
    name: 'finish',
    description: 'Give the final answer. Call exactly once, when you have enough evidence (or when told to stop).',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer in Markdown, referring to nodes inline as [[N12]].' },
        highlight: { type: 'array', items: { type: 'string' }, description: 'Refs of every node relevant to the answer.' },
        path: { type: 'array', items: { type: 'string' }, description: 'Refs of the main execution path in call order, or empty if the question is not about a flow.' },
        evidence: {
          type: 'array',
          description: 'Source locations that support the answer.',
          items: {
            type: 'object',
            properties: { node: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, claim: { type: 'string', description: 'What this location shows, in a few words.' } },
            required: ['claim']
          }
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are. high: you read the code of the functions the answer depends on. medium: based on the graph structure, or on only part of the code. low: you could not find the relevant code, or you are guessing. It is combined with checks on your evidence, so do not round it down out of caution.' }
      },
      required: ['answer', 'confidence']
    }
  }
];

const SYSTEM = `You are investigating a C/C++ codebase for a developer who sees it as an interactive graph of files, classes and functions.
Do not guess: use the tools to find symbols, follow relationships and read code, and check each idea against the source before relying on it.
Nodes are identified by refs such as N12. Pass refs to tools, and refer to nodes in your answer as [[N12]] so they become clickable.
Relationships: calls (function -> function), includes (file -> header), inherits (derived -> base), overrides (method -> base method), uses (code -> type), pairs (header -> source file implementing it).
Calls marked "uncertain" were matched by name only. Calls through function pointers, callbacks and macros are missing from the graph; grep can find them.
Work efficiently: you have at most ${MAX_STEPS} rounds of tool calls, and several independent calls can be made in one round. Stop as soon as you can answer well.
Then call finish. Write for someone who may be new to the code: clear and concise (under 250 words unless needed).
Only state what code you have read supports. Some function bodies are given below; read the others with read_code before you describe them, or say that you did not check them.
Back the important claims with 2-4 evidence items whose file and line come from tool output.`;

const MODE_HINTS = {
  ask: '',
  path: `The developer wants the execution path. Start at the selected node if it is a function, otherwise at main.
Follow calls in the order they happen: read the bodies to get the order right and to notice branches, early returns, loops and error handling.
In finish, put the usual path in routes[0], in call order. When the code has an important branch (an error path, a retry, an early exit), add it as another route that starts with the step where it branches off, and give its condition.
Mark each step's kind: call (default), branch (taken only under a condition), callback (reached through a function pointer or virtual dispatch), error (error handling), return (back to the caller).`
};

const STEP_KINDS = ['call', 'branch', 'callback', 'error', 'return'];
const MAX_ROUTES = 4;
const MAX_ROUTE_STEPS = 30;

/** The tools for a mode: in path mode, finish takes routes with step kinds and conditions instead of a flat path. */
function toolsFor(mode) {
  if (mode !== 'path') return TOOLS;
  const finish = TOOLS.find(t => t.name === 'finish');
  const props = { ...finish.inputSchema.properties };
  delete props.path;
  props.routes = {
    type: 'array',
    description: 'routes[0] is the usual path from the entry point, in call order. Up to 3 more routes for important branches; each starts with the step where it branches off routes[0].',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name, e.g. "main", "file not open", "retry".' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node: nodeArg,
              kind: { type: 'string', enum: STEP_KINDS },
              condition: { type: 'string', description: 'For a branch or error step: the condition in the code, e.g. "if (!g_file)".' },
              note: { type: 'string', description: 'What happens at this step, in a few words.' }
            },
            required: ['node']
          }
        }
      },
      required: ['steps']
    }
  };
  return TOOLS.map(t => (t === finish ? { ...finish, inputSchema: { ...finish.inputSchema, properties: props } } : t));
}

/**
 * @param {{nodes:object[], edges:object[]}} graph
 * @param {string} question
 * @param {{llm:{send:Function, name?:string, maxInputTokens?:number}, mode?:'ask'|'path', focusId?:string,
 *          readSource:(file:string)=>Promise<string|null>, onStep?:(step:object)=>void, token?:{isCancellationRequested:boolean},
 *          maxSteps?:number}} opts
 */
async function investigate(graph, question, opts) {
  const llm = opts.llm;
  const token = opts.token || { isCancellationRequested: false };
  const onStep = opts.onStep || (() => {});
  const maxSteps = opts.maxSteps || MAX_STEPS;
  const tools = new GraphTools(graph, { readSource: opts.readSource });
  // Roughly 3 characters per token; keep a quarter of the window for the reply.
  const budget = Math.min((llm.maxInputTokens || 32000) * 3, 400000) * 0.75;

  const steps = [];
  const step = s => {
    s.i = steps.length;
    steps.push(s);
    onStep(s);
  };

  // A head start, shown as the first step: what matches the question, and where the program starts.
  const first = tools.searchSymbols(question, { k: 8 });
  step({ tool: 'search_symbols', args: { query: question }, summary: `Searched the question → ${first.nodeIds.length} symbol${first.nodeIds.length === 1 ? '' : 's'}`, nodeIds: first.nodeIds });
  const focus = opts.focusId && tools.nodes.get(opts.focusId);
  const mains = graph.nodes.filter(n => n.kind === 'function' && n.name === 'main');
  const files = graph.nodes.filter(n => n.kind === 'file').length;
  const modeTools = toolsFor(opts.mode);
  let callTree = '';
  if (opts.mode === 'path') {
    const entry = focus && (focus.kind === 'function' || focus.kind === 'method') ? focus : mains[0];
    if (entry) callTree = 'Calls reachable from ' + tools.label(entry) + ' (up to 3 levels; read the bodies for the order):\n' + tools.reach(entry.id, { dir: 'out', maxDepth: 3, limit: 60 }).text;
  }
  // The source of the likeliest functions up front, so the model starts from code instead of guesses.
  const isFn = n => !!n && (n.kind === 'function' || n.kind === 'method');
  const candidates = [];
  for (const n of [isFn(focus) ? focus : null, opts.mode === 'path' ? mains[0] : null, ...first.nodeIds.map(id => tools.nodes.get(id))]) {
    if (isFn(n) && !candidates.includes(n.id)) candidates.push(n.id);
  }
  const preBudget = Math.min(24000, Math.floor(budget * 0.3));
  const preRead = [];
  const preBlocks = [];
  let preUsed = 0;
  for (const id of candidates.slice(0, PRELOAD_MAX)) {
    const r = await tools.readCode(id, { maxLines: PRELOAD_LINES });
    if (!r.file || preUsed + r.text.length > preBudget) continue;
    preRead.push(id);
    preBlocks.push(r.text);
    preUsed += r.text.length;
  }
  if (preRead.length) step({ tool: 'read_code', args: { preloaded: true }, summary: `Read the code of ${preRead.length} likely function${preRead.length === 1 ? '' : 's'}`, nodeIds: preRead });
  const intro = [
    SYSTEM,
    MODE_HINTS[opts.mode || 'ask'] || '',
    `The codebase has ${files} files and ${graph.nodes.length} nodes.${graph.nodes.some(n => n.status) ? ' This is a comparison of two versions: nodes are tagged [added], [removed] or [modified].' : ''}`,
    mains.length ? 'Entry point: ' + mains.map(n => tools.label(n)).join('; ') : 'No main() was found.',
    focus ? 'The developer has this node selected: ' + tools.label(focus) : '',
    'Symbols matching the question:\n' + first.text,
    callTree,
    preBlocks.length ? 'Source of the likeliest functions (already read, no need to read them again):\n' + preBlocks.join('\n\n') : '',
    'Question: ' + question
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [{ role: 'user', text: intro }];
  let used = intro.length;
  const cache = new Map();
  let final = null;
  let lastText = '';
  const readIds = new Set(preRead); // nodes whose code the model has seen
  let toolCalls = 0; // lookups beyond the head start
  let forced = null; // why the model was made to finish, if it was

  for (let round = 0; round < maxSteps && !final; round++) {
    if (token.isCancellationRequested) break;
    const mustFinish = round === maxSteps - 1 || used > budget;
    if (mustFinish) forced = round === maxSteps - 1 ? 'step limit' : 'context limit';
    if (mustFinish && round > 0) messages[messages.length - 1].text = 'Stop investigating now and call finish with the best answer you have. Say in the answer what you could not check.';
    const reply = await llm.send(messages, { tools: mustFinish ? modeTools.filter(t => t.name === 'finish') : modeTools, forceTool: mustFinish ? 'finish' : null }, token);
    const calls = reply.calls || [];
    lastText = reply.text || '';
    if (!calls.length) break; // answered in plain text instead of calling finish
    messages.push({ role: 'assistant', text: reply.text || '', calls });
    used += (reply.text || '').length + JSON.stringify(calls).length;

    const results = [];
    for (const call of calls) {
      if (call.name === 'finish') {
        final = call.input || {};
        break;
      }
      const key = call.name + JSON.stringify(call.input || {});
      let r = cache.get(key);
      if (!r) {
        r = await runTool(tools, call.name, call.input || {});
        cache.set(key, r);
      }
      step({ tool: call.name, args: call.input || {}, summary: summarize(tools, call.name, call.input || {}, r), nodeIds: r.nodeIds || [], note: reply.text ? reply.text.trim().slice(0, 300) : undefined });
      toolCalls++;
      if (call.name === 'read_code') for (const id of r.nodeIds || []) readIds.add(id);
      const text = r.text.length > RESULT_CHARS ? r.text.slice(0, RESULT_CHARS) + '\n(truncated)' : r.text;
      results.push({ id: call.id, text });
      used += text.length;
    }
    if (!final) messages.push({ role: 'user', results });
  }

  // A plain-text reply is a normal answer; its confidence comes from the evidence, like any other.
  const failed = !final && !lastText;
  const raw = final || { answer: lastText || (token.isCancellationRequested ? '_Cancelled._' : 'The investigation ended without an answer.') };
  return { ...validate(tools, raw, { readIds, toolCalls, forced, failed }), steps: steps.length, model: llm.name || null };
}

async function runTool(tools, name, a) {
  const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);
  try {
    switch (name) {
      case 'search_symbols':
        return tools.searchSymbols(String(a.query || ''), { k: Math.min(num(a.k, 10), 30), kinds: a.kinds });
      case 'get_node':
        return tools.getNode(a.node);
      case 'neighbors':
        return tools.neighbors(a.node, { dir: a.direction, kinds: a.kinds, limit: 40 });
      case 'call_paths':
        return tools.callPaths(a.from, a.to, { maxDepth: Math.min(num(a.max_depth, 8), 12), k: 3 });
      case 'reach':
        return tools.reach(a.node, { dir: a.direction === 'in' ? 'in' : 'out', kinds: a.kinds, maxDepth: Math.min(num(a.max_depth, 6), 10), limit: 120 });
      case 'read_code':
        if (a.file && !a.node) return await tools.readCode({ file: String(a.file), start: num(a.start, 1), end: num(a.end, num(a.start, 1) + 79) }, { maxLines: 120 });
        return await tools.readCode(a.node, { maxLines: 120 });
      case 'grep':
        return await tools.grep(String(a.pattern || ''), { file: a.file, maxHits: 30 });
      default:
        return { text: `Unknown tool "${name}".`, nodeIds: [] };
    }
  } catch (err) {
    return { text: `The tool failed: ${(err && err.message) || err}`, nodeIds: [] };
  }
}

/** One line for the investigation timeline. */
function summarize(tools, name, a, r) {
  const nm = x => {
    const n = tools.resolve(x);
    return n ? n.qname || n.name : String(x);
  };
  const count = r.nodeIds ? r.nodeIds.length : 0;
  if (r.missing) return `Could not find ${String(a.node || a.from || a.to || '')}`;
  switch (name) {
    case 'search_symbols':
      return `Searched “${a.query}” → ${count} symbol${count === 1 ? '' : 's'}`;
    case 'get_node':
      return `Looked up ${nm(a.node)}`;
    case 'neighbors': {
      const n = r.rows ? r.rows.length : 0;
      const what = a.direction === 'in' ? 'Incoming' : a.direction === 'out' ? 'Outgoing' : 'All';
      return `${what} ${a.kinds && a.kinds.length ? a.kinds.join('/') : 'relationships'} of ${nm(a.node)} (${n})`;
    }
    case 'call_paths':
      return `Call paths ${nm(a.from)} → ${nm(a.to)} (${r.paths ? r.paths.length : 0})`;
    case 'reach':
      return `${a.direction === 'in' ? 'Everything that reaches' : 'Everything reached from'} ${nm(a.node)} (${r.items ? r.items.length : 0})`;
    case 'read_code':
      return a.file && !a.node ? `Read ${a.file}:${a.start || 1}${r.end ? '-' + r.end : ''}` : `Read the code of ${nm(a.node)}`;
    case 'grep':
      return `Grepped /${a.pattern}/ → ${r.hits ? r.hits.length : 0} line${r.hits && r.hits.length === 1 ? '' : 's'}`;
  }
  return name;
}

/**
 * Checks the model's answer against the graph: refs become node ids, unknown
 * nodes are dropped, path hops without a call edge are marked inferred, and
 * evidence gets a location when it names a node.
 */
function validate(tools, raw, ctx) {
  const toId = x => {
    const n = tools.resolve(x);
    return n && n.kind !== 'dir' ? n.id : null;
  };
  const list = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+|->/) : []).map(s => String(s).trim()).filter(Boolean);

  let answer = String(raw.answer || '').trim();
  const referenced = [];
  answer = answer.replace(/\[\[([^\]]+)\]\]/g, (m, x) => {
    const id = toId(x);
    if (id) {
      referenced.push(id);
      return '[[' + id + ']]';
    }
    return '`' + x + '`';
  });

  const routes = buildRoutes(tools, raw, toId, list);
  const path = routes.length ? routes[0].steps.map(s => s.id) : [];
  const hops = routes.length ? routes[0].steps.slice(1).map((s, i) => ({ s: path[i], t: s.id, inferred: s.inferred, uncertain: s.uncertain, dispatch: s.dispatch, returns: s.returns, site: s.site })) : [];

  const evidence = [];
  for (const ev of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!ev || typeof ev !== 'object') continue;
    const n = ev.node ? tools.resolve(ev.node) : null;
    let file = ev.file ? String(ev.file).replace(/\\/g, '/').replace(/^\.\//, '') : null;
    let line = Number.isFinite(+ev.line) && +ev.line > 0 ? Math.floor(+ev.line) : null;
    if (file && !tools.nodes.has('file:' + file)) {
      const match = tools.graph.nodes.find(f => f.kind === 'file' && (f.file.endsWith('/' + file) || file.endsWith('/' + f.file)));
      file = match ? match.file : null;
      if (!file) line = null;
    }
    if (!file && n && n.kind !== 'dir') {
      const r = tools.codeRange(n);
      file = r.file;
      line = line || r.start;
    }
    if (!file && !n) continue;
    evidence.push({ nodeId: n ? n.id : file && line ? (tools.enclosing(file, line) || {}).id || null : null, file, line, claim: String(ev.claim || '').slice(0, 200) });
  }

  const highlight = [...new Set([...list(raw.highlight).map(toId).filter(Boolean), ...referenced, ...path, ...evidence.map(e => e.nodeId).filter(Boolean)])];
  const rated = rateConfidence(tools, { referenced, routes, evidence }, raw.confidence, ctx || { readIds: new Set(), toolCalls: 0, forced: null, failed: false });
  const routeIds = routes.flatMap(r => r.steps.map(s => s.id));
  return { answer, highlight: [...new Set([...highlight, ...routeIds])], path, hops, routes, evidence, confidence: rated.confidence, confidenceReason: rated.reason };
}

/**
 * Routes from raw.routes (path mode) or raw.path. Each step is
 * {id, kind, condition?, note?} plus, after the first, how it is reached:
 * a call edge (site, uncertain), virtual dispatch (calls a base method this
 * one overrides), a return to the caller, or inferred (no edge in the graph).
 * Alternatives that start at a step of the main route get its prefix, and
 * divergeAt is the index of the step where they branch off.
 */
function buildRoutes(tools, raw, toId, list) {
  const clip = (v, n) => (v == null ? undefined : String(v).trim().slice(0, n) || undefined);
  const rawRoutes = Array.isArray(raw.routes) && raw.routes.length ? raw.routes : raw.path ? [{ label: 'main', steps: list(raw.path).map(node => ({ node })) }] : [];
  const routes = [];
  for (const r of rawRoutes.slice(0, MAX_ROUTES)) {
    if (!r || typeof r !== 'object') continue;
    const steps = [];
    for (const st of (Array.isArray(r.steps) ? r.steps : []).slice(0, MAX_ROUTE_STEPS)) {
      const id = toId(st && typeof st === 'object' ? st.node : st);
      if (!id || (steps.length && steps[steps.length - 1].id === id)) continue;
      steps.push({ id, kind: STEP_KINDS.includes(st.kind) ? st.kind : 'call', condition: clip(st.condition, 120), note: clip(st.note, 160) });
    }
    if (steps.length) routes.push({ label: clip(r.label, 40) || (routes.length ? 'alternative ' + routes.length : 'main'), steps, divergeAt: 0 });
  }
  if (!routes.length) return routes;
  const main = routes[0];
  for (const alt of routes.slice(1)) {
    const at = main.steps.findIndex(s => s.id === alt.steps[0].id);
    if (at < 0) continue;
    // The branching step keeps the alternative's kind and condition.
    alt.steps = [...main.steps.slice(0, at).map(s => ({ ...s })), alt.steps[0], ...alt.steps.slice(1)];
    alt.divergeAt = at;
  }
  for (const r of routes) {
    for (let i = 1; i < r.steps.length; i++) Object.assign(r.steps[i], hopInfo(tools, r.steps[i - 1].id, r.steps[i].id));
  }
  return routes;
}

function hopInfo(tools, from, to) {
  const calls = (tools.out.get(from) || []).filter(e => e.kind === 'calls');
  const site = e => (e.sites && e.sites[0]) || null;
  let e = calls.find(x => x.t === to);
  if (e) return { inferred: false, uncertain: !!e.uncertain, site: site(e) };
  // Virtual dispatch: `from` calls a base method that `to` overrides.
  const bases = new Set((tools.out.get(to) || []).filter(x => x.kind === 'overrides').map(x => x.t));
  e = calls.find(x => bases.has(x.t));
  if (e) return { inferred: false, dispatch: true, uncertain: true, site: site(e) };
  // Returning to the caller.
  e = (tools.out.get(to) || []).find(x => x.kind === 'calls' && x.t === from);
  if (e) return { inferred: false, returns: true, site: null };
  return { inferred: true, site: null };
}

/**
 * How far to trust an answer, from what can be checked, with the reason:
 *   high   - the code of the functions it cites was read (at least half of them,
 *            or three), a source line backs it, and every path step is a known call
 *   medium - some code was read, a line is cited, or the graph was explored
 *   low    - none of that, or no answer
 * Inferred path steps and being forced to stop cap it at medium. The model's own
 * rating can only lower it: "medium" caps at medium, "low" drops it a level.
 * @param {string} [rating] the model's own rating
 */
function rateConfidence(tools, { referenced, routes, evidence }, rating, ctx) {
  const callable = id => {
    const n = tools.nodes.get(id);
    return !!n && (n.kind === 'function' || n.kind === 'method');
  };
  const cited = new Set([...referenced, ...routes.flatMap(r => r.steps.map(s => s.id))].filter(callable));
  const reads = [...cited].filter(id => ctx.readIds.has(id)).length;
  const readAny = ctx.readIds.size > 0;
  const located = evidence.filter(e => e.file && e.line).length;
  // Alternative routes repeat the main route's steps, so count each hop once.
  const hopsSeen = new Set();
  let inferred = 0;
  let byName = 0;
  for (const r of routes) {
    r.steps.forEach((s, i) => {
      const key = i && r.steps[i - 1].id + '>' + s.id;
      if (!i || hopsSeen.has(key)) return;
      hopsSeen.add(key);
      if (s.inferred) inferred++;
      else if (s.uncertain && !s.dispatch) byName++;
    });
  }

  let level;
  if (ctx.failed) level = 0;
  else if (readAny && located >= 1 && inferred === 0 && (cited.size ? reads >= 1 && (reads * 2 >= cited.size || reads >= 3) : true)) level = 2;
  else if (readAny || located >= 1 || ctx.toolCalls > 0) level = 1;
  else level = 0;
  if (inferred || ctx.forced) level = Math.min(level, 1);
  if (rating === 'medium') level = Math.min(level, 1);
  else if (rating === 'low') level = Math.max(0, Math.min(level, 2) - 1);

  const parts = [];
  const s = n => (n === 1 ? '' : 's');
  if (ctx.failed) parts.push('no answer was produced');
  else {
    if (cited.size) parts.push(reads ? `read the code of ${reads} of the ${cited.size} function${s(cited.size)} it cites` : `read none of the ${cited.size} function${s(cited.size)} it cites`);
    else parts.push(readAny ? 'read the code it describes' : 'read no code');
    parts.push(located ? `${located} cited source line${s(located)}` : 'no cited source lines');
    if (inferred) parts.push(`${inferred} path step${s(inferred)} with no known call`);
    if (byName) parts.push(`${byName} call${s(byName)} matched by name only`);
    if (ctx.forced) parts.push(`stopped at the ${ctx.forced}`);
    if (rating === 'low') parts.push('the model was unsure');
  }
  return { confidence: ['low', 'medium', 'high'][level], reason: parts.join('; ') };
}

module.exports = { investigate, validate, rateConfidence, toolsFor, TOOLS };
