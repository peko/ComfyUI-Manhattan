/*
 * drag.js — pointer-level drag interception with a live drop-target preview.
 *
 * Two node-picking paths, because the frontend has two node renderers:
 *   - Vue nodes (nodes v2, the default here): nodes are DOM elements carrying
 *     data-node-id — the drag starts on one of those. The Vue composable
 *     moves the node live during the drag (not interceptable from a classic
 *     extension, and it does not need to be): we only watch the pointer,
 *     paint the target cell, and snap everything on release.
 *   - classic canvas: the pointerdown lands on the canvas element; the node
 *     is resolved with graph.getNodeOnPos at graph coordinates.
 *
 * The drop commit itself lives in index.js (it needs transact/relayout); this
 * module only turns pointer events into (node, hitTest result, graph x/y).
 */

import * as model from './model.js';
import { hitTest } from './layout.js';
import * as paint from './paint.js';

/* A press is a drag once the pointer has travelled this many CLIENT px —
 * below it, it is a click/widget interaction and none of ours. */
const DRAG_THRESHOLD = 8;

let state = null;   // {node, sx, sy, live}

function toGraph(app, e) {
  const canvas = app.canvas;
  const rect = canvas.canvas.getBoundingClientRect();
  return [
    (e.clientX - rect.left) / canvas.ds.scale - canvas.ds.offset[0],
    (e.clientY - rect.top) / canvas.ds.scale - canvas.ds.offset[1],
  ];
}

function pickNode(app, graph, e) {
  const el = e.target instanceof Element ? e.target.closest('[data-node-id]') : null;
  if (el) {
    const raw = el.getAttribute('data-node-id');
    return graph.getNodeById(/^\d+$/.test(raw) ? Number(raw) : raw) ?? null;
  }
  if (e.target === app.canvas?.canvas && typeof graph.getNodeOnPos === 'function') {
    const [gx, gy] = toGraph(app, e);
    return graph.getNodeOnPos(gx, gy) ?? null;
  }
  return null;
}

/**
 * Wires the document-level listeners. `getContext()` -> {graph, grid} | null,
 * `commit(node, hit, gx, gy)` performs the drop. Call once from setup().
 */
export function install(app, getContext, commit) {
  document.addEventListener('pointerdown', (e) => {
    state = null;
    if (e.button !== 0) return;
    const live = getContext();
    if (!live || !paint.getBands()) return;
    const node = pickNode(app, live.graph, e);
    if (!node) return;
    state = { node, sx: e.clientX, sy: e.clientY, live: false };
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!state) return;
    if (!state.live) {
      if (Math.hypot(e.clientX - state.sx, e.clientY - state.sy) < DRAG_THRESHOLD) return;
      state.live = true;
    }
    const [gx, gy] = toGraph(app, e);
    paint.setHighlight(hitTest(paint.getBands(), gx, gy, model.cfg));
    app.canvas.setDirty(true, true);
  }, true);

  const finish = (e, commitDrop) => {
    if (!state) return;
    const wasLive = state.live;
    const node = state.node;
    state = null;
    if (!wasLive) return;
    paint.setHighlight(null);
    if (commitDrop) {
      const [gx, gy] = toGraph(app, e);
      commit(node, hitTest(paint.getBands(), gx, gy, model.cfg), gx, gy);
    }
    app.canvas.setDirty(true, true);
  };
  document.addEventListener('pointerup', (e) => finish(e, true), true);
  document.addEventListener('pointercancel', (e) => finish(e, false), true);
}
