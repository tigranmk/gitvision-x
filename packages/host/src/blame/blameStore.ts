/**
 * Blame state per open document. Blame is requested as soon as a document becomes visible (D10);
 * entries stream in while git runs (D11a), so recently changed lines are known long before the
 * oldest ones. The buffer → blob line map is computed per document version in the worker.
 */
import * as vscode from 'vscode';
import type { BlameProgress, BlameResult } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from '../repoRegistry';
import type { RepoSession } from '../repoSession';
import { UNKNOWN_LINE, type BlameView } from './format';

export type BlameFailure = { failed: true; code: string; message: string };
export type BlameOutcome = BlameResult | BlameFailure;

/** Expected outcomes that are not worth a log line. */
const QUIET_FAILURES = ['not-tracked', 'binary', 'too-large', 'cancelled'];

export const isFailure = <T extends object>(b: T | BlameFailure | undefined): b is BlameFailure => !!b && 'failed' in b;

/** Entries received so far while git blame runs. */
class PartialBlame {
  commits: BlameProgress['commits'] = [];
  files: string[] = [];
  lineCommit: Uint32Array;
  lineOrig: Uint32Array;
  lineFile: Uint32Array;

  constructor(capacity: number) {
    this.lineCommit = new Uint32Array(capacity).fill(UNKNOWN_LINE);
    this.lineOrig = new Uint32Array(capacity);
    this.lineFile = new Uint32Array(capacity);
  }

  add(p: BlameProgress): void {
    this.commits.push(...p.commits);
    this.files.push(...p.files);
    for (let i = 0; i < p.ranges.length; i += 5) {
      const [final0, count, commit, orig, file] = [p.ranges[i]!, p.ranges[i + 1]!, p.ranges[i + 2]!, p.ranges[i + 3]!, p.ranges[i + 4]!];
      this.grow(final0 + count);
      for (let k = 0; k < count; k++) {
        this.lineCommit[final0 + k] = commit;
        this.lineOrig[final0 + k] = orig + k;
        this.lineFile[final0 + k] = file;
      }
    }
  }

  private grow(n: number): void {
    if (n <= this.lineCommit.length) return;
    const cap = Math.max(n, this.lineCommit.length * 2);
    const extend = (a: Uint32Array, fill: number) => {
      const b = new Uint32Array(cap).fill(fill);
      b.set(a);
      return b;
    };
    this.lineCommit = extend(this.lineCommit, UNKNOWN_LINE);
    this.lineOrig = extend(this.lineOrig, 0);
    this.lineFile = extend(this.lineFile, 0);
  }
}

export interface FileBlame {
  readonly key: string;
  readonly session: RepoSession;
  readonly path: string;
  readonly controller: AbortController;
  readonly promise: Promise<BlameOutcome>;
  /** Set once the promise settles, for the synchronous path. */
  outcome?: BlameOutcome;
  partial?: PartialBlame;
  blobSha?: string;
  /** Prefetch start → blame complete (ms). */
  coldMs?: number;
  map?: { version: number; value: Int32Array | null };
  pendingMap?: { version: number; promise: Promise<Int32Array | null> };
}

export class BlameStore implements vscode.Disposable {
  private readonly files = new Map<string, FileBlame>();
  private readonly _onDidLoad = new vscode.EventEmitter<FileBlame>();
  private readonly _onDidProgress = new vscode.EventEmitter<FileBlame>();
  /** A file's blame finished loading (or failed). */
  readonly onDidLoad = this._onDidLoad.event;
  /** More entries of a running blame arrived. */
  readonly onDidProgress = this._onDidProgress.event;

