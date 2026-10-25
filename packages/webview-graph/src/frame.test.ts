import { describe, expect, it } from 'vitest';
import type { DrawInput } from './draw';
import { pack, unpack } from './frame';

describe('frame packing (D6)', () => {
  it('round-trips visible rows, keeping gaps for rows not loaded yet', () => {
    const input: DrawInput = {
      width: 120,
      height: 66,
      dpr: 2,
      scrollTop: 30,
      first: 1,
      rows: [
        { lane: 0, flags: 8, edges: new Uint32Array([1, 2]) },
        null,
        { lane: 3, flags: 1, edges: new Uint32Array([7]) },
      ],
      theme: { lanes: ['#000'], surface: '#111', contrastBorder: null, head: '#222' },
      headRow: -1,
      pulseRow: 2,
      pulse: 0.5,
      pulseColor: '#333',
      lineage: new Int32Array([1, 3]),
      lineageColor: '#444',
    };
    const out = unpack(pack(input));
    expect(out.rows.map((r) => r && { lane: r.lane, flags: r.flags, edges: [...r.edges] })).toEqual([
      { lane: 0, flags: 8, edges: [1, 2] },
      null,
      { lane: 3, flags: 1, edges: [7] },
    ]);
    expect({ ...out, rows: null }).toEqual({ ...input, rows: null });
  });
});
