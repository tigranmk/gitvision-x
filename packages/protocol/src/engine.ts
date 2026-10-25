/** Methods the git engine (worker_threads) serves to the extension host. */
import type { GraphView } from './graph';
import type { MethodSpec } from './rpc';

export interface RepoInfo {
  /** Working tree root (forward slashes as git prints them). */
  root: string;
  /** This worktree's git dir: HEAD, index, MERGE_HEAD live here. */
  gitDir: string;
  /** Shared git dir: refs and packed-refs live here (differs from gitDir in linked worktrees). */
  commonDir: string;
  isShallow: boolean;
  /** `git config user.email` for this repo, used to show "You". */
  userEmail: string | null;
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
  /** Where the result came from: the worker's memory cache, the on-disk cache, or a git run. */
  source: 'memory' | 'disk' | 'git';
  cacheHit: boolean;
}

/**
 * Streamed while git blame runs: what arrived since the previous progress message.
 * Commit and file indices continue across messages; `ranges` holds 5-tuples
 * (first final line 0-based, line count, commit index, first original line 1-based, file index).
 */
export interface BlameProgress {
  blobSha: string | null;
  commits: BlameCommit[];
  files: string[];
  ranges: Uint32Array;
}

export interface CommitGraphStatus {
  /** A commit-graph file (or chain) exists. */
  graph: boolean;
  /** Every layer carries changed-path Bloom filters. */
  bloom: boolean;
}

export interface LineHistoryEntry {
  sha: string;
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
}

export interface GraphCommit {
  sha: string;
  /** Parents in this view (merges have 2+). */
  parents: number;
  subject: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  time: number;
}

/**
 * A slice of the graph for the viewport. Edges are packed as kind (2 bits: 0 pass, 1 in, 2 out),
 * from lane (15), to lane (15); `flags` holds merge (1), root (2), shallow boundary (4), tip (8).
 */
export interface GraphPage {
  start: number;
  /** Rows in the whole graph. */
  total: number;
  /** Widest lane count laid out so far (grows as later pages are laid out). */
  width: number;
  commits: GraphCommit[];
  nodeLane: Uint16Array;
  flags: Uint8Array;
  /** Edges of row `start + i` are `edges[edgeStart[i] .. edgeStart[i + 1])`. */
  edgeStart: Uint32Array;
  edges: Uint32Array;
}

export interface CommitFile {
  path: string;
  /** Renames and copies: the path in the parent. */
  oldPath?: string;
  /** git's status letter: A, M, D, R, C, T (type change). */
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  authorMail: string;
  authorTime: number;
  committer: string;
  committerMail: string;
  commitTime: number;
  /** Full message (subject, blank line, body). */
  message: string;
  /** Changes against the first parent (the root commit: everything added). */
  files: CommitFile[];
  /** Files left out past the cap. */
  filesTruncated: number;
}

export interface RefInfo {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  sha: string;
}

export interface WorktreeHead {
  /** Worktree directory (forward slashes). */
  path: string;
  sha: string;
  /** Null when that worktree's HEAD is detached. */
  branch: string | null;
  /** The worktree these refs were read from. */
  current: boolean;
}

export interface RepoRefs {
  /** HEAD's commit (null in an empty repo) and its branch (null when detached). */
  head: { sha: string | null; branch: string | null };
  refs: RefInfo[];
  /** Every worktree's HEAD (linked worktrees share the refs, but each has its own HEAD). */
  worktrees: WorktreeHead[];
  /** A shallow clone: history stops at boundary commits. */
  shallow: boolean;
}

export interface MicroDiffLine {
  /** 1-based line number on that side. */
  line: number;
  text: string;
}

/** One row of a side-by-side diff; 'gap' separates hunks (unchanged lines left out). */
export interface MicroDiffRow {
  kind: 'same' | 'add' | 'del' | 'mod' | 'gap';
  left?: MicroDiffLine;
  right?: MicroDiffLine;
}

export interface MicroDiff {
  rows: MicroDiffRow[];
  /** More changed lines exist past the row cap. */
  truncated: boolean;
  binary: boolean;
  /** A side is over the size cap: not diffed. */
  tooLarge: boolean;
}

