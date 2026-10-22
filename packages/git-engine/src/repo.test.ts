import { afterAll, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fwd, makeRepo, tempDir } from '../../../test/unit/helpers/gitRepo';
import { commitGraphStatus, writeCommitGraph } from './commitGraph';
import { Git } from './git';
import { readHeadSha, resolveRepo } from './repo';

describe('readHeadSha', () => {
  const repo = makeRepo();
  afterAll(() => repo.cleanup());
  const c1 = repo.commit('one');
  const c2 = repo.commit('two');
  const git = new Git('git');

  it('matches git for loose refs, packed refs, detached HEAD and worktrees', async () => {
    const info = (await resolveRepo(git, fwd(repo.dir)))!;
    expect(await readHeadSha(info.gitDir, info.commonDir)).toBe(c2);
    repo.git('pack-refs', '--all');
    expect(await readHeadSha(info.gitDir, info.commonDir)).toBe(c2);
    repo.git('checkout', '-q', '--detach', c1);
    expect(await readHeadSha(info.gitDir, info.commonDir)).toBe(c1);
    repo.git('checkout', '-q', 'main');
    const wt = tempDir('gvx-wt-');
    repo.git('worktree', 'add', '-q', '-b', 'side', wt, c1);
    const wtInfo = (await resolveRepo(git, wt))!;
    expect(await readHeadSha(wtInfo.gitDir, wtInfo.commonDir)).toBe(c1);
  });

  it('returns null for an unborn branch (caller falls back to git)', async () => {
    const empty = makeRepo();
    const info = (await resolveRepo(git, fwd(empty.dir)))!;
    expect(await readHeadSha(info.gitDir, info.commonDir)).toBeNull();
    empty.cleanup();
  });

  it('detects commit-graph and Bloom filters, and writes them', async () => {
    const info = (await resolveRepo(git, fwd(repo.dir)))!;
    repo.git('config', 'gc.writeCommitGraph', 'false');
    expect(await commitGraphStatus(info.commonDir)).toEqual({ graph: false, bloom: false });
    repo.git('commit-graph', 'write', '--reachable');
    expect(await commitGraphStatus(info.commonDir)).toEqual({ graph: true, bloom: false });
    await writeCommitGraph(git, info.root);
    expect(await commitGraphStatus(info.commonDir)).toEqual({ graph: true, bloom: true });
    const graphFile = path.join(info.commonDir, 'objects', 'info', 'commit-graph');
    rmSync(graphFile, { force: true }); // git writes it read-only
    writeFileSync(graphFile, 'junk');
    expect(await commitGraphStatus(info.commonDir)).toEqual({ graph: false, bloom: false });
  });
});
