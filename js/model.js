/*
 * model.js — the persisted state of the grid, and nothing else.
 *
 * Two homes, both chosen so a workflow saved with the plugin opens cleanly in
 * stock ComfyUI (the hard requirement of this pack):
 *
 *   - workflow.extra.gridcm       — the grid itself (columns, origin, claims).
 *     The workflow `extra` schema is zod .passthrough(), so unknown keys
 *     survive validation, save and load; stock ComfyUI carries them inertly.
 *   - node.properties['gridcm.*'] — the per-node cell assignment. `properties`
 *     is a canonical serialized field, restored natively on configure.
 *
 * Everything mutable at runtime goes through the accessors here so the schema
 * stays in one file. No imports: this module operates on graph/node objects
 * handed to it and is loadable from a console for poking.
 */

export const EXTRA_KEY = 'gridcm';
export const SCHEMA_VERSION = 1;

/* Property names on node.properties. Kept dotted so they group visually in
 * the frontend's properties panel and cannot collide with widget names. */
export const P_COL = 'gridcm.col';
export const P_ROW = 'gridcm.row';
export const P_SPAN = 'gridcm.rowspan';
export const P_ORDER = 'gridcm.order';
export const P_SKIP = 'gridcm.skip';

/*
 * Tuning values. The geometry ones are deliberately NOT stored per-workflow:
 * they are viewing preferences, and the layout re-derives from them — column
 * widths and origin are the only geometry the workflow owns. Settings
 * (index.js) overwrite these fields in place; every consumer reads them live.
 */
export const cfg = {
  cellPad: 10,       // inner padding between a cell border and its nodes
  nodeGap: 12,       // vertical gap between stacked nodes in one cell
  gutterMin: 28,     // a gutter never collapses below this, even with 0 lanes
  laneSpacing: 14,   // centre-to-centre distance of parallel lanes in a gutter
  laneMargin: 12,    // gutter edge to the first lane
  rowMin: 40,        // an (accidentally) empty row still gets this height
  colDefault: 340,   // width of a freshly created column
};

/** The grid object from graph.extra, or null when absent or from the future. */
export function getGrid(graph) {
  const grid = graph?.extra?.[EXTRA_KEY];
  if (!grid) return null;
  if (grid.version > SCHEMA_VERSION) {
    console.warn(`[gridcm] workflow has gridcm v${grid.version}, this build understands v${SCHEMA_VERSION} — leaving it alone`);
    return null;
  }
  return grid;
}

/** The grid object, bootstrapping a fresh one on first use. */
export function ensureGrid(graph, colCount = 0) {
  let grid = getGrid(graph);
  if (!grid) {
    grid = {
      version: SCHEMA_VERSION,
      enabled: true,
      origin: [80, 80],
      columns: [],
      gutterMode: 'lanes',
      rerouteClaims: {},
    };
    graph.extra ??= {};
    graph.extra[EXTRA_KEY] = grid;
  }
  ensureColumns(grid, colCount);
  return grid;
}

/** Grows grid.columns to at least n entries. Never shrinks — removing a
 * column is an explicit command that must first rehome its nodes. */
export function ensureColumns(grid, n) {
  while (grid.columns.length < n) grid.columns.push({ width: cfg.colDefault });
  return grid;
}

/**
 * The node's cell, or null when the node is skipped or not yet assigned.
 * A cell is {col, row, rowspan, order} with sane clamps applied on read, so
 * a hand-edited or stale property cannot push the solver out of range.
 */
export function cellOf(node) {
  const p = node.properties;
  if (!p || p[P_SKIP] === true) return null;
  const col = p[P_COL], row = p[P_ROW];
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return null;
  return {
    col,
    row,
    rowspan: Math.max(1, Number.isInteger(p[P_SPAN]) ? p[P_SPAN] : 1),
    order: Number.isFinite(p[P_ORDER]) ? p[P_ORDER] : 0,
  };
}

export function setCell(node, cell) {
  node.properties ??= {};
  node.properties[P_COL] = cell.col;
  node.properties[P_ROW] = cell.row;
  if (cell.rowspan !== undefined) node.properties[P_SPAN] = cell.rowspan;
  if (cell.order !== undefined) node.properties[P_ORDER] = cell.order;
}

export function setSkip(node, skip) {
  node.properties ??= {};
  if (skip) node.properties[P_SKIP] = true;
  else delete node.properties[P_SKIP];
}

