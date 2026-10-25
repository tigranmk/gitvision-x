import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { Git } from './git';
import { ViewStore, searchTable } from './graphViews';
import { IndexStore } from './indexStore';

const git = new Git('git');
let repo: TestRepo;
afterEach(() => repo?.cleanup());

/** main: a → b → m(merge of side) → d; side: s1 → s2 off b; other: o1 off a (not merged). */
async function setup() {
  repo = makeRepo();
  repo.commit('a', { 'f.txt': '1\n' }, 'Ann <ann@x.io>');
  repo.git('branch', 'other');
  repo.commit('b', { 'g.txt': '1\n' });
  repo.git('checkout', '-q', '-b', 'side');
  repo.commit('s1', { 'f.txt': '2\n' }, 'Sid <sid@x.io>');
  repo.commit('s2', { 'h.txt': '1\n' });
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', '--no-edit', 'side');
  repo.commit('d', { 'f.txt': '3\n' });
  repo.git('checkout', '-q', 'other');
  repo.commit('o1', { 'f.txt': 'other\n' });
  repo.git('checkout', '-q', 'main');
  const index = new IndexStore(git);
  await index.sync(repo.dir, repo.dir + '/.git/gvx-test');
  return index.table(repo.dir)!;
}

const subjects = (t: { count: number; subject(r: number): string }) => Array.from({ length: t.count }, (_, r) => t.subject(r));

describe('ViewStore', () => {
  it('all = the index; branch = commits reachable from HEAD; file = commits touching it with parents rewritten', async () => {
    const base = await setup();
    const store = new ViewStore(git);
    expect((await store.get(repo.dir, base, { kind: 'all' })).table).toBe(base);

    const branch = (await store.get(repo.dir, base, { kind: 'branch' })).table;
    expect(subjects(branch).sort()).toEqual(['Merge branch \'side\'', 'a', 'b', 'd', 's1', 's2'].sort());

    const file = await store.get(repo.dir, base, { kind: 'file', path: 'f.txt' });
    expect(subjects(file.table).sort()).toEqual(['a', 'd', 'o1', 's1'].sort());
    // d's history simplifies to s1 (b and the merge did not change f.txt), s1's to a.
    const row = (s: string) => subjects(file.table).indexOf(s);
    expect(file.table.parentsOf(row('d'))).toEqual([row('s1')]);
    expect(file.table.parentsOf(row('s1'))).toEqual([row('a')]);
    expect(file.layout.rows).toBe(file.table.count); // laid out eagerly
  });

  it('rebuilds the branch view when HEAD moves without changing the index', async () => {
    const base = await setup();
    const store = new ViewStore(git);
    expect((await store.get(repo.dir, base, { kind: 'branch' })).table.count).toBe(6);
    repo.git('checkout', '-q', 'other');
    expect(subjects((await store.get(repo.dir, base, { kind: 'branch' })).table).sort()).toEqual(['a', 'o1']);
  });

  it('searches subject, author name/email and SHA prefixes, case-insensitively', async () => {
    const base = await setup();
    const rows = (q: string) => searchTable(base, q, 100).rows.map((r) => base.subject(r));
    expect(rows('S1')).toEqual(['s1']);
    expect(rows('sid@')).toEqual(['s1']);
    expect(rows('ann')).toEqual(['a']);
    const sha = repo.git('rev-parse', 'HEAD').trim();
    expect(rows(sha.slice(0, 6))).toEqual(['d']);
    expect(searchTable(base, 'a', 2)).toMatchObject({ capped: true });
    expect(rows('  ')).toEqual([]);
  });
});
