/** Host ↔ time-travel timeline webview channel. */
import type { FileRevision } from './engine';
import type { MethodSpec } from './rpc';

/** Where the session is; small, pushed on every step. Revisions are sent separately, once per session. */
export interface TimelinePosition {
  /** Session in progress (else the view offers to start one for `file`). */
  active: boolean;
  /** Repo-relative path of the file travelled (or that would be: the active editor's file). */
  file: string | null;
  /** Index into the session's revisions (newest first); -1 = the working copy. */
  index: number;
  pinned: string | null;
  /** Index being loaded (a partial clone fetching the blob), or null. */
  loading: number | null;
  /** Bumped when a new session starts, so the view knows its revisions are stale. */
  session: number;
}

export interface TimelineRevisions {
  session: number;
  /** The file's current path (revisions with another path predate a rename). */
  path: string;
  revisions: FileRevision[];
}

export type TimelineHostMethods = {
  'timeline.position': MethodSpec<Record<string, never>, TimelinePosition>;
  'timeline.revisions': MethodSpec<Record<string, never>, TimelineRevisions | null>;
  /** Starts a session for the active editor's file and shows its newest revision. */
  'timeline.start': MethodSpec<Record<string, never>, boolean>;
  /** Shows revision `index` (-1: the working copy). */
  'timeline.go': MethodSpec<{ session: number; index: number }, null>;
  'timeline.pin': MethodSpec<Record<string, never>, null>;
  /** Opens the QuickPick with every revision (the bucketed view's full list). */
  'timeline.pick': MethodSpec<Record<string, never>, null>;
  'timeline.exit': MethodSpec<Record<string, never>, null>;
};

export type TimelineHostEvents = {
  'timeline.position': TimelinePosition;
};
