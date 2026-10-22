import { describe, expect, it } from 'vitest';
import type { BlameCommit, BlameResult } from '@gvx/protocol';
import { aggregate, aggregateText, ageBucket, ghostText, lineBlame, relativeTime, sparklinePositions, truncate, UNKNOWN_LINE } from './format';

const NOW = 1_800_000_000;
const DAY = 86400;
const commit = (over: Partial<BlameCommit>): BlameCommit => ({
  sha: 'a'.repeat(40),
  author: 'Ann',
  authorMail: 'ann@x.io',
  authorTime: NOW - 3 * DAY,
  summary: 'Fix token refresh (#412)',
  boundary: false,
  uncommitted: false,
  ...over,
});

/** HEAD blob of 4 lines: Ann, Ann, Bob (moved from old.ts), Ann. */
const blame: BlameResult & { complete: boolean } = {
  complete: true,
  rev: 'HEAD',
  blobSha: 'b'.repeat(40),
  commits: [commit({}), commit({ sha: 'c'.repeat(40), author: 'Bob', authorMail: 'bob@x.io', authorTime: NOW - 400 * DAY, summary: 'x'.repeat(80) })],
  lineCommit: Uint32Array.from([0, 0, 1, 0]),
  lineOrig: Uint32Array.from([1, 2, 7, 4]),
  lineFile: Uint32Array.from([0, 0, 1, 0]),
  files: ['src/a.ts', 'src/old.ts'],
  source: 'git',
  cacheHit: false,
};

describe('relativeTime', () => {
  it('picks the largest whole unit', () => {
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(relativeTime(NOW - 10, NOW)).toBe('now');
    expect(relativeTime(NOW - 90, NOW)).toBe('2 minutes ago');
    expect(relativeTime(NOW - 2 * 365 * DAY, NOW)).toBe('2 years ago');
    expect(relativeTime(NOW - 8 * DAY, NOW)).toBe('1 week ago');
  });
});

describe('lineBlame + ghostText', () => {
  it('formats the spec example and says You for the current user', () => {
    expect(ghostText(lineBlame(blame, null, 0), null, NOW)).toBe('Ann, 3 days ago • Fix token refresh (#412)');
    expect(ghostText(lineBlame(blame, null, 0), 'ANN@x.io', NOW)).toBe('You, 3 days ago • Fix token refresh (#412)');
  });

  it('follows the remap and reports inserted lines as not committed', () => {
    const map = Int32Array.from([-1, 0, 1, 2, 3]); // a line inserted at the top
    expect(lineBlame(blame, map, 0)).toEqual({ kind: 'uncommitted' });
    expect(ghostText(lineBlame(blame, map, 0), null, NOW)).toBe('Not committed yet');
    expect(lineBlame(blame, map, 3)).toMatchObject({ kind: 'commit', headLine: 2, origLine: 7, origPath: 'src/old.ts' });
    expect(lineBlame(blame, null, 99)).toEqual({ kind: 'uncommitted' }); // past the blob's end
  });

  it('truncates long summaries', () => {
    expect(ghostText(lineBlame(blame, null, 2), null, NOW)).toMatch(/^Bob, 1 year ago • x{59}…$/);
    expect(truncate('short')).toBe('short');
  });
});

describe('partial (streaming) blame', () => {
  it('reports lines git has not reached as pending, not as uncommitted', () => {
    const partial = { ...blame, complete: false, lineCommit: Uint32Array.from([0, UNKNOWN_LINE, 1, 0]) };
    expect(lineBlame(partial, null, 1)).toEqual({ kind: 'pending' });
    expect(lineBlame(partial, null, 9)).toEqual({ kind: 'pending' }); // beyond what arrived
    expect(lineBlame(partial, null, 0).kind).toBe('commit');
    expect(lineBlame(partial, Int32Array.from([-1]), 0)).toEqual({ kind: 'uncommitted' }); // edited line
    expect(ghostText({ kind: 'pending' }, null, NOW)).toBe('');
  });
});

describe('aggregate', () => {
  it('summarises authors by line share and the change range', () => {
    const infos = [0, 1, 2, 3].map((l) => lineBlame(blame, null, l)).concat({ kind: 'uncommitted' });
    const a = aggregate(infos, 'ann@x.io');
    expect(a.authors).toEqual([
      { name: 'You', lines: 3 },
      { name: 'Bob', lines: 1 },
      { name: 'Not committed yet', lines: 1 },
    ]);
    expect(aggregateText(a, NOW)).toBe('5 lines: 3 authors · You 60%, Bob 20% · oldest 1 year ago · newest 3 days ago');
    expect(aggregateText(aggregate([lineBlame(blame, null, 0), lineBlame(blame, null, 1)], null), NOW)).toBe('2 lines: Ann · 3 days ago');
  });
});

describe('ageBucket', () => {
  it('buckets by age, uncommitted as newest', () => {
    expect(ageBucket({ kind: 'uncommitted' }, NOW)).toBe(0);
    expect(ageBucket(lineBlame(blame, null, 0), NOW)).toBe(0);
    expect(ageBucket(lineBlame(blame, null, 2), NOW)).toBe(4);
  });
});

describe('sparklinePositions', () => {
  it('places ticks on a time axis, oldest left, never overlapping', () => {
    const h = [NOW, NOW - DAY, NOW - DAY, NOW - 100 * DAY].map((authorTime) => ({ authorTime }));
    const p = sparklinePositions(h, 20);
    expect(p[0]).toBe(19);
    expect(p[3]).toBe(0);
    expect(new Set(p).size).toBe(4);
    expect(p[2]!).toBeLessThan(p[1]!);
    expect(sparklinePositions(Array.from({ length: 10 }, () => ({ authorTime: NOW })), 10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });
});
