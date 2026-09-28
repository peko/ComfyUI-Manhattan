/*
 * ComfyUI-Manhattan — column/table layout for the ComfyUI graph canvas,
 * with Manhattan cable routing through dedicated gutters.
 *
 * Replaces free node placement with a newspaper-style grid: content columns
 * hold stacked nodes (width pinned to the column, height free), cable gutters
 * between and around them carry all link routing as NATIVE reroute points.
 * Everything is materialized into real pos/size/reroutes, so a workflow saved
 * with this plugin opens fully laid out in stock ComfyUI — the plugin owns
 * the interaction, never the data.
 *
 * v1 is command-driven: "Arrange into grid" + menu edits. Live dragging
 * between cells is phase 2; the seams for it (layout.hitTest, the pure
 * solver) are already in place.
 *
 * Module map: model.js (persisted schema) — layout.js (pure solver) —
 * topology.js (pure auto-placement) — enforce.js (width pinning) —
 * reroutes.js (Manhattan cable routing) — paint.js (band shading).
 *
 * Vue nodes (nodes v2, the 1.53.6 default and what this box runs): the
 * data-level features all work — pos/size commit through layoutStore and the
 * Vue renderer reads them back, native reroutes stay canvas-drawn, undo
 * transactions hold. What degrades: the canvas band shading (drawBackCanvas
 * path) and live width snap-back on a Vue-side resize drag. So the gate warns
 * instead of blocking.
 */

import { app } from '../../scripts/app.js';
import * as model from './model.js';
import * as layout from './layout.js';
import * as topology from './topology.js';
import * as enforce from './enforce.js';
import * as reroutes from './reroutes.js';
import * as paint from './paint.js';
import * as drag from './drag.js';

let masterEnabled = true;      // the setting; per-workflow flag lives in extra
let orthoLinks = true;         // gridcm.orthoLinks: arrange switches Spline -> Linear
let announcedLinkMode = false; // one toast per session, not one per arrange

function vueMode() {
  return !!window.LiteGraph?.vueNodesMode;
}

/** The live graph when the whole feature may act, else null. */
function gate() {
  if (!masterEnabled) return null;
  return app.graph ?? null;
}

/** Gate + the workflow's own enabled flag. */
function activeGraph() {
  const graph = gate();
  return graph && model.getGrid(graph)?.enabled ? graph : null;
}

function toast(detail, severity = 'info') {
  try {
    app.extensionManager?.toast?.add?.({ severity, summary: 'Grid', detail, life: 5000 });
  } catch {
    /* toast API is UI furniture; its absence must never break a command */
  }
  console.log(`[gridcm] ${detail}`);
}

/** One undo step for a whole layout mutation (changeTracker counts the
 * before/after pair and snapshots once — verified in changeTracker.ts). */
function transact(fn) {
  app.canvas.emitBeforeChange();
  try {
    fn();
  } finally {
    app.canvas.emitAfterChange();
    app.graph.setDirtyCanvas(true, true);
  }
}

/* --- solving and applying ------------------------------------------------- */

function buildCells(graph) {
  return model.assignments(graph).map(({ node, cell }) => ({
    id: node.id,
    col: cell.col,
    row: cell.row,
    rowspan: cell.rowspan,
    order: cell.order,
    h: enforce.measureOuterHeight(node),
  }));
}

function solveOpts(lanes) {
  return { ...model.cfg, vLanes: lanes.vLanes ?? [], hLanes: lanes.hLanes ?? [] };
}

/**
 * The whole pipeline: solve -> apply -> (route -> solve with real lane counts
 * -> re-apply -> materialize). Cable regeneration is explicit — menu edits
 * pass reroute=true because they change structure; the load path passes
 * false and reuses the reroutes already in the file.
 */
