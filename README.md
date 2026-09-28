# ComfyUI-Manhattan

Column/table layout for the ComfyUI graph canvas: content columns with stacked
full-width nodes, cable gutters (vertical and horizontal) carrying all link
routing as **native reroute points** along Manhattan (orthogonal) routes,
rowspan for tall nodes, drag-and-drop with drop-target preview, spreadsheet
column-resize handles.

Purely client-side (`WEB_DIRECTORY`), no custom node types, no build step.
**Workflows stay fully compatible with stock ComfyUI**: positions are real
`pos`/`size`, cables are native reroutes serialized into the workflow, plugin
state rides inertly in `workflow.extra.gridcm` and
`node.properties["gridcm.*"]`. Remove the extension — the workflow opens
already laid out, cables intact.

## Use

- Click **M** in the floating action bar: first click arranges the graph into
  a grid (auto-layout by dataflow depth; switches Link Render Mode to Linear
  for clean orthogonal traces — opt out in Settings → GridCM), later clicks
  toggle Manhattan mode on/off without losing the cell assignments.
- Drag nodes between cells — the target cell highlights; drop position picks
  the slot inside a stack; dashed ghost columns/rows around the table split
  outward on drop.
- Drag the grips above the vertical gutters to resize columns (clamped at the
  widest node's natural width).
- Collapse a node — the stack closes up around it, collapsed title stretches
  to the column.
- Node context menu: rowspan, exclude from grid. Everything else is a drag.
- Command palette: arrange, reflow cables, toggle, column width, stack
  selection.

## Internals

`gridcm` is the internal namespace (settings ids, `extra` key, node property
prefix) — kept stable across the project rename. Module map: `model.js`
(persisted schema) — `layout.js` (pure solver) — `topology.js` (layering +
barycenter) — `enforce.js` (width pinning) — `reroutes.js` (Manhattan routing
over native reroutes) — `paint.js` (bands, highlight, ribbon) — `drag.js`
(pointer interception) — `index.js` (commands, menus, lifecycle).

Requires the 1.53.x frontend (built and verified against ComfyUI 0.37.0 /
comfyui-frontend-package 1.53.6, Vue nodes on or off).
