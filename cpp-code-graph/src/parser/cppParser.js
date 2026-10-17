'use strict';

// Lightweight structural parser for C and C++.
//
// It does not try to be a compiler front end. It recognizes the structure a
// human needs to navigate a codebase: namespaces, classes/structs/unions,
// enums, functions and methods (inline and out-of-line), fields, globals,
// #includes, and inside function bodies the call sites, local variable types
// and referenced identifiers. Name resolution happens later in the graph
// builder, once every file is known.

const { tokenize } = require('./lexer');

const KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch', 'char',
  'char8_t', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
  'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype', 'default', 'delete', 'do', 'double',
  'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if',
  'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or',
  'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'restrict', 'return', 'short',
  'signed', 'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
  'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
  'wchar_t', 'while', 'xor', 'xor_eq', 'override', 'final', '_Bool', '_Complex', '_Alignas', '_Alignof', '_Atomic',
  '_Generic', '_Noreturn', '_Static_assert', '_Thread_local', '__attribute__', '__declspec', '__inline', '__inline__',
  '__forceinline', '__restrict', '__restrict__', '__extension__', '__typeof__', 'typeof', '__asm__', '__volatile__',
  '_Pragma', '__pragma', 'NULL'
]);

// Identifiers that can precede '(' without being a function name.
const NON_FUNC = new Set([...KEYWORDS].filter(k => k !== 'operator'));

const TYPE_QUALIFIERS = new Set(['const', 'volatile', 'static', 'inline', 'extern', 'mutable', 'register', 'constexpr',
  'consteval', 'constinit', 'thread_local', 'virtual', 'explicit', 'friend', 'typename', 'struct', 'class', 'union',
  'enum', 'unsigned', 'signed', 'long', 'short', '__inline', '__forceinline', 'restrict', '__restrict']);

// Templates whose first argument is the type a variable really "points to".
const WRAPPERS = new Set(['unique_ptr', 'shared_ptr', 'weak_ptr', 'optional', 'reference_wrapper', 'atomic',
  'QPointer', 'QSharedPointer', 'QScopedPointer', 'QWeakPointer', 'ComPtr', 'CComPtr', 'scoped_ptr', 'intrusive_ptr']);

const ALLCAPS = /^[A-Z_][A-Z0-9_]*$/;

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function joinTokens(toks) {
  let out = '';
  let prev = null;
  for (const t of toks) {
    const v = t.v;
    if (prev) {
      const pw = prev.t === 'id' || prev.t === 'num';
      const cw = t.t === 'id' || t.t === 'num';
      if ((pw && cw) || prev.v === ',' || ((prev.v === '*' || prev.v === '&' || prev.v === '&&') && cw && !out.endsWith('(' + prev.v))) out += ' ';
      else if (v === '=' || prev.v === '=') out += ' ';
    }
    out += v;
    prev = t;
  }
  return out;
}

class Parser {
  constructor(path, text) {
    this.path = path;
    const { tokens, includes } = tokenize(text);
    this.T = tokens;
    this.includes = includes;
    this.p = 0;
    this.entities = [];
  }

  // ---- token helpers -------------------------------------------------

  v(k) {
    const t = this.T[k];
    return t ? t.v : undefined;
  }

