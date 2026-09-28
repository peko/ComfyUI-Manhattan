/*
 * reroutes.js — Manhattan cable routing through the gutters, materialized as
 * NATIVE reroute points.
 *
 * Native reroutes are the backcompat trick: they serialize into
 * workflow.extra.reroutes / extra.linkExtensions and stock ComfyUI renders
 * them, so the routing survives removing this plugin entirely.
 *
 * Chain mechanics (verified against the vendored litegraph source, 1.53.6):
 * link.parentId points at the LAST reroute of its chain (nearest the input),
 * each reroute's parentId points at the previous one (toward the output), and
 * reroute.linkIds is DERIVED from the links' parentId chains — never stored.
 * So building a chain is: setReroute({parentId, pos}) per waypoint in
 * output->input order, then link.parentId = tail id. graph.removeReroute()
 * splices a chain correctly in both directions.
 *
 * Ownership: every reroute this module creates is recorded in
 * grid.rerouteClaims. Regeneration deletes exactly the claimed ids, tail
 * first, and never touches user-made reroutes (alt-click). A link whose chain
 * still holds a foreign reroute after cleanup is the user's — left alone.
 *
 * Route shapes:
 *   adjacent gutter (V(a) === V(b)): travel vertically inside one V gutter —
 *     1 point when the slots nearly align, 2 otherwise.
 *   general: V(cs+1) -> chosen H channel -> V(ct), 4 points. The H channel is
 *     the cheapest one whose crossed segments are not blocked by rowspans;
 *     the outer channels H0/H(rows) are never blocked, so a route always
 *     exists. Backward links fall out of the same formula (a > b).
 */

import * as model from './model.js';
import { laneCoord } from './layout.js';

/** Deletes every claimed reroute still present, tail-first, and empties the
 * claims map. Tail-first keeps each removeReroute splice trivial. */
export function cleanup(graph, grid) {
  const c = model.claims(grid);
  const remaining = new Set(
    Object.keys(c).map(Number).filter((id) => graph.reroutes.has(id)));
  while (remaining.size) {
    const parents = new Set();
    for (const id of remaining) {
      const parent = graph.reroutes.get(id)?.parentId;
      if (parent !== undefined && remaining.has(parent)) parents.add(parent);
    }
    let removedAny = false;
    for (const id of [...remaining]) {
      if (parents.has(id)) continue;    // still someone's parent — not a tail
      graph.removeReroute(id);
      remaining.delete(id);
      removedAny = true;
    }
    if (!removedAny) {                  // cycle guard; should never happen
      for (const id of remaining) graph.removeReroute(id);
      break;
    }
  }
  grid.rerouteClaims = {};
}

/**
 * Plans every route against solved geometry and live slot positions (call
 * AFTER applySolved). Returns {routes, vLanes, hLanes}; lane counts feed the
 * second solver pass, routes carry their lane so materialize() only has to
 * turn (gutter, lane) into coordinates.
 */
