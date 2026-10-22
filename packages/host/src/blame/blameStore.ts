/**
 * Blame state per open document. Blame is requested as soon as a document becomes visible (D10),
 * and the buffer → blob line map is computed per document version in the worker, so the cursor-idle
 * render path is synchronous whenever nothing changed.
 */
import * as vscode from 'vscode';
import type { BlameResult } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from '../repoRegistry';
import type { RepoSession } from '../repoSession';

export type BlameFailure = { failed: true; code: string; message: string };
export type BlameOutcome = BlameResult | BlameFailure;
/** Expected outcomes that are not worth a log line. */
const QUIET_FAILURES = ['not-tracked', 'binary', 'too-large', 'cancelled'];

export const isFailure = (b: BlameOutcome | undefined): b is BlameFailure => !!b && 'failed' in b;

export interface FileBlame {
  readonly key: string;
  readonly session: RepoSession;
  readonly path: string;
  readonly controller: AbortController;
  readonly promise: Promise<BlameOutcome>;
  /** Set once the promise settles, for the synchronous path. */
  outcome?: BlameOutcome;
  /** Prefetch start → blame ready (ms): the "cold" measure. */
  coldMs?: number;
  map?: { version: number; value: Int32Array | null };
  pendingMap?: { version: number; promise: Promise<Int32Array | null> };
}

export class BlameStore implements vscode.Disposable {
  private readonly files = new Map<string, FileBlame>();
  private readonly _onDidLoad = new vscode.EventEmitter<FileBlame>();
  /** A file's blame finished loading (or failed). */
  readonly onDidLoad = this._onDidLoad.event;

  constructor(
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Existing state, or starts the blame now. Undefined outside an open repo. */
  ensure(doc: vscode.TextDocument, force = false): FileBlame | undefined {
    const key = doc.uri.toString();
    const existing = this.files.get(key);
    if (existing && !(force && isFailure(existing.outcome) && existing.outcome.code === 'too-large')) return existing;
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
        .request('blame.file', { root, path: file.path, force }, { affinity: root, signal: controller.signal })
        .then(
          (b): BlameOutcome => b,
          (e: { code?: string; message?: string }): BlameOutcome => ({ failed: true, code: e.code ?? 'error', message: e.message ?? String(e) }),
        ),
    };
    void entry.promise.then((outcome) => {
      if (this.files.get(key) !== entry) return; // superseded
      entry.outcome = outcome;
      entry.coldMs = performance.now() - started;
      if (isFailure(outcome)) {
        if (!QUIET_FAILURES.includes(outcome.code)) this.log.warn(`blame ${file.path}: ${outcome.message}`);
      } else {
        this.log.trace(`blame ${file.path}: ${entry.coldMs.toFixed(0)} ms${outcome.cacheHit ? ' (cached)' : ''}`);
      }
      this._onDidLoad.fire(entry);
    });
    this.files.set(key, entry);
    return entry;
  }

  get(doc: vscode.TextDocument): FileBlame | undefined {
    return this.files.get(doc.uri.toString());
  }

  /** The line map for the document's current version: sync when cached, else a worker round trip. */
  mapFor(entry: FileBlame, doc: vscode.TextDocument): Int32Array | null | Promise<Int32Array | null> {
    const { version } = doc;
    if (entry.map?.version === version) return entry.map.value;
    if (entry.pendingMap?.version === version) return entry.pendingMap.promise;
    const outcome = entry.outcome;
    if (!outcome || isFailure(outcome) || !outcome.blobSha) return null;
    const root = entry.session.root;
    const promise = this.pool
      .request('blame.remap', { root, blobSha: outcome.blobSha, text: doc.getText() }, { affinity: root, signal: entry.controller.signal })
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
  }
}
