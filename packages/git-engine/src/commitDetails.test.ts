import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { makeRepo, tempDir, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { commitDetails, parseRawNumstat } from './commitDetails';
import { Git } from './git';
import { pathToFileURL } from 'node:url';
import { readRefs } from './repo';
import { repoWrite } from './repoWrite';

const git = new Git('git');
let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe('commitDetails', () => {
  it('lists files with status and +/− counts, renames and binaries included', async () => {
    repo = makeRepo();
    const first = repo.commit('initial', { 'a.txt': 'one\ntwo\nthree\n', 'old/name.ts': 'export const x = 1;\nexport const y = 2;\n' });
    repo.git('rm', '-q', 'old/name.ts');
    repo.write('new/name.ts', 'export const x = 1;\nexport const y = 2;\n'); // same content: detected as a rename
    repo.write('a.txt', 'one\n2\nthree\nfour\n');
    repo.write('img.bin', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
    const sha = repo.commit('second\n\nBody line one.\nBody line two.');

    const d = await commitDetails(git, repo.dir, sha);
    expect(d.parents).toEqual([first]);
    expect(d.message).toBe('second\n\nBody line one.\nBody line two.');
    expect(d.author).toBe('Test User');
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'M', added: 2, removed: 1, binary: false });
    expect(byPath['new/name.ts']).toMatchObject({ status: 'R', oldPath: 'old/name.ts', added: 0, removed: 0 });
    expect(byPath['img.bin']).toMatchObject({ status: 'A', binary: true });
    expect(d.files).toHaveLength(3);

    const root = await commitDetails(git, repo.dir, first);
    expect(root.parents).toEqual([]);
    expect(root.files.map((f) => [f.path, f.status, f.added])).toEqual([
      ['a.txt', 'A', 3],
      ['old/name.ts', 'A', 2],
    ]);
  });

  it('diffs a merge against its first parent', async () => {
    repo = makeRepo();
    repo.commit('base', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('side work', { 'side.txt': 's\n' });
    repo.git('checkout', '-q', 'main');
    repo.commit('main work', { 'main.txt': 'm\n' });
    repo.git('merge', '-q', '--no-edit', 'side');
    const d = await commitDetails(git, repo.dir, repo.git('rev-parse', 'HEAD').trim());
    expect(d.parents).toHaveLength(2);
    expect(d.files.map((f) => f.path)).toEqual(['side.txt']);
  });

  it('parses rename records whose numstat paths come as separate tokens', () => {
    const out = ':100644 100644 aaa bbb R090\0a/old.ts\0b/new.ts\0:100644 100644 ccc ddd M\0x.ts\0' + '3\t1\t\0a/old.ts\0b/new.ts\0' + '5\t0\tx.ts\0';
    expect(parseRawNumstat(out)).toEqual([
      { status: 'R', oldPath: 'a/old.ts', path: 'b/new.ts', added: 3, removed: 1, binary: false },
      { status: 'M', path: 'x.ts', added: 5, removed: 0, binary: false },
    ]);
  });
});

describe('readRefs', () => {
  it('names branches, remotes and peeled tags; skips symbolic refs; reports a detached HEAD', async () => {
    repo = makeRepo();
    const c1 = repo.commit('one');
    const c2 = repo.commit('two');
    repo.git('branch', 'feature', c1);
    repo.git('tag', '-a', '-m', 'release', 'v1.0', c1);
    repo.git('tag', 'light', c2);
    repo.git('update-ref', 'refs/remotes/origin/main', c2);
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

    const r = await readRefs(git, repo.dir);
    expect(r.head).toEqual({ sha: c2, branch: 'main' });
    expect(r.refs).toEqual(
      expect.arrayContaining([
        { name: 'main', kind: 'branch', sha: c2 },
        { name: 'feature', kind: 'branch', sha: c1 },
        { name: 'origin/main', kind: 'remote', sha: c2 },
        { name: 'v1.0', kind: 'tag', sha: c1 },
        { name: 'light', kind: 'tag', sha: c2 },
      ]),
    );
    expect(r.refs).toHaveLength(5);

    repo.git('checkout', '-q', '--detach', c1);
    expect((await readRefs(git, repo.dir)).head).toEqual({ sha: c1, branch: null });
  });
});

describe('readRefs: worktrees and shallow clones', () => {
  it('lists every worktree HEAD (branch or detached) and marks the current one', async () => {
    repo = makeRepo();
    const a = repo.commit('a');
    repo.commit('b');
    const wtBranch = `${repo.dir}-wt-feature`;
    const wtDetached = `${repo.dir}-wt-detached`;
    repo.git('worktree', 'add', '-q', '-b', 'feature', wtBranch);
    repo.git('worktree', 'add', '-q', '--detach', wtDetached, a);
    try {
      const r = await readRefs(git, repo.dir);
      expect(r.shallow).toBe(false);
      const byName = Object.fromEntries(r.worktrees.map((w) => [w.path.split('/').pop(), w]));
      expect(r.worktrees).toHaveLength(3);
      expect(byName[repo.dir.split('/').pop()!.split('\\').pop()!]).toMatchObject({ branch: 'main', current: true });
      expect(byName[wtBranch.split(/[\\/]/).pop()!]).toMatchObject({ branch: 'feature', current: false });
      expect(byName[wtDetached.split(/[\\/]/).pop()!]).toMatchObject({ branch: null, sha: a, current: false });
    } finally {
      repo.git('worktree', 'remove', '--force', wtBranch);
      repo.git('worktree', 'remove', '--force', wtDetached);
    }
  });

  it('flags a shallow clone, and deepen fetches more history', async () => {
    repo = makeRepo();
    for (let i = 0; i < 5; i++) repo.commit(`c${i}`);
    const dest = tempDir();
    try {
      repo.git('clone', '-q', '--depth=1', pathToFileURL(repo.dir).href, dest);
      expect((await readRefs(git, dest)).shallow).toBe(true);
      const count = () => execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim();
      expect(count()).toBe('1');
      await repoWrite(git, dest, { kind: 'deepen', by: 2 });
      expect(count()).toBe('3');
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
