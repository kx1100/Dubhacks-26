'use strict';

// A small, forgiving C/C++ tokenizer. It is not a full preprocessor: it keeps
// #include directives, drops other directives, and keeps only the first branch
// of #if/#ifdef/#ifndef blocks (skipping `#if 0` bodies) so that brace
// structure stays balanced in the common cases.

const MULTI_PUNCT = ['...', '<<=', '>>=', '->*', '::', '->', '++', '--', '==', '!=', '<=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '.*'];

function isIdStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\x7f';
}
function isIdChar(c) {
  return isIdStart(c) || (c >= '0' && c <= '9');
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

/**
 * @param {string} src
 * @returns {{tokens: Array<{t:string,v:string,line:number,nl:boolean}>, includes: Array<{path:string,system:boolean,line:number}>}}
 */
function tokenize(src) {
  const tokens = [];
  const includes = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let sawNewline = true; // a newline (or start of file) precedes the next token
  let atLineStart = true; // only whitespace so far on this line

  // Preprocessor conditional stack: each entry {active, taken}
  const cond = [];
  const skipping = () => cond.length > 0 && cond.some(c => !c.active);

  function push(t, v) {
    if (skipping()) return;
    tokens.push({ t, v, line, nl: sawNewline });
    sawNewline = false;
  }

  function readDirective() {
    // i points at '#'. Read until end of line honoring backslash continuations and comments.
    let text = '';
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
        i += src[i + 1] === '\r' ? 3 : 2;
        line++;
        text += ' ';
        continue;
      }
      if (c === '\n') break;
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        text += ' ';
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        break;
      }
      text += c;
      i++;
    }
    return text.trim();
  }

  function handleDirective(text, dirLine) {
    const m = /^(\w+)\s*(.*)$/s.exec(text);
    if (!m) return;
    const kw = m[1];
    const rest = m[2].trim();
    switch (kw) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const isZero = kw === 'if' && /^(0|false)\b/.test(rest);
        cond.push({ active: !isZero, taken: !isZero });
        break;
      }
      case 'elif':
      case 'elifdef':
      case 'elifndef':
      case 'else': {
        const top = cond[cond.length - 1];
        if (top) {
          // Keep only the first taken branch.
          if (top.taken) top.active = false;
          else {
            const isZero = kw === 'elif' && /^(0|false)\b/.test(rest);
            top.active = !isZero;
            top.taken = top.active;
          }
        }
        break;
      }
      case 'endif':
        cond.pop();
        break;
      case 'include':
      case 'include_next':
      case 'import': {
        if (skipping()) break;
        const im = /^(?:"([^"]+)"|<([^>]+)>)/.exec(rest);
        if (im) includes.push({ path: im[1] || im[2], system: !im[1], line: dirLine });
        break;
      }
      default:
        break;
    }
  }

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      line++;
      i++;
      sawNewline = true;
      atLineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '#' && atLineStart) {
      const dirLine = line;
      const text = readDirective();
      handleDirective(text, dirLine);
      continue;
    }
    atLineStart = false;

    // Raw string literal: R"delim( ... )delim" with optional prefix
    if ((c === 'R' || ((c === 'u' || c === 'U' || c === 'L') && (src[i + 1] === 'R' || (src[i + 1] === '8' && src[i + 2] === 'R')))) ) {
      const rm = /^(?:u8|u|U|L)?R"([^()\\\s]{0,16})\(/.exec(src.slice(i, i + 24));
      if (rm) {
        const close = ')' + rm[1] + '"';
        const start = i;
        const end = src.indexOf(close, i + rm[0].length);
        const stop = end < 0 ? n : end + close.length;
        const startLine = line;
        for (let k = start; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        if (!skipping()) {
          tokens.push({ t: 'str', v: '""', line: startLine, nl: sawNewline });
          sawNewline = false;
        }
        continue;
      }
    }

    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      const word = src.slice(i, j);
      // String/char literal prefixes
      if ((src[j] === '"' || src[j] === "'") && /^(u8|u|U|L)$/.test(word)) {
        i = j;
        continue; // the literal itself is read on the next iteration
      }
      push('id', word);
      i = j;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (isIdChar(d) || d === '.' || d === "'") j++;
        else if ((d === '+' || d === '-') && /[eEpP]/.test(src[j - 1])) j++;
        else break;
      }
      push('num', src.slice(i, j));
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') break; // unterminated
        j++;
      }
      push(c === '"' ? 'str' : 'chr', c === '"' ? '""' : "''");
      i = Math.min(n, j + 1);
      continue;
    }

    let matched = null;
    for (const p of MULTI_PUNCT) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      push('p', matched);
      i += matched.length;
      continue;
    }
    push('p', c);
    i++;
  }

  return { tokens, includes };
}

module.exports = { tokenize };
