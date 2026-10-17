'use strict';

// Deterministic queries over the code graph, used as tools by the AI agent (and
// by the impact simulator). No `vscode` dependency, so it can be unit-tested.
//
// Every node gets a short ref (N12) for the model to read and pass back. Each
// tool returns { text, nodeIds }: `text` is compact and uses refs, `nodeIds` are
// real graph ids for the webview to highlight.

const { STOP_WORDS } = require('./context');

const CALLABLE = new Set(['function', 'method']);
const CONTAINER = new Set(['dir', 'file', 'namespace', 'class', 'struct', 'union']);
const LINE_MAX = 160;

/** Splits identifiers and words into lowercase tokens: "pixelCount log_init" -> pixel count pixelcount log init log_init. */
function tokenize(text) {
  const out = [];
  for (const word of String(text || '').split(/[^A-Za-z0-9_~]+/)) {
    if (!word) continue;
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .filter(Boolean);
    const whole = word.toLowerCase();
    if (parts.length > 1) out.push(whole.replace(/^_+|_+$/g, ''));
    for (const p of parts) out.push(stem(p.toLowerCase()));
  }
  return out.filter(t => t.length > 1);
}

function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

class GraphTools {
  /**
   * @param {{nodes:object[], edges:object[]}} graph
   * @param {{readSource?:(file:string)=>Promise<string|null>, includeRemoved?:boolean}} [opts]
   */
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.readSource = opts.readSource || (async () => null);
    this.nodes = new Map();
    this.refOf = new Map();
    this.byRef = new Map();
    this.children = new Map();
    this.out = new Map();
    this.inc = new Map();
    this.sourceCache = new Map();

