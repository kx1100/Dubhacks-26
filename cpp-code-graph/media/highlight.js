// Small C/C++ syntax highlighter for the code cards in the graph.
// Unlike the parser's lexer it keeps comments, whitespace and string text, so a
// snippet is shown exactly as written. Exposes window.CodeHighlight.
(function () {
  'use strict';

  const KEYWORDS = new Set(
    ('alignas alignof and asm auto break case catch class const consteval constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern false final for friend goto if inline mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this throw true try typedef typeid typename union using virtual volatile while xor').split(' ')
  );
  const TYPES = new Set(
    ('bool char char8_t char16_t char32_t double float int long short signed size_t ssize_t unsigned void wchar_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t intptr_t ptrdiff_t FILE string vector map set unique_ptr shared_ptr').split(' ')
  );

  function esc(s) {
    return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }
  function span(cls, text) {
    return `<span class="tk-${cls}">${esc(text)}</span>`;
  }

  /**
   * Highlights an array of source lines. Returns one HTML string per line.
   * Block comments, raw strings and preprocessor continuations carry over to
   * the next line.
   */
  function highlightLines(lines) {
    let inBlock = false;
    let rawEnd = null; // closing sequence of an open raw string, e.g. )delim"
    let inPP = false; // inside a #directive continued with a trailing backslash
    return lines.map(line => {
      let out = '';
      let i = 0;
      const n = line.length;
      const emit = (cls, text) => {
        out += cls ? span(cls, text) : esc(text);
      };
      // "#include", "#define", ... at the start of a (non-continued) line.
      const directive = !inBlock && rawEnd === null && !inPP ? /^(\s*)(#\s*[A-Za-z_]*)(\s*<[^>]*>)?/.exec(line) : null;
      if (directive) {
        inPP = true;
        emit('', directive[1]);
        emit('pp', directive[2]);
        if (directive[3]) {
          const lead = /^\s*/.exec(directive[3])[0];
          emit('', lead);
          emit('str', directive[3].slice(lead.length));
        }
        i = directive[0].length;
      }
      while (i < n) {
        if (inBlock) {
          const end = line.indexOf('*/', i);
          if (end < 0) {
            emit('cm', line.slice(i));
            i = n;
          } else {
            emit('cm', line.slice(i, end + 2));
            i = end + 2;
            inBlock = false;
          }
          continue;
        }
        if (rawEnd !== null) {
          const end = line.indexOf(rawEnd, i);
          if (end < 0) {
            emit('str', line.slice(i));
            i = n;
          } else {
            emit('str', line.slice(i, end + rawEnd.length));
            i = end + rawEnd.length;
            rawEnd = null;
          }
          continue;
        }
        const ch = line[i];
        const two = line.substr(i, 2);
        if (two === '//') {
          emit('cm', line.slice(i));
          i = n;
        } else if (two === '/*') {
          const end = line.indexOf('*/', i + 2);
          if (end < 0) {
            inBlock = true;
            emit('cm', line.slice(i));
            i = n;
          } else {
            emit('cm', line.slice(i, end + 2));
            i = end + 2;
          }
        } else if (ch === '"' || ch === "'") {
          const raw = ch === '"' && /R$/.test(line.slice(Math.max(0, i - 2), i)) ? /^"([^()\\\s]{0,16})\(/.exec(line.slice(i)) : null;
          if (raw) {
            rawEnd = ')' + raw[1] + '"';
            emit('str', raw[0]);
            i += raw[0].length;
            continue;
          }
          let j = i + 1;
          while (j < n && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
          emit('str', line.slice(i, Math.min(n, j + 1)));
          i = Math.min(n, j + 1);
        } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
          const m = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|[0-9][0-9']*\.?[0-9']*([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)[uUlLfF]*/.exec(line.slice(i));
          emit('num', m[0]);
          i += m[0].length;
        } else if (/[A-Za-z_]/.test(ch)) {
          const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
          const word = m[0];
          i += word.length;
          if (KEYWORDS.has(word)) emit('kw', word);
          else if (TYPES.has(word)) emit('ty', word);
          else if (/^\s*\(/.test(line.slice(i))) emit('fn', word);
          else if (/^[A-Z][A-Za-z0-9]*$/.test(word) && word.length > 1 && /[a-z]/.test(word)) emit('ty', word);
          else emit('', word);
        } else {
          // Run of punctuation / whitespace up to the next interesting character.
          const m = /^[^A-Za-z0-9_"'\/.]+|^./.exec(line.slice(i));
          emit('', m[0]);
          i += m[0].length;
        }
      }
      if (inPP && !/\\\s*$/.test(line)) inPP = false;
      return out;
    });
  }

  window.CodeHighlight = { highlightLines, escape: esc };
})();