export function isSkipped(node) {
  return node.properties?.[P_SKIP] === true;
}

/** Every gridded node of the graph as [{node, cell}], skipping subgraph
 * interiors by construction (graph._nodes is one flat coordinate space). */
export function assignments(graph) {
  const out = [];
  for (const node of graph._nodes) {
    const cell = cellOf(node);
    if (cell) out.push({ node, cell });
  }
  return out;
}

/**
 * Removes empty rows by renumbering every assignment downward. A row is
 * occupied when any cell's [row, row+rowspan) covers it, so a row under a
 * spanning node never reads as empty and spans cannot be broken by the shift.
 * Kept as the single place row numbers are ever rewritten — the pinned-row
 * bookkeeping in topology relies on that.
 */
export function compactRows(graph) {
  const assigned = assignments(graph);
  if (!assigned.length) return;
  const covered = new Set();
  let maxRow = 0;
  for (const { cell } of assigned) {
    for (let r = cell.row; r < cell.row + cell.rowspan; r++) covered.add(r);
    maxRow = Math.max(maxRow, cell.row + cell.rowspan - 1);
  }
  const shift = [];   // shift[r] = how many empty rows precede r
  let empty = 0;
  for (let r = 0; r <= maxRow; r++) {
    shift[r] = empty;
    if (!covered.has(r)) empty++;
  }
  if (!empty) return;
  for (const { node, cell } of assigned) {
    const to = cell.row - shift[cell.row];
    if (to !== cell.row) node.properties[P_ROW] = to;
    console.assert(to >= 0, '[gridcm] row compaction produced a negative row');
  }
}

/** Number of rows the current assignments occupy (after compaction). */
export function rowCount(graph) {
  let n = 0;
  for (const { cell } of assignments(graph)) n = Math.max(n, cell.row + cell.rowspan);
  return n;
}

/** Removes empty columns and their width entries — the column mirror of
 * compactRows. A column is occupied when any assignment sits in it. Also
 * truncates TRAILING width entries beyond the last occupied column: the
 * ghost guides make standing empty edge columns pointless, and leaving the
 * tail in grid.columns is exactly what rendered them (the solver takes
 * columns.length as the column count). */
export function compactColumns(graph, grid) {
  const assigned = assignments(graph);
  if (!assigned.length) return;
  const covered = new Set(assigned.map(({ cell }) => cell.col));
  let maxCol = Math.max(...covered);
  const shift = [];
  let empty = 0;
  const keptWidths = [];
  for (let c = 0; c <= maxCol; c++) {
    shift[c] = empty;
    if (!covered.has(c)) empty++;
    else keptWidths.push(grid.columns[c] ?? { width: cfg.colDefault });
  }
  if (!empty && grid.columns.length <= maxCol + 1) return;
  for (const { node, cell } of assigned) {
    const to = cell.col - shift[cell.col];
    if (to !== cell.col) node.properties[P_COL] = to;
  }
  grid.columns = keptWidths;
}

/** Inserts an empty column at `at`, shifting every assignment at or right of
 * it. The way "drop a node onto the left/inner ghost" splits a column. */
export function insertColumn(graph, grid, at) {
  for (const { node, cell } of assignments(graph)) {
    if (cell.col >= at) node.properties[P_COL] = cell.col + 1;
  }
  grid.columns.splice(at, 0, { width: cfg.colDefault });
}

/** Inserts an empty row at `at`, shifting rows down. Spans that straddle the
 * insertion point simply move as a whole — a span is one cell. */
export function insertRow(graph, at) {
  for (const { node, cell } of assignments(graph)) {
    if (cell.row >= at) node.properties[P_ROW] = cell.row + 1;
  }
}

/* --- reroute claims ------------------------------------------------------ */

/** claims: {rerouteId: {link, gutter: ['v'|'h', index], lane}}. Plugin-owned
 * reroutes only — regeneration may delete exactly these ids and no others. */
export function claims(grid) {
  grid.rerouteClaims ??= {};
  return grid.rerouteClaims;
}

/** Drops claims whose reroute no longer exists (user deleted the dot). */
export function pruneClaims(graph, grid) {
  const c = claims(grid);
  for (const id of Object.keys(c)) {
    if (!graph.reroutes.has(Number(id))) delete c[id];
  }
}
