import { describe, expect, it } from 'vitest';
import { EDGE_IN, EDGE_OUT, EDGE_PASS, ROW_BOUNDARY, ROW_MERGE, ROW_ROOT, ROW_TIP, edgeFrom, edgeKind, edgeTo } from '@gvx/protocol';
import { GraphLayout, type LayoutPage } from './graphLayout';
import type { LogRecord } from './logParser';
import { LogTable } from './logTable';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const rec = (n: number, parents: number[]): LogRecord => ({
  sha: sha(n),
  parents: parents.map(sha),
  author: 'A',
  email: 'a@x',
  time: 1000 + n,
  subject: `c${n}`,
});

/** Builds a table from [commit, parents] pairs given in topological order. */
function table(commits: [number, number[]][]): LogTable {
  const t = new LogTable();
  for (const [n, ps] of commits) t.append(rec(n, ps));
  return t.finalize();
}

const KIND = ['pass', 'in', 'out'] as const;
function rowEdges(p: LayoutPage, i: number): string[] {
  const out: string[] = [];
  for (let k = p.edgeStart[i]!; k < p.edgeStart[i + 1]!; k++) {
    const e = p.edges[k]!;
    out.push(`${KIND[edgeKind(e)]} ${edgeFrom(e)}→${edgeTo(e)}`);
  }
  return out;
}

/**
 * Checks the layout is drawable: the lanes leaving the bottom of each row are exactly the lanes
 * entering the top of the next one, and every lane opened towards a parent ends at that parent's node.
 */
function checkContinuity(t: LogTable, p: LayoutPage): void {
  let below = new Map<number, number>(); // lane → row it is heading to
  for (let i = 0; i < t.count; i++) {
    const r = p.start + i;
    const top = new Map<number, number>();
    const next = new Map<number, number>();
    for (let k = p.edgeStart[i]!; k < p.edgeStart[i + 1]!; k++) {
      const e = p.edges[k]!;
      const kind = edgeKind(e);
      if (kind === EDGE_PASS) {
        top.set(edgeFrom(e), below.get(edgeFrom(e))!);
        next.set(edgeTo(e), below.get(edgeFrom(e))!);
      } else if (kind === EDGE_IN) {
        top.set(edgeFrom(e), r);
        expect(edgeTo(e)).toBe(p.nodeLane[i]);
      } else {
        expect(edgeFrom(e)).toBe(p.nodeLane[i]);
      }
    }
    expect([...top.keys()].sort()).toEqual([...below.keys()].sort());
    for (const [lane, want] of below) expect(top.get(lane)).toBe(want);
    // OUT edges: one per in-table parent, each landing on a lane heading to that parent.
    const parents: number[] = [];
    for (let k = 0; k < t.parentCount(r); k++) if (t.parentRow(r, k) >= 0) parents.push(t.parentRow(r, k));
    const outs: number[] = [];
    for (let k = p.edgeStart[i]!; k < p.edgeStart[i + 1]!; k++) {
      const e = p.edges[k]!;
      if (edgeKind(e) !== EDGE_OUT) continue;
      outs.push(edgeTo(e));
      const want = parents[outs.length - 1]!;
      const existing = next.get(edgeTo(e));
      if (existing !== undefined) expect(existing).toBe(want);
      next.set(edgeTo(e), want);
    }
    expect(outs.length).toBe(parents.length);
    below = next;
  }
  expect(below.size).toBe(0);
}