/** Git operations the graph can run. Each one is confirmed by the user before it is sent. */
export type RepoWriteOp =
  | { kind: 'checkout'; branch: string }
  | { kind: 'checkoutDetached'; sha: string }
  | { kind: 'branch'; name: string; sha: string; checkout?: boolean }
  | { kind: 'tag'; name: string; sha: string; message?: string }
  | { kind: 'cherryPick'; sha: string; mainline?: number }
  | { kind: 'revert'; sha: string; mainline?: number }
  | { kind: 'reset'; sha: string; mode: 'soft' | 'mixed' | 'hard' }
  /** Merges `branch` into the branch checked out. */
  | { kind: 'merge'; branch: string }
  /** Rebases `branch` onto `upstream` (checks `branch` out). */
  | { kind: 'rebase'; upstream: string; branch: string }
  /** Shallow clone: fetch `by` more commits of history (git fetch --deepen). */
  | { kind: 'deepen'; by: number }
  /** Conflicts: take one side of a whole file (binary, or content resolved wholesale). */
  | { kind: 'takeSide'; path: string; side: 'ours' | 'theirs' }
  /** Conflicts: keep a file as it is in the working tree (mark resolved), or delete it. */
  | { kind: 'markResolved'; path: string }
  | { kind: 'deleteFile'; path: string }
  /** The stopped operation: finish it, skip the current commit (rebase / pick), or abort it. */
  | { kind: 'continue' | 'skip' | 'abort'; op: ConflictOp };

/**
 * Errors from repo.write carry code 'conflict' (the operation stopped with conflicts to resolve),
 * 'invalid' (a bad name or argument; nothing ran) or 'git' (git refused; the message is its stderr).
 */
export interface RepoWriteResult {
  output: string;
}

/** One revision of a file (time-travel), newest first. */
export interface FileRevision {
  sha: string;
  /** Unix seconds (author date). */
  time: number;
  author: string;
  authorMail: string;
  subject: string;
  /** The file's path at this revision (differs from the current path before a rename). */
  path: string;
}

/** A revision of a file as time-travel shows it: its text and what changed against the comparison revision. */
export interface RevisionView {
  text: string;
  /** 0-based lines of `text` that are new or changed since the comparison revision. */
  added: number[];
  /** Lines removed since the comparison revision, each group placed after a line of `text` (-1: before the first). */
  removed: { after: number; lines: string[] }[];
  /** `mapFrom.line` carried into this revision through the diff (null when no mapFrom). */
  mappedLine: number | null;
  binary: boolean;
  tooLarge: boolean;
}

export type RevisionRef = { sha: string; path: string };

export type ConflictOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** How a path is unmerged (from its index stages: 1 base, 2 ours, 3 theirs). */
export type ConflictKind =
  | 'content' // both sides changed it: markers in the file
  | 'binary' // both changed a binary file: keep ours or theirs
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'added-by-us' // only ours has it at this path (one side of a rename/rename)
  | 'added-by-them'
  | 'both-deleted'; // the original path of a rename/rename

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /** Rename/rename: the original path and where each side put it. */
  rename?: { from: string; ours: string; theirs: string };
}

export interface ConflictState {
  /** The operation that stopped, or null when none is in progress. */
  op: ConflictOp | null;
  /** HEAD (the side being merged into / rebased onto). */
  ours: string | null;
  /** The commit being merged, rebased or picked. */
  theirs: string | null;
  /** Where the two sides forked (merge base; for a pick, the picked commit's parent). */
  base: string | null;
  oursLabel: string;
  theirsLabel: string;
  /** Rebase progress: step `step` of `total` (1-based), or null. */
  rebase: { step: number; total: number } | null;
  files: ConflictFile[];
}

export interface ExplainCommit {
  sha: string;
  author: string;
  authorMail: string;
  time: number;
  subject: string;
}

/** Files above this many lines are blamed on demand only (spec F1). */
export const AUTO_BLAME_MAX_LINES = 20_000;

/** Pushed by a worker to the host. */
export type EngineEvents = {
  /** One diagnostic line (a git run, a blame step) for the host's log at trace level. */
  'engine.trace': { msg: string };
};

