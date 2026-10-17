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
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high: you read the code that shows it. medium: inferred from graph structure. low: partly guessed.' }
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
Back the important claims with evidence items whose file and line come from tool output.`;

const MODE_HINTS = {
  ask: '',
  path: 'The developer wants the execution path. Start at the entry point (main, or the selected node), follow calls in the order they happen, and read the bodies to notice branches and error handling. Put the main path in `path`, in call order.'
};

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
  const intro = [
    SYSTEM,
    MODE_HINTS[opts.mode || 'ask'] || '',
    `The codebase has ${files} files and ${graph.nodes.length} nodes.${graph.nodes.some(n => n.status) ? ' This is a comparison of two versions: nodes are tagged [added], [removed] or [modified].' : ''}`,
    mains.length ? 'Entry point: ' + mains.map(n => tools.label(n)).join('; ') : 'No main() was found.',
    focus ? 'The developer has this node selected: ' + tools.label(focus) : '',
    'Symbols matching the question:\n' + first.text,
    'Question: ' + question
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [{ role: 'user', text: intro }];
  let used = intro.length;
  const cache = new Map();
  let final = null;
  let lastText = '';

  for (let round = 0; round < maxSteps && !final; round++) {
    if (token.isCancellationRequested) break;
    const mustFinish = round === maxSteps - 1 || used > budget;
    if (mustFinish && round > 0) messages[messages.length - 1].text = 'Stop investigating now and call finish with the best answer you have. Lower the confidence if needed.';
    const reply = await llm.send(messages, { tools: mustFinish ? TOOLS.filter(t => t.name === 'finish') : TOOLS, forceTool: mustFinish ? 'finish' : null }, token);
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
      const text = r.text.length > RESULT_CHARS ? r.text.slice(0, RESULT_CHARS) + '\n(truncated)' : r.text;
      results.push({ id: call.id, text });
      used += text.length;
    }
    if (!final) messages.push({ role: 'user', results });
  }

  const raw = final || { answer: lastText || (token.isCancellationRequested ? '_Cancelled._' : 'The investigation ended without an answer.'), confidence: 'low' };
  return { ...validate(tools, raw), steps: steps.length, model: llm.name || null };
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
function validate(tools, raw) {
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

  const path = [];
  for (const x of list(raw.path)) {
    const id = toId(x);
    if (id && path[path.length - 1] !== id) path.push(id);
  }
  const hops = [];
  for (let i = 1; i < path.length; i++) {
    const e = (tools.out.get(path[i - 1]) || []).find(x => x.kind === 'calls' && x.t === path[i]);
    hops.push({ s: path[i - 1], t: path[i], inferred: !e, uncertain: !!(e && e.uncertain), site: e && e.sites ? e.sites[0] : null });
  }

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
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';
  return { answer, highlight, path, hops, evidence, confidence };
}

module.exports = { investigate, validate, TOOLS };
