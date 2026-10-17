// Checks media/highlight.js: node test/highlight.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'highlight.js'), 'utf8'), ctx);
const { highlightLines } = ctx.window.CodeHighlight;

const strip = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const has = (html, cls, text) => html.includes(`<span class="tk-${cls}">${text}</span>`);

const src = [
  '#include <stdio.h>',
  '#define MAX(a, b) \\',
  '  ((a) > (b) ? (a) : (b))',
  '/* block',
  'still */ int x = 0x1F; // tail',
  'static void log_init(const char* path) {',
  '  printf("hi %d\\n", Shape(3.5f)); char c = \'a\';',
  '  auto s = R"x(raw ) text',
  'more)x"; return a < b && c > d;',
  '}'
];
const out = highlightLines(src);

assert.strictEqual(out.length, src.length);
// Highlighting must never change the text.
out.forEach((html, i) => assert.strictEqual(strip(html), src[i], 'line ' + (i + 1)));

assert(has(out[0], 'pp', '#include'), 'directive name');
assert(has(out[1], 'pp', '#define'));
assert(!out[2].includes('tk-pp'), 'continuation line is not a new directive');
assert(has(out[3], 'cm', '/* block'), 'block comment start');
assert(has(out[4], 'cm', 'still */'), 'block comment end');
assert(has(out[4], 'kw', 'int') || has(out[4], 'ty', 'int'), 'int');
assert(has(out[4], 'num', '0x1F'));
assert(has(out[4], 'cm', '// tail'));
assert(has(out[5], 'kw', 'static'));
assert(has(out[5], 'fn', 'log_init'));
assert(has(out[6], 'str', '"hi %d\\n"'));
assert(has(out[6], 'num', '3.5f'));
assert(has(out[6], 'str', "'a'"));
assert(out[7].includes('tk-str'), 'raw string opens');
assert(has(out[8], 'str', 'more)x"'), 'raw string closes');
assert(has(out[8], 'kw', 'return'));
assert(strip(out[8]).includes('a < b && c > d'));

console.log('highlight: ok');
