import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fwd, makeRepo, tempDir } from '../../../test/unit/helpers/gitRepo';
import { WorkerPool } from './pool';

const workerPath = path.resolve(__dirname, '../../../dist/worker.js');

describe('WorkerPool', () => {
  const repo = makeRepo();
  repo.commit('one', { 'a.txt': 'a\n' });
  const root = fwd(repo.dir);
  const storage = tempDir('gvx-storage-');
  const pool = new WorkerPool({ workerPath, gitPath: 'git', size: 2 });
  afterAll(() => {
    pool.dispose();
    repo.cleanup();
  });

  it('spawns workers lazily', () => {
    expect(pool.started).toBe(0);
  });

  it('runs engine methods in a worker and transfers blame columns', async () => {
    expect(await pool.request('repo.resolve', { path: repo.dir })).toMatchObject({ root, isShallow: false });
    const stats = await pool.request('index.sync', { root, storageDir: storage }, { affinity: root });
    expect(stats).toMatchObject({ commitCount: 1, mode: 'full' });
    const blame = await pool.request('blame.file', { root, path: 'a.txt' }, { affinity: root });
    expect(blame.lineCommit).toBeInstanceOf(Uint32Array);
    expect(blame.lineCommit).toHaveLength(1);
    expect(pool.started).toBeGreaterThanOrEqual(1);
  });

  it('routes the same affinity to the same worker (shared in-memory index)', async () => {
    for (let i = 0; i < 4; i++) {
      expect(await pool.request('index.stats', { root }, { affinity: root })).toMatchObject({ commitCount: 1 });
    }
  });

  it('runs blame on a different worker than index work for the same repo', async () => {
    const before = pool.started;
    await pool.request('index.stats', { root }, { affinity: root });
    await pool.request('blame.file', { root, path: 'a.txt' }, { affinity: root });
    expect(pool.started).toBe(2);
    expect(before).toBeLessThanOrEqual(2);
  });

  it('surfaces git errors with their message', async () => {
    await expect(pool.request('blame.file', { root, path: 'missing.txt' }, { affinity: root })).rejects.toMatchObject({ code: 'not-tracked' });
  });

  it('a disposed pool rejects requests', async () => {
    const p = new WorkerPool({ workerPath, gitPath: 'git', size: 1 });
    p.dispose();
    await expect(p.request('index.stats', { root })).rejects.toMatchObject({ code: 'disposed' });
  });
});
