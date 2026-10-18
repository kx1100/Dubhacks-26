'use strict';

// The AI pass over a change-impact prediction: the model reads the code at the
// riskiest affected places and says whether the planned change breaks each one,
// may need a look, or should be fine. Its verdict is blended into the static
// risk score. No `vscode` dependency: the model is reached through
// complete(prompt) -> text.

const { CHANGE_TYPES } = require('./impact');

const MAX_PLACES = 10;
const CONTEXT_LINES = 5; // lines shown around a call site
const NODE_LINES = 30; // lines shown when there is no call site
const TARGET_LINES = 40;
const VERDICTS = ['breaks', 'review', 'fine'];

const PROMPT = `A developer plans to change an element of a C/C++ codebase. For each affected place below, decide what the change will do to it.
Verdicts:
- "breaks": it will not compile, or will behave wrongly, unless it is updated
- "review": it may need an update, depending on details of the change
- "fine": it should keep working unchanged
Judge from the code shown. If the planned change is vague, assume the most common form of that kind of change.
Reply with only a JSON array, one entry per place, no Markdown:
[{"ref": "A1", "verdict": "breaks", "reason": "under 20 words", "line": 42}]
"line" is the line number that shows it, when there is one.`;

function tierOf(score) {
  return score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
}

/** The static score adjusted by the model's verdict. */
function blendScore(score, verdict) {
  if (verdict === 'breaks') return Math.max(score, 85);
  if (verdict === 'fine') return Math.min(score, 15);
  if (verdict === 'review') return Math.round((score + 55) / 2);
  return score;
}

/** Lines [from, to] of a file with numbers; `mark` gets a ">" in front. */
function excerpt(text, from, to, mark) {
  const all = text.split(/\r?\n/);
  const a = Math.max(1, from);
  const b = Math.min(all.length, to);
  const width = String(b).length;
  const out = [];
  for (let i = a; i <= b; i++) out.push((i === mark ? '>' : ' ') + String(i).padStart(width) + '  ' + all[i - 1]);
  return out.join('\n');
}

/**
 * The prompt and the places it asks about (refs A1, A2, ...), most at risk first.
 * Files are left out: an #include line says little about how a change affects them.
 * @param {import('./graphTools').GraphTools} tools
 * @param {{target:string, changeType:string, items:object[]}} impact  from predictImpact
 * @param {string} [description]  what the developer plans, in their words
 */
async function buildCheckPrompt(tools, impact, description) {
  const target = tools.nodes.get(impact.target);
  const places = impact.items.filter(i => i.kind !== 'file').slice(0, MAX_PLACES);
  const refs = new Map();
  const blocks = [];
  for (const [k, it] of places.entries()) {
    const ref = 'A' + (k + 1);
    const n = tools.nodes.get(it.id);
    const name = n.qname || n.name;
    let file;
    let code = null;
    let line = null;
    if (it.site && it.site.file && (it.relation === 'caller' || it.relation === 'memberCaller')) {
      file = it.site.file;
      line = it.site.line;
      const text = await tools.source(file);
      if (text != null) code = excerpt(text, line - CONTEXT_LINES, line + CONTEXT_LINES, line);
    } else {
      const r = tools.codeRange(n);
      file = r.file;
      line = r.start;
      const text = await tools.source(file);
      if (text != null) code = excerpt(text, r.start, Math.min(r.end, r.start + NODE_LINES - 1), null);
    }
    refs.set(ref, { id: it.id, file });
    blocks.push(`${ref} ${it.relation} ${n.kind} ${name} (${file}:${line})${code ? ':\n```cpp\n' + code + '\n```' : ' (source not available)'}`);
  }
  const r = tools.codeRange(target);
  const text = await tools.source(r.file);
  const targetCode = text != null ? excerpt(text, r.start, target.kind === 'file' ? TARGET_LINES : Math.min(r.end, r.start + TARGET_LINES - 1), null) : null;
  const lines = [
    PROMPT,
    `Changed element: ${target.kind === 'file' ? target.file : target.qname || target.name} (${target.kind}) at ${r.file}:${r.start}`,
    target.signature ? 'Signature: ' + target.signature : '',
    `Planned change: ${(CHANGE_TYPES[impact.changeType] || impact.changeType).toLowerCase()}${description ? ': ' + description : ''}`,
    targetCode ? 'Its current code:\n```cpp\n' + targetCode + '\n```' : '',
    'Affected places:\n' + blocks.join('\n\n')
  ];
  return { prompt: lines.filter(Boolean).join('\n\n'), refs };
}

/** Reads the model's JSON array leniently; entries with unknown refs or verdicts are skipped. */
function parseVerdicts(text, refs) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  if (!m) return [];
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    if (!v || typeof v !== 'object') continue;
    const place = refs.get(String(v.ref || '').trim());
    const verdict = String(v.verdict || '').toLowerCase().trim();
    if (!place || !VERDICTS.includes(verdict) || seen.has(place.id)) continue;
    seen.add(place.id);
    const line = Number.isFinite(+v.line) && +v.line > 0 ? Math.floor(+v.line) : null;
    out.push({ id: place.id, verdict, reason: String(v.reason || '').trim().slice(0, 200), file: place.file, line });
  }
  return out;
}

/**
 * Asks the model about the riskiest places and blends its verdicts into their scores.
 * @returns {Promise<{verdicts: object[], asked: number}>}
 */
async function checkWithModel(tools, impact, description, complete) {
  const { prompt, refs } = await buildCheckPrompt(tools, impact, description);
  if (!refs.size) return { verdicts: [], asked: 0 };
  const scores = new Map(impact.items.map(i => [i.id, i.score]));
  const verdicts = parseVerdicts(await complete(prompt), refs).map(v => {
    const score = blendScore(scores.get(v.id), v.verdict);
    return { ...v, score, tier: tierOf(score) };
  });
  return { verdicts, asked: refs.size };
}

module.exports = { buildCheckPrompt, parseVerdicts, blendScore, checkWithModel, MAX_PLACES };
