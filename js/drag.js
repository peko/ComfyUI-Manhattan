/*
 * drag.js — pointer-level interception for the two grid interactions:
 *
 *   node drag: pick a node (Vue nodes are DOM elements carrying data-node-id;
 *     classic canvas resolves via graph.getNodeOnPos), preview the drop target
 *     while the pointer moves, hand the drop to index.js. The Vue composable
 *     moves the node live during the drag — not interceptable from a classic
 *     extension and it does not need to be: everything snaps on release.
 *     On the first live move the routing of the node's links is dropped
 *     (callbacks.onNodeDragStart) so they rubber-band straight to the node
 *     instead of staying pinned to its old cell.
 *
 *   column resize: spreadsheet-style grips in the top ghost band, one above
 *     each vertical gutter from V1 on; dragging resizes the column to its
 *     left, live (solver re-run per move), cables regenerated on release.
 *
 * This module only turns pointer events into callbacks — the graph mutations
 * and undo pairing live in index.js.
 */

import * as model from './model.js';
import { hitTest, resizeHandleAt } from './layout.js';
import * as paint from './paint.js';

/* A press is a drag once the pointer has travelled this many CLIENT px —
 * below it, it is a click/widget interaction and none of ours. */
const DRAG_THRESHOLD = 8;

let state = null;        // {kind: 'node'|'resize', ...}
let cursorSet = false;   // we own the canvas cursor only while over a grip

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
 * Wires the document-level listeners (capture phase, so node-level handlers
 * cannot swallow the events first). `getContext()` -> {graph, grid} | null.
 * callbacks: onNodeDragStart(node), onNodeDrop(node, hit|null, gx),
 * onResizeStart(gutter), onResizeMove(gutter, dxGraph), onResizeEnd(commit).
 */
export function install(app, getContext, callbacks) {
  document.addEventListener('pointerdown', (e) => {
    state = null;
    if (e.button !== 0) return;
    const live = getContext();
    const bands = paint.getBands();
    if (!live || !bands) return;
    const [gx, gy] = toGraph(app, e);
    const handle = resizeHandleAt(bands, model.cfg, gx, gy);
    if (handle) {
      state = { kind: 'resize', gutter: handle.gutter, startGx: gx, live: false };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const node = pickNode(app, live.graph, e);
    if (!node) return;
    state = { kind: 'node', node, sx: e.clientX, sy: e.clientY, live: false };
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!state) {
      /* Idle hover: advertise the grips with a col-resize cursor. */
      const bands = paint.getBands();
      const canvasEl = app.canvas?.canvas;
      if (!bands || !canvasEl || !getContext()) return;
      const [gx, gy] = toGraph(app, e);
      const over = !!resizeHandleAt(bands, model.cfg, gx, gy);
      if (over && !cursorSet) { canvasEl.style.cursor = 'col-resize'; cursorSet = true; }
      else if (!over && cursorSet) { canvasEl.style.cursor = ''; cursorSet = false; }
      return;
    }
    const [gx, gy] = toGraph(app, e);
    if (state.kind === 'resize') {
      if (!state.live) {
        state.live = true;
        callbacks.onResizeStart(state.gutter);
      }
      callbacks.onResizeMove(state.gutter, gx - state.startGx);
      return;
    }
    if (!state.live) {
      if (Math.hypot(e.clientX - state.sx, e.clientY - state.sy) < DRAG_THRESHOLD) return;
      state.live = true;
      callbacks.onNodeDragStart(state.node);
    }
    paint.setHighlight(hitTest(paint.getBands(), gx, gy, model.cfg));
    app.canvas.setDirty(true, true);
  }, true);

  const finish = (e, commit) => {
    if (!state) return;
    const s = state;
    state = null;
    if (!s.live) return;
    if (s.kind === 'resize') {
      callbacks.onResizeEnd(commit);
      return;
    }
    paint.setHighlight(null);
    const [gx, gy] = toGraph(app, e);
    callbacks.onNodeDrop(s.node, commit ? hitTest(paint.getBands(), gx, gy, model.cfg) : null, gx, gy);
    app.canvas.setDirty(true, true);
  };
  document.addEventListener('pointerup', (e) => finish(e, true), true);
  document.addEventListener('pointercancel', (e) => finish(e, false), true);
}
