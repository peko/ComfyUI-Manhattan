/*
 * layout.js — the pure grid solver. No graph, no app, no DOM: cells in,
 * coordinates out. Everything here is testable from a console with literals.
 *
 * The model: content columns C0..Cn-1 separated (and flanked) by vertical
 * cable gutters V0..Vn; content rows R0..Rm-1 separated (and flanked) by
 * horizontal gutters H0..Hm. The outer gutters always exist and are never
 * blocked, so the cable router always has an escape channel.
 *
 * A cell is the (col, row) intersection; nodes sharing a cell stack
 * vertically. A cell whose tallest member declares rowspan s occupies rows
 * [row, row+s) and BLOCKS the horizontal gutter segments H(row+1)..H(row+s-1)
 * in its column — that is the spec's "hidden cable cells", and the router
 * treats those segments as obstacles.
 *
 * Row heights use the HTML-table algorithm: span-1 cells set the row minima,
 * then spanning cells (ascending span) pour any deficit into their last row.
 * A spanning cell's available height includes the gutters it swallows.
 */

/**
 * Solves the grid.
 *
 * gridDef: {origin: [x, y], columns: [{width}]}
 * cells:   [{id, col, row, rowspan, order, h}] — h is the node's OUTER height
 *          (title included); the caller converts back to litegraph pos/size.
 * opts:    {cellPad, nodeGap, gutterMin, laneSpacing, laneMargin, rowMin,
 *           vLanes: [], hLanes: []} — lane counts per gutter from the cable
 *          plan; missing entries mean 0 (gutter collapses to gutterMin).
 *
 * Returns {nodes: Map<id, {x, y, w}>, colBands, rowBands, vGutters, hGutters,
 *          width, height, rows, cols} — all bands are {x0,x1} / {y0,y1} in
 * graph space; hGutters carry {blocked: Set<col>}. Returns null on no cells.
 */
export function solve(gridDef, cells, opts) {
  if (!cells.length) return null;
  const { cellPad, nodeGap, rowMin } = opts;

  let cols = gridDef.columns.length;
  let rows = 0;
  for (const c of cells) {
    cols = Math.max(cols, c.col + 1);
    rows = Math.max(rows, c.row + c.rowspan);
  }

  /* Stacks: nodes sharing (col, row), ordered; the stack inherits the widest
   * rowspan among its members. */
  const stacks = new Map();
  for (const c of cells) {
    const key = `${c.col}:${c.row}`;
    let s = stacks.get(key);
    if (!s) stacks.set(key, s = { col: c.col, row: c.row, span: 1, members: [] });
    s.members.push(c);
    s.span = Math.max(s.span, c.rowspan);
  }
  for (const s of stacks.values()) {
    s.members.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    s.h = s.members.reduce((acc, m) => acc + m.h, 0)
      + nodeGap * (s.members.length - 1) + 2 * cellPad;
  }

  /* Gutter sizes from lane counts. Index ranges: V0..V(cols), H0..H(rows). */
  const gutterSize = (lanes) =>
    Math.max(opts.gutterMin, (lanes | 0) * opts.laneSpacing + 2 * opts.laneMargin);
  const vWidth = [], hHeight = [];
  for (let j = 0; j <= cols; j++) vWidth[j] = gutterSize(opts.vLanes?.[j] ?? 0);
  for (let i = 0; i <= rows; i++) hHeight[i] = gutterSize(opts.hLanes?.[i] ?? 0);

  /* Blocked horizontal gutter segments under rowspans. */
  const blocked = [];
  for (let i = 0; i <= rows; i++) blocked[i] = new Set();
  for (const s of stacks.values()) {
    for (let i = s.row + 1; i < s.row + s.span; i++) blocked[i].add(s.col);
  }

  /* Row heights: span-1 minima first, then spanning deficits, ascending span
   * so shorter spans settle before longer ones stretch across them. */
  const rowH = new Array(rows).fill(rowMin);
  for (const s of stacks.values()) {
    if (s.span === 1) rowH[s.row] = Math.max(rowH[s.row], s.h);
  }
  const spanning = [...stacks.values()].filter((s) => s.span > 1)
    .sort((a, b) => a.span - b.span);
  for (const s of spanning) {
    let avail = 0;
    for (let r = s.row; r < s.row + s.span; r++) avail += rowH[r];
    for (let i = s.row + 1; i < s.row + s.span; i++) avail += hHeight[i];
    if (s.h > avail) rowH[s.row + s.span - 1] += s.h - avail;
  }

  /* Bands. The x axis alternates V-gutter / column; y alternates H-gutter / row. */
  const [ox, oy] = gridDef.origin;
  const colBands = [], vGutters = [], rowBands = [], hGutters = [];
  let x = ox;
  for (let j = 0; j < cols; j++) {
    vGutters.push({ x0: x, x1: x + vWidth[j] });
    x += vWidth[j];
    const w = gridDef.columns[j]?.width ?? 0;
    colBands.push({ x0: x, x1: x + w });
    x += w;
  }
  vGutters.push({ x0: x, x1: x + vWidth[cols] });
  x += vWidth[cols];

  let y = oy;
  for (let i = 0; i < rows; i++) {
    hGutters.push({ y0: y, y1: y + hHeight[i], blocked: blocked[i] });
    y += hHeight[i];
    rowBands.push({ y0: y, y1: y + rowH[i] });
    y += rowH[i];
  }
  hGutters.push({ y0: y, y1: y + hHeight[rows], blocked: blocked[rows] });
  y += hHeight[rows];

  /* Node placement: stacks flow from the cell's top, padded. */
  const nodes = new Map();
  for (const s of stacks.values()) {
    const band = colBands[s.col];
    let cursor = rowBands[s.row].y0 + cellPad;
    for (const m of s.members) {
      nodes.set(m.id, { x: band.x0 + cellPad, y: cursor, w: band.x1 - band.x0 - 2 * cellPad });
      cursor += m.h + nodeGap;
    }
  }

  return { nodes, colBands, rowBands, vGutters, hGutters, width: x - ox, height: y - oy, rows, cols };
}

