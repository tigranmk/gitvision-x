/** The single selection model every surface reads: active file, active line, selected commit. */
export interface Selection {
  /** Repo root of the active file, or null outside a repo. */
  repo: string | null;
  /** Repo-relative path with forward slashes. */
  file: string | null;
  /** 0-based active line. */
  line: number | null;
  commit: string | null;
  /** Pinned revision to compare against (time-travel pin). */
  compareTo: string | null;
}

export const EMPTY_SELECTION: Selection = { repo: null, file: null, line: null, commit: null, compareTo: null };

export type SelectionKey = keyof Selection;