function relayout(graph, grid, { reroute }) {
  const cells = buildCells(graph);
  if (!cells.length) return null;
  let maxCol = 0;
  for (const c of cells) maxCol = Math.max(maxCol, c.col);
  model.ensureColumns(grid, maxCol + 1);
  const def = { origin: grid.origin, columns: grid.columns };

  const lanes = reroute ? { vLanes: [], hLanes: [] } : reroutes.laneCountsFromClaims(grid);
  let solved = layout.solve(def, cells, solveOpts(lanes));
  if (!solved) return null;
  enforce.applySolved(graph, solved);

  if (reroute) {
    reroutes.cleanup(graph, grid);
    const plan = reroutes.planRoutes(graph, solved);
    solved = layout.solve(def, cells, solveOpts(plan)) ?? solved;
    enforce.applySolved(graph, solved);
    /* Re-plan against final geometry; lane structure matches the first plan
     * (intervals only shifted), the coordinates are what changed. */
    reroutes.materialize(graph, grid, solved, reroutes.planRoutes(graph, solved));
  }

  reroutes.hideClaimedDots(graph, isClaimedAndActive);
  paint.setBands(solved);
  paint.setGhosts(layout.ghosts(solved, model.cfg));
  return solved;
}

/** Whether a reroute is one of ours in an active grid — hidden dot if so. */
function isClaimedAndActive(reroute) {
  const graph = activeGraph();
  if (!graph) return false;
  const grid = model.getGrid(graph);
  return !!grid?.enabled && grid.rerouteClaims?.[reroute.id] !== undefined;
}

/** Orthogonal traces need a non-spline link mode; splines cut every gutter
 * corner. The mode follows the Manhattan toggle: Linear while the grid is
 * on, back to the stock Spline when it goes off. Gated by gridcm.orthoLinks. */
function setLinkMode(manhattanOn) {
  if (!orthoLinks) return;
  const want = manhattanOn ? window.LiteGraph.LINEAR_LINK : window.LiteGraph.SPLINE_LINK;
  if (app.canvas.links_render_mode === want) return;
  try {
    app.ui.settings.setSettingValue('Comfy.LinkRenderMode', want);
    if (manhattanOn && !announcedLinkMode) {
      announcedLinkMode = true;
      toast('Link Render Mode follows the grid: Linear while on, Spline when off (Settings → GridCM to opt out)');
    }
  } catch (e) {
    console.error('[gridcm] could not switch link render mode', e);
  }
}

/* --- drag lifecycle -------------------------------------------------------
 * One undo pair spans the whole gesture: route clearing on the first live
 * move, then the drop relayout. changeTracker counts nested pairs, so the
 * transact() inside dropCommit composes into the same single snapshot. */
let dragPaired = false;
let resizeCtx = null;   // {col, startWidth} while a grip drag is live

function nodeDragStarted(node) {
  const graph = activeGraph();
  if (!graph || node.graph !== graph) return;
  app.canvas.emitBeforeChange();
  dragPaired = true;
  /* Rubber-band: drop this node's plugin routes so its links point straight
   * at it while it moves. Regenerated on drop (or snap-back). */
  reroutes.clearNodeRoutes(graph, model.getGrid(graph), node);
  graph.setDirtyCanvas(false, true);
}

function nodeDropped(node, hit, gx, gy) {
  try {
    dropCommit(node, hit, gx, gy);
  } finally {
    if (dragPaired) {
      dragPaired = false;
      app.canvas.emitAfterChange();
    }
  }
}

function colResizeStart(gutter) {
  const graph = activeGraph();
  const grid = graph && model.getGrid(graph);
  const col = gutter - 1;
  if (!grid?.columns[col]) return;
  app.canvas.emitBeforeChange();
  resizeCtx = { col, startWidth: grid.columns[col].width };
}

/** The narrowest a column may go: its widest node's natural width plus the
 * cell padding — squeezing past that would push nodes into the gutters. */
function minColWidth(graph, col) {
  let min = 120;
  for (const { node, cell } of model.assignments(graph)) {
    if (cell.col === col) {
      min = Math.max(min, enforce.naturalMinWidth(node) + 2 * model.cfg.cellPad);
    }
  }
  return min;
}

