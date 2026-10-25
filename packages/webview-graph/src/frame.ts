/** A graph frame packed into typed arrays, for posting to the render worker (D6). */
import type { DrawInput, RowGraph } from './draw';

/** A frame: everything draw() needs, with rows packed for postMessage. */
export interface PackedFrame extends Omit<DrawInput, 'rows'> {
  present: Uint8Array;
  lanes: Uint16Array;
  flags: Uint8Array;
  edgeStart: Uint32Array;
  edges: Uint32Array;
  /** performance.now() on the main thread when the frame was posted. */
  sentAt: number;
}

export type RenderMessage =
  | { kind: 'init'; canvas: OffscreenCanvas }
  | { kind: 'frame'; frame: PackedFrame };

export function pack(d: DrawInput): PackedFrame {
  const n = d.rows.length;
  const present = new Uint8Array(n);
  const lanes = new Uint16Array(n);
  const flags = new Uint8Array(n);
  const edgeStart = new Uint32Array(n + 1);
  let total = 0;
  for (const r of d.rows) total += r ? r.edges.length : 0;
  const edges = new Uint32Array(total);
  let k = 0;
  d.rows.forEach((r, i) => {
    if (r) {
      present[i] = 1;
      lanes[i] = r.lane;
      flags[i] = r.flags;
      edges.set(r.edges, k);
      k += r.edges.length;
    }
    edgeStart[i + 1] = k;
  });
  return { ...frameFields(d), present, lanes, flags, edgeStart, edges, sentAt: performance.now() };
}

/** Everything in a frame except the rows. */
function frameFields(d: Omit<DrawInput, 'rows'>): Omit<DrawInput, 'rows'> {
  const { width, laneWidth, height, dpr, scrollTop, first, theme, headRow, pulseRow, pulse, pulseColor, lineage, lineageColor } = d;
  return { width, laneWidth, height, dpr, scrollTop, first, theme, headRow, pulseRow, pulse, pulseColor, lineage, lineageColor };
}

export function unpack(f: PackedFrame): DrawInput {
  const rows: (RowGraph | null)[] = [];
  for (let i = 0; i < f.present.length; i++) {
    rows.push(f.present[i] ? { lane: f.lanes[i]!, flags: f.flags[i]!, edges: f.edges.subarray(f.edgeStart[i], f.edgeStart[i + 1]) } : null);
  }
  return { ...frameFields(f), rows };
}

/** Sizes the backing store to CSS size × devicePixelRatio. */
export function size(canvas: { width: number; height: number }, d: Pick<DrawInput, 'width' | 'height' | 'dpr'>): void {
  const w = Math.round(d.width * d.dpr);
  const h = Math.round(d.height * d.dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
