import { describe, expect, it } from 'vitest';
import type { FileRevision } from '@gvx/protocol';
import { BUCKET_ABOVE, buildTicks, tickOf, visibleLabels } from './ticks';

const DAY = 86400;
const rev = (i: number, time: number): FileRevision => ({ sha: i.toString(16).padStart(40, '0'), time, author: 'A', authorMail: 'a@x', subject: `r${i}`, path: 'f' });
/** n revisions, newest first, one per `step` seconds, ending at `end`. */
const history = (n: number, step: number, end = 1_700_000_000) => Array.from({ length: n }, (_, i) => rev(i, end - i * step));

describe('timeline ticks', () => {
  it('one tick per revision, oldest first, with month labels where the month changes', () => {
    const t = buildTicks(history(90, DAY), 'en-US');
    expect(t).toHaveLength(90);
    expect(t[0]!.index).toBe(89);
    expect(t.at(-1)!.index).toBe(0);
    const labels = t.filter((x) => x.label).map((x) => x.label);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThanOrEqual(4);
    expect(t[0]!.label).not.toBeNull();
  });

  it(`buckets by week above ${BUCKET_ABOVE} revisions; each bucket shows its newest revision`, () => {
    const revs = history(1000, DAY / 4); // 4 a day: 250 days ≈ 36 weeks
    const t = buildTicks(revs, 'en-US');
    expect(t.length).toBeGreaterThan(34);
    expect(t.length).toBeLessThan(40);
    // Buckets tile the history without gaps.
    expect(t[0]!.last).toBe(999);
    expect(t.at(-1)!.first).toBe(0);
    for (let i = 1; i < t.length; i++) expect(t[i]!.last).toBe(t[i - 1]!.first - 1);
    for (const x of t) expect(x.index).toBe(x.first);
    expect(tickOf(t, 500)).toBeGreaterThan(0);
    expect(tickOf(t, -1)).toBe(t.length);
  });

  it('labels years on long histories', () => {
    const t = buildTicks(history(400, 7 * DAY), 'en-US'); // ~7.7 years
    expect(t.filter((x) => x.label).every((x) => /^\d{4}$/.test(x.label!))).toBe(true);
  });
});

describe('visibleLabels', () => {
  it('skips labels that would collide and keeps clear of the Now label', () => {
    const t = buildTicks(history(500, DAY), 'en-US'); // ~17 month labels
    const wide = visibleLabels(t, 2000);
    const narrow = visibleLabels(t, 600);
    expect(narrow.length).toBeLessThan(wide.length);
    const xs = (idx: number[], w: number) => idx.map((i) => ((i + 0.5) / (t.length + 1)) * w);
    for (const [a, b] of xs(narrow, 600).map((x, i, all) => [x, all[i + 1]] as const).slice(0, -1)) expect(b! - a).toBeGreaterThanOrEqual(72);
    expect(Math.max(...xs(narrow, 600))).toBeLessThanOrEqual(600 - 54);
  });
});
