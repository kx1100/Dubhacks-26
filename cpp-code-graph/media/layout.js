// media/layout.js
// Left-to-right layout with ELK, and opening things without moving them.
//
// 1. ELK "layered", direction RIGHT (cytoscape-elk), lays out the files, all
//    closed, in columns so that arrows point right: includers and callers on
//    the left, what they use on the right.
// 2. Opening a file or a code card never re-runs that layout. The node grows
//    where it is (a file's contents get their own small column layout inside
//    the box), and every other node moves straight away from it, right, left,
//    up or down, by as much as the node grew on that side. Nodes keep their
//    direction from each other; the arrows between them just get longer.
//    Closing undoes exactly those moves.

import elk from 'cytoscape-elk';

/** @param {typeof import('cytoscape')} cytoscape */
export function registerLayouts(cytoscape) {
    cytoscape.use(elk);
}

export const FLOW = {
    name: 'elk',
    nodeDimensionsIncludeLabels: true,
    // main.js animates the nodes and fits the view itself, after open files
    // have made room.
    animate: false,
    fit: false,
    elk: {
        algorithm: 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': 120, // space between columns
        'elk.spacing.nodeNode': 40, // space between nodes in each column
        'elk.padding': '[top=30,left=30,bottom=30,right=30]',
        // Keep ELK's default node placement (Brandes-Koepf): NETWORK_SIMPLEX
        // looks slightly tidier but took 90 s instead of 1 s at ~200 nodes.
    },
};

/** Above this many nodes ELK does one crossing-minimization pass instead of seven. */
const QUICK_FLOW_NODES = 150;

/**
 * Lay out `eles` with ELK.
 * @param {import('cytoscape').Collection} eles
 * @returns {Promise<void>}
 */
export function runLayout(eles) {
    return new Promise((resolve) => {
        if (eles.nodes().empty()) {
            resolve();
            return;
        }
        const quick = eles.nodes().length > QUICK_FLOW_NODES;
        const layout = eles.layout(quick ? { ...FLOW, elk: { ...FLOW.elk, 'elk.layered.thoroughness': 1 } } : FLOW);
        layout.one('layoutstop', () => resolve());
        layout.run();
    });
}

/** Space between columns, and between nodes in a column, inside an open file. */
const INNER_RANK_SEP = 60;
const INNER_NODE_SEP = 20;

/**
 * Arrange the nodes inside an open file left to right, centered on `center`.
 * A small column layout instead of ELK, because it must finish right away
 * (it runs inside growInPlace): each function goes one column right of the
 * functions that call it, in file order, then one pass orders each column by
 * where its callers are, to untangle the arrows.
 * @param {import('cytoscape').NodeSingular} box
 * @param {Array<[string, string]>} links arrows between the box's nodes
 * @param {{x: number, y: number}} center
 */
export function arrangeChildren(box, links, center) {
    const kids = box.children();
    if (kids.empty()) return;
    const ids = kids.map((k) => k.id());
    /** @type {Map<string, string[]>} */
    const out = new Map(ids.map((id) => [id, []]));
    for (const [s, t] of links) if (s !== t && out.has(s) && out.has(t)) out.get(s)?.push(t);

    // Depth-first search; arrows back to a node still on the path close a cycle and are ignored.
    const seen = new Map(); // id -> 1 on the path, 2 done
    /** @type {Map<string, string[]>} */
    const forward = new Map(ids.map((id) => [id, []]));
    /** @type {string[]} */
    const finished = [];
    const visit = (/** @type {string} */ id) => {
        seen.set(id, 1);
        for (const t of out.get(id) ?? []) {
            if (seen.get(t) === 1) continue;
            forward.get(id)?.push(t);
            if (!seen.has(t)) visit(t);
        }
        seen.set(id, 2);
        finished.push(id);
    };
    for (const id of ids) if (!seen.has(id)) visit(id);

    // Reverse finishing order is a topological order: each node one column right of its callers.
    const rank = new Map(ids.map((id) => [id, 0]));
    for (let i = finished.length - 1; i >= 0; i--) {
        const id = finished[i];
        for (const t of forward.get(id) ?? []) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
    }
    /** @type {string[][]} */
    const columns = [];
    for (const id of ids) (columns[rank.get(id) ?? 0] ??= []).push(id);

    // Order each column by the average place of its callers in the column before.
    const callers = new Map(ids.map((id) => [id, /** @type {string[]} */ ([])]));
    for (const [s, ts] of forward) for (const t of ts) callers.get(t)?.push(s);
    for (let c = 1; c < columns.length; c++) {
        const place = new Map(columns[c - 1].map((id, i) => [id, i]));
        const weight = (/** @type {string} */ id) => {
            const ps = (callers.get(id) ?? []).filter((p) => place.has(p)).map((p) => place.get(p) ?? 0);
            return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
        };
        const fileOrder = new Map(columns[c].map((id, i) => [id, i]));
        columns[c].sort((a, b) => weight(a) - weight(b) || (fileOrder.get(a) ?? 0) - (fileOrder.get(b) ?? 0));
    }

    // Columns side by side, each stacked and centered vertically.
    const size = new Map(kids.map((k) => [k.id(), k.layoutDimensions({ nodeDimensionsIncludeLabels: true })]));
    /** @type {Map<string, {x: number, y: number}>} */
    const pos = new Map();
    let x = 0;
    for (const col of columns) {
        if (!col) continue;
        const width = Math.max(...col.map((id) => size.get(id)?.w ?? 0));
        const height = col.reduce((sum, id) => sum + (size.get(id)?.h ?? 0), 0) + INNER_NODE_SEP * (col.length - 1);
        let y = -height / 2;
        for (const id of col) {
            const h = size.get(id)?.h ?? 0;
            pos.set(id, { x: x + width / 2, y: y + h / 2 });
            y += h + INNER_NODE_SEP;
        }
        x += width + INNER_RANK_SEP;
    }
    kids.positions((k) => pos.get(k.id()) ?? { x: 0, y: 0 });
    // Center exactly on `center`, measured the way closeFile measures it, so
    // opening and closing a file again and again never makes it drift.
    const bb = kids.boundingBox();
    const dx = center.x - (bb.x1 + bb.x2) / 2;
    const dy = center.y - (bb.y1 + bb.y2) / 2;
    kids.positions((k) => ({ x: k.position('x') + dx, y: k.position('y') + dy }));
}

