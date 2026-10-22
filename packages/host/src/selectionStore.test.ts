import { describe, expect, it } from 'vitest';
import { SelectionStore } from './selectionStore';

describe('SelectionStore', () => {
  it('emits once per effective change with the changed keys', () => {
    const s = new SelectionStore();
    const events: string[][] = [];
    s.onDidChange((e) => events.push(e.changed));
    s.update({ repo: '/r', file: 'a.ts', line: 3 });
    s.update({ line: 3 }); // no-op
    s.update({ line: 4, file: 'a.ts' });
    expect(events).toEqual([['repo', 'file', 'line'], ['line']]);
    expect(s.get()).toMatchObject({ repo: '/r', file: 'a.ts', line: 4, commit: null });
  });

  it('allows clearing a key with null and stops after dispose', () => {
    const s = new SelectionStore();
    let n = 0;
    const sub = s.onDidChange(() => n++);
    s.update({ line: 1 });
    s.update({ line: null });
    sub.dispose();
    s.update({ line: 2 });
    expect(n).toBe(2);
    expect(Object.isFrozen(s.get())).toBe(true);
  });
});
