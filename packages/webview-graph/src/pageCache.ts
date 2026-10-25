/**
 * Viewport paging for the graph: fixed-size pages fetched around the visible rows, requests for
 * pages that scrolled out of reach cancelled, least recently used pages dropped.
 */
import { isCancelled, type GraphCommit, type GraphPage } from '@gvx/protocol';
import type { RowGraph } from './draw';

export const PAGE_ROWS = 200;
const MAX_PAGES = 64;
/** Pages fetched beyond the viewport on each side. */
const AHEAD = 1;

export type FetchPage = (start: number, count: number, signal: AbortSignal) => Promise<GraphPage>;

export interface RowView {
  commit: GraphCommit;
  graph: RowGraph;
}

export class PageCache {
  /** Widest lane count seen in any page. */
  width = 1;
  private readonly pages = new Map<number, GraphPage>();
  private readonly inflight = new Map<number, AbortController>();

  constructor(
    private total: number,
    private readonly fetch: FetchPage,
    private readonly onLoad: () => void,
    private readonly onError: (e: unknown) => void = () => {},
  ) {}

  /** Drops everything (history changed or another repo is shown). */
  reset(total: number): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.pages.clear();
    this.total = total;
    this.width = 1;
  }

  /** Makes sure rows [first, last] (and a page either side) are loaded or loading. */
  ensure(first: number, last: number): void {
    if (this.total === 0) return;
    const lo = Math.max(0, Math.floor(first / PAGE_ROWS) - AHEAD);
    const hi = Math.min(Math.floor((this.total - 1) / PAGE_ROWS), Math.floor(Math.max(first, last) / PAGE_ROWS) + AHEAD);
    for (const [p, c] of this.inflight) {
      if (p < lo || p > hi) {
        c.abort();
        this.inflight.delete(p);
      }
    }
    for (let p = lo; p <= hi; p++) {
      const page = this.pages.get(p);
      if (page) {
        // Refresh recency: Map iteration order is insertion order.
        this.pages.delete(p);
        this.pages.set(p, page);
      } else if (!this.inflight.has(p)) {
        this.load(p);
      }
    }
  }

  row(r: number): RowView | null {
    const page = this.pages.get(Math.floor(r / PAGE_ROWS));
    if (!page) return null;
    const i = r - page.start;
    const commit = page.commits[i];
    if (!commit) return null;
    return {
      commit,
      graph: { lane: page.nodeLane[i]!, flags: page.flags[i]!, edges: page.edges.subarray(page.edgeStart[i], page.edgeStart[i + 1]) },
    };
  }

  /** Row of a commit among the loaded pages (-1 if not loaded). */
  find(sha: string): number {
    for (const page of this.pages.values()) {
      const i = page.commits.findIndex((c) => c.sha === sha);
      if (i >= 0) return page.start + i;
    }
    return -1;
  }

  get loadedPages(): number {
    return this.pages.size;
  }

  private load(p: number): void {
    const controller = new AbortController();
    this.inflight.set(p, controller);
    this.fetch(p * PAGE_ROWS, PAGE_ROWS, controller.signal).then(
      (page) => {
        if (this.inflight.get(p) !== controller) return;
        this.inflight.delete(p);
        this.pages.set(p, page);
        if (page.width > this.width) this.width = page.width;
        while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
        this.onLoad();
      },
      (e) => {
        if (this.inflight.get(p) === controller) this.inflight.delete(p);
        if (!isCancelled(e)) this.onError(e);
      },
    );
  }
}
