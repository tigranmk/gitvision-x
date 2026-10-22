import { describe, expect, it } from 'vitest';
import { mapLines, splitLines } from './lineDiff';

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('splitLines', () => {
  it('counts lines like git blame', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('mapLines', () => {
  it('maps unchanged lines around an edit, insert and delete', () => {
    const before = ['a', 'b', 'c', 'd', 'e'];
    expect(Array.from(mapLines(before, ['a', 'B', 'c', 'd', 'e']))).toEqual([0, -1, 2, 3, 4]);
    expect(Array.from(mapLines(before, ['new', 'a', 'b', 'c', 'd', 'e']))).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(Array.from(mapLines(before, ['a', 'b', 'd', 'e']))).toEqual([0, 1, 3, 4]);
    expect(Array.from(mapLines(before, ['e', 'a', 'x', 'c']))).toEqual(expect.arrayContaining([-1]));
    expect(Array.from(mapLines([], ['x']))).toEqual([-1]);
    expect(Array.from(mapLines(['x'], []))).toEqual([]);
  });

  it('finds an optimal, order-preserving matching (fuzz vs. LCS)', () => {
    const rand = rng(42);
    for (let t = 0; t < 400; t++) {
      const alphabet = 1 + Math.floor(rand() * 5);
      const gen = () => Array.from({ length: Math.floor(rand() * 14) }, () => String.fromCharCode(97 + Math.floor(rand() * alphabet)));
      const a = gen();
      const b = gen();
      const map = mapLines(a, b);
      let last = -1;
      let matched = 0;
      map.forEach((i, j) => {
        if (i < 0) return;
        expect(a[i]).toBe(b[j]);
        expect(i).toBeGreaterThan(last);
        last = i;
        matched++;
      });
      expect(matched).toBe(lcs(a, b));
    }
  });

  it('remaps a 20k-line buffer with a few edits quickly', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `row ${i}`);
    const after = [...before];
    after.splice(10_000, 1, 'edited', 'inserted');
    after.splice(500, 3);
    const t = performance.now();
    const map = mapLines(before, after);
    expect(performance.now() - t).toBeLessThan(50);
    expect(map[0]).toBe(0);
    expect(map[after.indexOf('edited')]).toBe(-1);
    expect(map[after.length - 1]).toBe(19_999);
  });

  it('treats a wholesale rewrite past the edit limit as unmapped instead of stalling', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `a${i}`);
    const after = Array.from({ length: 5000 }, (_, i) => `b${i}`);
    const t = performance.now();
    expect(mapLines(before, after).every((v) => v === -1)).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