export function planRoutes(graph, solved) {
  const cellByNode = new Map();
  for (const { node, cell } of model.assignments(graph)) cellByNode.set(node.id, cell);

  const routes = [];
  for (const link of graph.links.values()) {
    if (link.parentId !== undefined) continue;   // user reroutes on the chain
    const src = graph.getNodeById(link.origin_id);
    const dst = graph.getNodeById(link.target_id);
    const cs = cellByNode.get(link.origin_id)?.col;
    const ct = cellByNode.get(link.target_id)?.col;
    if (!src || !dst || cs === undefined || ct === undefined) continue;

    const srcY = src.getOutputPos(link.origin_slot)[1];
    const dstY = dst.getInputPos(link.target_slot)[1];
    const a = cs + 1, b = ct;

    if (a === b) {
      routes.push({ link, segs: [{ dir: 'v', index: a, lo: Math.min(srcY, dstY), hi: Math.max(srcY, dstY) }],
        srcY, dstY });
      continue;
    }

    /* Content columns the horizontal run crosses: everything strictly between
     * the two V gutters. A channel qualifies when none of them is blocked. */
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const crossed = [];
    for (let col = lo; col < hi; col++) crossed.push(col);
    let bestK = -1, bestCost = Infinity;
    for (let k = 0; k < solved.hGutters.length; k++) {
      const g = solved.hGutters[k];
      if (crossed.some((col) => g.blocked.has(col))) continue;
      const hy = (g.y0 + g.y1) / 2;
      const cost = Math.abs(hy - srcY) + Math.abs(hy - dstY);
      if (cost < bestCost) { bestCost = cost; bestK = k; }
    }
    console.assert(bestK >= 0, '[gridcm] no horizontal channel found — outer gutters must never block');
    const hg = solved.hGutters[bestK];
    const hy = (hg.y0 + hg.y1) / 2;
    const vxa = (solved.vGutters[a].x0 + solved.vGutters[a].x1) / 2;
    const vxb = (solved.vGutters[b].x0 + solved.vGutters[b].x1) / 2;
    routes.push({
      link, srcY, dstY,
      segs: [
        { dir: 'v', index: a, lo: Math.min(srcY, hy), hi: Math.max(srcY, hy) },
        { dir: 'h', index: bestK, lo: Math.min(vxa, vxb), hi: Math.max(vxa, vxb) },
        { dir: 'v', index: b, lo: Math.min(hy, dstY), hi: Math.max(hy, dstY) },
      ],
    });
  }

  /* Greedy interval coloring per gutter. Segments are sorted by their low
   * end; a lane is reusable once its previous occupant ended. */
  const buckets = new Map();   // 'v:3' -> [seg, ...]
  for (const r of routes) {
    for (const seg of r.segs) {
      const key = `${seg.dir}:${seg.index}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(seg);
    }
  }
  const vLanes = [], hLanes = [];
  for (const [key, segs] of buckets) {
    segs.sort((s, t) => s.lo - t.lo);
    const laneEnds = [];
    for (const seg of segs) {
      let lane = laneEnds.findIndex((end) => end <= seg.lo);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(-Infinity); }
      laneEnds[lane] = seg.hi;
      seg.lane = lane;
    }
    const [dir, index] = key.split(':');
    const target = dir === 'v' ? vLanes : hLanes;
    target[Number(index)] = laneEnds.length;
  }
  return { routes, vLanes, hLanes };
}

/**
 * Turns a planned route into waypoints against FINAL solved geometry and
 * creates the native reroutes. Slot y positions are re-read live, since the
 * second solver pass may have shifted the nodes.
 */
export function materialize(graph, grid, solved, plan) {
  const c = model.claims(grid);
  for (const route of plan.routes) {
    const { link, segs } = route;
    const src = graph.getNodeById(link.origin_id);
    const dst = graph.getNodeById(link.target_id);
    if (!src || !dst) continue;
    const srcY = src.getOutputPos(link.origin_slot)[1];
    const dstY = dst.getInputPos(link.target_slot)[1];

    const points = [];   // [{x, y, seg}]
    if (segs.length === 1) {
      const seg = segs[0];
      const vx = laneCoord(solved.vGutters[seg.index].x0, seg.lane, model.cfg);
      if (Math.abs(srcY - dstY) < model.cfg.laneSpacing) {
        points.push({ x: vx, y: (srcY + dstY) / 2, seg });
      } else {
        points.push({ x: vx, y: srcY, seg }, { x: vx, y: dstY, seg });
      }
    } else {
      const [sa, sh, sb] = segs;
      const vxa = laneCoord(solved.vGutters[sa.index].x0, sa.lane, model.cfg);
      const hy = laneCoord(solved.hGutters[sh.index].y0, sh.lane, model.cfg);
      const vxb = laneCoord(solved.vGutters[sb.index].x0, sb.lane, model.cfg);
      points.push(
        { x: vxa, y: srcY, seg: sa },
        { x: vxa, y: hy, seg: sh },
        { x: vxb, y: hy, seg: sh },
        { x: vxb, y: dstY, seg: sb },
      );
    }

    let parent;
    for (const p of points) {
      const reroute = graph.setReroute({ parentId: parent, pos: [p.x, p.y] });
      if (!reroute) break;
      c[reroute.id] = { link: link.id, gutter: [p.seg.dir, p.seg.index], lane: p.seg.lane };
      parent = reroute.id;
    }
    if (parent !== undefined) link.parentId = parent;
  }
}

/**
 * Drops the plugin-owned routes of every link touching `node`, so a drag
 * shows the links rubber-banding straight to the node instead of staying
 * pinned to its old cell. Chains containing a foreign (user) reroute are left
 * whole — mixed chains are the user's. The caller regenerates on drop.
 */
export function clearNodeRoutes(graph, grid, node) {
  const c = model.claims(grid);
  for (const link of graph.links.values()) {
    if (link.origin_id !== node.id && link.target_id !== node.id) continue;
    const ids = [];   // collected tail -> root, which is also safe delete order
    let cursor = link.parentId, guard = 0, foreign = false;
    while (cursor !== undefined && guard++ < 64) {
      if (c[cursor] === undefined) { foreign = true; break; }
      ids.push(cursor);
      cursor = graph.reroutes.get(cursor)?.parentId;
    }
    if (foreign) continue;
    for (const id of ids) {
      graph.removeReroute(Number(id));
      delete c[id];
    }
  }
}

const DRAW_WRAPPED = Symbol('gridcm.rerouteDrawWrapped');

/**
 * Hides the dots of plugin-owned reroutes while the grid is active: at
 * Reroute.radius = 10 they dominate every elbow, and ours exist for routing
 * and backcompat, not for grabbing. User reroutes keep their dots, and the
 * hover highlight (drawn separately) still reveals ours for discoverability.
 * The Reroute class is not exported to window, so the prototype is taken
 * from a live instance — call after the first materialize/load.
 */
export function hideClaimedDots(graph, isHidden) {
  const first = graph.reroutes.values().next().value;
  if (!first) return;
  const proto = Object.getPrototypeOf(first);
  if (proto[DRAW_WRAPPED]) return;
  const original = proto.draw;
  proto.draw = function drawUnlessClaimed(ctx, backgroundPattern) {
    if (isHidden(this)) return;
    return original.call(this, ctx, backgroundPattern);
  };
  proto[DRAW_WRAPPED] = true;
}

/** Lane counts implied by the persisted claims — lets a workflow load rebuild
 * gutter sizes without replanning (the reroutes themselves are already in the
 * file). */
export function laneCountsFromClaims(grid) {
  const vLanes = [], hLanes = [];
  for (const claim of Object.values(model.claims(grid))) {
    const [dir, index] = claim.gutter ?? [];
    if (dir === undefined) continue;
    const target = dir === 'v' ? vLanes : hLanes;
    target[index] = Math.max(target[index] ?? 0, claim.lane + 1);
  }
  return { vLanes, hLanes };
}