function colResizeMove(gutter, dx) {
  const graph = activeGraph();
  if (!graph || !resizeCtx) return;
  const grid = model.getGrid(graph);
  grid.columns[resizeCtx.col].width = Math.max(
    minColWidth(graph, resizeCtx.col), Math.round(resizeCtx.startWidth + dx));
  relayout(graph, grid, { reroute: false });   // live: solver only, cables lag
  graph.setDirtyCanvas(true, true);
}

function colResizeEnd(commit) {
  const graph = activeGraph();
  if (!resizeCtx) return;
  const ctx = resizeCtx;
  resizeCtx = null;
  if (graph) {
    const grid = model.getGrid(graph);
    if (!commit) grid.columns[ctx.col].width = ctx.startWidth;
    relayout(graph, grid, { reroute: true });
    graph.setDirtyCanvas(true, true);
  }
  app.canvas.emitAfterChange();
}

/** Drop commit for the drag layer: cell -> (re)assign & stack, ghost ->
 * split outward into a fresh column/row. Anything else snaps the node back
 * (with rerouting — the drag start cleared this node's cables). */
function dropCommit(node, hit, gx, gy) {
  const graph = activeGraph();
  if (!graph || node.graph !== graph) return;
  const grid = model.getGrid(graph);
  if (!hit || (hit.type !== 'cell' && hit.type !== 'ghost')) {
    transact(() => relayout(graph, grid, { reroute: true }));   // snap back
    return;
  }
  transact(() => {
    const prev = model.cellOf(node) ?? { rowspan: 1 };
    model.setSkip(node, false);
    if (hit.type === 'cell') {
      /* Insert into the stack at the drop's y: above the first tenant whose
       * vertical centre lies below the pointer. Dropping above the top
       * node's centre makes ours the top; between two centres — between. */
      const tenants = [];
      for (const { node: other, cell } of model.assignments(graph)) {
        if (other !== node && cell.col === hit.col && cell.row === hit.row) {
          const title = window.LiteGraph.NODE_TITLE_HEIGHT;
          const outerTop = other.pos[1] - title;
          const outerH = (other.flags?.collapsed ? 0 : other.size[1]) + title;
          tenants.push({ other, cell, midY: outerTop + outerH / 2 });
        }
      }
      tenants.sort((a, b) => a.cell.order - b.cell.order);
      const insertAt = tenants.filter((t) => t.midY < gy).length;
      tenants.forEach((t, i) => {
        model.setCell(t.other, { ...t.cell, order: i < insertAt ? i : i + 1 });
      });
      model.setCell(node, { col: hit.col, row: hit.row, rowspan: prev.rowspan, order: insertAt });
    } else {
      /* nearest column for the horizontal ghosts */
      const bands = paint.getBands();
      let nearCol = 0, best = Infinity;
      for (let c = 0; c < bands.colBands.length; c++) {
        const d = Math.abs((bands.colBands[c].x0 + bands.colBands[c].x1) / 2 - gx);
        if (d < best) { best = d; nearCol = c; }
      }
      if (hit.side === 'left') {
        model.insertColumn(graph, grid, 0);
        model.setCell(node, { col: 0, row: 0, rowspan: prev.rowspan, order: 0 });
      } else if (hit.side === 'right') {
        model.ensureColumns(grid, grid.columns.length + 1);
        model.setCell(node, { col: grid.columns.length - 1, row: 0, rowspan: prev.rowspan, order: 0 });
      } else if (hit.side === 'top') {
        model.insertRow(graph, 0);
        model.setCell(node, { col: nearCol, row: 0, rowspan: prev.rowspan, order: 0 });
      } else {
        model.setCell(node, { col: nearCol, row: model.rowCount(graph), rowspan: prev.rowspan, order: 0 });
      }
    }
    model.compactRows(graph);
    model.compactColumns(graph, grid);
    relayout(graph, grid, { reroute: true });
  });
}