describe('GraphLayout', () => {
  it('keeps a linear history in one lane', () => {
    const t = table([[3, [2]], [2, [1]], [1, []]]);
    const p = new GraphLayout(t).page(0, 3);
    expect([...p.nodeLane]).toEqual([0, 0, 0]);
    expect([0, 1, 2].map((i) => rowEdges(p, i))).toEqual([['out 0→0'], ['in 0→0', 'out 0→0'], ['in 0→0']]);
    expect([...p.flags]).toEqual([ROW_TIP, 0, ROW_ROOT]);
    expect(p.width).toBe(1);
  });

  it('opens a lane for a merge and joins it back where histories meet', () => {
    // 5 merges 4 and 3; 4 ← 2 ← 1 and 3 ← 1; 1's parent 0 is outside the table (shallow).
    const t = table([[5, [4, 3]], [4, [2]], [3, [1]], [2, [1]], [1, [0]]]);
    const p = new GraphLayout(t).page(0, 5);
    expect([...p.nodeLane]).toEqual([0, 0, 1, 0, 1]);
    expect([0, 1, 2, 3, 4].map((i) => rowEdges(p, i))).toEqual([
      ['out 0→0', 'out 0→1'],
      ['pass 1→1', 'in 0→0', 'out 0→0'],
      ['pass 0→0', 'in 1→1', 'out 1→1'],
      ['pass 1→1', 'in 0→0', 'out 0→1'], // 2's parent 1 already has lane 1: join it
      ['in 1→1'],
    ]);
    expect(p.flags[0]).toBe(ROW_TIP | ROW_MERGE);
    expect(p.flags[4]).toBe(ROW_BOUNDARY);
    expect(p.width).toBe(2);
    checkContinuity(t, p);
  });

  it('lays out octopus merges with one lane per parent', () => {
    const t = table([[9, [4, 3, 2, 1]], [4, [0]], [3, [0]], [2, [0]], [1, [0]], [0, []]]);
    const p = new GraphLayout(t).page(0, 6);
    expect(rowEdges(p, 0)).toEqual(['out 0→0', 'out 0→1', 'out 0→2', 'out 0→3']);
    expect([...p.nodeLane]).toEqual([0, 0, 1, 2, 3, 0]);
    expect(p.width).toBe(4);
    checkContinuity(t, p);
  });

  it('handles several tips and orphan roots', () => {
    // Two unrelated histories (gh-pages style), interleaved by topo order.
    const t = table([[6, [5]], [8, [7]], [5, []], [7, []]]);
    const p = new GraphLayout(t).page(0, 4);
    expect([...p.nodeLane]).toEqual([0, 1, 0, 1]);
    expect([...p.flags]).toEqual([ROW_TIP, ROW_TIP, ROW_ROOT, ROW_ROOT]);
    checkContinuity(t, p);
  });

  it('reuses freed lanes for later branches', () => {
    // 10 ← 9 ← 1 and 8 ← 7 ← 1, then 6 (a second tip) ← 1 after lane 1 has closed.
    const t = table([[10, [9]], [8, [7]], [9, [1]], [7, [1]], [6, [1]], [1, []]]);
    const p = new GraphLayout(t).page(0, 6);
    expect([...p.nodeLane]).toEqual([0, 1, 0, 1, 1, 0]);
    checkContinuity(t, p);
  });

  it('pages and lazy layout match a full layout', () => {
    const t = randomDag(3000, 7);
    const full = new GraphLayout(t).page(0, t.count);
    const lazy = new GraphLayout(t);
    lazy.layoutTo(10);
    expect(lazy.rows).toBe(11);
    const mid = lazy.page(1200, 300);
    expect(mid.start).toBe(1200);
    for (let i = 0; i < 300; i++) {
      expect(mid.nodeLane[i]).toBe(full.nodeLane[1200 + i]);
      expect(rowEdges(mid, i)).toEqual(rowEdges(full, 1200 + i));
    }
    expect(lazy.page(t.count - 5, 100).nodeLane.length).toBe(5);
    expect(lazy.page(t.count + 10, 5).nodeLane.length).toBe(0);
  });

  it('produces a continuous layout for random histories', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = randomDag(800, seed);
      checkContinuity(t, new GraphLayout(t).page(0, t.count));
    }
  });
});

/**
 * A random history in topological order: branches fork off, merge (sometimes octopus), and a few
 * orphan roots and external (shallow) parents appear.
 */
function randomDag(n: number, seed: number): LogTable {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Commit i (0 = newest) picks parents among older commits, i.e. higher numbers.
  const commits: [number, number[]][] = [];
  for (let i = 0; i < n; i++) {
    const ps: number[] = [];
    const left = n - 1 - i;
    if (left > 0 && rand() > 0.01) {
      ps.push(i + 1 + Math.floor(rand() * Math.min(left, 4)));
      const extra = rand() < 0.15 ? (rand() < 0.2 ? 3 : 1) : 0;
      for (let k = 0; k < extra && left > 1; k++) {
        const p = i + 1 + Math.floor(rand() * Math.min(left, 60));
        if (!ps.includes(p)) ps.push(p);
      }
    }
    if (rand() < 0.005) ps.push(n + 100 + i); // outside the table
    commits.push([i + 1, ps.map((p) => p + 1)]);
  }
  // Rows already in topological order: every parent has a higher index than its child.
  return table(commits);
}
