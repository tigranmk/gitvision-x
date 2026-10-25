import { describe, expect, it } from 'vitest';
import type { LogRecord } from './logParser';
import { LogTable } from './logTable';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const r = (n: number, parents: number[], subject = `c${n}`, author = 'A'): LogRecord => ({
  sha: sha(n),
  parents: parents.map(sha),
  author,
  email: `${author.toLowerCase()}@x`,
  time: 1000 + n,
  subject,
});

/** 5 ← 4 ← 2 ← 1, 5 ← 3 ← 1 (merge 5 has parents 4 and 3); 1's parent 0 is outside (shallow). */
function build(): LogTable {
  const t = new LogTable();
  [r(5, [4, 3], 'merge ✓', 'B'), r(4, [2]), r(3, [1]), r(2, [1]), r(1, [0])].forEach((x) => t.append(x));
  return t.finalize();
}

describe('LogTable', () => {
  it('resolves parents to rows and keeps unknown parents as external shas', () => {
    const t = build();
    expect(t.count).toBe(5);
    expect(t.parentsOf(0)).toEqual([1, 2]);
    expect(t.parentsOf(3)).toEqual([4]);
    expect(t.parentsOf(4)).toEqual([sha(0)]);
    expect(t.externalCount).toBe(1);
    expect(t.subject(0)).toBe('merge ✓');
    expect(t.author(0)).toEqual({ name: 'B', email: 'b@x' });
    expect(t.rowOf(sha(3))).toBe(2);
    expect(() => t.sha(5)).toThrow(RangeError);
  });

  it('round-trips through serialize/deserialize with meta', () => {
    const t = build();
    const { table, meta } = LogTable.deserialize(t.serialize({ tips: ['x'] }));
    expect(meta).toEqual({ tips: ['x'] });
    for (let i = 0; i < t.count; i++) {
      expect([table.sha(i), table.parentsOf(i), table.subject(i), table.author(i), table.time(i)]).toEqual([
        t.sha(i), t.parentsOf(i), t.subject(i), t.author(i), t.time(i),
      ]);
    }
  });

  it('rejects foreign or corrupt buffers', () => {
    expect(() => LogTable.deserialize(new Uint8Array(32))).toThrow(/Not a GitVision index/);
  });

  it('concat links new commits onto the old table', () => {
    const old = build();
    const head = new LogTable();
    head.append(r(7, [6, 5], 'merge new', 'C'));
    head.append(r(6, [5]));
    head.finalize();
    const t = LogTable.concat(head, old);
    expect(t.count).toBe(7);
    expect(t.parentsOf(0)).toEqual([1, 2]); // 7 → 6, 5
    expect(t.parentsOf(1)).toEqual([2]); // 6 → 5
    expect(t.parentsOf(2)).toEqual([3, 4]); // old merge, shifted
    expect(t.parentsOf(6)).toEqual([sha(0)]); // external survives
    expect(t.author(0).name).toBe('C');
    expect(t.author(2).name).toBe('B');
    expect(t.subject(6)).toBe('c1');
    expect(LogTable.deserialize(t.serialize()).table.parentsOf(2)).toEqual([3, 4]);
  });

  it('without() removes commits and renumbers parent links', () => {
    const t = build().without(new Set([sha(5), sha(4)])); // drop the merge and one side
    expect(t.count).toBe(3);
    expect([t.sha(0), t.sha(1), t.sha(2)]).toEqual([sha(3), sha(2), sha(1)]);
    expect(t.parentsOf(0)).toEqual([2]);
    expect(t.parentsOf(2)).toEqual([sha(0)]);
    expect(() => build().without(new Set([sha(1)]))).toThrow(/is a parent of kept/);
  });

  it('handles 100k rows within a modest time', () => {
    const t = new LogTable();
    const start = performance.now();
    for (let i = 100_000; i > 0; i--) t.append(r(i, [i - 1]));
    t.finalize();
    expect(t.count).toBe(100_000);
    expect(t.parentsOf(0)).toEqual([1]);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe('LogTable.subset / reachable', () => {
  it('keeps marked rows in order, remaps parents, and turns dropped parents into boundaries', () => {
    const t = build(); // 5 ← 4,3; 4 ← 2; 3 ← 1; 2 ← 1; 1 ← (0, outside)
    expect([...t.reachable(2)]).toEqual([0, 0, 1, 0, 1]); // 3 reaches 1
    const s = t.subset(new Uint8Array([1, 1, 0, 1, 1])); // drop 3
    expect(s.count).toBe(4);
    expect(s.parentsOf(0)).toEqual([1, sha(3)]); // 5 → 4, and 3 is now outside
    expect(s.parentsOf(2)).toEqual([3]); // 2 → 1
    expect(s.parentsOf(3)).toEqual([sha(0)]); // still outside
    expect(s.subject(0)).toBe('merge ✓');
    // Rewritten parents (history simplification): 5's parent becomes 1 directly.
    const r = t.subset(new Uint8Array([1, 0, 0, 0, 1]), new Map([[0, [4]]]));
    expect(r.parentsOf(0)).toEqual([1]);
  });
});
