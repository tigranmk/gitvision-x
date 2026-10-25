import { describe, expect, it } from 'vitest';
import { CancelledError, type GraphPage } from '@gvx/protocol';
import { PAGE_ROWS, PageCache } from './pageCache';

function fakePage(start: number, count: number, width = 3): GraphPage {
  return {
    start,
    total: 10_000,
    width,
    commits: Array.from({ length: count }, (_, i) => ({ sha: `sha${start + i}`, subject: `c${start + i}`, author: 'A', authorMail: 'a@x', time: 0 })),
    nodeLane: new Uint16Array(count),
    flags: new Uint8Array(count),
    edgeStart: new Uint32Array(count + 1),
    edges: new Uint32Array(0),
  };
}

/** A fetch whose requests resolve when the test says so. */
function controlledFetch() {
  const calls: { start: number; signal: AbortSignal; resolve: () => void }[] = [];
  const fetch = (start: number, count: number, signal: AbortSignal) =>
    new Promise<GraphPage>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new CancelledError()));
      calls.push({ start, signal, resolve: () => resolve(fakePage(start, count)) });
    });
  return { calls, fetch };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PageCache', () => {
  it('loads the visible pages plus one either side, once', async () => {
    const { calls, fetch } = controlledFetch();
    let loads = 0;
    const cache = new PageCache(10_000, fetch, () => loads++);
    cache.ensure(450, 480); // page 2 visible → pages 1..3
    cache.ensure(450, 480);
    expect(calls.map((c) => c.start)).toEqual([200, 400, 600]);
    calls.forEach((c) => c.resolve());
    await flush();
    expect(loads).toBe(3);
    expect(cache.row(450)?.commit.sha).toBe('sha450');
    expect(cache.row(0)).toBeNull();
    expect(cache.width).toBe(3);
    expect(cache.find('sha601')).toBe(601);
  });

  it('cancels requests for pages that scrolled out of reach', async () => {
    const { calls, fetch } = controlledFetch();
    const errors: unknown[] = [];
    const cache = new PageCache(10_000, fetch, () => {}, (e) => errors.push(e));
    cache.ensure(0, 30);
    cache.ensure(5000, 5030);
    expect(calls.filter((c) => c.signal.aborted).map((c) => c.start)).toEqual([0, 200]);
    await flush();
    expect(errors).toEqual([]); // cancellations are not errors
  });

  it('keeps at most 64 pages, dropping the least recently used', async () => {
    const { calls, fetch } = controlledFetch();
    const cache = new PageCache(100_000, fetch, () => {});
    for (let p = 0; p < 80; p++) {
      cache.ensure(p * PAGE_ROWS, p * PAGE_ROWS);
      calls.forEach((c) => c.resolve());
      calls.length = 0;
      await flush();
    }
    expect(cache.loadedPages).toBe(64);
    expect(cache.row(0)).toBeNull();
    expect(cache.row(79 * PAGE_ROWS)).not.toBeNull();
  });

  it('reset drops pages and ignores answers to requests made before it', async () => {
    const { calls, fetch } = controlledFetch();
    const cache = new PageCache(10_000, fetch, () => {});
    cache.ensure(0, 10);
    const before = calls.slice();
    cache.reset(5);
    expect(before.every((c) => c.signal.aborted)).toBe(true);
    before.forEach((c) => c.resolve());
    await flush();
    expect(cache.loadedPages).toBe(0);
    cache.ensure(0, 10);
    expect(calls.at(-1)!.start).toBe(0);
  });
});