  matchClose(k) {
    // T[k] is an opening bracket; returns index of its matching closer (or last token).
    const T = this.T;
    const open = T[k].v;
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    for (let j = k; j < T.length; j++) {
      const v = T[j].v;
      if (T[j].t !== 'p') continue;
      if (v === open) depth++;
      else if (v === close) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return T.length - 1;
  }

  matchAngle(k) {
    // T[k] is '<'. Returns index of matching '>' or -1 if this is not a template list.
    const T = this.T;
    let depth = 0;
    let paren = 0;
    for (let j = k; j < T.length && j < k + 80; j++) {
      const v = T[j].v;
      if (T[j].t !== 'p') continue;
      if (v === '(') paren++;
      else if (v === ')') {
        paren--;
        if (paren < 0) return -1;
      } else if (paren === 0 && v === '<') depth++;
      else if (paren === 0 && v === '>') {
        depth--;
        if (depth === 0) return j;
      } else if (v === ';' || v === '{' || v === '}' || v === '&&' || v === '||') return -1;
    }
    return -1;
  }

  matchAngleBackward(k) {
    // T[k] is '>'. Returns index of matching '<' or -1.
    const T = this.T;
    let depth = 0;
    for (let j = k; j >= 0 && j > k - 80; j--) {
      const v = T[j].v;
      if (v === '>') depth++;
      else if (v === '<') {
        depth--;
        if (depth === 0) return j;
      } else if (v === ';' || v === '{' || v === '}') return -1;
    }
    return -1;
  }

  skipToSemicolon() {
    const T = this.T;
    let k = this.p;
    while (k < T.length) {
      const v = T[k].v;
      if (v === ';') {
        this.p = k + 1;
        return;
      }
      if (v === '(' || v === '[' || v === '{') {
        k = this.matchClose(k) + 1;
        continue;
      }
      if (v === '}') {
        this.p = k;
        return;
      }
      k++;
    }
    this.p = k;
  }

  addEntity(e) {
    this.entities.push(e);
    return this.entities.length - 1;
  }

  // ---- scopes ---------------------------------------------------------

  parse() {
    this.parseScope(false, { kind: 'file', parent: -1, nsPath: [], classIdx: -1, access: 'public' });
    return { path: this.path, includes: this.includes, entities: this.entities };
  }

  parseScope(endAtBrace, ctx) {
    const T = this.T;
    while (this.p < T.length) {
      const t = T[this.p];
      const v = t.v;

      if (t.t === 'p') {
        if (v === '}') {
          this.p++;
          if (endAtBrace) return;
          continue;
        }
        if (v === ';') {
          this.p++;
          continue;
        }
        if (v === '[' && this.v(this.p + 1) === '[') {
          this.p = this.matchClose(this.p) + 1; // [[attribute]]
          continue;
        }
      }

      if (t.t === 'id') {
        if (v === 'namespace' || (v === 'inline' && this.v(this.p + 1) === 'namespace')) {
          this.parseNamespace(ctx);
          continue;
        }
        if (v === 'extern' && T[this.p + 1] && T[this.p + 1].t === 'str') {
          if (this.v(this.p + 2) === '{') {
            this.p += 3;
            this.parseScope(true, ctx);
          } else this.p += 2;
          continue;
        }
        if (v === 'extern' && this.v(this.p + 1) === 'template') {
          this.skipToSemicolon();
          continue;
        }
        if (v === 'template') {
          this.p++;
          if (this.v(this.p) === '<') {
            const c = this.matchAngle(this.p);
            this.p = c < 0 ? this.p + 1 : c + 1;
          }
          continue;
        }
        if (v === 'class' || v === 'struct' || v === 'union') {
          if (this.tryParseClass(ctx, false)) continue;
        }
        if (v === 'enum') {
          if (this.tryParseEnum(ctx, false)) continue;
        }
        if (v === 'typedef') {
          const nv = this.v(this.p + 1);
          if (nv === 'struct' || nv === 'class' || nv === 'union') {
            this.p++;
            if (this.tryParseClass(ctx, true)) continue;
            this.p--;
          } else if (nv === 'enum') {
            this.p++;
            if (this.tryParseEnum(ctx, true)) continue;
            this.p--;
          }
          this.skipToSemicolon();
          continue;
        }
        if (v === 'using' || v === 'static_assert' || v === '_Static_assert' || v === 'asm' || v === '__asm__' || v === 'concept') {
          this.skipToSemicolon();
          continue;
        }
        if (ctx.kind === 'class') {
          if ((v === 'public' || v === 'private' || v === 'protected')) {
            let k = this.p + 1;
            while (T[k] && T[k].t === 'id' && T[k].v !== 'virtual') k++; // "public slots:"
            if (this.v(k) === ':') {
              ctx.access = v;
              this.p = k + 1;
              continue;
            }
          }
          if (this.v(this.p + 1) === ':' && (v === 'signals' || v === 'slots' || v === 'Q_SIGNALS' || v === 'Q_SLOTS')) {
            this.p += 2;
            continue;
          }
        }
        if (v === 'friend') {
          // friend class X; / friend void f(); are not members. Inline friend definitions are kept.
          let k = this.p;
          let hasBody = false;
          while (k < T.length && T[k].v !== ';') {
            if (T[k].v === '{') {
              hasBody = true;
              break;
            }
            if (T[k].v === '}') break;
            k++;
          }
          if (!hasBody) {
            this.skipToSemicolon();
            continue;
          }
        }
        // Object-like or function-like macro invocations without a trailing semicolon,
        // e.g. Q_OBJECT or DECLARE_DYNAMIC(Foo).
        if (ALLCAPS.test(v) && v.length > 1) {
          const next = T[this.p + 1];
          if (next && next.nl && !['{', ';', '(', '::', '<', '*', '&', '='].includes(next.v)) {
            this.p++;
            continue;
          }
          if (next && next.v === '(') {
            const c = this.matchClose(this.p + 1);
            const after = T[c + 1];
            if (!after || (after.nl && !['{', ';', ':', 'const', 'noexcept', 'override', 'final', '->', 'throw', 'try', 'volatile', '&', '&&', '='].includes(after.v))) {
              this.p = c + 1;
              continue;
            }
          }
        }
      }

      const before = this.p;
      this.parseDeclaration(ctx);
      if (this.p === before) this.p++; // always make progress
    }
  }

  parseNamespace(ctx) {
    const T = this.T;
    if (this.v(this.p) === 'inline') this.p++;
    const line = T[this.p].line;
    this.p++; // 'namespace'
    const parts = [];
    while (this.p < T.length) {
      const t = T[this.p];
      if (t.t === 'id' && t.v !== 'inline') parts.push(t.v);
      else if (t.v === '::' || t.v === 'inline') {
        // continue
      } else if (t.v === '[' && this.v(this.p + 1) === '[') {
        this.p = this.matchClose(this.p);
      } else break;
      this.p++;
    }
    if (this.v(this.p) === '=') {
      this.skipToSemicolon();
      return;
    }
    if (this.v(this.p) !== '{') {
      this.skipToSemicolon();
      return;
    }
    const name = parts.length ? parts.join('::') : '(anonymous)';
    const idx = this.addEntity({
      kind: 'namespace',
      name,
      qname: ctx.nsPath.concat(parts.length ? parts : ['(anonymous)']).join('::'),
      line,
      endLine: line,
      parent: ctx.parent
    });
    this.p++; // '{'
    const inner = { kind: 'namespace', parent: idx, nsPath: ctx.nsPath.concat(parts.length ? parts : []), classIdx: -1, access: 'public' };
    this.parseScope(true, inner);
    const last = T[Math.min(this.p - 1, T.length - 1)];
    this.entities[idx].endLine = last ? last.line : line;
  }

  tryParseClass(ctx, isTypedef) {
    const T = this.T;
    const start = this.p;
    const key = T[start].v;
    const line = T[start].line;
    let k = start + 1;
    // Find the end of the class head: '{' (definition) or ';' / '(' / '=' (not a definition).
    let stop = -1;
    while (k < T.length) {
      const v = T[k].v;
      if (v === '{') {
        stop = k;
        break;
      }
      if (v === ';' || v === '(' || v === '=' || v === ')' || v === '}' || v === ',' && !this.inBases(start, k)) break;
      if (v === '<') {
        const c = this.matchAngle(k);
        if (c < 0) break;
        k = c + 1;
        continue;
      }
      if (v === '[' && this.v(k + 1) === '[') {
        k = this.matchClose(k) + 1;
        continue;
      }
      k++;
    }
    if (stop < 0) {
      // Forward declaration "class Foo;" — nothing to record.
      if (this.v(k) === ';' && k - start <= 4 && !isTypedef) {
        this.p = k + 1;
        return true;
      }
      return false;
    }

    const head = T.slice(start + 1, stop);
    // Split head into name part and base list at a top-level single ':'.
    let colon = -1;
    let depth = 0;
    for (let j = 0; j < head.length; j++) {
      const v = head[j].v;
      if (v === '<') depth++;
      else if (v === '>') depth--;
      else if (v === ':' && depth === 0) {
        colon = j;
        break;
      }
    }
    const namePart = colon < 0 ? head : head.slice(0, colon);
    const basePart = colon < 0 ? [] : head.slice(colon + 1);

    // The class name is the last identifier chain at angle depth 0, ignoring final/attributes/macros.
    let name = '';
    let qual = [];
    depth = 0;
    for (let j = 0; j < namePart.length; j++) {
      const t = namePart[j];
      if (t.v === '<') depth++;
      else if (t.v === '>') depth--;
      else if (depth === 0 && t.t === 'id' && t.v !== 'final' && t.v !== 'sealed' && !KEYWORDS.has(t.v)) {
        if (j > 0 && namePart[j - 1].v === '::') qual.push(name);
        else qual = [];
        name = t.v;
      }
    }

    const bases = [];
    if (basePart.length) {
      let cur = [];
      depth = 0;
      const flush = () => {
        let access = key === 'class' ? 'private' : 'public';
        let isVirtual = false;
        const chain = [];
        let d = 0;
        for (const t of cur) {
          if (t.v === '<') d++;
          else if (t.v === '>') d--;
          else if (d === 0 && t.t === 'id') {
            if (t.v === 'public' || t.v === 'private' || t.v === 'protected') access = t.v;
            else if (t.v === 'virtual') isVirtual = true;
            else chain.push(t.v);
          }
        }
        if (chain.length) bases.push({ name: chain.join('::'), access, virtual: isVirtual });
        cur = [];
      };
      for (const t of basePart) {
        if (t.v === '<') depth++;
        else if (t.v === '>') depth--;
        if (t.v === ',' && depth === 0) flush();
        else cur.push(t);
      }
      flush();
    }

    const idx = this.addEntity({
      kind: 'class',
      key,
      name,
      qname: '',
      outerQual: qual,
      bases,
      line,
      endLine: line,
      parent: ctx.parent,
      headHash: hashString(head.map(t => t.v).join(' ')),
      access: ctx.kind === 'class' ? ctx.access : undefined
    });
    this.p = stop + 1;
    const inner = {
      kind: 'class',
      parent: idx,
      nsPath: ctx.nsPath.concat(qual, [name || '(anonymous)']),
      classIdx: idx,
      access: key === 'class' ? 'private' : 'public'
    };
    this.parseScope(true, inner);
    const ent = this.entities[idx];
    ent.endLine = T[this.p - 1] ? T[this.p - 1].line : line;

    // Declarators after the closing brace: typedef names or variables.
    let declName = '';
    while (this.p < T.length && T[this.p].v !== ';' && T[this.p].v !== '}') {
      const t = T[this.p];
      if (t.t === 'id' && !KEYWORDS.has(t.v) && !declName) declName = t.v;
      if (t.v === '(' || t.v === '[' || t.v === '{') {
        this.p = this.matchClose(this.p) + 1;
        continue;
      }
      this.p++;
    }
    if (this.v(this.p) === ';') this.p++;
    if (!ent.name && declName) {
      ent.name = declName;
    } else if (!ent.name) {
      ent.name = '(anonymous ' + key + ')';
    }
    ent.qname = ctx.nsPath.concat(qual, [ent.name]).join('::');
    // Children were created with the provisional path; fix their qualified names.
    if (inner.nsPath[inner.nsPath.length - 1] !== ent.name) {
      const oldPrefix = inner.nsPath.join('::');
      for (let j = idx + 1; j < this.entities.length; j++) {
        const e = this.entities[j];
        if (e.qname && e.qname.startsWith(oldPrefix)) e.qname = ent.qname + e.qname.slice(oldPrefix.length);
      }
    }
    return true;
  }

  inBases(start, k) {
    // True if position k is after a top-level ':' in a class head (so ',' separates bases).
    for (let j = start; j < k; j++) if (this.T[j].v === ':') return true;
    return false;
  }

  tryParseEnum(ctx, isTypedef) {
    const T = this.T;
    const start = this.p;
    const line = T[start].line;
    let k = start + 1;
    let name = '';
    let qual = [];
    let sawColon = false;
    while (k < T.length) {
      const t = T[k];
      if (t.v === '{' || t.v === ';' || t.v === '=' || t.v === '(' || t.v === ')' || t.v === '}') break;
      if (t.v === ':') sawColon = true;
      if (!sawColon && t.t === 'id' && t.v !== 'class' && t.v !== 'struct' && !KEYWORDS.has(t.v)) {
        if (T[k - 1].v === '::') qual.push(name);
        name = t.v;
      }
      k++;
    }
    if (this.v(k) !== '{') {
      if (this.v(k) === ';' && !isTypedef) {
        this.p = k + 1;
        return true; // opaque enum declaration
      }
      return false;
    }
    const close = this.matchClose(k);
    // Enumerators
    const values = [];
    let expect = true;
    for (let j = k + 1; j < close; j++) {
      const t = T[j];
      if (expect && t.t === 'id') {
        values.push(t.v);
        expect = false;
      } else if (t.v === ',') expect = true;
      else if (t.v === '(' || t.v === '{' || t.v === '[') j = this.matchClose(j);
    }
    const idx = this.addEntity({
      kind: 'enum',
      name,
      qname: '',
      line,
      endLine: T[close].line,
      parent: ctx.parent,
      values,
      headHash: hashString(T.slice(start, close + 1).map(t => t.v).join(' '))
    });
    this.p = close + 1;
    let declName = '';
    while (this.p < T.length && T[this.p].v !== ';' && T[this.p].v !== '}') {
      if (T[this.p].t === 'id' && !declName && !KEYWORDS.has(T[this.p].v)) declName = T[this.p].v;
      this.p++;
    }
    if (this.v(this.p) === ';') this.p++;
    const ent = this.entities[idx];
    if (!ent.name) ent.name = declName || '(anonymous enum)';
    ent.qname = ctx.nsPath.concat(qual, [ent.name]).join('::');
    return true;
  }

  // ---- declarations ------------------------------------------------------

  funcNameBefore(open, start) {
    const T = this.T;
    // operator overloads
    for (let j = open - 1; j >= start && j >= open - 4; j--) {
      if (T[j].v === 'operator') {
        if (j === open - 1) {
          // operator()(...) — the first () is part of the name
          if (this.v(open + 1) === ')' && this.v(open + 2) === '(') {
            return { name: 'operator()', qual: this.qualBefore(j, start).qual, nameStart: this.qualBefore(j, start).nameStart, paramsOpen: open + 2 };
          }
          return null;
        }
        const name = 'operator' + T.slice(j + 1, open).map(t => (t.t === 'id' ? ' ' + t.v : t.v)).join('');
        const q = this.qualBefore(j, start);
        return { name, qual: q.qual, nameStart: q.nameStart, paramsOpen: open };
      }
    }
    const k = open - 1;
    if (k < start) return null;
    const t = T[k];
    if (t.t !== 'id' || NON_FUNC.has(t.v)) return null;
    let name = t.v;
    let nameIdx = k;
    if (k - 1 >= start && T[k - 1].v === '~') {
      name = '~' + name;
      nameIdx = k - 1;
    }
    const q = this.qualBefore(nameIdx, start);
    const prev = T[q.nameStart - 1];
    if (q.nameStart > start && prev && (prev.v === '.' || prev.v === '->')) return null;
    return { name, qual: q.qual, nameStart: q.nameStart, paramsOpen: open };
  }

  qualBefore(nameIdx, start) {
    const T = this.T;
    const qual = [];
    let nameStart = nameIdx;
    let j = nameIdx - 1;
    while (j >= start && T[j].v === '::') {
      let q = j - 1;
      if (q >= start && T[q].v === '>') {
        const o = this.matchAngleBackward(q);
        if (o < 0) break;
        q = o - 1;
      }
      if (q < start || T[q].t !== 'id' || KEYWORDS.has(T[q].v)) {
        nameStart = j; // leading global '::'
        break;
      }
      qual.unshift(T[q].v);
      nameStart = q;
      j = q - 1;
    }
    return { qual, nameStart };
  }

  afterParams(k) {
    // k is the token after the parameter list's ')'. Returns {body} or {end} index.
    const T = this.T;
    while (k < T.length) {
      const v = T[k].v;
      if (T[k].t === 'p') {
        if (v === '{') return { body: k };
        if (v === ';') return { end: k };
        if (v === '}' ) return { end: k - 1, unterminated: true };
        if (v === '=') {
          while (k < T.length && T[k].v !== ';' && T[k].v !== '}') {
            if (T[k].v === '{' || T[k].v === '(') k = this.matchClose(k);
            k++;
          }
          return { end: k };
        }
        if (v === ',') {
          while (k < T.length && T[k].v !== ';' && T[k].v !== '}') k++;
          return { end: k };
        }
        if (v === '(' || v === '[') {
          k = this.matchClose(k) + 1;
          continue;
        }
        if (v === ':') {
          // constructor member-initializer list
          k++;
          let state = 'name';
          while (k < T.length) {
            const w = T[k].v;
            if (state === 'name') {
              if (T[k].t === 'id' || w === '::' || w === '.') {
                k++;
                continue;
              }
              if (w === '<') {
                const c = this.matchAngle(k);
                if (c < 0) return { end: k };
                k = c + 1;
                continue;
              }
              if (w === '(' || w === '{') {
                k = this.matchClose(k) + 1;
                state = 'after';
                continue;
              }
              return { end: k };
            } else {
              if (w === ',') {
                state = 'name';
                k++;
                continue;
              }
              if (w === '...') {
                k++;
                continue;
              }
              if (w === '{') return { body: k };
              return { end: k };
            }
          }
          return { end: k };
        }
      }
      k++;
    }
    return { end: T.length - 1 };
  }

  parseDeclaration(ctx) {
    const T = this.T;
    const start = this.p;
    let k = start;
    let assignAt = -1;
    while (k < T.length) {
      const t = T[k];
      const v = t.v;
      if (t.t === 'p') {
        if (v === '(') {
          const cand = assignAt < 0 ? this.funcNameBefore(k, start) : null;
          if (cand) {
            const open = cand.paramsOpen;
            const close = this.matchClose(open);
            const r = this.afterParams(close + 1);
            this.recordFunction(ctx, start, cand, open, close, r);
            if (r.body !== undefined) {
              this.p = this.matchClose(r.body) + 1;
            } else {
              this.p = r.unterminated ? r.end + 1 : r.end + 1;
            }
            return;
          }
          k = this.matchClose(k) + 1;
          continue;
        }
        if (v === '[') {
          k = this.matchClose(k) + 1;
          continue;
        }
        if (v === '{') {
          k = this.matchClose(k) + 1;
          continue;
        }
        if (v === '=' && assignAt < 0) assignAt = k;
        if (v === ';') {
          this.recordVariables(ctx, start, k);
          this.p = k + 1;
          return;
        }
        if (v === '}') {
          this.recordVariables(ctx, start, k);
          this.p = k;
          return;
        }
      }
      k++;
    }
    this.p = k;
  }

  splitTopLevel(toks, sep) {
    const parts = [];
    let cur = [];
    let depth = 0;
    let angle = 0;
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j];
      const v = t.v;
      if (t.t === 'p') {
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') depth--;
        else if (v === '<' && j > 0 && toks[j - 1].t === 'id') angle++;
        else if (v === '>' && angle > 0) angle--;
        else if (v === sep && depth === 0 && angle === 0) {
          parts.push(cur);
          cur = [];
          continue;
        }
      }
      cur.push(t);
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  typeInfo(toks) {
    // Returns {name, ids} where name is the main class-like type name in a type expression.
    const ids = [];
    let main = '';
    let mainIdx = -1;
    let depth = 0;
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j];
      if (t.v === '<') depth++;
      else if (t.v === '>') depth--;
      else if (t.t === 'id' && !KEYWORDS.has(t.v)) {
        ids.push(t.v);
        if (depth === 0 && !TYPE_QUALIFIERS.has(t.v)) {
          main = t.v;
          mainIdx = j;
        }
      }
    }
    if (main && WRAPPERS.has(main) && toks[mainIdx + 1] && toks[mainIdx + 1].v === '<') {
      let inner = '';
      let d = 0;
      for (let j = mainIdx + 1; j < toks.length; j++) {
        const t = toks[j];
        if (t.v === '<') d++;
        else if (t.v === '>') {
          d--;
          if (d === 0) break;
        } else if (t.v === ',' && d === 1) break;
        else if (d === 1 && t.t === 'id' && !KEYWORDS.has(t.v) && !TYPE_QUALIFIERS.has(t.v)) inner = t.v;
      }
      if (inner) main = inner;
    }
    return { name: main, ids };
  }

  parseParams(open, close) {
    const toks = this.T.slice(open + 1, close);
    const params = [];
    if (toks.length === 0 || (toks.length === 1 && toks[0].v === 'void')) return params;
    for (let part of this.splitTopLevel(toks, ',')) {
      const eq = part.findIndex(t => t.v === '=');
      if (eq >= 0) part = part.slice(0, eq);
      if (!part.length) continue;
      if (part.length === 1 && part[0].v === '...') {
        params.push({ type: '...', name: '', typeName: '' });
        continue;
      }
      // Name is the last identifier if there is more than a bare type.
      let nameIdx = -1;
      for (let j = part.length - 1; j >= 0; j--) {
        if (part[j].v === '[') continue;
        if (part[j].t === 'id' && !KEYWORDS.has(part[j].v)) {
          nameIdx = j;
        }
        break;
      }
      // Arrays: "int a[10]" — last tokens are [ 10 ]
      if (nameIdx < 0) {
        const br = part.findIndex(t => t.v === '[');
        if (br > 0 && part[br - 1].t === 'id') nameIdx = br - 1;
      }
      const typeToks = nameIdx > 0 && part.slice(0, nameIdx).some(t => t.t === 'id') ? part.slice(0, nameIdx) : part;
      const name = typeToks === part ? '' : part[nameIdx].v;
      const ti = this.typeInfo(typeToks);
      params.push({ type: joinTokens(typeToks), name, typeName: ti.name, ids: ti.ids });
    }
    return params;
  }

  recordFunction(ctx, start, cand, open, close, r) {
    const T = this.T;
    const retToks = T.slice(start, cand.nameStart);
    const flagsOf = new Set(retToks.filter(t => t.t === 'id').map(t => t.v));
    const params = this.parseParams(open, close);
    // trailing qualifiers between ')' and body/end
    const tailEnd = r.body !== undefined ? r.body : r.end;
    const tail = T.slice(close + 1, Math.max(close + 1, tailEnd)).filter(t => t.t === 'id').map(t => t.v);
    const isPure = r.body === undefined && T.slice(close + 1, r.end + 1).some((t, j, arr) => t.v === '=' && arr[j + 1] && arr[j + 1].v === '0');

    let name = cand.name;
    const isMacroStyle = retToks.length === 0 && cand.qual.length === 0 && ALLCAPS.test(name) && ctx.kind !== 'class';
    if (isMacroStyle) {
      name = name + '(' + params.map(p => p.type).join(', ') + ')';
    }
    const retType = joinTokens(retToks.filter(t => !['virtual', 'static', 'inline', 'explicit', 'constexpr', 'extern', 'friend', '__inline', '__forceinline', 'consteval'].includes(t.v)));
    const paramsText = params.map(p => (p.name ? p.type + ' ' + p.name : p.type)).join(', ');
    const constQual = tail.includes('const') ? ' const' : '';
    const fullName = (cand.qual.length ? cand.qual.join('::') + '::' : '') + cand.name;
    const signature = (retType ? retType + ' ' : '') + fullName + '(' + paramsText + ')' + constQual;
    const sig = isMacroStyle ? '' : params.map(p => p.type.replace(/\b(class|struct|union|enum|typename)\s+/g, '').replace(/\s+/g, '')).join(',') + (constQual ? ' const' : '');

    const ent = {
      kind: 'function',
      name,
      qname: ctx.nsPath.concat(cand.qual, [name]).join('::'),
      nsPath: ctx.nsPath.slice(),
      qual: cand.qual,
      inClass: ctx.kind === 'class' ? ctx.classIdx : -1,
      params,
      sig,
      signature,
      isDecl: r.body === undefined,
      isVirtual: flagsOf.has('virtual') || tail.includes('override') || tail.includes('final'),
      isPure,
      isStatic: flagsOf.has('static'),
      access: ctx.kind === 'class' ? ctx.access : undefined,
      line: T[cand.nameStart].line,
      endLine: T[cand.nameStart].line,
      parent: ctx.parent,
      retTypeName: this.typeInfo(retToks).name,
      body: null,
      hash: ''
    };

    if (r.body === undefined) {
      // Class member declarations are kept so out-of-line definitions can attach
      // to them. Free function prototypes are kept too; the builder links each to
      // its definition instead of making a node (GraphBuilder.linkPrototypes).
      ent.hash = hashString(signature);
      if (T[r.end]) ent.endLine = T[r.end].line;
      this.addEntity(ent);
      return;
    }
    const bodyClose = this.matchClose(r.body);
    ent.endLine = T[bodyClose].line;
    ent.body = this.scanBody(r.body, bodyClose, close + 1);
    ent.hash = hashString(signature + '|' + T.slice(r.body, bodyClose + 1).map(t => t.v).join(' '));
    this.addEntity(ent);
  }

  scanBody(b0, b1, initStart) {
    // Scan tokens of a function body (and constructor initializer list) for calls,
    // identifier references and local variable types.
    const T = this.T;
    const calls = [];
    const idents = new Set();
    const locals = {};
    const from = initStart !== undefined && initStart < b0 ? initStart : b0;
    for (let k = from + 1; k < b1; k++) {
      const t = T[k];
      if (t.t !== 'id') continue;
      const v = t.v;
      if (KEYWORDS.has(v)) {
        if (v === 'new') {
          // new T(...)  ->  creates T
          let j = k + 1;
          let last = '';
          while (j < b1 && (T[j].t === 'id' || T[j].v === '::')) {
            if (T[j].t === 'id') last = T[j].v;
            j++;
          }
          if (last) calls.push({ name: last, qual: [], recv: null, line: t.line, isNew: true });
        }
        continue;
      }
      idents.add(v);

      let next = k + 1;
      if (T[next] && T[next].v === '<') {
        const c = this.matchAngle(next);
        if (c > 0) {
          // template call foo<T>(...) or template type Foo<T> var
          if (T[c + 1] && T[c + 1].v === '(') next = c + 1;
          else {
            this.maybeLocal(k, c + 1, b1, locals);
            continue;
          }
        }
      }
      if (T[next] && T[next].v === '(') {
        const prev = T[k - 1];
        let qual = [];
        let recv = null;
        if (prev && prev.v === '::') {
          qual = this.qualBefore(k, from).qual;
        } else if (prev && (prev.v === '.' || prev.v === '->')) {
          const r = T[k - 2];
          if (r && r.v === 'this') recv = { this: true };
          else if (r && r.t === 'id') recv = { var: r.v };
          else recv = { expr: true };
        }
        calls.push({ name: v, qual, recv, line: t.line });
        continue;
      }
      this.maybeLocal(k, k + 1, b1, locals);
    }
    return { calls, idents: [...idents], locals };
  }

  maybeLocal(typeIdx, k, b1, locals) {
    // Pattern: Type [*&const]* name followed by = ; ( { , ) [ :
    const T = this.T;
    const prev = T[typeIdx - 1];
    if (prev && (prev.v === '.' || prev.v === '->')) return;
    let typeName = T[typeIdx].v;
    if (T[typeIdx + 1] && T[typeIdx + 1].v === '<' && WRAPPERS.has(typeName)) {
      const inner = this.typeInfo(T.slice(typeIdx, k)).name;
      if (inner) typeName = inner;
    }
    let j = k;
    while (j < b1 && (T[j].v === '*' || T[j].v === '&' || T[j].v === '&&' || T[j].v === 'const')) j++;
    const nameTok = T[j];
    if (!nameTok || nameTok.t !== 'id' || KEYWORDS.has(nameTok.v)) return;
    const after = T[j + 1];
    if (!after || !['=', ';', '(', '{', ',', ')', '[', ':'].includes(after.v)) return;
    if (typeName === 'auto' && after.v === '=') {
      // auto x = new T / std::make_unique<T>() / static_cast<T*>(...)
      let q = j + 2;
      if (T[q] && T[q].v === 'new') {
        let last = '';
        q++;
        while (q < b1 && (T[q].t === 'id' || T[q].v === '::')) {
          if (T[q].t === 'id') last = T[q].v;
          q++;
        }
        if (last) locals[nameTok.v] = last;
        return;
      }
      while (q < b1 && (T[q].t === 'id' || T[q].v === '::')) q++;
      if (T[q] && T[q].v === '<') {
        const c = this.matchAngle(q);
        if (c > 0) {
          const inner = this.typeInfo(T.slice(q + 1, c)).name;
          if (inner) locals[nameTok.v] = inner;
        }
        return;
      }
      // auto x = T(...) or T::create(...)
      const first = T[j + 2];
      if (first && first.t === 'id' && !KEYWORDS.has(first.v)) locals[nameTok.v] = '?' + first.v;
      return;
    }
    if (KEYWORDS.has(typeName) && typeName !== 'auto') return;
    if (typeName === 'auto') return;
    locals[nameTok.v] = typeName;
  }

  recordVariables(ctx, start, end) {
    if (ctx.kind === 'block') return;
    const T = this.T;
    const toks = T.slice(start, end);
    if (!toks.length) return;
    const first = toks[0].v;
    if (['return', 'goto', 'break', 'continue', 'case', 'default', 'delete', 'throw', 'typedef', 'using', 'friend', 'static_assert'].includes(first)) return;
    const parts = this.splitTopLevel(toks, ',');
    let typeToks = null;
    let typeName = '';
    for (let pi = 0; pi < parts.length; pi++) {
      let part = parts[pi];
      const stopIdx = part.findIndex((t, j) => t.v === '=' || t.v === '[' || t.v === '{' || (t.v === ':' && j > 0) || t.v === '(');
      const declPart = stopIdx >= 0 ? part.slice(0, stopIdx) : part;
      let nameIdx = -1;
      for (let j = declPart.length - 1; j >= 0; j--) {
        if (declPart[j].t === 'id') {
          nameIdx = j;
          break;
        }
        if (!['*', '&', '&&'].includes(declPart[j].v)) break;
      }
      if (nameIdx < 0) continue;
      const nameTok = declPart[nameIdx];
      if (KEYWORDS.has(nameTok.v)) continue;
      if (pi === 0) {
        typeToks = declPart.slice(0, nameIdx);
        if (!typeToks.some(t => t.t === 'id')) return; // "x;" or a macro: not a declaration
        typeName = this.typeInfo(typeToks).name;
      }
      if (!typeToks) return;
      const flags = new Set(typeToks.filter(t => t.t === 'id').map(t => t.v));
      const typeText = joinTokens(typeToks.concat(declPart.slice(nameIdx + 1)).filter(t => !['static', 'extern', 'inline', 'mutable', 'constexpr', 'thread_local'].includes(t.v)));
      this.addEntity({
        kind: ctx.kind === 'class' ? 'field' : 'variable',
        name: nameTok.v,
        qname: ctx.nsPath.concat([nameTok.v]).join('::'),
        typeText,
        typeName,
        typeIds: this.typeInfo(typeToks).ids,
        isStatic: flags.has('static'),
        isExtern: flags.has('extern'),
        access: ctx.kind === 'class' ? ctx.access : undefined,
        line: nameTok.line,
        endLine: nameTok.line,
        parent: ctx.parent,
        hash: hashString(typeText + ' ' + nameTok.v)
      });
    }
  }
}

function parseFile(path, text) {
  try {
    return new Parser(path, text).parse();
  } catch (err) {
    return { path, includes: [], entities: [], error: String(err && err.stack || err) };
  }
}

module.exports = { parseFile, hashString, KEYWORDS };
