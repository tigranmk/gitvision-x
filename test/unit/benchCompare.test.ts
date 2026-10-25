import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

describe('bench/compare.mjs as CI runs it', () => {
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['bench/compare.mjs', ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: err.stdout + err.stderr };
    }
  };
  it('reads the results file with no --baseline (the platform baseline), and fails only on a regression', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gvx-cmp-'));
    const file = path.join(dir, 'r.json');
    const base = path.join(dir, 'b.json');
    writeFileSync(file, JSON.stringify({ date: 'd', machine: { platform: 'nowhere' }, ...results(1, 10) }));
    expect(run(file).out).toMatch(/No baseline/); // the platform file for "nowhere" does not exist
    expect(run(file, '--update', '--baseline', base).code).toBe(0);
    expect(run(file, '--baseline', base).code).toBe(0);
    writeFileSync(file, JSON.stringify({ date: 'd', machine: { platform: 'nowhere' }, ...results(1, 13) }));
    expect(run(file, '--baseline', base).code).toBe(1);
    expect(run(file, '--report-only', '--baseline', base).code).toBe(0);
  });
});