/* --- commands -------------------------------------------------------------- */

function cmdArrange() {
  const graph = gate();
  if (!graph) return toast('disabled', 'warn');
  if (!graph._nodes.length) return toast('nothing to arrange');
  transact(() => {
    const grid = model.ensureGrid(graph);
    grid.enabled = true;

    /* Auto-placement: existing assignments are pins, everything else flows
     * from the dataflow topology. */
    const placed = topology.assign({
      nodes: graph._nodes.filter((n) => !model.isSkipped(n)).map((n) => {
        const cell = model.cellOf(n);
        return { id: n.id, pinnedCol: cell?.col ?? null, pinnedRow: cell?.row ?? null };
      }),
      edges: [...graph.links.values()].map((l) => ({ from: l.origin_id, to: l.target_id })),
    });
    for (const node of graph._nodes) {
      if (model.isSkipped(node)) continue;
      const spot = placed.get(node.id);
      if (!spot) continue;
      const existing = model.cellOf(node);
      model.setCell(node, {
        col: spot.col,
        row: spot.row,
        rowspan: existing?.rowspan ?? 1,
        order: existing?.order ?? 0,
      });
    }
    model.compactRows(graph);
    model.compactColumns(graph, model.getGrid(graph));
    relayout(graph, model.getGrid(graph), { reroute: true });
  });
  setLinkMode(true);
  syncToggleButton(true);
}

function cmdReflow() {
  const graph = activeGraph();
  if (!graph) return;
  transact(() => {
    const grid = model.getGrid(graph);
    model.compactRows(graph);
    model.compactColumns(graph, grid);
    relayout(graph, grid, { reroute: true });
  });
}

function cmdToggleGrid() {
  const graph = gate();
  if (!graph) return;
  const grid = model.getGrid(graph);
  if (!grid) return toast('no grid in this workflow yet — run Arrange first');
  grid.enabled = !grid.enabled;
  if (grid.enabled) {
    /* Re-enable = snap everything back to the stored cells; the user may
     * have moved nodes freely meanwhile, so the cables need a fresh pass. */
    transact(() => {
      model.compactRows(graph);
      model.compactColumns(graph, grid);
      relayout(graph, grid, { reroute: true });
    });
  } else {
    /* Off = back to a stock-looking graph: the routing points only make
     * sense while the grid drives them, so they are removed outright and
     * the links fall back to plain splines. Toggling on regenerates. */
    transact(() => reroutes.cleanup(graph, grid));
    paint.setBands(null);
    graph.setDirtyCanvas(true, true);
  }
  setLinkMode(grid.enabled);
  syncToggleButton(grid.enabled);
  toast(grid.enabled ? 'grid on' : 'grid off (cables back to splines, positions stay)');
}

function cmdColumnWidth() {
  const graph = activeGraph();
  if (!graph) return;
  const grid = model.getGrid(graph);
  app.canvas.prompt('Column width ("W" for all, "INDEX W" for one)', '', (text) => {
    const parts = String(text).trim().split(/\s+/).map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return;
    transact(() => {
      if (parts.length === 1) {
        grid.columns.forEach((col, i) => {
          col.width = Math.max(minColWidth(graph, i), parts[0]);
        });
      } else {
        const col = grid.columns[parts[0]];
        if (col) col.width = Math.max(minColWidth(graph, parts[0]), parts[1]);
      }
      relayout(graph, grid, { reroute: true });
    });
  }, null);
}

function cmdStackSelection() {
  const graph = activeGraph();
  if (!graph) return;
  const selected = Object.values(app.canvas.selected_nodes ?? {});
  if (selected.length < 2) return toast('select at least two nodes to stack');
  const anchor = model.cellOf(selected[0]);
  if (!anchor) return toast('the first selected node is not on the grid');
  transact(() => {
    selected.forEach((node, i) => {
      model.setCell(node, { col: anchor.col, row: anchor.row, rowspan: anchor.rowspan, order: i });
    });
    model.compactRows(graph);
    relayout(graph, model.getGrid(graph), { reroute: true });
  });
}

