import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fwd, makeRepo, tempDir, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { Git } from './git';
import { IndexStore, indexFile } from './indexStore';
import { resolveRepo } from './repo';

const git = new Git('git');
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(n = 5): { repo: TestRepo; storage: string; root: string } {
  const repo = makeRepo();
  for (let i = 0; i < n; i++) repo.commit(`c${i}`, { 'f.txt': `${i}\n` });
  const storage = tempDir('gvx-storage-');
  cleanups.push(repo.cleanup, () => rmSync(storage, { recursive: true, force: true }));
  return { repo, storage, root: fwd(repo.dir) };
}

describe('IndexStore', () => {
  it('full load, then unchanged, then cached from disk in a new store', async () => {
    const { storage, root } = setup();
    const a = new IndexStore(git);
    expect(await a.sync(root, storage)).toMatchObject({ mode: 'full', commitCount: 5, refsChanged: true });
    expect(existsSync(indexFile(storage, root))).toBe(true);
    expect(await a.sync(root, storage)).toMatchObject({ mode: 'unchanged', refsChanged: false });
    const b = new IndexStore(git);
    expect(await b.sync(root, storage)).toMatchObject({ mode: 'cached', commitCount: 5, refsChanged: false });
    expect(b.table(root)!.subject(0)).toBe('c4');
  });

  it('loads only new commits after a commit, a branch and a merge', async () => {
    const { repo, storage, root } = setup();
    const store = new IndexStore(git);
    await store.sync(root, storage);
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('feature work', { 'g.txt': 'x\n' });
    repo.git('checkout', '-q', 'main');
    repo.commit('main work', { 'f.txt': 'main\n' });
    repo.git('merge', '-q', '--no-edit', 'feature');
    const s = await store.sync(root, storage);
    expect(s).toMatchObject({ mode: 'incremental', commitCount: 8, refsChanged: true });
    const t = store.table(root)!;
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(t.sha(0)).toBe(head);
    expect(t.parentsOf(0)).toHaveLength(2);
    // Every row's parents resolve to rows (no dangling externals in a full-history repo).
    for (let r = 0; r < t.count; r++) for (const p of t.parentsOf(r)) expect(typeof p).toBe('number');
    // And the persisted file matches.
    expect(await new IndexStore(git).sync(root, storage)).toMatchObject({ mode: 'cached', commitCount: 8 });
  });

  it('drops rewritten commits and adds new ones incrementally', async () => {
    const { repo, storage, root } = setup();
    const store = new IndexStore(git);
    await store.sync(root, storage);
    repo.git('reset', '-q', '--hard', 'HEAD~2');
    const c = repo.commit('rewritten', { 'f.txt': 'r\n' });
    expect(await store.sync(root, storage)).toMatchObject({ mode: 'incremental', commitCount: 4 });
    const t = store.table(root)!;
    expect(t.sha(0)).toBe(c);
    expect(t.subject(1)).toBe('c2');
    expect(t.parentsOf(0)).toEqual([1]);
    expect(t.parentsOf(3)).toEqual([]);
  });

  it('drops the commits of a deleted unmerged branch', async () => {
    const { repo, storage, root } = setup();
    repo.git('checkout', '-q', '-b', 'topic');
    repo.commit('topic 1');
    repo.commit('topic 2');
    repo.git('checkout', '-q', 'main');
    const store = new IndexStore(git);
    expect(await store.sync(root, storage)).toMatchObject({ commitCount: 7 });
    repo.git('branch', '-D', 'topic');
    expect(await store.sync(root, storage)).toMatchObject({ mode: 'incremental', commitCount: 5 });
  });

  it('reloads fully when an old tip no longer exists', async () => {
    const { repo, storage, root } = setup();
    repo.git('checkout', '-q', '-b', 'topic');
    repo.commit('topic 1');
    repo.git('checkout', '-q', 'main');
    const store = new IndexStore(git);
    await store.sync(root, storage);
    repo.git('branch', '-D', 'topic');
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '-q', '--prune=now');
    expect(await store.sync(root, storage)).toMatchObject({ mode: 'full', commitCount: 5 });
  });

  it('stays incremental when a merged branch is deleted', async () => {
    const { repo, storage, root } = setup();
    repo.git('branch', 'old');
    const store = new IndexStore(git);
    await store.sync(root, storage);
    repo.git('branch', '-D', 'old');
    repo.commit('next');
    expect(await store.sync(root, storage)).toMatchObject({ mode: 'incremental', commitCount: 6 });
  });

  it('handles empty repos and peeled annotated tags', async () => {
    const { repo, storage, root } = setup(0);
    const store = new IndexStore(git);
    expect(await store.sync(root, storage)).toMatchObject({ commitCount: 0, tips: [] });
    const c = repo.commit('tagged');
    repo.git('tag', '-a', 'v1', '-m', 'release');
    const s = await store.sync(root, storage);
    expect(s.tips).toEqual([c]);
  });

  it('rebuilds when the index file is corrupt', async () => {
    const { storage, root } = setup();
    await new IndexStore(git).sync(root, storage);
    writeFileSync(indexFile(storage, root), 'garbage');
    expect(await new IndexStore(git).sync(root, storage)).toMatchObject({ mode: 'full', commitCount: 5 });
  });

  it('indexes shallow clones (the boundary commit has no parents)', async () => {
    const { root: src } = setup(6);
    const dst = tempDir('gvx-shallow-');
    cleanups.push(() => rmSync(dst, { recursive: true, force: true }));
    execFileSync('git', ['clone', '-q', '--depth=3', pathToFileURL(src).href, dst]);
    const storage = tempDir('gvx-storage-');
    const info = await resolveRepo(git, fwd(dst));
    expect(info?.isShallow).toBe(true);
    const store = new IndexStore(git);
    expect(await store.sync(info!.root, storage)).toMatchObject({ commitCount: 3 });
    expect(store.table(info!.root)!.parentsOf(2)).toEqual([]); // the cut is listed in .git/shallow
  });

  it('reports worktree git dirs separately from the common dir', async () => {
    const { repo } = setup(1);
    const wt = tempDir('gvx-wt-');
    cleanups.push(() => rmSync(wt, { recursive: true, force: true }));
    repo.git('worktree', 'add', '-q', '--detach', wt);
    const info = await resolveRepo(git, wt);
    expect(info!.root).toBe(fwd(wt));
    expect(info!.commonDir).toBe(`${fwd(repo.dir)}/.git`);
    expect(info!.gitDir).toContain('/.git/worktrees/');
  });
});
