/**
 * One open repository: watches .git and keeps the engine's commit index in sync.
 * Watched: HEAD, index, MERGE_HEAD (worktree git dir), refs/** and packed-refs (common dir).
 * Changes are debounced 300 ms and trigger an incremental sync, never a full reload.
 */
import * as vscode from 'vscode';
import { isCancelled, type IndexStats, type RepoInfo } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import { debounce } from './debounce';

export const WATCH_DEBOUNCE_MS = 300;

export class RepoSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly scheduleSync = debounce(() => void this.sync(), WATCH_DEBOUNCE_MS);
  private readonly lifetime = new AbortController();
  private current: Promise<IndexStats | null> | null = null;
  private queued: Promise<IndexStats | null> | null = null;
  private queuedFull = false;
  private disposed = false;
  private readonly _onDidSync = new vscode.EventEmitter<IndexStats>();
  readonly onDidSync = this._onDidSync.event;
  lastStats: IndexStats | null = null;
  private markIndexed!: () => void;
  /** Resolves after the first successful sync: the engine then holds this repo's commit index. */
  readonly whenIndexed = new Promise<void>((r) => (this.markIndexed = r));

  constructor(
    readonly info: RepoInfo,
    private readonly pool: WorkerPool,
    private readonly storageDir: string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const watch = (base: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      w.onDidCreate(this.scheduleSync);
      w.onDidChange(this.scheduleSync);
      w.onDidDelete(this.scheduleSync);
      this.disposables.push(w);
    };
    watch(info.gitDir, '{HEAD,index,MERGE_HEAD}');
    watch(info.commonDir, 'packed-refs');
    watch(info.commonDir, 'refs/**');
    this.disposables.push(this._onDidSync);
  }

  get root(): string {
    return this.info.root;
  }

  /**
   * Syncs now, or right after the sync in flight. Triggers that arrive while one is queued
   * share it, so bursts of ref changes cost at most one extra sync.
   */
  sync(full = false): Promise<IndexStats | null> {
    this.scheduleSync.cancel();
    this.queuedFull ||= full;
    if (this.queued) return this.queued;
    const p: Promise<IndexStats | null> = (this.current ?? Promise.resolve(null)).then(() => {
      this.queued = null;
      this.current = p;
      const f = this.queuedFull;
      this.queuedFull = false;
      return this.runOnce(f);
    });
    void p.finally(() => {
      if (this.current === p) this.current = null;
    });
    this.queued = p;
    return p;
  }

  private async runOnce(full: boolean): Promise<IndexStats | null> {
    if (this.disposed) return null;
    try {
      const stats = await this.pool.request(
        'index.sync',
        { root: this.root, storageDir: this.storageDir, full },
        { affinity: this.root, signal: this.lifetime.signal },
      );
      this.lastStats = stats;
      this.markIndexed();
      this.log.info(`index ${stats.mode}: ${stats.commitCount} commits in ${stats.durationMs} ms (${this.root})`);
      this._onDidSync.fire(stats);
      return stats;
    } catch (e) {
      if (!isCancelled(e)) this.log.error(`index sync failed for ${this.root}: ${(e as Error).message}`);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.scheduleSync.cancel();
    this.lifetime.abort();
    for (const d of this.disposables) d.dispose();
  }
}
