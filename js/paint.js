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

let cached = null;     // last solver output, or null when the grid is off
let highlight = null;  // hitTest result while a drag is live, else null
let ghostRects = [];   // computed alongside `cached` by the drag layer

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
