import { describe, expect, it } from 'vitest';
import { EDGE_IN, EDGE_OUT, EDGE_PASS, packEdge } from '@gvx/protocol';
import type { RowGraph } from './draw';
import { laneStart } from './laneName';

// 0: merge M (lane 0) → 1 (lane 0), 2 (lane 1)   | 1: A (lane 0), lane 1 passes | 2: B (lane 1) joins | 3: tip T in lane 2
const rows: RowGraph[] = [
  { lane: 0, flags: 0, edges: new Uint32Array([packEdge(EDGE_OUT, 0, 0), packEdge(EDGE_OUT, 0, 1)]) },
  { lane: 0, flags: 0, edges: new Uint32Array([packEdge(EDGE_PASS, 1, 1), packEdge(EDGE_IN, 0, 0), packEdge(EDGE_OUT, 0, 0)]) },
  { lane: 1, flags: 0, edges: new Uint32Array([packEdge(EDGE_PASS, 0, 0), packEdge(EDGE_IN, 1, 1), packEdge(EDGE_OUT, 1, 0)]) },
];
const names = (r: number) => (r === 0 ? ['main'] : []);

describe('laneStart', () => {
  it('names the branch whose tip opens the lane', () => {
    expect(laneStart(2, 0, (r) => rows[r] ?? null, names)).toEqual({ kind: 'tip', row: 0, names: ['main'] });
  });
  it('names a merged branch by a ref on the way up, before reaching the merge', () => {
    expect(laneStart(2, 1, (r) => rows[r] ?? null, (r) => (r === 2 ? ['feature'] : names(r)))).toEqual({ kind: 'tip', row: 2, names: ['feature'] });
  });
  it('says a lane opened by a merge came from that merge', () => {
    expect(laneStart(2, 1, (r) => rows[r] ?? null, names)).toEqual({ kind: 'merged', row: 0 });
    expect(laneStart(1, 1, (r) => rows[r] ?? null, names)).toEqual({ kind: 'merged', row: 0 });
  });
  it('is unknown when the lane is not in the row or rows above are not loaded', () => {
    expect(laneStart(1, 5, (r) => rows[r] ?? null, names)).toEqual({ kind: 'unknown' });
    expect(laneStart(2, 0, (r) => (r === 2 ? rows[2]! : null), names)).toEqual({ kind: 'unknown' });
  });
});
