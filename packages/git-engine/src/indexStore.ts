/**
 * Persistent commit index per repo: an in-memory LogTable plus a file in globalStorage.
 * Refs changes load only `git log <newTips> ^<oldTips>`; a full reload happens only when
 * history was rewritten (an old tip is no longer reachable) or the index is missing.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { IndexStats, SyncMode, SyncProgress } from '@gvx/protocol';
import { GitError, type Git } from './git';
import { LOG_FORMAT, LogStreamParser } from './logParser';
import { LogTable } from './logTable';
import { readTips, resolveRepo } from './repo';

export const PAGE_SIZE = 2000;

interface RepoIndex {
  root: string;
  table: LogTable;
  tips: string[];
  stats: IndexStats;
}

interface IndexMeta {
  root: string;
  tips: string[];
}

export class IndexStore {
  private readonly repos = new Map<string, RepoIndex>();
  /** One sync at a time per repo; later callers wait for the running one, then run their own. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly git: Git) {}

  table(root: string): LogTable | undefined {
    return this.repos.get(root)?.table;
  }

  stats(root: string): IndexStats | null {
    return this.repos.get(root)?.stats ?? null;
  }

  sync(
    root: string,
    storageDir: string,
    opts: { full?: boolean; signal?: AbortSignal; onProgress?: (p: SyncProgress) => void } = {},
  ): Promise<IndexStats> {
    const prev = this.locks.get(root) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.doSync(root, storageDir, opts));
    this.locks.set(root, run);
    void run.finally(() => {
      if (this.locks.get(root) === run) this.locks.delete(root);
    }).catch(() => {});
    return run;
  }

  private async doSync(
    root: string,
    storageDir: string,
    opts: { full?: boolean; signal?: AbortSignal; onProgress?: (p: SyncProgress) => void },
  ): Promise<IndexStats> {
    const started = performance.now();
    const { signal, onProgress } = opts;
    const file = indexFile(storageDir, root);
    const tips = await readTips(this.git, root, signal);

    let current = this.repos.get(root);
    let loadedFromDisk = false;
    if (!current && !opts.full) {
      const disk = await loadIndexFile(file, root);
      if (disk) {
        current = { root, table: disk.table, tips: disk.tips, stats: undefined as unknown as IndexStats };
        loadedFromDisk = true;
      }
    }

    let table: LogTable;
    let mode: SyncMode;
    if (current && !opts.full && sameTips(current.tips, tips)) {
      table = current.table;
      mode = loadedFromDisk ? 'cached' : 'unchanged';
    } else {
      const dropped = current && !opts.full ? await this.unreachable(root, current.tips, tips, signal) : null;
      if (current && dropped) {
        const head = await this.load(root, tips, current.tips, signal, onProgress);
        const kept = dropped.size ? current.table.without(dropped) : current.table;
        table = head.count ? LogTable.concat(head, kept) : kept;
        mode = 'incremental';
      } else {
        table = await this.load(root, tips, [], signal, onProgress);
        mode = 'full';
      }
    }

    const refsChanged = !current || !sameTips(current.tips, tips);
    const stats: IndexStats = {
      root,
      commitCount: table.count,
      mode,
      durationMs: Math.round(performance.now() - started),
      tips,
      refsChanged: refsChanged && !(mode === 'cached'),
    };
    this.repos.set(root, { root, table, tips, stats });
    if (mode !== 'unchanged' && mode !== 'cached') {
      await saveIndexFile(file, table, { root, tips });
    }
    return stats;
  }

  /**
   * Indexed commits no new tip reaches (deleted branches, rewritten history), or null when an
   * incremental update is not safe and the caller should reload fully.
   */
  private async unreachable(root: string, oldTips: string[], newTips: string[], signal?: AbortSignal): Promise<Set<string> | null> {
    if ((await resolveRepo(this.git, root, signal))?.isShallow) return null; // boundaries may have moved
    const removed = oldTips.filter((t) => !newTips.includes(t));
    if (!removed.length) return new Set();
    try {
      const out = await this.git.text(['rev-list', '--stdin'], {
        cwd: root,
        signal,
        input: [...removed, ...newTips.map((t) => `^${t}`)].join('\n') + '\n',
      });
      return new Set(out.split('\n').filter(Boolean));
    } catch (e) {
      if (e instanceof GitError) return null; // an old tip was garbage-collected
      throw e;
    }
  }

  private async load(
    root: string,
    include: string[],
    exclude: string[],
    signal?: AbortSignal,
    onProgress?: (p: SyncProgress) => void,
  ): Promise<LogTable> {
    const table = new LogTable();
    if (!include.length) return table.finalize();
    const parser = new LogStreamParser((r) => {
      table.append(r);
      if (onProgress && table.count % PAGE_SIZE === 0) onProgress({ loaded: table.count });
    });
    const input = [...include, ...exclude.map((t) => `^${t}`)].join('\n') + '\n';
    await this.git.stream(['log', '--topo-order', '-z', LOG_FORMAT, '--stdin'], { cwd: root, signal, input }, (c) => parser.push(c));
    parser.end();
    return table.finalize();
  }
}

function sameTips(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function indexFile(storageDir: string, root: string): string {
  const id = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(storageDir, 'index', `${id}.gvx`);
}

async function loadIndexFile(file: string, root: string): Promise<{ table: LogTable; tips: string[] } | null> {
  try {
    const { table, meta } = LogTable.deserialize(await readFile(file));
    const m = meta as IndexMeta | null;
    if (!m || m.root !== root || !Array.isArray(m.tips)) return null;
    return { table, tips: m.tips };
  } catch {
    return null; // missing or corrupt: rebuild
  }
}

async function saveIndexFile(file: string, table: LogTable, meta: IndexMeta): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, table.serialize(meta));
  await rename(tmp, file);
}
