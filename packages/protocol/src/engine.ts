/** Methods the git engine (worker_threads) serves to the extension host. */
import type { MethodSpec } from './rpc';

export interface RepoInfo {
  /** Working tree root (forward slashes as git prints them). */
  root: string;
  /** This worktree's git dir: HEAD, index, MERGE_HEAD live here. */
  gitDir: string;
  /** Shared git dir: refs and packed-refs live here (differs from gitDir in linked worktrees). */
  commonDir: string;
  isShallow: boolean;
}

export type SyncMode = 'cached' | 'incremental' | 'full' | 'unchanged';

export interface IndexStats {
  root: string;
  commitCount: number;
  mode: SyncMode;
  durationMs: number;
  /** Tip SHAs (refs + HEAD) the index covers. */
  tips: string[];
  /** True when tips changed since the previous sync (drives repo.refsChanged). */
  refsChanged: boolean;
}

export interface SyncProgress {
  loaded: number;
}

export interface BlameCommit {
  sha: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  authorTime: number;
  summary: string;
  /** Previous revision of the blamed lines, when git reports one. */
  previous?: { sha: string; path: string };
  boundary: boolean;
  uncommitted: boolean;
}

export interface BlameResult {
  /** Revision that was blamed ('HEAD' unless asked otherwise) and the blob it resolved to. */
  rev: string;
  blobSha: string | null;
  commits: BlameCommit[];
  /** Per final line (0-based): index into `commits`. */
  lineCommit: Uint32Array;
  /** Per final line: 1-based line number in the originating commit. */
  lineOrig: Uint32Array;
  /** Per final line: index into `files` (differs from the blamed path when -C followed a move). */
  lineFile: Uint32Array;
  files: string[];
  cacheHit: boolean;
}

export type EngineMethods = {
  'engine.init': MethodSpec<{ gitPath: string }, { gitVersion: string }>;
  'repo.resolve': MethodSpec<{ path: string }, RepoInfo | null>;
  'index.sync': MethodSpec<{ root: string; storageDir: string; full?: boolean }, IndexStats, SyncProgress>;
  'index.stats': MethodSpec<{ root: string }, IndexStats | null>;
  'blame.file': MethodSpec<{ root: string; path: string; rev?: string }, BlameResult>;
};
