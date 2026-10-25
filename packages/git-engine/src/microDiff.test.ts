import { afterEach, describe, expect, it } from 'vitest';
import type { MicroDiffRow } from '@gvx/protocol';
import { makeRepo, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { Git } from './git';
import { fileMicroDiff, microDiff } from './microDiff';

/** Compact row notation: `kind left|right` with line numbers. */
const show = (rows: MicroDiffRow[]) =>
  rows.map((r) => (r.kind === 'gap' ? '…' : `${r.kind} ${r.left ? `${r.left.line}:${r.left.text}` : '-'} | ${r.right ? `${r.right.line}:${r.right.text}` : '-'}`));
const lines = (n: number, f = (i: number) => `l${i + 1}`) => Array.from({ length: n }, (_, i) => f(i));

describe('microDiff', () => {
  it('pairs a changed line, keeps 3 lines of context and marks gaps', () => {
    const before = lines(20);
    const after = before.map((l, i) => (i === 9 ? 'changed' : l));
    expect(show(microDiff(before, after).rows)).toEqual([
      '…',
      'same 7:l7 | 7:l7',
      'same 8:l8 | 8:l8',
      'same 9:l9 | 9:l9',
      'mod 10:l10 | 10:changed',
      'same 11:l11 | 11:l11',
      'same 12:l12 | 12:l12',
      'same 13:l13 | 13:l13',
      '…',
    ]);
  });

  it('shows pure additions and deletions on one side only', () => {
    const r = microDiff(['a', 'b', 'c'], ['a', 'new', 'c', 'd']);
    expect(show(r.rows)).toEqual(['same 1:a | 1:a', 'mod 2:b | 2:new', 'same 3:c | 3:c', 'add - | 4:d']);
    expect(show(microDiff(['a', 'x', 'y', 'b'], ['a', 'b']).rows)).toEqual(['same 1:a | 1:a', 'del 2:x | -', 'del 3:y | -', 'same 4:b | 2:b']);
    expect(show(microDiff([], ['only']).rows)).toEqual(['add - | 1:only']);
  });

  it('stops at the row cap and says more changes follow', () => {
    const before = lines(200);
    const after = before.map((l, i) => (i % 10 === 0 ? `${l}!` : l));
    const r = microDiff(before, after, 40);
    expect(r.rows.filter((x) => x.kind !== 'gap')).toHaveLength(40);
    expect(r.truncated).toBe(true);
    expect(microDiff(before, after, 1000).truncated).toBe(false);
  });
});

describe('fileMicroDiff', () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());
  const git = new Git('git');

  it('diffs modified, added, deleted, renamed and binary files against the first parent', async () => {
    repo = makeRepo();
    const root = repo.commit('one', { 'a.txt': 'x\ny\nz\n', 'gone.txt': 'bye\n', 'mv/old.txt': 'same\ncontent\nhere\n', 'img.bin': '\0\x01' });
    expect(show((await fileMicroDiff(git, repo.dir, root, 'a.txt', undefined)).rows)).toEqual(['add - | 1:x', 'add - | 2:y', 'add - | 3:z']);

    repo.git('rm', '-q', 'gone.txt', 'mv/old.txt');
    repo.write('mv/new.txt', 'same\ncontent\nhere!\n');
    repo.write('img.bin', '\0\x02');
    const sha = repo.commit('two', { 'a.txt': 'x\nY\nz\n', 'added.txt': 'hi\n' });
    const d = (p: string, old?: string) => fileMicroDiff(git, repo.dir, sha, p, old);
    expect(show((await d('a.txt')).rows)).toEqual(['same 1:x | 1:x', 'mod 2:y | 2:Y', 'same 3:z | 3:z']);
    expect(show((await d('added.txt')).rows)).toEqual(['add - | 1:hi']);
    expect(show((await d('gone.txt')).rows)).toEqual(['del 1:bye | -']);
    expect(show((await d('mv/new.txt', 'mv/old.txt')).rows)).toEqual(['same 1:same | 1:same', 'same 2:content | 2:content', 'mod 3:here | 3:here!']);
    expect(await d('img.bin')).toMatchObject({ binary: true, rows: [] });
  });
});
