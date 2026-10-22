import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fwd, makeRepo } from '../../../test/unit/helpers/gitRepo';
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
    expect(first).toMatchObject({ rev: 'HEAD', cacheHit: false });
    expect(first.lineCommit).toHaveLength(2);
    const second = await svc.blame(root, 'src/a.ts');
    expect(second.cacheHit).toBe(true);
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
    await expect(new BlameService(new Git('git')).blame(root, 'src/a.ts', 'HEAD', ctl.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