/**
 * The four ghost bands: exactly one empty guide column/row on each side of
 * the table. They are virtual — never part of gridDef — and exist so a drag
 * can always split outward. Returns [{side, x, y, w, h}].
 */
export function ghosts(solved, opts) {
  if (!solved) return [];
  const left = solved.vGutters[0].x0;
  const right = solved.vGutters[solved.vGutters.length - 1].x1;
  const top = solved.hGutters[0].y0;
  const bottom = solved.hGutters[solved.hGutters.length - 1].y1;
  const gw = opts.colDefault ?? 340;
  const gh = Math.max(2 * (opts.rowMin ?? 40), 80);
  return [
    { side: 'left', x: left - gw, y: top, w: gw, h: bottom - top },
    { side: 'right', x: right, y: top, w: gw, h: bottom - top },
    { side: 'top', x: left, y: top - gh, w: right - left, h: gh },
    { side: 'bottom', x: left, y: bottom, w: right - left, h: gh },
  ];
}

/**
 * Which part of the grid a graph-space point falls in: drop targets for the
 * drag layer, band lookup for paint. Cells win over gutters, gutters over
 * ghosts. Returns {type: 'cell'|'vgutter'|'hgutter'|'ghost'|'outside',
 * col?, row?, index?, side?}.
 */
export function hitTest(solved, x, y, opts) {
  if (!solved) return { type: 'outside' };
  const col = solved.colBands.findIndex((b) => x >= b.x0 && x < b.x1);
  const row = solved.rowBands.findIndex((b) => y >= b.y0 && y < b.y1);
  if (col >= 0 && row >= 0) return { type: 'cell', col, row };
  const vg = solved.vGutters.findIndex((b) => x >= b.x0 && x < b.x1);
  const hg = solved.hGutters.findIndex((b) => y >= b.y0 && y < b.y1);
  /* Inside the table's y-extent an x-gutter hit is a gutter; the crossing
   * squares report the vertical gutter (routing owns them either way). */
  if (vg >= 0 && (row >= 0 || hg >= 0)) return { type: 'vgutter', index: vg };
  if (hg >= 0 && col >= 0) return { type: 'hgutter', index: hg };
  if (opts) {
    for (const g of ghosts(solved, opts)) {
      if (x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h) {
        return { type: 'ghost', side: g.side };
      }
    }
  }
  return { type: 'outside' };
}

/**
 * Spreadsheet-style column resize handle under the pointer, or null. Handles
 * live in the TOP ghost band, one above each vertical gutter from V1 on
 * (V0 has no column to its left); dragging one resizes column `gutter - 1`.
 */
export function resizeHandleAt(solved, opts, x, y) {
  if (!solved) return null;
  const top = ghosts(solved, opts).find((g) => g.side === 'top');
  if (!top || y < top.y || y >= top.y + top.h) return null;
  for (let j = 1; j < solved.vGutters.length; j++) {
    const b = solved.vGutters[j];
    if (x >= b.x0 - 6 && x < b.x1 + 6) return { gutter: j };
  }
  return null;
}

/** Lane centreline coordinate inside a gutter band (works for both axes). */
export function laneCoord(band0, lane, opts) {
  return band0 + opts.laneMargin + (lane + 0.5) * opts.laneSpacing;
}
