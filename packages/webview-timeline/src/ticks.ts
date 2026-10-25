/** Tick layout for the timeline: one per revision, or one per week past BUCKET_ABOVE revisions (spec F3). */
import type { FileRevision } from '@gvx/protocol';

export const BUCKET_ABOVE = 500;
const WEEK = 7 * 86400;

export interface Tick {
  /** Revision shown when this tick is chosen (the newest in its bucket). */
  index: number;
  /** Revisions in the tick: [first, last] indices (newest first, so first <= last). */
  first: number;
  last: number;
  time: number;
  /** Date label drawn at this tick (where the month, or the year on long histories, changes). */
  label: string | null;
}

/** Ticks oldest → newest (left → right). */
export function buildTicks(revisions: FileRevision[], locale?: string): Tick[] {
  const n = revisions.length;
  const ticks: Tick[] = [];
  if (n <= BUCKET_ABOVE) {
    for (let i = n - 1; i >= 0; i--) ticks.push({ index: i, first: i, last: i, time: revisions[i]!.time, label: null });
  } else {
    // Weekly buckets: walk oldest → newest, start a bucket whenever the week changes.
    let i = n - 1;
    while (i >= 0) {
      const week = Math.floor(revisions[i]!.time / WEEK);
      let j = i;
      while (j - 1 >= 0 && Math.floor(revisions[j - 1]!.time / WEEK) === week) j--;
      ticks.push({ index: j, first: j, last: i, time: revisions[j]!.time, label: null });
      i = j - 1;
    }
  }
  if (!ticks.length) return ticks;
  const span = ticks.at(-1)!.time - ticks[0]!.time;
  const byYear = span > 2 * 365 * 86400;
  const key = (t: number) => {
    const d = new Date(t * 1000);
    return byYear ? `${d.getFullYear()}` : `${d.getFullYear()}-${d.getMonth()}`;
  };
  const fmt = (t: number) =>
    new Date(t * 1000).toLocaleDateString(locale, byYear ? { year: 'numeric' } : { month: 'short', year: 'numeric' });
  let prev = '';
  for (const t of ticks) {
    const k = key(t.time);
    if (k !== prev) t.label = fmt(t.time);
    prev = k;
  }
  return ticks;
}

/**
 * Which date labels to draw on a track `width` px wide: a label needs about `labelPx` of room, so labels that
 * would collide with the previous one drawn are skipped (the boundary tick stays). Returns tick indices.
 */
export function visibleLabels(ticks: Tick[], width: number, labelPx = 72): number[] {
  const slots = ticks.length + 1;
  const out: number[] = [];
  let lastX = -Infinity;
  ticks.forEach((t, i) => {
    if (!t.label) return;
    const x = ((i + 0.5) / slots) * width;
    // Keep clear of the "Now" label at the right end too.
    if (x - lastX >= labelPx && width - x >= labelPx * 0.75) {
      out.push(i);
      lastX = x;
    }
  });
  return out;
}

/** The tick that contains revision `index` (-1 for the working copy). */
export function tickOf(ticks: Tick[], index: number): number {
  if (index < 0) return ticks.length; // "Now", right of the last tick
  return ticks.findIndex((t) => index >= t.first && index <= t.last);
}
