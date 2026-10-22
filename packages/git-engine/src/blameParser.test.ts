import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { makeRepo } from '../../../test/unit/helpers/gitRepo';
import { BlameStreamParser } from './blameParser';

describe('BlameStreamParser', () => {
  const repo = makeRepo();
  afterAll(() => repo.cleanup());
  repo.commit('first', { 'a.txt': 'one\ntwo\nthree\n' }, 'Ann <ann@x.io>');
  repo.commit('second ✓', { 'a.txt': 'one\nTWO\nthree\nfour\n' }, 'Bob <bob@x.io>');
  repo.write('a.txt', 'zero\none\nTWO\nthree\nfour\n'); // uncommitted first line
  const out = execFileSync('git', ['blame', '--incremental', '--porcelain', '-w', '-C', '--', 'a.txt'], { cwd: repo.dir });

  const parse = (chunks: Uint8Array[]) => {
    const p = new BlameStreamParser();
    chunks.forEach((c) => p.push(c));
    return p.end();
  };

  it('attributes every line', () => {
    const b = parse([out]);
    const who = Array.from(b.lineCommit, (i) => b.commits[i]!.author);
    expect(who).toEqual(['Not Committed Yet', 'Ann', 'Bob', 'Ann', 'Bob']);
    const bob = b.commits.find((c) => c.author === 'Bob')!;
    expect(bob).toMatchObject({ authorMail: 'bob@x.io', summary: 'second ✓', uncommitted: false });
    expect(bob.previous?.path).toBe('a.txt');
    expect(b.commits.find((c) => c.author === 'Not Committed Yet')!.uncommitted).toBe(true);
    expect(Array.from(b.lineOrig)).toEqual([1, 1, 2, 3, 4]);
    expect(b.files).toEqual(['a.txt']);
  });

  it('is independent of chunk boundaries', () => {
    const whole = parse([out]);
    for (let i = 1; i < out.length; i += 7) expect(parse([out.subarray(0, i), out.subarray(i)])).toEqual(whole);
  });
});