export type EngineMethods = {
  'engine.init': MethodSpec<{ gitPath: string }, { gitVersion: string }>;
  'repo.resolve': MethodSpec<{ path: string }, RepoInfo | null>;
  'index.sync': MethodSpec<{ root: string; storageDir: string; full?: boolean }, IndexStats, SyncProgress>;
  'index.stats': MethodSpec<{ root: string }, IndexStats | null>;
  /** Whether each commit is in the repo's index (reachable from a tip); null if the index is not loaded. */
  /** Rows [start, start + count) of the repo's graph; errors with code 'no-index' before the first index.sync. */
  'graph.page': MethodSpec<{ root: string; view?: GraphView; start: number; count: number }, GraphPage>;
  /**
   * Rows of the view matching a search, ascending (at most `limit`, default 10,000). Plain text matches
   * the subject, author name or email (case-insensitive) or a SHA prefix; `path:<glob>` matches commits
   * touching paths (git pathspec glob).
   */
  'graph.search': MethodSpec<{ root: string; view?: GraphView; query: string; limit?: number }, { rows: number[]; capped: boolean }>;
  /** Row of each commit in the repo's graph, -1 when it is not in the index. */
  'graph.rows': MethodSpec<{ root: string; view?: GraphView; shas: string[] }, number[]>;
  'commit.details': MethodSpec<{ root: string; sha: string }, CommitDetails>;
  /** Side-by-side diff of one file of a commit against its first parent, at most `maxRows` rows (default 40). */
  'commit.fileDiff': MethodSpec<{ root: string; sha: string; path: string; oldPath?: string; maxRows?: number }, MicroDiff>;
  /** Every revision of a file, following renames (`git log --follow`), newest first. */
  'file.revisions': MethodSpec<{ root: string; path: string }, FileRevision[]>;
  /**
   * A file at `rev`, diffed against `against` (the previous or a pinned revision; null: no diff), with a
   * line of what was shown before (`mapFrom`: a revision, or the working copy's text) mapped into it.
   */
  'file.revision': MethodSpec<
    { root: string; rev: RevisionRef; against: RevisionRef | null; mapFrom?: { line: number } & (RevisionRef | { text: string }) },
    RevisionView
  >;
  /** Raw bytes of a file at a revision (the gitvision: file system). */
  'file.blob': MethodSpec<{ root: string; rev: RevisionRef }, { bytes: Uint8Array }>;
  /** Loads revisions into the worker's cache ahead of use (time-travel prefetch). */
  'file.prefetch': MethodSpec<{ root: string; revs: RevisionRef[] }, null>;
  'repo.write': MethodSpec<{ root: string; op: RepoWriteOp }, RepoWriteResult>;
  /** Files changed between two commits (`from` → `to`), like a commit's file list. */
  'commit.compare': MethodSpec<{ root: string; from: string; to: string }, CommitFile[]>;
  'conflicts.state': MethodSpec<{ root: string }, ConflictState>;
  /** Commits on one side since the base that touched a hunk's lines (`git log base..side -L`). */
  'conflicts.explain': MethodSpec<{ root: string; path: string; side: 'ours' | 'theirs'; lines: string[] }, ExplainCommit[]>;
  'repo.refs': MethodSpec<{ root: string }, RepoRefs>;
  'index.contains': MethodSpec<{ root: string; shas: string[] }, boolean[] | null>;
  'repo.commitGraph': MethodSpec<{ root: string }, CommitGraphStatus>;
  /** `git commit-graph write --reachable --changed-paths`. */
  'repo.writeCommitGraph': MethodSpec<{ root: string }, { durationMs: number }>;
  /** Errors with code 'not-tracked', 'binary', 'too-large' (unless `force`), or 'ignore-revs-missing'. */
  'blame.file': MethodSpec<
    { root: string; path: string; rev?: string; force?: boolean; storageDir?: string; noDiskCache?: boolean },
    BlameResult,
    BlameProgress
  >;
  /** Starts the repo's blame worker and caches its repo layout and blame config, ahead of the first file. */
  'blame.warm': MethodSpec<{ root: string }, null>;
  /**
   * Maps buffer lines to lines of the blamed blob (index = buffer line, value = blob line or -1).
   * `map: null` means the buffer equals the blob.
   */
  'blame.remap': MethodSpec<{ root: string; blobSha: string; text: string }, { map: Int32Array | null }>;
  /** The last `count` commits that touched a line (1-based, at `rev`), newest first; follows renames. */
  'blame.lineHistory': MethodSpec<{ root: string; path: string; line: number; rev?: string; count?: number }, LineHistoryEntry[]>;
};
