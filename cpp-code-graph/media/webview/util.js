// Small helpers with no knowledge of the graph.

export const measureCtx = document.createElement('canvas').getContext('2d');
export function textWidth(text, bold) {
  measureCtx.font = (bold ? '600 ' : '') + '12px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
  return measureCtx.measureText(text).width;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function push(map, k, v) {
  let a = map.get(k);
  if (!a) map.set(k, (a = []));
  a.push(v);
}

export function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
