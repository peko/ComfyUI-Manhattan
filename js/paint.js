/*
 * paint.js — draws the grid itself: column and gutter bands behind the graph.
 *
 * Chained onto app.canvas.onDrawBackground (the selectionBorder.ts idiom:
 * save the previous handler, call it, then draw ours). onDrawBackground runs
 * in graph coordinates, under links and nodes — exactly where band shading
 * belongs. The bands come from the last solver run, cached here; nothing is
 * recomputed per frame.
 *
 * (The v2 "ribbon/fat cable" trunk overlay lived here and was removed at the
 * user's call — it never became functional enough to keep.)
 */

/* Colors are deliberately low-contrast: the grid is furniture, not content.
 * Both canvas themes here are dark; a light-theme pass can come later. */
const COL_FILL = 'rgba(255, 255, 255, 0.030)';   // content columns
const GUTTER_FILL = 'rgba(0, 0, 0, 0.140)';      // cable gutters, both axes
const EDGE_STROKE = 'rgba(255, 255, 255, 0.055)';

/* Drop-target feedback while dragging. */
const GHOST_STROKE = 'rgba(255, 255, 255, 0.16)';
const HILITE_FILL = 'rgba(90, 150, 230, 0.16)';
const HILITE_STROKE = 'rgba(110, 170, 250, 0.75)';

/* A link between two nodes that sit back to back inside one cell needs no
 * route: the gutter detour around them is longer than the gap it crosses and
 * reads as a knot. Those links are drawn as a single arrowhead in the gap
 * instead, in the slot's type colour -- an arrow rather than a dot because
 * the pair is connected in whichever direction, and the picture has to say
 * which node feeds which. */
const ARROW_HALF_WIDTH = 7;
const ARROW_HEIGHT = 11;
const DOT_SPACING = 18;        // several links between one pair, side by side
const DOT_FALLBACK = '#9A9';   // litegraph's defaultLinkColor

let cached = null;     // last solver output, or null when the grid is off
let highlight = null;  // hitTest result while a drag is live, else null
let ghostRects = [];   // computed alongside `cached` by the drag layer
let dots = new Map();  // linkId -> {index, total} for stacked-neighbour links

export function setBands(solved) {
  cached = solved;
}

export function getBands() {
  return cached;
}

export function setGhosts(rects) {
  ghostRects = rects ?? [];
}

export function setHighlight(hit) {
  highlight = hit && (hit.type === 'cell' || hit.type === 'ghost') ? hit : null;
}

export function setDots(map) {
  dots = map ?? new Map();
}

export function dotLinkIds() {
  return dots;
}

/** Outer box of a node, title included -- the same convention the solver uses. */
function outerBox(node) {
  const title = window.LiteGraph.NODE_TITLE_HEIGHT;
  const h = (node.flags?.collapsed ? 0 : node.size[1]) + title;
  return { top: node.pos[1] - title, bottom: node.pos[1] - title + h,
           left: node.pos[0], right: node.pos[0] + node.size[0] };
}

/**
 * Replaces one stacked-neighbour link with an arrowhead in the gap between
 * the two nodes, pointing from the source to the target: down when the
 * source is the upper node, up when the stack order runs the other way.
 * Geometry is read live rather than cached, so the arrow follows a node that
 * is being dragged instead of hanging where the layout last put it.
 */
function drawDot(ctx, graph, link, slot) {
  const src = graph.getNodeById(link.origin_id);
  const dst = graph.getNodeById(link.target_id);
  if (!src || !dst) return false;
  const a = outerBox(src), b = outerBox(dst);
  const srcIsUpper = a.top <= b.top;
  const [upper, lower] = srcIsUpper ? [a, b] : [b, a];
  const y = (upper.bottom + lower.top) / 2;
  const centre = (Math.max(upper.left, lower.left) + Math.min(upper.right, lower.right)) / 2;
  const spread = (slot.total - 1) * DOT_SPACING;
  const x = centre - spread / 2 + slot.index * DOT_SPACING;
  const dir = srcIsUpper ? 1 : -1;           // +1 points down, towards the target

  const colour = window.LGraphCanvas.link_type_colors?.[link.type] || DOT_FALLBACK;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y + dir * ARROW_HEIGHT / 2);                     // the tip
  ctx.lineTo(x - ARROW_HALF_WIDTH, y - dir * ARROW_HEIGHT / 2);
  ctx.lineTo(x + ARROW_HALF_WIDTH, y - dir * ARROW_HEIGHT / 2);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';   // keeps it legible on a pale cell
  ctx.stroke();
  ctx.restore();
  return true;
}

