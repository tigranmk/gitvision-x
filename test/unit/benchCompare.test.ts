import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { normalise, regressions } from '../../bench/compare.mjs';

const results = (scale: number, layout: number) => ({
  results: [
    { name: 'calibration: git log of 100k commits', samples: [400 * scale] },
    { name: 'calibration: JS parse/sort/map, 200k rows', samples: [100 * scale] },
    { name: 'index: cold full load, 100k commits', samples: [500 * scale, 520 * scale, 510 * scale] },
    { name: 'graph: first page, cold (lays out all 100k rows)', samples: [layout * scale] },
  ],
});

describe('bench regression gate', () => {
  it('cancels out a slower machine', () => {
    const base = normalise(results(1, 10));
    expect(regressions(normalise(results(1.8, 10)), base)).toEqual([]);
  });
  it('flags a measure that got >10% slower relative to its calibration', () => {
    const base = normalise(results(1, 10));
    const bad = regressions(normalise(results(1.3, 12)), base);
    expect(bad.map((r: { name: string }) => r.name)).toEqual(['graph: first page, cold (lays out all 100k rows)']);
    expect(bad[0].change).toBeCloseTo(0.2, 5);
  });
});
