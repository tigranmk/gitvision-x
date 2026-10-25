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
};
