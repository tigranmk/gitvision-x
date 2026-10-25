/** Host ↔ graph webview channel (an RpcEndpoint over the webview's postMessage). */
import type { CommitDetails, CommitFile, GraphPage, MicroDiff, RefInfo, WorktreeHead } from './engine';
import type { GraphView } from './graph';
import type { MethodSpec } from './rpc';

export interface GraphState {
  /** Repo shown, or null when no repository is open. */
  root: string | null;
  /** Rows in the graph (0 while the index is loading). */
  total: number;
  /** `git config user.email`, to show "You". */
  userEmail: string | null;
  /** The commit synced to the editor cursor, if any (so a newly opened graph starts in sync). */
  sync: GraphSync | null;
  /** Repo-relative path of the active editor's file in this repo (for the "active file" filter). */
  activeFile: string | null;
}

/** Editor → graph sync, stage 1 (D1): the commit that last touched the cursor line, from the blame cache. */
export interface GraphSync {
  sha: string;
  /** Bumped on every sync, so the webview pulses again when the same commit is synced twice. */
  seq: number;
}

/** Stage 2 (D1): every commit in the cursor line's history (`git log -L`), computed async in the worker. */
export interface GraphLineage {
  /** The sync this lineage belongs to; stale lineages are ignored. */
  seq: number;
  shas: string[];
}

export interface GraphRef extends RefInfo {
  /** Row of the commit it points at (-1 if not in the graph). */
  row: number;
}

export interface GraphRefs {
  head: { sha: string | null; branch: string | null; row: number };
  refs: GraphRef[];
  /** Other worktrees' HEADs (the current one is `head`), each with its row. */
  worktrees: (WorktreeHead & { row: number })[];
  shallow: boolean;
}

export interface GraphFile extends CommitFile {
  /** Open in an editor tab: pinned to the top of the file tree and badged. */
  open: boolean;
}

export interface GraphCommitDetails extends Omit<CommitDetails, 'files'> {
  files: GraphFile[];
}

/** Served by the host, called by the webview. */
export type GraphHostMethods = {
  'graph.refs': MethodSpec<{ root: string; view?: GraphView }, GraphRefs>;
  /** Rows of the view matching a query (see the engine's graph.search). */
  'graph.search': MethodSpec<{ root: string; view?: GraphView; query: string }, { rows: number[]; capped: boolean }>;
  'graph.details': MethodSpec<{ root: string; sha: string }, GraphCommitDetails>;
  /** Rows of commits (-1 when not in the graph), e.g. to jump to a parent. */
  'graph.rows': MethodSpec<{ root: string; view?: GraphView; shas: string[] }, number[]>;
  'clipboard.write': MethodSpec<{ text: string }, null>;
  /** Shallow clone: fetch more history (the host confirms nothing: fetching adds, never removes). */
  'graph.fetchMore': MethodSpec<{ root: string }, null>;
  /** A branch chip dropped on another: the host offers merge or rebase and confirms before running it. */
  'graph.dropBranch': MethodSpec<
    { root: string; source: { name: string; kind: 'branch' | 'remote' }; target: { name: string; kind: 'branch' | 'remote' } },
    null
  >;
  'graph.fileDiff': MethodSpec<{ root: string; sha: string; path: string; oldPath?: string }, MicroDiff>;
  /** Opens VS Code's diff editor for a file of a commit, against its first parent. */
  'graph.openDiff': MethodSpec<{ root: string; sha: string; parent: string | null; file: Pick<CommitFile, 'path' | 'oldPath' | 'status'> }, null>;
  'graph.state': MethodSpec<Record<string, never>, GraphState>;
  /** Rows of the repo in `root` (the state the webview last saw); 'stale' if the host moved on. */
  /** `count: 0` returns just the view's size (`total`). */
  'graph.page': MethodSpec<{ root: string; view?: GraphView; start: number; count: number }, GraphPage>;
};

/** Pushed by the host. */
export type GraphHostEvents = {
  /** The repo shown changed, or its history did (a sync replaced the table): drop cached pages. */
  'graph.reset': GraphState;
  'graph.sync': GraphSync | null;
  'graph.lineage': GraphLineage;
  /** HEAD or refs may have moved without the index changing (checkout): refetch refs and branch views. */
  'graph.refresh': { root: string };
  /** The active editor's file changed (null: none, or outside the repo shown). */
  'graph.activeFile': { root: string; path: string | null };
  /** Repo-relative paths open in editor tabs changed. */
  'graph.openFiles': { root: string; paths: string[] };
};
