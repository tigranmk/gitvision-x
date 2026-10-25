/**
 * What a lane is (spec: lane colour is never the only cue; the hovered lane's tooltip names the branch).
 * Walks up the lane from the hovered row to where it starts: a branch tip (named by its refs) or a merge that
 * brought the branch in (unnamed: git keeps no branch name for merged history).
 */
import { EDGE_IN, EDGE_OUT, EDGE_PASS, edgeFrom, edgeKind, edgeTo } from '@gvx/protocol';
import type { RowGraph } from './draw';

export type LaneStart =
  /** The lane starts at a commit in that lane: names = its branch/remote refs (may be empty). */
  | { kind: 'tip'; row: number; names: string[] }
  /** The lane was opened by a merge (its second parent), at `row`. */
  | { kind: 'merged'; row: number }
  /** Rows above are not loaded yet. */
  | { kind: 'unknown' };

/** Does `lane` cross the top edge of `row` (i.e. continue into the row above)? */
function entersFromAbove(g: RowGraph, lane: number): boolean {
  for (const e of g.edges) {
    const k = edgeKind(e);
    if ((k === EDGE_PASS || k === EDGE_IN) && edgeFrom(e) === lane) return true;
  }
  return false;
}

/** Is `lane` drawn in `row` at all (node, passing, ending or opening)? */
function inRow(g: RowGraph, lane: number): boolean {
  if (g.lane === lane) return true;
  return g.edges.some((e) => edgeFrom(e) === lane || (edgeKind(e) === EDGE_OUT && edgeTo(e) === lane));
}

export function laneStart(row: number, lane: number, rowAt: (r: number) => RowGraph | null, namesAt: (r: number) => string[], maxRows = 5000): LaneStart {
  let r = row;
  let g = rowAt(r);
  if (!g || !inRow(g, lane)) return { kind: 'unknown' };
  for (let n = 0; n < maxRows; n++) {
    // The first commit up the lane that a branch points at names it (it may sit below where the lane opens).
    if (g.lane === lane) {
      const names = namesAt(r);
      if (names.length) return { kind: 'tip', row: r, names };
    }
    if (!entersFromAbove(g, lane)) {
      // The lane starts in this row: at its own node (a tip), or opened by an OUT edge of another lane's node.
      if (g.lane === lane) return { kind: 'tip', row: r, names: namesAt(r) };
      return { kind: 'merged', row: r };
    }
    if (r === 0) return { kind: 'unknown' };
    r--;
    g = rowAt(r);
    if (!g) return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}
