/**
 * Draws the graph column for the visible rows. Pure: takes any 2D context, so the same code runs on
 * the main thread and in the OffscreenCanvas worker (D6).
 */
import {
  EDGE_IN,
  EDGE_OUT,
  LANE_COLORS,
  ROW_BOUNDARY,
  ROW_MERGE,
  edgeFrom,
  edgeKind,
  edgeTo,
} from '@gvx/protocol';

export const ROW_HEIGHT = 22;
export const LANE_WIDTH = 16;
export const NODE_RADIUS = 4;
export const GRAPH_PAD = 4;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What draw() needs from one row: views into a cached page. */
export interface RowGraph {
  lane: number;
  flags: number;
  edges: Uint32Array;
}

export interface DrawTheme {
  lanes: string[];
  surface: string;
  contrastBorder: string | null;
  head: string;
}

export interface DrawInput {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  scrollTop: number;
  /** Laid-out rows for [first, first + rows.length); null where the page has not arrived. */
  first: number;
  rows: (RowGraph | null)[];
  theme: DrawTheme;
  /** Row of HEAD, drawn as a ringed node. */
  headRow: number;
  /** Row pulsed by editor → graph sync, and the pulse's progress 0..1 (1 = settled). */
  pulseRow: number;
  pulse: number;
  pulseColor: string;
  /** Rows in the synced line's history (stage 2), outlined; sorted ascending. */
  lineage: Int32Array;
  lineageColor: string;
}

export const laneX = (lane: number) => GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;

/** Width in CSS pixels of a graph column holding `lanes` lanes (capped so text keeps room). */
export const graphWidth = (lanes: number, max = 24) => GRAPH_PAD * 2 + Math.max(1, Math.min(lanes, max)) * LANE_WIDTH;

export function draw(ctx: Ctx, d: DrawInput): void {
  ctx.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
  ctx.clearRect(0, 0, d.width, d.height);
  const top = d.first * ROW_HEIGHT - d.scrollTop;

  // One path per lane colour: 8 strokes per frame, however many edges are visible.
  const paths = Array.from({ length: LANE_COLORS }, () => new Path2D());
  const boundaries = new Path2D();
  for (let i = 0; i < d.rows.length; i++) {
    const row = d.rows[i];
    if (!row) continue;
    const y0 = top + i * ROW_HEIGHT;
    const yc = y0 + ROW_HEIGHT / 2;
    const y1 = y0 + ROW_HEIGHT;
    const xn = laneX(row.lane);
    for (let k = 0; k < row.edges.length; k++) {
      const e = row.edges[k]!;
      const kind = edgeKind(e);
      const from = edgeFrom(e);
      const to = edgeTo(e);
      if (kind === EDGE_IN) {
        const p = paths[from % LANE_COLORS]!;
        const xf = laneX(from);
        p.moveTo(xf, y0);
        if (from === to) p.lineTo(xn, yc);
        else p.bezierCurveTo(xf, yc, xf, yc, xn, yc);
      } else if (kind === EDGE_OUT) {
        const p = paths[to % LANE_COLORS]!;
        const xt = laneX(to);
        p.moveTo(xn, yc);
        if (from === to) p.lineTo(xt, y1);
        else p.bezierCurveTo(xt, yc, xt, yc, xt, y1);
      } else {
        const p = paths[from % LANE_COLORS]!;
        const x = laneX(from);
        p.moveTo(x, y0);
        p.lineTo(x, y1);
      }
    }
    if (row.flags & ROW_BOUNDARY) {
      boundaries.moveTo(xn, yc);
      boundaries.lineTo(xn, y1);
    }
  }
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (let c = 0; c < LANE_COLORS; c++) {
    ctx.strokeStyle = d.theme.lanes[c]!;
    ctx.stroke(paths[c]!);
  }
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = d.theme.lanes[0]!;
  ctx.stroke(boundaries);
  ctx.restore();

  // Nodes on top of edges.
  const inLineage = lineageSet(d.lineage, d.first, d.first + d.rows.length);
  for (let i = 0; i < d.rows.length; i++) {
    const row = d.rows[i];
    if (!row) continue;
    const r = d.first + i;
    const x = laneX(row.lane);
    const y = top + i * ROW_HEIGHT + ROW_HEIGHT / 2;
    const color = d.theme.lanes[row.lane % LANE_COLORS]!;
    if (r === d.pulseRow && d.pulse < 1) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 2 + 6 * d.pulse, 0, Math.PI * 2);
      ctx.globalAlpha = 1 - d.pulse;
      ctx.fillStyle = d.pulseColor;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
    if (row.flags & ROW_MERGE) {
      // Merges are hollow: shape, not only colour, tells them apart (spec: colour is never the only cue).
      ctx.fillStyle = d.theme.surface;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (d.theme.contrastBorder) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = d.theme.contrastBorder;
      ctx.stroke();
    }
    if (inLineage.has(r)) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = d.lineageColor;
      ctx.stroke();
    }
    if (r === d.headRow) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 2.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = d.theme.head;
      ctx.stroke();
    }
  }
}

/** Lineage rows within [lo, hi), by binary search into the sorted list. */
function lineageSet(rows: Int32Array, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  let a = 0;
  let b = rows.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (rows[m]! < lo) a = m + 1;
    else b = m;
  }
  for (let i = a; i < rows.length && rows[i]! < hi; i++) out.add(rows[i]!);
  return out;
}