  constructor(
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly storageDir: string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /**
   * Existing state, or starts the blame now. `force` re-runs a file refused as too large;
   * `refresh` replaces whatever is there (e.g. a stale disk-cache result).
   */
  ensure(doc: vscode.TextDocument, opts: { force?: boolean; refresh?: boolean } = {}): FileBlame | undefined {
    const key = doc.uri.toString();
    const existing = this.files.get(key);
    const retryTooLarge = opts.force && isFailure(existing?.outcome) && existing.outcome.code === 'too-large';
    if (existing && !retryTooLarge && !opts.refresh) return existing;
    const file = this.repos.fileOf(doc.uri);
    if (!file) return undefined;
    existing?.controller.abort();

    const controller = new AbortController();
    const started = performance.now();
    const root = file.session.root;
    const entry: FileBlame = {
      key,
      session: file.session,
      path: file.path,
      controller,
      promise: this.pool
        .request(
          'blame.file',
          { root, path: file.path, force: opts.force, storageDir: this.storageDir, noDiskCache: opts.refresh },
          {
            affinity: root,
            signal: controller.signal,
            onPartial: (p) => {
              if (this.files.get(key) !== entry) return;
              (entry.partial ??= new PartialBlame(doc.lineCount + 16)).add(p);
              if (p.blobSha) entry.blobSha = p.blobSha;
              this._onDidProgress.fire(entry);
            },
          },
        )
        .then(
          (b): BlameOutcome => b,
          (e: { code?: string; message?: string }): BlameOutcome => ({ failed: true, code: e.code ?? 'error', message: e.message ?? String(e) }),
        ),
    };
    void entry.promise.then((outcome) => {
      if (this.files.get(key) !== entry) return; // superseded
      entry.outcome = outcome;
      entry.partial = undefined;
      entry.coldMs = performance.now() - started;
      if (isFailure(outcome)) {
        if (!QUIET_FAILURES.includes(outcome.code)) this.log.warn(`blame ${file.path}: ${outcome.message}`);
      } else {
        entry.blobSha = outcome.blobSha ?? undefined;
        this.log.trace(`blame ${file.path}: ${entry.coldMs.toFixed(0)} ms (${outcome.source})`);
        if (outcome.source === 'disk') void this.validate(entry, doc, outcome);
      }
      this._onDidLoad.fire(entry);
    });
    this.files.set(key, entry);
    return entry;
  }

  get(doc: vscode.TextDocument): FileBlame | undefined {
    return this.files.get(doc.uri.toString());
  }

  /** The final result, the streamed part so far, a failure, or undefined before anything arrived. */
  view(entry: FileBlame): BlameView | BlameFailure | undefined {
    const o = entry.outcome;
    if (isFailure(o)) return o;
    if (o) return { ...o, complete: true };
    return entry.partial && { ...entry.partial, complete: false };
  }

  /** The line map for the document's current version: sync when cached, else a worker round trip. */
  mapFor(entry: FileBlame, doc: vscode.TextDocument): Int32Array | null | Promise<Int32Array | null> {
    const { version } = doc;
    if (entry.map?.version === version) return entry.map.value;
    if (entry.pendingMap?.version === version) return entry.pendingMap.promise;
    if (!entry.blobSha) return null;
    const root = entry.session.root;
    const promise = this.pool
      .request('blame.remap', { root, blobSha: entry.blobSha, text: doc.getText() }, { affinity: root, signal: entry.controller.signal })
      .then(({ map }) => {
        if (!entry.map || entry.map.version < version) entry.map = { version, value: map };
        return map;
      })
      .finally(() => {
        if (entry.pendingMap?.promise === promise) entry.pendingMap = undefined;
      });
    entry.pendingMap = { version, promise };
    return promise;
  }

  /**
   * A disk-cache hit is keyed by (path, blob), not by history. If history was rewritten since it was
   * stored (rebase, amend), it may cite commits no tip reaches any more: then blame again from git.
   */
  private async validate(entry: FileBlame, doc: vscode.TextDocument, outcome: BlameResult): Promise<void> {
    await entry.session.whenIndexed;
    const shas = [...new Set(outcome.commits.filter((c) => !c.uncommitted).map((c) => c.sha))];
    const root = entry.session.root;
    const known = await this.pool.request('index.contains', { root, shas }, { affinity: root }).catch(() => null);
    if (!known || known.every(Boolean) || this.files.get(entry.key) !== entry) return;
    this.log.info(`blame ${entry.path}: cached result cites rewritten commits; blaming again`);
    this.ensure(doc, { refresh: true });
  }

  forget(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.files.get(key)?.controller.abort();
    this.files.delete(key);
  }

  /** HEAD or refs moved: blame of HEAD may have changed for every file of the repo. */
  invalidateRepo(root: string): void {
    for (const [key, f] of this.files) {
      if (f.session.root === root) {
        f.controller.abort();
        this.files.delete(key);
      }
    }
  }

  dispose(): void {
    for (const f of this.files.values()) f.controller.abort();
    this.files.clear();
    this._onDidLoad.dispose();
    this._onDidProgress.dispose();
  }
}
