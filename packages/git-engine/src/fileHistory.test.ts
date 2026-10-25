import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { RevisionStore, changes, fileRevisions, mapLine } from './fileHistory';
import { Git } from './git';

const git = new Git('git');
let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe('changes / mapLine', () => {
  it('lists added lines and places removed runs after the line they followed', () => {
    const r = changes(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'e', 'f']);
    expect(r.added).toEqual([1, 3, 4]);
    expect(r.removed).toEqual([
      { after: 0, lines: ['b'] },
      { after: 2, lines: ['d'] },
    ]);
    expect(changes(['x', 'a'], ['a']).removed).toEqual([{ after: -1, lines: ['x'] }]);
    expect(changes([], ['a', 'b']).added).toEqual([0, 1]);
  });

  it('keeps the reader on the same code across revisions', () => {
    const from = ['import x', 'one', 'two', 'three', 'four'];
    const to = ['import x', 'import y', 'one', 'two', 'three', 'four'];
    expect(mapLine(from, to, 3)).toBe(4); // "three" moved down by one
    expect(mapLine(['a', 'CHANGED', 'c'], ['a', 'b', 'c'], 1)).toBe(1); // changed line: nearest unchanged above + 1
    expect(mapLine(['a'], [], 0)).toBe(0);
  });
});

describe('fileRevisions / RevisionStore', () => {
  it('follows renames, newest first, with each revision’s path', async () => {
    repo = makeRepo();
    repo.commit('add', { 'src/util.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' }, 'Ann <ann@x.io>');
    repo.git('mv', 'src/util.ts', 'src/helpers.ts');
    repo.commit('rename');
    repo.commit('edit', { 'src/helpers.ts': 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n' });
    const revs = await fileRevisions(git, repo.dir, 'src/helpers.ts');
    expect(revs.map((r) => [r.subject, r.path])).toEqual([
      ['edit', 'src/helpers.ts'],
      ['rename', 'src/helpers.ts'],
      ['add', 'src/util.ts'],
    ]);
    expect(revs[2]).toMatchObject({ author: 'Ann', authorMail: 'ann@x.io' });

    const store = new RevisionStore(git);
    const v = await store.view(repo.dir, revs[0]!, revs[1]!, { line: 2, sha: revs[2]!.sha, path: 'src/util.ts' });
    expect(v.text).toBe('export const a = 1;\nexport const b = 20;\nexport const c = 3;\n');
    expect(v.added).toEqual([1]);
    expect(v.removed).toEqual([{ after: 0, lines: ['export const b = 2;'] }]);
    expect(v.mappedLine).toBe(2);
    // From the working copy's text, with a line inserted at the top.
    const w = await store.view(repo.dir, revs[0]!, null, { line: 3, text: '// new\nexport const a = 1;\nexport const b = 20;\nexport const c = 3;\n' });
    expect(w.mappedLine).toBe(2);
    expect(w.added).toEqual([]);
  });

  it('treats a file missing from the comparison revision as all added, and flags binaries', async () => {
    repo = makeRepo();
    const a = repo.commit('one', { 'x.txt': 'x\n' });
    const b = repo.commit('two', { 'y.txt': 'y1\ny2\n', 'bin.dat': '\0\x01\x02' });
    const store = new RevisionStore(git);
    const v = await store.view(repo.dir, { sha: b, path: 'y.txt' }, { sha: a, path: 'y.txt' }, undefined);
    expect(v.added).toEqual([0, 1]);
    expect((await store.view(repo.dir, { sha: b, path: 'bin.dat' }, null, undefined)).binary).toBe(true);
    await expect(store.view(repo.dir, { sha: a, path: 'y.txt' }, null, undefined)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('fetches blobs lazily in a partial clone', async () => {
    repo = makeRepo();
    repo.git('config', 'uploadpack.allowFilter', 'true');
    repo.commit('one', { 'f.txt': 'v1\n' });
    repo.commit('two', { 'f.txt': 'v2\n' });
    const dest = path.join(repo.dir, '..', `${path.basename(repo.dir)}-partial`);
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${repo.dir}`, dest]);
    try {
      const revs = await fileRevisions(git, dest, 'f.txt');
      expect(revs).toHaveLength(2);
      const v = await new RevisionStore(git).view(dest, revs[1]!, null, undefined);
      expect(v.text).toBe('v1\n');
    } finally {
      execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', dest] : ['-rf', dest]);
    }
  });
});
