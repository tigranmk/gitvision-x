import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { classify, conflictState, explainConflict } from './conflicts';
import { Git } from './git';
import { repoWrite } from './repoWrite';

const git = new Git('git');
let repo: TestRepo;
afterEach(() => repo?.cleanup());
const ten = (tag: string, change: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => change[i] ?? `${tag} ${i}`).join('\n') + '\n';
const tryGit = (...args: string[]) => {
  try {
    repo.git(...args);
  } catch {
    /* expected to stop with conflicts */
  }
};

/** base → ours (main) and theirs (side), each applying `files`; returns to main. */
function fork(base: Record<string, string>, ours: Record<string, string | null>, theirs: Record<string, string | null>) {
  repo = makeRepo();
  repo.commit('base', base, 'Base <base@x.io>');
  const apply = (files: Record<string, string | null>, msg: string, who: string) => {
    for (const [f, c] of Object.entries(files)) {
      if (c === null) repo.git('rm', '-q', f);
      else repo.write(f, c);
    }
    return repo.commit(msg, {}, who);
  };
  repo.git('checkout', '-q', '-b', 'side');
  const t = apply(theirs, 'theirs change', 'Tess <tess@x.io>');
  repo.git('checkout', '-q', 'main');
  const o = apply(ours, 'ours change', 'Otto <otto@x.io>');
  return { ours: o, theirs: t };
}

describe('conflictState', () => {
  it('reports a stopped merge: sides, base, labels and a content conflict', async () => {
    const { ours, theirs } = fork({ 'f.txt': ten('l') }, { 'f.txt': ten('l', { 4: 'ours' }) }, { 'f.txt': ten('l', { 4: 'theirs' }) });
    expect((await conflictState(git, repo.dir)).op).toBeNull();
    tryGit('merge', '--no-edit', 'side');
    const s = await conflictState(git, repo.dir);
    expect(s).toMatchObject({ op: 'merge', ours, theirs, oursLabel: 'main', theirsLabel: 'side', rebase: null });
    expect(s.base).toBe(repo.git('merge-base', ours, theirs).trim());
    expect(s.files).toEqual([{ path: 'f.txt', kind: 'content' }]);

    // Explain: each side's commit that touched the hunk.
    expect((await explainConflict(git, repo.dir, 'f.txt', 'ours', ['ours'])).map((c) => [c.subject, c.author])).toEqual([['ours change', 'Otto']]);
    expect((await explainConflict(git, repo.dir, 'f.txt', 'theirs', ['theirs'])).map((c) => c.subject)).toEqual(['theirs change']);

    // Take a side, then finish the merge without an editor.
    await repoWrite(git, repo.dir, { kind: 'takeSide', path: 'f.txt', side: 'theirs' });
    await repoWrite(git, repo.dir, { kind: 'continue', op: 'merge' });
    expect(repo.git('log', '-1', '--format=%P').trim().split(' ')).toEqual([ours, theirs]);
    expect(repo.git('show', 'HEAD:f.txt')).toBe(ten('l', { 4: 'theirs' }));
    expect((await conflictState(git, repo.dir)).op).toBeNull();
  });

  it('reports rebase progress and the commit being replayed; abort restores the branch', async () => {
    const { ours } = fork({ 'f.txt': ten('l') }, { 'f.txt': ten('l', { 1: 'ours' }) }, { 'f.txt': ten('l', { 1: 'theirs' }) });
    repo.git('checkout', '-q', 'side');
    repo.commit('second on side', { 'g.txt': 'g\n' });
    const before = repo.git('rev-parse', 'side').trim();
    tryGit('rebase', 'main');
    const s = await conflictState(git, repo.dir);
    expect(s).toMatchObject({ op: 'rebase', ours, rebase: { step: 1, total: 2 } });
    expect(s.theirs).toBe(repo.git('rev-parse', 'side~1').trim());
    expect(s.oursLabel).toBe('main');
    await repoWrite(git, repo.dir, { kind: 'abort', op: 'rebase' });
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(before);
  });

  it('classifies delete/modify, binary and rename/rename', async () => {
    fork({ 'dm.txt': ten('d'), 'b.bin': '\0base', 'rr.txt': ten('r') }, { 'dm.txt': ten('d', { 1: 'edit' }), 'b.bin': '\0ours' }, { 'dm.txt': null, 'b.bin': '\0theirs' });
    // Rename/rename needs git mv on each side: do it by hand on top of the fork.
    repo.git('checkout', '-q', 'side');
    repo.git('mv', 'rr.txt', 'rr-theirs.txt');
    repo.commit('rename theirs');
    repo.git('checkout', '-q', 'main');
    repo.git('mv', 'rr.txt', 'rr-ours.txt');
    repo.commit('rename ours');
    tryGit('merge', '--no-edit', 'side');
    const s = await conflictState(git, repo.dir);
    const kinds = Object.fromEntries(s.files.map((f) => [f.path, f.kind]));
    expect(kinds).toEqual({ 'b.bin': 'binary', 'dm.txt': 'deleted-by-them', 'rr.txt': 'both-deleted', 'rr-ours.txt': 'added-by-us', 'rr-theirs.txt': 'added-by-them' });
    expect(s.files.find((f) => f.path === 'rr.txt')!.rename).toEqual({ from: 'rr.txt', ours: 'rr-ours.txt', theirs: 'rr-theirs.txt' });

    await repoWrite(git, repo.dir, { kind: 'takeSide', path: 'b.bin', side: 'ours' });
    await repoWrite(git, repo.dir, { kind: 'deleteFile', path: 'dm.txt' });
    expect((await conflictState(git, repo.dir)).files.map((f) => f.path)).toEqual(['rr-ours.txt', 'rr-theirs.txt', 'rr.txt']);
  });

  it('parses ls-files -u stages, paths with tabs and spaces included', () => {
    const out = ['100644 aaa 1\tsp ace.txt', '100644 bbb 2\tsp ace.txt', '100644 ccc 3\tsp ace.txt', '100644 ddd 1\ttab\there', '100644 eee 2\ttab\there', ''].join('\0');
    expect(classify(out)).toEqual([
      { path: 'sp ace.txt', kind: 'content' },
      { path: 'tab\there', kind: 'deleted-by-them' },
    ]);
  });
});