const box = (/** @type {any} */ n) => n.boundingBox({ includeLabels: true, includeOverlays: false });

/** @typedef {{id: string, dx: number, dy: number}} Move */

/**
 * Run `change` (which grows `node`, e.g. opens it) and move every other node
 * away from it by as much as it grew on that side. A node inside an open
 * file pushes its neighbours in the file, then the file box pushes the other
 * files, so no direction between two nodes flips and nothing overlaps.
 * Returns the moves, so closing the node can undo exactly them (undoMoves).
 * @param {import('cytoscape').NodeSingular} node
 * @param {() => void} change
 * @returns {Move[]}
 */
export function growInPlace(node, change) {
    /** @type {Move[]} */
    const moves = [];
    /** @type {Array<{n: any, before: any}>} */
    const levels = [];
    for (let n = /** @type {any} */ (node); n.nonempty(); n = n.parent()) levels.push({ n, before: box(n) });
    change();
    for (const { n, before } of levels) {
        if (n.removed()) continue;
        const after = box(n);
        // Only growth pushes (a shrinking side would pull nodes past each other).
        const right = Math.max(0, after.x2 - before.x2);
        const left = Math.max(0, before.x1 - after.x1);
        const down = Math.max(0, after.y2 - before.y2);
        const up = Math.max(0, before.y1 - after.y1);
        if (!right && !left && !down && !up) continue;
        const siblings = n.isChild() ? n.siblings() : n.cy().nodes().orphans().not(n);
        siblings.forEach((/** @type {any} */ s) => {
            const b = box(s);
            const sx = (b.x1 + b.x2) / 2;
            const sy = (b.y1 + b.y2) / 2;
            // Sideways only for nodes past the node's old left or right edge, so
            // the node's own column stays lined up; likewise up and down for rows.
            const dx = sx > before.x2 ? right : sx < before.x1 ? -left : 0;
            const dy = sy > before.y2 ? down : sy < before.y1 ? -up : 0;
            if (dx || dy) {
                shift(s, dx, dy);
                moves.push({ id: s.id(), dx, dy });
            }
        });
    }
    return moves;
}

/**
 * Move nodes back by what growInPlace moved them. Every move is a plain
 * shift, so undoing the moves of everything that was opened always returns
 * to the original layout, whatever the order things were opened and closed.
 * @param {import('cytoscape').Core} cy
 * @param {Move[] | undefined} moves
 */
export function undoMoves(cy, moves) {
    for (const { id, dx, dy } of moves ?? []) {
        const n = cy.$id(id);
        if (n.nonempty()) shift(n, -dx, -dy);
    }
}

/** Move a node, or everything inside a box. */
function shift(/** @type {any} */ n, /** @type {number} */ dx, /** @type {number} */ dy) {
    const leaves = n.isParent() ? n.descendants().filter((/** @type {any} */ d) => !d.isParent()) : n;
    leaves.positions((/** @type {any} */ l) => ({ x: l.position('x') + dx, y: l.position('y') + dy }));
}