    let i = 0;
    for (const n of graph.nodes) {
      this.nodes.set(n.id, n);
      if (n.kind === 'dir') continue;
      const ref = 'N' + i++;
      this.refOf.set(n.id, ref);
      this.byRef.set(ref, n.id);
    }
    for (const n of graph.nodes) if (n.parent) push(this.children, n.parent, n.id);
    for (const e of graph.edges) {
      if (e.status === 'removed' && !opts.includeRemoved) continue;
      if (!this.nodes.has(e.s) || !this.nodes.has(e.t)) continue;
      push(this.out, e.s, e);
      push(this.inc, e.t, e);
    }
    this.buildSearchIndex();
    this.buildRanges();
  }

  // ---- refs and formatting ----------------------------------------------------

  ref(id) {
    return this.refOf.get(id) || id;
  }

  /** Accepts a ref (N12), a full node id, a qualified name or a plain name. Returns the node or null. */
  resolve(x) {
    if (!x) return null;
    x = String(x).trim().replace(/^\[\[|\]\]$/g, '');
    if (this.byRef.has(x)) return this.nodes.get(this.byRef.get(x));
    if (this.nodes.has(x)) return this.nodes.get(x);
    const bare = x.replace(/\(.*\)$/, '');
    // Functions first, then classes, but a bare class name means the class, not its constructor.
    const isCtor = n => n.kind === 'method' && n.parent && (this.nodes.get(n.parent) || {}).name === n.name;
    const prefer = n => (isCtor(n) ? 1.5 : CALLABLE.has(n.kind) ? 0 : n.kind === 'class' || n.kind === 'struct' ? 1 : 2) + (n.defFile ? 0 : 0.25);
    const pick = list => (list.length ? list.sort((a, b) => prefer(a) - prefer(b))[0] : null);
    const all = this.graph.nodes.filter(n => n.kind !== 'dir');
    // Fields have no qname, but their ids do: "field:geo::Canvas::pixels_".
    const qualified = n => n.qname || n.id.replace(/^[a-z]+:/, '').replace(/\(.*$/, '');
    return pick(all.filter(n => qualified(n) === bare)) || pick(all.filter(n => n.name === bare)) || pick(all.filter(n => n.kind === 'file' && (n.file === bare || n.file.endsWith('/' + bare)))) || null;
  }

  loc(n) {
    return (n.defFile || n.file || '') + ':' + (n.defLine || n.line || 1);
  }

  label(n) {
    const status = n.status ? ' [' + n.status + ']' : '';
    return `${this.ref(n.id)} ${n.kind} ${n.qname || n.name}${status} @${this.loc(n)}`;
  }

  notFound(x) {
    return { text: `No node matches "${x}". Use searchSymbols to find one.`, nodeIds: [], missing: true };
  }

  // ---- searchSymbols ----------------------------------------------------------

  buildSearchIndex() {
    // BM25 over identifier tokens. Name tokens count three times, signature and
    // qualified-name tokens twice, file path once. Body tokens can be added later
    // with indexSources().
    this.docs = [];
    this.df = new Map();
    for (const n of this.graph.nodes) {
      if (n.kind === 'dir') continue;
      const tf = new Map();
      const add = (text, w) => {
        for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + w);
      };
      add(n.name, 3);
      add(n.qname, 2);
      add(n.signature, 1);
      add(n.file, 1);
      let len = 0;
      for (const v of tf.values()) len += v;
      this.docs.push({ id: n.id, tf, len });
    }
    this.recomputeDf();
  }

  recomputeDf() {
    this.df = new Map();
    let total = 0;
    for (const d of this.docs) {
      total += d.len;
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = total / Math.max(1, this.docs.length);
  }

  /** Reads function bodies once and adds their tokens (weight 0.5) to the search index. */
  async indexSources(maxFunctions = 2000) {
    if (this.sourcesIndexed) return;
    this.sourcesIndexed = true;
    const byId = new Map(this.docs.map(d => [d.id, d]));
    let count = 0;
    for (const n of this.graph.nodes) {
      if (!CALLABLE.has(n.kind) || count++ >= maxFunctions) continue;
      const r = this.codeRange(n);
      const text = await this.source(r.file);
      if (!text) continue;
      const body = text.split(/\r?\n/).slice(r.start - 1, r.end).join('\n');
      const d = byId.get(n.id);
      for (const t of tokenize(body)) {
        d.tf.set(t, (d.tf.get(t) || 0) + 0.5);
        d.len += 0.5;
      }
    }
    this.recomputeDf();
  }

  /**
   * @param {string} query  words or identifiers
   * @param {{k?:number, kinds?:string[]}} [opts]
   */
  searchSymbols(query, opts = {}) {
    const k = opts.k || 10;
    const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
    const qterms = [...new Set(tokenize(query).filter(t => !STOP_WORDS.has(t)))];
    if (!qterms.length) return { text: 'The query has no searchable words.', nodeIds: [], results: [] };
    // Prefix matches ("pixel" -> "pixels") count for half.
    const vocab = [...this.df.keys()];
    const expanded = new Map();
    for (const q of qterms) {
      expanded.set(q, 1);
      if (q.length < 3) continue;
      for (const v of vocab) if (v !== q && (v.startsWith(q) || (v.length >= 4 && q.startsWith(v))) && !expanded.has(v)) expanded.set(v, 0.5);
    }
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored = [];
    for (const d of this.docs) {
      const n = this.nodes.get(d.id);
      if (kinds && !kinds.has(n.kind)) continue;
      let s = 0;
      for (const [t, w] of expanded) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (s > 0) scored.push({ id: d.id, score: s });
    }
    scored.sort((a, b2) => b2.score - a.score);
    const results = scored.slice(0, k);
    const text = results.length
      ? results.map(r => this.label(this.nodes.get(r.id))).join('\n') + (scored.length > k ? `\n(${scored.length - k} more matches)` : '')
      : `No symbols match "${query}".`;
    return { text, nodeIds: results.map(r => r.id), results };
  }

  // ---- getNode ----------------------------------------------------------------

  getNode(x) {
    const n = this.resolve(x);
    if (!n) return this.notFound(x);
    const lines = [this.label(n)];
    if (n.signature) lines.push('signature: ' + n.signature);
    const flags = [n.access, n.isVirtual && 'virtual', n.isPure && 'pure', n.isStatic && 'static', n.header && 'header'].filter(Boolean);
    if (flags.length) lines.push('flags: ' + flags.join(', '));
    if (n.declFile) lines.push('declared: ' + n.declFile + ':' + n.declLine);
    if (n.defFile) lines.push('defined: ' + n.defFile + ':' + n.defLine + (n.defEndLine ? '-' + n.defEndLine : ''));
    else if (CALLABLE.has(n.kind)) lines.push('defined: (no definition found)');
    const parent = n.parent && this.nodes.get(n.parent);
    if (parent && parent.kind !== 'dir') lines.push('inside: ' + this.label(parent));
    if (n.values && n.values.length) lines.push('values: ' + n.values.slice(0, 20).join(', '));
    const kids = (this.children.get(n.id) || []).map(id => this.nodes.get(id));
    if (kids.length) {
      lines.push(`contains (${kids.length}):`);
      for (const c of kids.slice(0, 40)) lines.push('  ' + this.label(c));
      if (kids.length > 40) lines.push(`  (${kids.length - 40} more)`);
    }
    const counts = list => {
      const m = {};
      for (const e of list) m[e.kind] = (m[e.kind] || 0) + 1;
      return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
    };
    const o = this.out.get(n.id) || [];
    const i = this.inc.get(n.id) || [];
    if (o.length) lines.push('outgoing: ' + counts(o));
    if (i.length) lines.push('incoming: ' + counts(i));
    if (n.hash) lines.push('hash: ' + n.hash);
    return { text: lines.join('\n'), nodeIds: [n.id], node: n };
  }

  // ---- neighbors --------------------------------------------------------------

  /**
   * Direct relationships of a node.
   * @param {string} x
   * @param {{kinds?:string[], dir?:'out'|'in'|'both', limit?:number}} [opts]
   */
  neighbors(x, opts = {}) {
    const n = this.resolve(x);
    if (!n) return this.notFound(x);
    const dir = opts.dir || 'both';
    const limit = opts.limit || 30;
    const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
    const rows = [];
    const take = (list, outgoing) => {
      for (const e of list) {
        if (kinds && !kinds.has(e.kind)) continue;
        rows.push({ e, other: outgoing ? e.t : e.s, outgoing });
      }
    };
    if (dir !== 'in') take(this.out.get(n.id) || [], true);
    if (dir !== 'out') take(this.inc.get(n.id) || [], false);
    if (!rows.length) return { text: `${this.label(n)} has no ${kinds ? [...kinds].join('/') + ' ' : ''}relationships${dir === 'both' ? '' : ' (' + dir + ')'}.`, nodeIds: [n.id], rows };
    const fmt = r => {
      const other = this.nodes.get(r.other);
      const site = r.e.sites && r.e.sites[0];
      const extra = [r.e.n > 1 ? 'x' + r.e.n : '', r.e.uncertain ? 'uncertain' : '', r.e.status || '', site ? 'at ' + site.file + ':' + site.line : ''].filter(Boolean).join(' ');
      return (r.outgoing ? `${r.e.kind} -> ` : `<- ${r.e.kind} `) + this.label(other) + (extra ? ' (' + extra + ')' : '');
    };
    const shown = rows.slice(0, limit);
    const text = this.label(n) + '\n' + shown.map(fmt).join('\n') + (rows.length > limit ? `\n(${rows.length - limit} more)` : '');
    return { text, nodeIds: [n.id, ...new Set(shown.map(r => r.other))], rows };
  }

  // ---- callPaths --------------------------------------------------------------

  /** Callable nodes at or inside x (a function itself, or the functions of a class/file). */
  callablesUnder(n) {
    if (CALLABLE.has(n.kind)) return [n.id];
    const out = [];
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop();
      const node = this.nodes.get(id);
      if (CALLABLE.has(node.kind)) out.push(id);
      if (CONTAINER.has(node.kind)) stack.push(...(this.children.get(id) || []));
    }
    return out;
  }

  /**
   * Up to k shortest call chains from `from` to `to`. Either end may be a class or
   * file, meaning any function inside it.
   * @param {{maxDepth?:number, k?:number}} [opts]
   */
  callPaths(from, to, opts = {}) {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (!a) return this.notFound(from);
    if (!b) return this.notFound(to);
    const maxDepth = opts.maxDepth || 8;
    const k = opts.k || 3;
    const starts = this.callablesUnder(a);
    const targets = new Set(this.callablesUnder(b));
    if (!starts.length || !targets.size) return { text: `${this.label(starts.length ? b : a)} contains no functions.`, nodeIds: [], paths: [] };

    // Breadth-first over paths; each node is expanded at most k times, which
    // yields the k shortest simple paths in an unweighted graph.
    const expanded = new Map();
    const queue = starts.map(id => [id]);
    const paths = [];
    let steps = 0;
    while (queue.length && paths.length < k && steps++ < 50000) {
      const p = queue.shift();
      const last = p[p.length - 1];
      // A start that is already inside the target is not a path; keep searching from it.
      if (p.length > 1 && targets.has(last)) {
        paths.push(p);
        continue;
      }
      if (p.length > maxDepth) continue;
      const seen = expanded.get(last) || 0;
      if (seen >= k) continue;
      expanded.set(last, seen + 1);
      for (const e of this.out.get(last) || []) {
        if (e.kind !== 'calls' || p.includes(e.t)) continue;
        queue.push([...p, e.t]);
      }
    }
    if (!paths.length) return { text: `No call chain of up to ${maxDepth} calls from ${this.label(a)} to ${this.label(b)}. (Calls through function pointers, callbacks or macros are not in the graph.)`, nodeIds: [a.id, b.id], paths };
    const lines = paths.map((p, i) => {
      const hops = [];
      for (let j = 1; j < p.length; j++) {
        const e = (this.out.get(p[j - 1]) || []).find(x => x.kind === 'calls' && x.t === p[j]);
        const site = e && e.sites && e.sites[0];
        hops.push((e && e.uncertain ? ' -?-> ' : ' -> ') + this.ref(p[j]) + (site ? ` (${site.file}:${site.line})` : ''));
      }
      return `${i + 1}. ${this.ref(p[0])}${hops.join('')}`;
    });
    const ids = [...new Set(paths.flat())];
    const legend = ids.map(id => this.label(this.nodes.get(id))).join('\n');
    return { text: lines.join('\n') + '\nwhere:\n' + legend, nodeIds: ids, paths };
  }

  // ---- reach ------------------------------------------------------------------

  /**
   * Everything reachable from x, with its distance. dir 'out' follows edges
   * forwards (callees), 'in' backwards (callers).
   * @param {{dir?:'out'|'in', kinds?:string[], maxDepth?:number, limit?:number}} [opts]
   */
  reach(x, opts = {}) {
    const n = this.resolve(x);
    if (!n) return this.notFound(x);
    const dir = opts.dir || 'out';
    const kinds = new Set(opts.kinds && opts.kinds.length ? opts.kinds : ['calls']);
    const maxDepth = opts.maxDepth || 6;
    const limit = opts.limit || 200;
    const seen = new Map([[n.id, { id: n.id, depth: 0, via: null, edge: null }]]);
    let frontier = [n.id];
    for (let depth = 1; depth <= maxDepth && frontier.length && seen.size <= limit; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const e of (dir === 'out' ? this.out : this.inc).get(id) || []) {
          if (!kinds.has(e.kind)) continue;
          const other = dir === 'out' ? e.t : e.s;
          if (seen.has(other)) continue;
          seen.set(other, { id: other, depth, via: id, edge: e });
          next.push(other);
          if (seen.size > limit) break;
        }
      }
      frontier = next;
    }
    const items = [...seen.values()].filter(r => r.id !== n.id);
    const truncated = seen.size > limit || frontier.length > 0;
    const verb = dir === 'out' ? 'reaches' : 'is reached from';
    if (!items.length) return { text: `${this.label(n)} ${verb} nothing through ${[...kinds].join('/')}.`, nodeIds: [n.id], items };
    const lines = items.map(r => {
      const site = r.edge.sites && r.edge.sites[0];
      return `d${r.depth} ${this.label(this.nodes.get(r.id))} via ${this.ref(r.via)} ${r.edge.kind}${r.edge.uncertain ? ' (uncertain)' : ''}${site ? ' at ' + site.file + ':' + site.line : ''}`;
    });
    return {
      text: `${this.label(n)} ${verb} ${items.length} node${items.length === 1 ? '' : 's'}${truncated ? ' (stopped at the depth or size limit)' : ''}:\n` + lines.join('\n'),
      nodeIds: [n.id, ...items.map(r => r.id)],
      items,
      truncated
    };
  }

  // ---- source -----------------------------------------------------------------

  async source(file) {
    if (!this.sourceCache.has(file)) {
      let text = null;
      try {
        text = await this.readSource(file);
      } catch {
        text = null;
      }
      this.sourceCache.set(file, text);
    }
    return this.sourceCache.get(file);
  }

  codeRange(n) {
    if (n.defFile) return { file: n.defFile, start: n.defLine || 1, end: n.defEndLine || n.endLine || n.defLine || 1 };
    return { file: n.file, start: n.line || 1, end: n.endLine || n.line || 1 };
  }

  /**
   * Source of a node (its definition when known), or of a file range, with line numbers.
   * @param {string|{file:string,start?:number,end?:number}} x
   * @param {{maxLines?:number}} [opts]
   */
  async readCode(x, opts = {}) {
    const maxLines = opts.maxLines || 80;
    let range;
    let node = null;
    if (x && typeof x === 'object') range = { file: x.file, start: x.start || 1, end: x.end || (x.start || 1) + maxLines - 1 };
    else {
      node = this.resolve(x);
      if (!node) return this.notFound(x);
      if (node.kind === 'dir') return { text: 'A folder has no source. Use getNode to list its files.', nodeIds: [node.id] };
      range = node.kind === 'file' ? { file: node.file, start: 1, end: maxLines } : this.codeRange(node);
    }
    const text = await this.source(range.file);
    if (text == null) return { text: `Source of ${range.file} is not available.`, nodeIds: node ? [node.id] : [] };
    const all = text.split(/\r?\n/);
    const start = Math.max(1, Math.min(range.start, all.length));
    const end = Math.min(all.length, Math.max(start, range.end), start + maxLines - 1);
    const width = String(end).length;
    const body = [];
    for (let i = start; i <= end; i++) body.push(String(i).padStart(width) + '  ' + clip(all[i - 1]));
    const head = (node && node.kind !== 'file' ? this.label(node) : range.file + ':' + start + '-' + end) + '\n';
    const wantedEnd = Math.min(all.length, node && node.kind === 'file' ? all.length : range.end);
    const more = wantedEnd > end ? `\n(${wantedEnd - end} more lines; read again with a file range to continue)` : '';
    return { text: head + body.join('\n') + more, nodeIds: node ? [node.id] : this.nodesInRange(range.file, start, end), file: range.file, start, end };
  }

  buildRanges() {
    // Per-file line ranges of non-container nodes, for mapping a line to its enclosing symbol.
    this.ranges = new Map();
    for (const n of this.graph.nodes) {
      if (n.kind === 'dir' || n.kind === 'file') continue;
      if (n.file && n.line) push(this.ranges, n.file, { id: n.id, a: n.line, b: n.endLine || n.line });
      if (n.defFile && n.defLine && (n.defFile !== n.file || n.defLine !== n.line)) push(this.ranges, n.defFile, { id: n.id, a: n.defLine, b: n.defEndLine || n.endLine || n.defLine });
    }
  }

  /** The innermost symbol whose range contains file:line, or the file node. */
  enclosing(file, line) {
    let best = null;
    for (const r of this.ranges.get(file) || []) {
      if (line >= r.a && line <= r.b && (!best || r.b - r.a < best.b - best.a)) best = r;
    }
    if (best) return this.nodes.get(best.id);
    return this.nodes.get('file:' + file) || null;
  }

  nodesInRange(file, start, end) {
    return [...new Set((this.ranges.get(file) || []).filter(r => r.a <= end && r.b >= start).map(r => r.id))];
  }

  /**
   * Searches the source of every file for a regular expression (case-insensitive).
   * An invalid pattern is searched for literally.
   * @param {{maxHits?:number, file?:string}} [opts]  file: only files whose path contains this text
   */
  async grep(pattern, opts = {}) {
    const maxHits = opts.maxHits || 30;
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const files = this.graph.nodes.filter(n => n.kind === 'file' && (!opts.file || n.file.includes(opts.file)));
    const hits = [];
    let total = 0;
    for (const f of files) {
      const text = await this.source(f.file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        if (hits.length < maxHits) hits.push({ file: f.file, line: i + 1, text: lines[i].trim(), node: this.enclosing(f.file, i + 1) });
      }
    }
    if (!hits.length) return { text: `No lines match /${re.source}/.`, nodeIds: [], hits };
    const text = hits.map(h => `${h.file}:${h.line} [${h.node ? this.ref(h.node.id) + ' ' + (h.node.qname || h.node.name) : '?'}] ${clip(h.text)}`).join('\n') + (total > hits.length ? `\n(${total - hits.length} more matches)` : '');
    return { text, nodeIds: [...new Set(hits.filter(h => h.node).map(h => h.node.id))], hits };
  }
}

function push(map, key, val) {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function clip(s) {
  s = String(s == null ? '' : s);
  return s.length > LINE_MAX ? s.slice(0, LINE_MAX) + '…' : s;
}

module.exports = { GraphTools, tokenize };
