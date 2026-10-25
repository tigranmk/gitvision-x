/**
 * Lane layout for the commit graph, computed in the worker over a LogTable (topological order,
 * children before parents).
 *
 * Lanes never move: a lane keeps its column from the row that opens it to the row that closes it,
 * and freed columns are reused. Colours cycle by lane index (spec: --gvx-lane-1 … 8), so a lane keeps
 * its colour for its whole length.
 *
 * Each row is a 22 px band: the node sits at mid-height, and edges are drawn within the band:
 * - PASS: a lane that crosses the row without touching the node (top → bottom, same column)
 * - IN:   a lane that ends at the node (top of its column → node)
 * - OUT:  node → a parent's lane at the bottom (continuing, newly opened, or joining another lane)
 *
 * Layout is lazy and resumable: `layoutTo(row)` extends it only as far as the viewport needs.
 */
import { EDGE_IN, EDGE_OUT, EDGE_PASS, ROW_BOUNDARY, ROW_MERGE, ROW_ROOT, ROW_TIP, packEdge } from '@gvx/protocol';
import type { LogTable } from './logTable';

const MAX_LANES = 0x7fff;

export interface LayoutPage {
  start: number;
  /** Per row: the node's lane. */
  nodeLane: Uint16Array;
  /** Per row: ROW_* bits. */
  flags: Uint8Array;
  /** Edges of row `start + i` are `edges[edgeStart[i] .. edgeStart[i + 1])`. */
  edgeStart: Uint32Array;
  edges: Uint32Array;
  /** Widest lane count over the whole layout so far. */
  width: number;
}

export class GraphLayout {
  /** Rows laid out so far. */
  rows = 0;
  /** Lanes in use at any point so far (the graph's width in lanes). */
  width = 0;
  private nodeLane: Uint16Array;
  private flags: Uint8Array;
  private edgeStart: Uint32Array;
  private edges = new Uint32Array(1024);
  private edgeLen = 0;
  /** Per lane: the row the lane is waiting for, or -1 when the lane is free. */
  private lanes = new Int32Array(64).fill(-1);
  private laneCount = 0;

  constructor(readonly table: LogTable) {
    this.nodeLane = new Uint16Array(table.count);
    this.flags = new Uint8Array(table.count);
    this.edgeStart = new Uint32Array(table.count + 1);
  }

  /** Lays out rows up to and including `row` (clamped to the table). */
  layoutTo(row: number): void {
    const end = Math.min(row + 1, this.table.count);
    for (let r = this.rows; r < end; r++) this.layoutRow(r);
    if (end > this.rows) this.rows = end;
  }

  /** Rows [start, start + count), laid out first if needed. Arrays are copies (safe to transfer). */
  page(start: number, count: number): LayoutPage {
    const s = Math.max(0, Math.min(start, this.table.count));
    const e = Math.min(s + Math.max(0, count), this.table.count);
    this.layoutTo(e - 1);
    const base = this.edgeStart[s]!;
    const edgeStart = new Uint32Array(e - s + 1);
    for (let i = 0; i <= e - s; i++) edgeStart[i] = this.edgeStart[s + i]! - base;
    return {
      start: s,
      nodeLane: this.nodeLane.slice(s, e),
      flags: this.flags.slice(s, e),
      edgeStart,
      edges: this.edges.slice(base, this.edgeStart[e]),
      width: this.width,
    };
  }

  private layoutRow(r: number): void {
    const lanes = this.lanes;
    let node = -1;
    let flags = 0;

    // Lanes that cross this row, and lanes that end at this commit (the leftmost becomes its lane).
    for (let l = 0; l < this.laneCount; l++) {
      const want = lanes[l]!;
      if (want === r) {
        if (node < 0) node = l;
      } else if (want >= 0) {
        this.push(packEdge(EDGE_PASS, l, l));
      }
    }
    if (node < 0) {
      flags |= ROW_TIP;
      node = this.freeLane(-1);
    } else {
      for (let l = node; l < this.laneCount; l++) {
        if (lanes[l] === r) {
          this.push(packEdge(EDGE_IN, l, node));
          lanes[l] = -1;
        }
      }
    }

    const np = this.table.parentCount(r);
    if (np === 0) flags |= ROW_ROOT;
    if (np > 1) flags |= ROW_MERGE;
    for (let k = 0; k < np; k++) {
      const p = this.table.parentRow(r, k);
      if (p < 0) {
        flags |= ROW_BOUNDARY;
        continue;
      }
      let target = -1;
      for (let l = 0; l < this.laneCount; l++) {
        if (lanes[l] === p) {
          target = l;
          break;
        }
      }
      if (target < 0) {
        // Prefer continuing straight down from the node; otherwise open the leftmost free lane.
        target = node < this.laneCount && lanes[node] === -1 ? node : this.freeLane(node);
        lanes[target] = p;
      }
      this.push(packEdge(EDGE_OUT, node, target));
    }

    while (this.laneCount > 0 && lanes[this.laneCount - 1] === -1) this.laneCount--;
    if (node + 1 > this.width) this.width = node + 1;
    if (this.laneCount > this.width) this.width = this.laneCount;
    this.nodeLane[r] = node;
    this.flags[r] = flags;
    this.edgeStart[r + 1] = this.edgeLen;
  }

  /** The leftmost free lane other than `except` (which is reserved for the node being placed). */
  private freeLane(except: number): number {
    for (let l = 0; l < this.laneCount; l++) if (this.lanes[l] === -1 && l !== except) return l;
    let l = this.laneCount;
    if (l === except) l++;
    if (l >= MAX_LANES) throw new Error(`Graph needs more than ${MAX_LANES} lanes`);
    if (l >= this.lanes.length) {
      const next = new Int32Array(this.lanes.length * 2).fill(-1);
      next.set(this.lanes);
      this.lanes = next;
    }
    this.laneCount = l + 1;
    return l;
  }

  private push(e: number): void {
    if (this.edgeLen === this.edges.length) {
      const next = new Uint32Array(this.edges.length * 2);
      next.set(this.edges);
      this.edges = next;
    }
    this.edges[this.edgeLen++] = e;
  }
}
