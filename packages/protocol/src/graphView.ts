/** Host ↔ graph webview channel (an RpcEndpoint over the webview's postMessage). */
import type { GraphPage } from './engine';
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
}

/** Editor → graph sync, stage 1 (D1): the commit that last touched the cursor line, from the blame cache. */
export interface GraphSync {
  sha: string;
  row: number;
  /** Bumped on every sync, so the webview pulses again when the same commit is synced twice. */
  seq: number;
}

/** Stage 2 (D1): every commit in the cursor line's history (`git log -L`), computed async in the worker. */
export interface GraphLineage {
  /** The sync this lineage belongs to; stale lineages are ignored. */
  seq: number;
  rows: number[];
}

/** Served by the host, called by the webview. */
export type GraphHostMethods = {
  'graph.state': MethodSpec<Record<string, never>, GraphState>;
  /** Rows of the repo in `root` (the state the webview last saw); 'stale' if the host moved on. */
  'graph.page': MethodSpec<{ root: string; start: number; count: number }, GraphPage>;
};

/** Pushed by the host. */
export type GraphHostEvents = {
  /** The repo shown changed, or its history did (a sync replaced the table): drop cached pages. */
  'graph.reset': GraphState;
  'graph.sync': GraphSync | null;
  'graph.lineage': GraphLineage;
};