/* --- node menu operations (the drag layer covers placement; only what a
 * drag cannot express stays as menu entries) --------------------------------- */

function promptRowspan(graph, node) {
  const cell = model.cellOf(node);
  if (!cell) return;
  app.canvas.prompt('Rowspan', cell.rowspan, (text) => {
    const span = Math.max(1, Math.floor(Number(text)));
    if (!Number.isFinite(span)) return;
    transact(() => {
      model.setCell(node, { ...cell, rowspan: span });
      relayout(graph, model.getGrid(graph), { reroute: true });
    });
  }, null);
}

function toggleSkip(graph, node) {
  transact(() => {
    model.setSkip(node, !model.isSkipped(node));
    model.compactRows(graph);
    relayout(graph, model.getGrid(graph), { reroute: true });
  });
}

/* --- the "M" toggle in the floating action bar ------------------------------
 * One click flips Manhattan mode for the current workflow without rebuilding
 * anything: the cell assignments already live in node properties, so ON
 * snaps everything back to its cell (with a cable pass), OFF releases the
 * nodes for free-form moving. First click on a grid-less workflow arranges. */
let toggleBtn = null;

function syncToggleButton(on) {
  if (!toggleBtn) return;
  toggleBtn.style.opacity = on ? '1' : '0.4';
  toggleBtn.title = `Manhattan grid: ${on ? 'on' : 'off'}`;
}

function installToggleButton() {
  const mount = () => {
    const bar = document.querySelector('[data-testid="action-bar-buttons"]');
    if (!bar) return;
    if (bar.querySelector('.gridcm-toggle')) return;
    const btn = document.createElement('button');
    btn.className = 'gridcm-toggle';
    btn.textContent = 'M';
    btn.style.cssText = 'width:28px;height:28px;border:none;border-radius:6px;'
      + 'background:transparent;color:inherit;font-weight:700;font-size:14px;'
      + 'cursor:pointer;font-family:inherit;line-height:1;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(128,128,128,0.25)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', () => {
      const graph = gate();
      if (!graph) return;
      if (!model.getGrid(graph)) {
        cmdArrange();
        syncToggleButton(true);
      } else {
        cmdToggleGrid();
      }
    });
    bar.appendChild(btn);
    toggleBtn = btn;
    syncToggleButton(!!model.getGrid(app.graph)?.enabled);
  };
  mount();
  /* The Vue action bar re-renders at will; keep re-mounting. mount() is
   * idempotent, the observer just watches for the button vanishing. */
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
}

/* --- extension ------------------------------------------------------------- */

