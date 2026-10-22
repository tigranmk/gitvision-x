/** Push channel, host → webviews. */
import type { Selection, SelectionKey } from './selection';

export interface ConflictsSummary {
  root: string;
  files: number;
}

export type HostEvents = {
  'selection.changed': { selection: Selection; changed: SelectionKey[] };
  'repo.refsChanged': { root: string; tips: string[] };
  'conflicts.changed': ConflictsSummary;
};
