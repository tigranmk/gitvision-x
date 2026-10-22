import { describe, expect, it } from 'vitest';
import { readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tempDir } from '../../../test/unit/helpers/gitRepo';
import { BlameDiskCache } from './blameDiskCache';
import type { ParsedBlame } from './blameParser';

const blame = (n: number): ParsedBlame => ({
  commits: [{ sha: 'a'.repeat(40), author: 'Ann', authorMail: 'a@x', authorTime: 1, summary: 's', boundary: false, uncommitted: false }],
  files: ['f.ts'],
  lineCommit: new Uint32Array(n),
  lineOrig: Uint32Array.from({ length: n }, (_, i) => i + 1),
  lineFile: new Uint32Array(n),
});

describe('BlameDiskCache', () => {
  it('round-trips and checks the key', async () => {
    const c = new BlameDiskCache(tempDir('gvx-dc-'));
    await c.write('/r', 'f.ts', 'b1', '', blame(3));
    expect(await c.read('/r', 'f.ts', 'b1', '')).toEqual(blame(3));
    expect(await c.read('/r', 'f.ts', 'b2', '')).toBeNull();
    expect(await c.read('/r', 'f.ts', 'b1', 'other-ignore')).toBeNull();
    expect(await c.read('/other', 'f.ts', 'b1', '')).toBeNull();
  });

  it('drops corrupt files instead of failing', async () => {
    const dir = tempDir('gvx-dc-');
    const c = new BlameDiskCache(dir);
    await c.write('/r', 'f.ts', 'b1', '', blame(3));
    const repoDir = path.join(dir, readdirSync(dir)[0]!);
    const file = path.join(repoDir, readdirSync(repoDir)[0]!);
    writeFileSync(file, 'garbage');
    expect(await c.read('/r', 'f.ts', 'b1', '')).toBeNull();
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it('prunes least recently used entries past the budget', async () => {
    const dir = tempDir('gvx-dc-');
    const c = new BlameDiskCache(dir);
    for (let i = 0; i < 4; i++) await c.write('/r', `f${i}.ts`, 'b', '', blame(1000));
    const repoDir = path.join(dir, readdirSync(dir)[0]!);
    const files = readdirSync(repoDir).map((f) => path.join(repoDir, f));
    files.forEach((f, i) => utimesSync(f, new Date(1000 * (i + 1)), new Date(1000 * (i + 1))));
    const size = statSync(files[0]!).size;
    await c.prune(size * 3, size * 2);
    expect(readdirSync(repoDir).sort()).toEqual(files.slice(2).map((f) => path.basename(f)).sort());
  });
});
