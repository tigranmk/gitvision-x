import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fwd, makeRepo, tempDir } from '../../../test/unit/helpers/gitRepo';
import { BlameService } from './blame';
import { Git } from './git';

describe('BlameService', () => {
  const repo = makeRepo();
  afterAll(() => repo.cleanup());
  const root = fwd(repo.dir);
  repo.commit('add', { 'src/a.ts': 'const a = 1;\nconst b = 2;\n' }, 'Ann <ann@x.io>');
  const fmt = repo.commit('format', { 'src/a.ts': 'const a = 1;\nconst  b = 2;\n' }, 'Fmt Bot <bot@x.io>');

  it('blames HEAD and serves repeats from the cache', async () => {
    const svc = new BlameService(new Git('git'));
    const first = await svc.blame(root, 'src/a.ts');
    expect(first).toMatchObject({ rev: repo.git('rev-parse', 'HEAD').trim(), cacheHit: false, source: 'git' });
    expect(first.lineCommit).toHaveLength(2);
    const second = await svc.blame(root, 'src/a.ts');
    expect(second).toMatchObject({ cacheHit: true, source: 'memory' });
    expect(second.lineCommit).not.toBe(first.lineCommit); // copies: transfers must not detach the cache
  });

  it('ignores whitespace-only changes (-w)', async () => {
    const b = await new BlameService(new Git('git')).blame(root, 'src/a.ts');
    expect(b.commits[b.lineCommit[1]!]!.sha).not.toBe(fmt);
  });

  it('honours blame.ignoreRevsFile, re-blames when it changes, and explains a missing one', async () => {
    const svc = new BlameService(new Git('git'));
    await svc.blame(root, 'src/a.ts');
    writeFileSync(path.join(repo.dir, '.git-blame-ignore-revs'), `${fmt}\n`);
    repo.git('config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs');
    const ignored = await svc.blame(root, 'src/a.ts');
    expect(ignored.cacheHit).toBe(false); // the file's hash is part of the cache key
    expect(ignored.commits.some((c) => c.sha === fmt)).toBe(false);
    repo.git('config', 'blame.ignoreRevsFile', 'missing-file');
    await expect(svc.blame(root, 'src/a.ts')).rejects.toMatchObject({ code: 'ignore-revs-missing' });
    repo.git('config', '--unset', 'blame.ignoreRevsFile');
  });

  it('reports untracked files with a code', async () => {
    await expect(new BlameService(new Git('git')).blame(root, 'nope.ts')).rejects.toMatchObject({ code: 'not-tracked' });
  });

  it('aborts the git process when cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(new BlameService(new Git('git')).blame(root, 'src/a.ts', { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses binary files and blames >20k-line files only on demand', async () => {
    const svc = new BlameService(new Git('git'));
    writeFileSync(path.join(repo.dir, 'img.bin'), Buffer.from([1, 0, 2, 3]));
    repo.commit('binary', { 'big.txt': Array.from({ length: 20_001 }, (_, i) => `r${i}`).join('\n') + '\n' });
    await expect(svc.blame(root, 'img.bin')).rejects.toMatchObject({ code: 'binary' });
    await expect(svc.blame(root, 'big.txt')).rejects.toMatchObject({ code: 'too-large' });
    const forced = await svc.blame(root, 'big.txt', { force: true });
    expect(forced.lineCommit).toHaveLength(20_001);
  });

  it('remaps buffer lines onto the blamed blob', async () => {
    const svc = new BlameService(new Git('git'));
    const b = await svc.blame(root, 'src/a.ts');
    expect(await svc.remap(root, b.blobSha!, 'const a = 1;\nconst  b = 2;\n')).toBeNull();
    expect(await svc.remap(root, b.blobSha!, 'const a = 1;\r\nconst  b = 2;\r\n')).toBeNull(); // CRLF checkout
    const map = await svc.remap(root, b.blobSha!, '// header\nconst a = 1;\nconst  b = 2;\n');
    expect(Array.from(map!)).toEqual([-1, 0, 1]);
  });

  it('lists the commits that touched a line, newest first, across renames', async () => {
    const svc = new BlameService(new Git('git'));
    repo.git('mv', 'src/a.ts', 'src/renamed.ts');
    repo.commit('rename');
    const c3 = repo.commit('edit after rename', { 'src/renamed.ts': 'const a = 1;\nconst b = 3;\n' });
    const h = await svc.lineHistory(root, 'src/renamed.ts', 2);
    expect(h).toHaveLength(3);
    expect(h.slice(0, 2).map((e) => e.sha)).toEqual([c3, fmt]);
    expect(h[0]).toMatchObject({ summary: 'edit after rename', author: 'Test User' });
    expect(h.at(-1)!.summary).toBe('add');
    expect(await svc.lineHistory(root, 'src/renamed.ts', 2, 'HEAD', 1)).toHaveLength(1);
  });

  it('answers a repeat request without starting git', async () => {
    const counting = new CountingGit('git');
    const svc = new BlameService(counting);
    await svc.blame(root, 'src/renamed.ts');
    counting.calls = 0;
    const again = await svc.blame(root, 'src/renamed.ts');
    expect(again.source).toBe('memory');
    expect(counting.calls).toBe(0);
  });

  it('streams entries as progress before the final result', async () => {
    const svc = new BlameService(new Git('git'));
    repo.commit('many lines', { 'many.txt': Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n' });
    for (let k = 0; k < 5; k++) {
      const lines = Array.from({ length: 300 }, (_, i) => (i % 5 === k ? `line ${i} v${k}` : `line ${i}`));
      repo.commit(`edit ${k}`, { 'many.txt': lines.join('\n') + '\n' });
    }
    const covered = new Set<number>();
    const commitsSeen: string[] = [];
    let blobSha: string | null = null;
    const b = await svc.blame(root, 'many.txt', {
      onProgress: (p) => {
        blobSha = p.blobSha;
        commitsSeen.push(...p.commits.map((c) => c.sha));
        for (let i = 0; i < p.ranges.length; i += 5) {
          const [final0, count, commit] = [p.ranges[i]!, p.ranges[i + 1]!, p.ranges[i + 2]!];
          expect(commit).toBeLessThan(commitsSeen.length); // never references a commit not yet sent
          for (let l = final0; l < final0 + count; l++) covered.add(l);
        }
      },
    });
    expect(covered.size).toBe(b.lineCommit.length);
    expect(blobSha).toBe(b.blobSha);
    expect(commitsSeen).toEqual(b.commits.map((c) => c.sha));
    expect(b.commits.every((c) => c.author && c.summary)).toBe(true);
  });

  it('persists blame on disk and serves it to a new session', async () => {
    const storageDir = tempDir('gvx-blame-store-');
    const first = await new BlameService(new Git('git')).blame(root, 'many.txt', { storageDir });
    expect(first.source).toBe('git');
    await new Promise((r) => setTimeout(r, 100)); // the write is fire-and-forget
    const counting = new CountingGit('git');
    const svc = new BlameService(counting);
    await svc.warm(root); // done at repo open in the extension
    counting.calls = 0;
    const second = await svc.blame(root, 'many.txt', { storageDir });
    expect(second.source).toBe('disk');
    expect(counting.calls).toBe(0); // HEAD from files, blob from the stored alias: no git process
    expect(Array.from(second.lineCommit)).toEqual(Array.from(first.lineCommit));
    expect(second.commits).toEqual(first.commits);
    const third = await new BlameService(new Git('git')).blame(root, 'many.txt', { storageDir, noDiskCache: true });
    expect(third.source).toBe('git');
  });
});

class CountingGit extends Git {
  calls = 0;
  override stream(...args: Parameters<Git['stream']>): ReturnType<Git['stream']> {
    this.calls++;
    return super.stream(...args);
  }
}
