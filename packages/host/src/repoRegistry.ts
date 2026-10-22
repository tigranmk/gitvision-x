/** Open repositories, and the mapping from editor paths to (repo, repo-relative path). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IndexStats } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import { RepoSession } from './repoSession';

export interface RepoFile {
  session: RepoSession;
  /** Repo-relative path with forward slashes. */
  path: string;
}

export class RepoRegistry implements vscode.Disposable {
  private readonly sessions = new Map<string, RepoSession>();
  private readonly _onDidOpen = new vscode.EventEmitter<RepoSession>();
  private readonly _onDidClose = new vscode.EventEmitter<RepoSession>();
  private readonly _onDidSync = new vscode.EventEmitter<{ session: RepoSession; stats: IndexStats }>();
  readonly onDidOpen = this._onDidOpen.event;
  readonly onDidClose = this._onDidClose.event;
  readonly onDidSync = this._onDidSync.event;

  constructor(
    private readonly pool: WorkerPool,
    private readonly storageDir: string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  all(): RepoSession[] {
    return [...this.sessions.values()];
  }

  async open(dir: string): Promise<void> {
    const info = await this.pool.request('repo.resolve', { path: dir });
    if (!info || this.sessions.has(info.root)) return;
    const session = new RepoSession(info, this.pool, this.storageDir, this.log);
    this.sessions.set(info.root, session);
    session.onDidSync((stats) => this._onDidSync.fire({ session, stats }));
    this._onDidOpen.fire(session);
    await session.sync();
  }

  closeByPath(fsPath: string): void {
    for (const s of this.sessions.values()) {
      if (sameFsPath(s.root, fsPath)) {
        s.dispose();
        this.sessions.delete(s.root);
        this._onDidClose.fire(s);
      }
    }
  }

  /** The session whose root is this directory, if open. */
  sessionAt(fsPath: string): RepoSession | undefined {
    const dir = realDir(fsPath);
    return this.all().find((s) => sameFsPath(s.root, dir));
  }

  /** The innermost open repo containing a file:// document. */
  fileOf(uri: vscode.Uri): RepoFile | undefined {
    if (uri.scheme !== 'file') return undefined;
    const p = realPath(uri.fsPath);
    let best: RepoSession | undefined;
    for (const s of this.sessions.values()) {
      const root = s.root.endsWith('/') ? s.root : `${s.root}/`;
      if (norm(p).startsWith(norm(root)) && (!best || s.root.length > best.root.length)) best = s;
    }
    return best && { session: best, path: p.slice(best.root.replace(/\/$/, '').length + 1) };
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this._onDidOpen.dispose();
    this._onDidClose.dispose();
    this._onDidSync.dispose();
  }
}

/**
 * git reports resolved paths (/private/var/… on macOS, long Windows names, no symlinked folders);
 * editors may hold another spelling. Resolve the file's directory once and cache it.
 */
const realDirs = new Map<string, string>();
/** A directory's resolved path with forward slashes (cached). */
export function realDir(dir: string): string {
  let real = realDirs.get(dir);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(dir);
    } catch {
      real = dir;
    }
    if (realDirs.size > 2000) realDirs.clear();
    realDirs.set(dir, real);
  }
  return real.replace(/\\/g, '/');
}

/** A file's resolved path: its directory resolved, its own name kept. */
export function realPath(fsPath: string): string {
  return `${realDir(path.dirname(fsPath)).replace(/\/$/, '')}/${path.basename(fsPath)}`;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
export function sameFsPath(a: string, b: string): boolean {
  const clean = (p: string) => norm(p.replace(/\\/g, '/').replace(/\/$/, ''));
  return clean(a) === clean(b);
}
