/*
 * topology.js — pure auto-placement: which column and row each node deserves.
 *
 * Column = dataflow depth (longest path from a source), the classic layered
 * ordering: loaders land in column 0, samplers midway, saves at the right.
 * Row = barycenter ordering within the column to keep neighbor links short.
 *
 * Works on a plain snapshot, not on live graph objects, so it can be poked
 * from a console. Manual assignments are pinned: a pinned node keeps its
 * column and row, layering and ordering flow around it — re-arranging a
 * hand-tuned graph must not shred the hand-tuning.
 *
 * Get/Set-style frontend-only nodes carry no links in the graph, so they show
 * up as islands here and land in column 0 unless pinned. That is deliberate:
 * their whole purpose is to cut cables, guessing virtual links would defeat it.
 */

/**
 * snapshot: {nodes: [{id, pinnedCol, pinnedRow}], edges: [{from, to}]}
 * (pinned* are null when free). Returns Map<id, {col, row}>.
 */
export function assign(snapshot) {
  const ids = snapshot.nodes.map((n) => n.id);
  const pinnedCol = new Map(), pinnedRow = new Map();
  for (const n of snapshot.nodes) {
    if (n.pinnedCol != null) pinnedCol.set(n.id, n.pinnedCol);
    if (n.pinnedRow != null) pinnedRow.set(n.id, n.pinnedRow);
  }

  /* Adjacency, ignoring self-loops. */
  const into = new Map(ids.map((id) => [id, []]));
  const outof = new Map(ids.map((id) => [id, []]));
  for (const e of snapshot.edges) {
    if (e.from === e.to || !into.has(e.to) || !outof.has(e.from)) continue;
    into.get(e.to).push(e.from);
    outof.get(e.from).push(e.to);
  }

  /* Longest-path depth with an explicit stack; back-edges (cycles) are simply
   * not followed — ComfyUI graphs are DAGs in practice, this is a guard, not
   * a feature. */
  const depth = new Map();
  const onStack = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (onStack.has(id)) return 0;   // back-edge: break the cycle here
    onStack.add(id);
    let d = 0;
    for (const up of into.get(id)) d = Math.max(d, depthOf(up) + 1);
    onStack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);

  const colOf = new Map();
  for (const id of ids) colOf.set(id, pinnedCol.get(id) ?? depth.get(id));

  /* Group into columns, order by barycenter of already-ordered neighbors.
   * Two sweeps (left-to-right on upstream rows, right-to-left on downstream)
   * settle typical ComfyUI graphs; more passes buy nothing visible. */
  const columns = new Map();
  for (const id of ids) {
    const c = colOf.get(id);
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c).push(id);
  }
  const rowOf = new Map();
  const orderColumn = (members, neighborRows) => {
    /* Pinned members keep their row index; free members are sorted by the
     * mean row of their placed neighbors and fill the remaining slots. */
    const free = [], taken = new Set();
    for (const id of members) {
      const r = pinnedRow.get(id);
      if (r != null && !taken.has(r)) { rowOf.set(id, r); taken.add(r); }
      else free.push(id);
    }
    free.sort((a, b) => neighborRows(a) - neighborRows(b) || String(a).localeCompare(String(b)));
    let slot = 0;
    for (const id of free) {
      while (taken.has(slot)) slot++;
      rowOf.set(id, slot);
      taken.add(slot);
    }
  };
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  for (const c of sortedCols) {
    orderColumn(columns.get(c), (id) =>
      mean(into.get(id).map((up) => rowOf.get(up)).filter((r) => r !== undefined)));
  }
  for (const c of [...sortedCols].reverse()) {
    orderColumn(columns.get(c), (id) =>
      mean(outof.get(id).map((dn) => rowOf.get(dn)).filter((r) => r !== undefined)));
  }

  const out = new Map();
  for (const id of ids) out.set(id, { col: colOf.get(id), row: rowOf.get(id) ?? 0 });
  return out;
}
