// Tooltip text for nodes, edges and path hops. The renderer decides where it is shown.

import { KIND_INFO, edgeVerb } from './constants.js';
import { esc } from './util.js';
import { S } from './state.js';
import { findEdge } from './model.js';

/** The tooltip HTML for a node id or an edge key (empty when there is nothing to say). */
export function tooltipHtml(id, edgeKey) {
  let html = '';
  if (id) {
    const n = S.nodes.get(id);
    const info = KIND_INFO[n.kind] || { label: n.kind };
    html = `<b>${esc(n.label)}</b> <span class="muted">${esc(info.label)}</span>${n.signature ? `<div class="mono">${esc(n.signature)}</div>` : ''}${n.qname && n.qname !== n.label && !n.signature ? `<div class="mono">${esc(n.qname)}</div>` : ''}${
      n.file && n.kind !== 'dir' ? `<div class="muted">${esc(n.defFile || n.file)}:${n.defLine || n.line || 1}</div>` : ''
    }${n.status ? `<div class="pill sm st-${n.status}">${n.status}</div>` : ''}`;
  } else if (edgeKey && S.vis) {
    const e = findEdge(edgeKey);
    if (e) {
      const verb = edgeVerb(e);
      html = `<b>${esc(S.nodes.get(e.source).label)}</b> ${esc(verb)} <b>${esc(S.nodes.get(e.target).label)}</b>${e.raw.length > 1 ? `<div class="muted">${e.raw.length} relationships combined (${e.count} occurrences)</div>` : e.count > 1 ? `<div class="muted">${e.count} occurrences</div>` : ''}${e.uncertain ? '<div class="muted">uncertain target</div>' : ''}${e.status ? `<div class="pill sm st-${e.status}">${e.status}</div>` : ''}`;
    }
  }
  return html;
}

/** The tooltip of a hop of the numbered execution path. */
export function hopTitle(hop) {
  if (hop.inferred) return 'Inferred: there is no call between these steps in the graph';
  if (hop.returns) return 'Returns to the caller';
  if (hop.dispatch) return 'Virtual dispatch: the call goes to a base method this one overrides';
  if (hop.uncertain) return 'Call matched by name only';
  return 'Call';
}
