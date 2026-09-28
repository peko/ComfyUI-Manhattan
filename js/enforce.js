/*
 * enforce.js — keeps node widths pinned to their column, everywhere the
 * frontend tries to widen them back.
 *
 * Three known offenders, all funneled through computeSize() or setSize():
 *   - expandToFitContent() on addInput/addOutput/addWidget,
 *   - the load-time widen loop (src/scripts/app.ts:1472-1480) that runs
 *     size[0] = max(size[0], computeSize()[0]) on EVERY workflow load,
 *   - the resize-drag min clamp (LGraphCanvas.ts:3042) and the drag itself,
 *     which commits through node.setSize() -> onResize.
 *
 * Strategy: wrap computeSize at the LGraphNode base prototype (and once per
 * node class that ships its own override) clamping out[0] as the LAST step —
 * widget computeLayoutSize feedback happens inside the original, so the clamp
 * wins. The resize drag is caught in onResize, which setSize always fires.
 *
 * Node height is never touched: it is the one degree of freedom the user
 * keeps. Collapsed nodes are measured, not resized.
 */

import * as model from './model.js';

const WRAPPED = Symbol('gridcm.computeSizeWrapped');
const ORIGINAL = Symbol('gridcm.computeSizeOriginal');

/* Set by index.js; returns the live graph when the grid is enabled and the
 * environment is sane (not vueNodesMode), else null. Keeping the gate in one
 * closure means every enforcement point shuts off together. */
let activeGraph = () => null;

export function init(activeGraphFn) {
  activeGraph = activeGraphFn;
}

/** Target inner width for a gridded node, or null when not enforced. */
export function widthFor(node) {
  const graph = activeGraph();
  if (!graph || node.graph !== graph) return null;
  const grid = model.getGrid(graph);
  if (!grid?.enabled) return null;
  const cell = model.cellOf(node);
  if (!cell) return null;
  const col = grid.columns[cell.col];
  if (!col) return null;
  return Math.max(60, col.width - 2 * model.cfg.cellPad);
}

function wrapComputeSize(proto) {
  if (proto[WRAPPED] || typeof proto.computeSize !== 'function') return;
  const original = proto.computeSize;
  proto.computeSize = function computeSizeClamped(out) {
    const size = original.call(this, out);
    const w = widthFor(this);
    if (w !== null && size) size[0] = w;
    return size;
  };
  proto[WRAPPED] = true;
  proto[ORIGINAL] = original;
}

/** The node's NATURAL minimum width — the unclamped computeSize result. The
 * column minimum derives from this (min node width + padding), so a resize
 * grip can never squeeze nodes into their gutters. */
export function naturalMinWidth(node) {
  let proto = Object.getPrototypeOf(node);
  while (proto && !Object.hasOwn(proto, ORIGINAL)) proto = Object.getPrototypeOf(proto);
  const original = proto?.[ORIGINAL];
  try {
    const size = original ? original.call(node) : node.computeSize?.();
    return Math.max(window.LiteGraph.NODE_MIN_WIDTH ?? 50, size?.[0] ?? 0);
  } catch {
    return window.LiteGraph.NODE_WIDTH ?? 140;
  }
}

/** Base-prototype wrap; call once from setup(). */
export function installBase() {
  wrapComputeSize(window.LGraphNode.prototype);
}

/**
 * Per-node hooks; call from nodeCreated. Covers node classes that override
 * computeSize themselves (the base wrap never runs for those), and chains
 * onResize so a corner-drag's width snaps back while the height sticks.
 */
export function adoptNode(node) {
  const proto = Object.getPrototypeOf(node);
  if (proto !== window.LGraphNode.prototype && Object.hasOwn(proto, 'computeSize')) {
    wrapComputeSize(proto);
  }
  const prevOnResize = node.onResize;
  node.onResize = function onResizeClamped(size) {
    prevOnResize?.call(this, size);
    const w = widthFor(this);
    if (w !== null && size && size[0] !== w) {
      size[0] = w;
      this.size[0] = w;
    }
  };
}

/** Outer (title included) height of a node as the solver must see it.
 * Collapsed nodes render title-only; their STORED size[1] is 0 — never
 * measure that. */
export function measureOuterHeight(node) {
  const title = window.LiteGraph.NODE_TITLE_HEIGHT;
  if (node.flags?.collapsed) return title;
  return node.size[1] + title;
}

/**
 * Writes solver output into real node geometry. This is the materialization
 * step the backcompat guarantee rests on: after it, the workflow is laid out
 * in plain pos/size and needs nothing from this plugin to look right.
 * Solver y is the OUTER box top; litegraph pos[1] is the body top (title
 * above), hence the shift.
 */
export function applySolved(graph, solved) {
  const title = window.LiteGraph.NODE_TITLE_HEIGHT;
  for (const node of graph._nodes) {
    const spot = solved.nodes.get(node.id);
    if (!spot) continue;
    node.pos = [spot.x, spot.y + title];
    if (node.flags?.collapsed) {
      /* Collapsed nodes render title-only at _collapsed_width; stretch that
       * to the column so they read as full-width rows. node.size is left
       * alone — it still holds the expanded height. */
      node._collapsed_width = spot.w;
    } else if (node.size[0] !== spot.w) {
      node.setSize([spot.w, node.size[1]]);
    }
  }
}

/** Re-asserts widths after a workflow load (the widen loop runs before
 * afterConfigureGraph, so whatever it inflated gets squeezed back here). */
export function reassertWidths(graph) {
  for (const node of graph._nodes) {
    const w = widthFor(node);
    if (w === null) continue;
    if (node.flags?.collapsed) node._collapsed_width = w;
    else if (node.size[0] !== w) node.setSize([w, node.size[1]]);
  }
}
