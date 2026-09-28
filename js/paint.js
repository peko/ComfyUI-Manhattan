/*
 * paint.js — draws the grid itself: column and gutter bands behind the graph.
 *
 * Chained onto app.canvas.onDrawBackground (the selectionBorder.ts idiom:
 * save the previous handler, call it, then draw ours). onDrawBackground runs
 * in graph coordinates, under links and nodes — exactly where band shading
 * belongs. The bands come from the last solver run, cached here; nothing is
 * recomputed per frame.
 *
 * The ribbon ("fat cable") mode is deliberately an OVERLAY, not a
 * drawConnections replacement: links render through the stock pipeline (so
 * the renderedPaths / link.path / link._pos hit-testing contract, tooltips
 * and other packs' wraps — quick-connections — all stay intact for free), and
 * a thick trunk is painted over each gutter's claimed-reroute extent in
 * onDrawForeground, visually bundling the lanes. Collapsing the gutter
 * geometry itself to a constant width is a phase-2 item.
 */

/* Colors are deliberately low-contrast: the grid is furniture, not content.
 * Both canvas themes here are dark; a light-theme pass can come later. */
const COL_FILL = 'rgba(255, 255, 255, 0.030)';   // content columns
const GUTTER_FILL = 'rgba(0, 0, 0, 0.140)';      // cable gutters, both axes
const EDGE_STROKE = 'rgba(255, 255, 255, 0.055)';

/* Trunk visuals: wide soft halo + a solid core reads as one round cable. */
const TRUNK_HALO = 'rgba(120, 130, 145, 0.28)';
const TRUNK_CORE = 'rgba(160, 170, 185, 0.55)';

/* Drop-target feedback while dragging. */
const GHOST_STROKE = 'rgba(255, 255, 255, 0.16)';
const HILITE_FILL = 'rgba(90, 150, 230, 0.16)';
const HILITE_STROKE = 'rgba(110, 170, 250, 0.75)';

let cached = null;     // last solver output, or null when the grid is off
let ribbonOn = false;  // the gridcm.ribbon setting
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

export function setRibbon(value) {
  ribbonOn = value === true;
}

/** quick-connections' circuit-board renderer redraws links itself; a trunk
 * painted over its work would just be mud. Defer when it is enabled. */
function circuitLinesActive(app) {
  try {
    return app.ui.settings.getSettingValue('circuit-board-lines.enable') === true;
  } catch {
    return false;
  }
}

/** Chains both paint passes onto the canvas. Call once from setup().
 * `context()` returns {graph, grid} when the grid is active, else null. */
export function install(app, canvas, context) {
  const prevBg = canvas.onDrawBackground;
  canvas.onDrawBackground = function drawGridBackground(ctx, visibleArea) {
    prevBg?.call(this, ctx, visibleArea);
    if (cached && context()) drawBands(ctx, cached);
  };
  const prevFg = canvas.onDrawForeground;
  canvas.onDrawForeground = function drawGridForeground(ctx, visibleArea) {
    prevFg?.call(this, ctx, visibleArea);
    if (!ribbonOn || !cached || circuitLinesActive(app)) return;
    const live = context();
    if (live) drawTrunks(ctx, cached, live.graph, live.grid);
  };
}

/**
 * The fat cables: one rounded trunk per gutter, spanning the extent of the
 * plugin-claimed reroutes inside it. Reroute dots and individual lanes stay
 * underneath (stock-rendered); the trunk visually bundles them.
 */
function drawTrunks(ctx, s, graph, grid) {
  const extents = new Map();   // 'v:2' -> {lo, hi}
  for (const [id, claim] of Object.entries(grid.rerouteClaims ?? {})) {
    const reroute = graph.reroutes.get(Number(id));
    const [dir, index] = claim.gutter ?? [];
    if (!reroute || dir === undefined) continue;
    const along = dir === 'v' ? reroute.pos[1] : reroute.pos[0];
    const key = `${dir}:${index}`;
    const e = extents.get(key);
    if (!e) extents.set(key, { lo: along, hi: along });
    else { e.lo = Math.min(e.lo, along); e.hi = Math.max(e.hi, along); }
  }

  ctx.save();
  ctx.lineCap = 'round';
  for (const [key, e] of extents) {
    if (e.hi - e.lo < 1) continue;   // a single elbow is not a bundle
    const [dir, indexStr] = key.split(':');
    const index = Number(indexStr);
    const band = dir === 'v' ? s.vGutters[index] : s.hGutters[index];
    if (!band) continue;
    const mid = dir === 'v' ? (band.x0 + band.x1) / 2 : (band.y0 + band.y1) / 2;
    const size = dir === 'v' ? band.x1 - band.x0 : band.y1 - band.y0;
    const draw = (width, style) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      if (dir === 'v') { ctx.moveTo(mid, e.lo); ctx.lineTo(mid, e.hi); }
      else { ctx.moveTo(e.lo, mid); ctx.lineTo(e.hi, mid); }
      ctx.stroke();
    };
    draw(Math.min(size - 8, 18), TRUNK_HALO);
    draw(Math.min(size - 14, 8), TRUNK_CORE);
  }
  ctx.restore();
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
