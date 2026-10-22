/** Single source of truth for { repo, file, line, commit, compareTo }; surfaces subscribe, never poll. */
import { EMPTY_SELECTION, type Selection, type SelectionKey } from '@gvx/protocol';

export type SelectionListener = (e: { selection: Selection; changed: SelectionKey[] }) => void;

export class SelectionStore {
  private state: Selection = EMPTY_SELECTION;
  private readonly listeners = new Set<SelectionListener>();

  get(): Selection {
    return this.state;
  }

  /** Applies a patch; listeners fire once, only when something actually changed. */
  update(patch: Partial<Selection>): void {
    const changed = (Object.keys(patch) as SelectionKey[]).filter((k) => patch[k] !== undefined && patch[k] !== this.state[k]);
    if (!changed.length) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const l of [...this.listeners]) l({ selection: this.state, changed });
  }

  onDidChange(listener: SelectionListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
