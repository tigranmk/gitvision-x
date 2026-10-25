import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo } from '../../../test/unit/helpers/gitRepo';
import { Git } from './git';
import { repoWrite, writeArgs } from './repoWrite';

const git = new Git('git');
let repo: TestRepo;
afterEach(() => repo?.cleanup());
const rejects = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe('repoWrite', () => {
  it('builds argv only from typed fields and keeps names out of option position', () => {
    expect(writeArgs({ kind: 'merge', branch: 'feature' })).toEqual(['merge', '--no-edit', '--end-of-options', 'feature']);
    expect(writeArgs({ kind: 'reset', sha: 'a'.repeat(40), mode: 'hard' })).toEqual(['reset', '--hard', 'a'.repeat(40)]);
    expect(writeArgs({ kind: 'cherryPick', sha: 'b'.repeat(40), mainline: 1 })).toEqual(['cherry-pick', '-m', '1', '--end-of-options', 'b'.repeat(40)]);
    expect(() => writeArgs({ kind: 'revert', sha: 'HEAD~1' })).toThrow(/full commit id/);
    expect(() => writeArgs({ kind: 'reset', sha: 'a'.repeat(40), mode: 'nuke' as 'hard' })).toThrow(/reset mode/);
  });

  it('creates branches and tags, checks out, cherry-picks, reverts and resets', async () => {
    repo = makeRepo();
    const a = repo.commit('a', { 'f.txt': '1\n' });
    const b = repo.commit('b', { 'g.txt': '1\n' });
    await repoWrite(git, repo.dir, { kind: 'branch', name: 'topic', sha: a });
    await repoWrite(git, repo.dir, { kind: 'tag', name: 'v1', sha: b, message: 'release' });
    expect(repo.git('rev-parse', 'topic').trim()).toBe(a);
    expect(repo.git('cat-file', '-t', 'v1').trim()).toBe('tag');

    await repoWrite(git, repo.dir, { kind: 'checkout', branch: 'topic' });
    expect(repo.git('branch', '--show-current').trim()).toBe('topic');
    await repoWrite(git, repo.dir, { kind: 'cherryPick', sha: b });
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('b');
    await repoWrite(git, repo.dir, { kind: 'revert', sha: repo.git('rev-parse', 'HEAD').trim() });
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('Revert "b"');
    await repoWrite(git, repo.dir, { kind: 'reset', sha: a, mode: 'hard' });
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(a);
    await repoWrite(git, repo.dir, { kind: 'checkoutDetached', sha: b });
    expect(repo.git('branch', '--show-current').trim()).toBe('');
  });

  it('merges and rebases branches', async () => {
    repo = makeRepo();
    repo.commit('base', { 'f.txt': '1\n' });
    repo.git('switch', '-q', '-c', 'side');
    repo.commit('side', { 's.txt': '1\n' });
    repo.git('switch', '-q', 'main');
    repo.commit('main', { 'm.txt': '1\n' });
    await repoWrite(git, repo.dir, { kind: 'rebase', upstream: 'main', branch: 'side' });
    expect(repo.git('log', '--format=%s', 'side').trim().split('\n')).toEqual(['side', 'main', 'base']);
    await repoWrite(git, repo.dir, { kind: 'checkout', branch: 'main' });
    await repoWrite(git, repo.dir, { kind: 'merge', branch: 'side' });
    expect(repo.git('rev-parse', 'main').trim()).toBe(repo.git('rev-parse', 'side').trim()); // fast-forward
  });

  it('rejects bad names before running anything, and reports conflicts', async () => {
    repo = makeRepo();
    const a = repo.commit('a', { 'f.txt': '1\n' });
    await rejects(repoWrite(git, repo.dir, { kind: 'branch', name: '--force', sha: a }), 'invalid');
    await rejects(repoWrite(git, repo.dir, { kind: 'branch', name: 'bad..name', sha: a }), 'invalid');
    await rejects(repoWrite(git, repo.dir, { kind: 'tag', name: 'has space', sha: a }), 'invalid');
    expect(repo.git('branch', '--list').trim()).toBe('* main');

    repo.git('switch', '-q', '-c', 'other');
    const theirs = repo.commit('theirs', { 'f.txt': 'theirs\n' });
    repo.git('switch', '-q', 'main');
    repo.commit('ours', { 'f.txt': 'ours\n' });
    await rejects(repoWrite(git, repo.dir, { kind: 'cherryPick', sha: theirs }), 'conflict');
    await rejects(repoWrite(git, repo.dir, { kind: 'checkout', branch: 'nope' }), 'git');
  });
});