app.registerExtension({
  name: 'ComfyUI-Manhattan',

  settings: [
    {
      id: 'gridcm.enabled',
      name: 'Grid layout features',
      category: ['GridCM', 'Grid', 'Enabled'],
      type: 'boolean',
      defaultValue: true,
      onChange(value) {
        masterEnabled = value !== false;
        app.graph?.setDirtyCanvas?.(true, true);
      },
    },
    {
      id: 'gridcm.orthoLinks',
      name: 'Switch Link Render Mode to Linear on arrange',
      category: ['GridCM', 'Grid', 'Orthogonal links'],
      type: 'boolean',
      defaultValue: true,
      onChange(value) { orthoLinks = value !== false; },
    },
    {
      id: 'gridcm.cellPad',
      name: 'Cell padding (px)',
      category: ['GridCM', 'Geometry', 'Cell padding'],
      type: 'number',
      defaultValue: model.cfg.cellPad,
      onChange(value) { if (Number.isFinite(value)) model.cfg.cellPad = value; },
    },
    {
      id: 'gridcm.nodeGap',
      name: 'Gap between stacked nodes (px)',
      category: ['GridCM', 'Geometry', 'Node gap'],
      type: 'number',
      defaultValue: model.cfg.nodeGap,
      onChange(value) { if (Number.isFinite(value)) model.cfg.nodeGap = value; },
    },
    {
      id: 'gridcm.gutterMin',
      name: 'Minimum gutter size (px)',
      category: ['GridCM', 'Geometry', 'Gutter minimum'],
      type: 'number',
      defaultValue: model.cfg.gutterMin,
      onChange(value) { if (Number.isFinite(value)) model.cfg.gutterMin = value; },
    },
    {
      id: 'gridcm.laneSpacing',
      name: 'Cable lane spacing (px)',
      category: ['GridCM', 'Geometry', 'Lane spacing'],
      type: 'number',
      defaultValue: model.cfg.laneSpacing,
      onChange(value) { if (Number.isFinite(value)) model.cfg.laneSpacing = value; },
    },
  ],

  commands: [
    { id: 'gridcm.arrange', label: 'Grid: arrange graph into grid', function: cmdArrange },
    { id: 'gridcm.reflow-cables', label: 'Grid: reflow cables', function: cmdReflow },
    { id: 'gridcm.toggle-grid', label: 'Grid: toggle for this workflow', function: cmdToggleGrid },
    { id: 'gridcm.column-width', label: 'Grid: set column width', function: cmdColumnWidth },
    { id: 'gridcm.stack-selection', label: 'Grid: stack selection into one cell', function: cmdStackSelection },
  ],

  /* No canvas context menu: the M button + command palette cover it, and the
   * drag layer covers node placement. The node menu keeps only what a drag
   * cannot express: rowspan and grid opt-out. */
  getNodeMenuItems(node) {
    const graph = activeGraph();
    if (!graph || node.graph !== graph) return [];
    if (model.isSkipped(node) || !model.cellOf(node)) {
      return [null, { content: 'Grid: include node', callback: () => toggleSkip(graph, node) }];
    }
    return [
      null,
      { content: 'Grid: set rowspan…', callback: () => promptRowspan(graph, node) },
      { content: 'Grid: exclude node', callback: () => toggleSkip(graph, node) },
    ];
  },

  getSelectionToolboxCommands() {
    return activeGraph() ? ['gridcm.stack-selection'] : [];
  },

  setup() {
    enforce.init(activeGraph);
    enforce.installBase();
    const context = () => {
      const graph = activeGraph();
      return graph ? { graph, grid: model.getGrid(graph) } : null;
    };
    paint.install(app, app.canvas, context);
    drag.install(app, context, {
      onNodeDragStart: nodeDragStarted,
      onNodeDrop: nodeDropped,
      onResizeStart: colResizeStart,
      onResizeMove: colResizeMove,
      onResizeEnd: colResizeEnd,
    });
    installToggleButton();

    /* Collapsing/expanding changes a node's stacked height — re-solve the
     * grid so the stack closes up (or reopens) around it. */
    const origCollapse = window.LGraphNode.prototype.collapse;
    window.LGraphNode.prototype.collapse = function collapseWithRelayout(...args) {
      const result = origCollapse.apply(this, args);
      const graph = activeGraph();
      if (graph && this.graph === graph && model.cellOf(this)) {
        transact(() => relayout(graph, model.getGrid(graph), { reroute: true }));
      }
      return result;
    };

    if (vueMode()) {
      console.log('[gridcm] Vue nodes rendering is on: layout/cables fully work, band shading may be absent');
    }
  },

  nodeCreated(node) {
    enforce.adoptNode(node);
  },

  beforeConfigureGraph() {
    paint.setBands(null);
  },

  afterConfigureGraph() {
    const graph = gate();
    if (!graph) return;
    const grid = model.getGrid(graph);
    if (!grid?.enabled) return;
    /* Runs after the frontend's load-time widen loop, so this is the spot to
     * squeeze widths back and restore band paint. Reroutes come straight from
     * the file — no regeneration on load. */
    model.pruneClaims(graph, grid);
    enforce.reassertWidths(graph);
    relayout(graph, grid, { reroute: false });
    syncToggleButton(grid.enabled);
  },
});