/**
 * Wraps renderLink so a stacked-neighbour link draws as a dot and nothing
 * else. Returning early is what suppresses the stock line; the link is then
 * absent from renderedPaths, so it has no click target -- which is the point,
 * the dot is the whole affordance.
 */
export function installLinkDots(app, context) {
  const proto = window.LGraphCanvas.prototype;
  if (proto.__gridcmDots) return;
  const original = proto.renderLink;
  proto.renderLink = function renderLinkOrDot(ctx, a, b, link, ...rest) {
    const slot = link && dots.get(link.id);
    if (slot) {
      const live = context();
      if (live && drawDot(ctx, live.graph, link, slot)) return;
    }
    return original.call(this, ctx, a, b, link, ...rest);
  };
  proto.__gridcmDots = true;
}

/** Chains the background pass onto the canvas. Call once from setup().
 * `context()` returns {graph, grid} when the grid is active, else null. */
export function install(app, canvas, context) {
  const prevBg = canvas.onDrawBackground;
  canvas.onDrawBackground = function drawGridBackground(ctx, visibleArea) {
    prevBg?.call(this, ctx, visibleArea);
    if (cached && context()) drawBands(ctx, cached);
  };
}

function drawBands(ctx, s) {
  const top = s.hGutters[0].y0;
  const bottom = s.hGutters[s.hGutters.length - 1].y1;
  const left = s.vGutters[0].x0;
  const right = s.vGutters[s.vGutters.length - 1].x1;

  ctx.save();

  /* Gutters first, columns painted over them, so the intersection squares
   * read as gutter — which is what they are to the router. */
  ctx.fillStyle = GUTTER_FILL;
  for (const g of s.vGutters) ctx.fillRect(g.x0, top, g.x1 - g.x0, bottom - top);
  for (const g of s.hGutters) ctx.fillRect(left, g.y0, right - left, g.y1 - g.y0);

  ctx.fillStyle = COL_FILL;
  for (const c of s.colBands) {
    for (const r of s.rowBands) {
      ctx.fillRect(c.x0, r.y0, c.x1 - c.x0, r.y1 - r.y0);
    }
  }

  /* Blocked horizontal segments under rowspans merge visually into the cell:
   * repaint them with the column fill. */
  for (let i = 0; i < s.hGutters.length; i++) {
    const g = s.hGutters[i];
    for (const col of g.blocked) {
      const c = s.colBands[col];
      if (c) ctx.fillRect(c.x0, g.y0, c.x1 - c.x0, g.y1 - g.y0);
    }
  }

  ctx.strokeStyle = EDGE_STROKE;
  ctx.lineWidth = 1;
  for (const c of s.colBands) {
    ctx.strokeRect(c.x0, top, c.x1 - c.x0, bottom - top);
  }

  /* Ghost guides: one dashed empty column/row per side, always available as
   * a drop target to split outward. */
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = GHOST_STROKE;
  for (const g of ghostRects) {
    ctx.strokeRect(g.x + 3, g.y + 3, g.w - 6, g.h - 6);
  }
  ctx.setLineDash([]);

  /* Column resize grips: a bar pair above every vertical gutter from V1 on,
   * sitting in the top ghost band like spreadsheet column dividers. */
  const topGhost = ghostRects.find((g) => g.side === 'top');
  if (topGhost) {
    const gy = topGhost.y + topGhost.h / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
    ctx.lineWidth = 2;
    for (let j = 1; j < s.vGutters.length; j++) {
      const gx = (s.vGutters[j].x0 + s.vGutters[j].x1) / 2;
      ctx.beginPath();
      ctx.moveTo(gx - 3, gy - 9); ctx.lineTo(gx - 3, gy + 9);
      ctx.moveTo(gx + 3, gy - 9); ctx.lineTo(gx + 3, gy + 9);
      /* tiny outward arrows so the grip reads as "drag horizontally" */
      ctx.moveTo(gx - 8, gy); ctx.lineTo(gx - 12, gy);
      ctx.moveTo(gx + 8, gy); ctx.lineTo(gx + 12, gy);
      ctx.stroke();
    }
  }

  /* The live drop target under the pointer. */
  if (highlight) {
    let r = null;
    if (highlight.type === 'cell') {
      const c = s.colBands[highlight.col], b = s.rowBands[highlight.row];
      if (c && b) r = { x: c.x0, y: b.y0, w: c.x1 - c.x0, h: b.y1 - b.y0 };
    } else {
      r = ghostRects.find((g) => g.side === highlight.side) ?? null;
    }
    if (r) {
      ctx.fillStyle = HILITE_FILL;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = HILITE_STROKE;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }
  }

  ctx.restore();
}
