/**
 * Conflict markers in a file (spec F4): merge style (ours / theirs), diff3 and zdiff3 (with a base section).
 * Pure: unit-tested without VS Code. Marker size follows git's conflict-marker-size (7 by default); a block's
 * markers must all have the same size, so longer runs of < or = inside the code are not taken for markers.
 */

export interface ConflictSection {
  /** 0-based line of the section's marker (<<<<<<<, |||||||, =======). */
  marker: number;
  /** Content lines [start, end), exclusive end. */
  start: number;
  end: number;
  /** Text after the marker: a branch name or commit, as git wrote it. */
  label: string;
}

export interface ConflictHunk {
  current: ConflictSection;
  /** diff3 / zdiff3 only. */
  base: ConflictSection | null;
  incoming: ConflictSection;
  /** 0-based lines of the opening and closing markers. */
  start: number;
  end: number;
}

export function parseConflicts(text: string): ConflictHunk[] {
  const lines = text.split(/\r\n|\n|\r/);
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^(<{7,})(?: (.*))?$/.exec(lines[i]!);
    if (!open) {
      i++;
      continue;
    }
    const size = open[1]!.length;
    const is = (l: string, ch: string) => l.length >= size && l.startsWith(ch.repeat(size)) && (l.length === size || l[size] === ' ');
    let base = -1;
    let sep = -1;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (sep < 0 && base < 0 && is(l, '|')) base = j;
      else if (sep < 0 && is(l, '=') && l.length === size) sep = j;
      else if (sep >= 0 && is(l, '>')) {
        close = j;
        break;
      } else if (is(l, '<')) break; // a new block opened before this one closed: malformed
    }
    if (sep < 0 || close < 0) {
      i++;
      continue;
    }
    const label = (j: number, ch: string) => lines[j]!.slice(size).replace(new RegExp(`^${ch === '|' ? '\\|' : ch}*`), '').trim();
    const currentEnd = base >= 0 ? base : sep;
    hunks.push({
      start: i,
      end: close,
      current: { marker: i, start: i + 1, end: currentEnd, label: open[2]?.trim() ?? '' },
      base: base >= 0 ? { marker: base, start: base + 1, end: sep, label: label(base, '|') } : null,
      incoming: { marker: sep, start: sep + 1, end: close, label: label(close, '>') },
    });
    i = close + 1;
  }
  return hunks;
}

/** The lines a resolution puts in place of the whole hunk (markers included). */
export function resolveHunk(lines: string[], h: ConflictHunk, how: 'current' | 'incoming' | 'both' | 'base'): string[] {
  const take = (s: ConflictSection | null) => (s ? lines.slice(s.start, s.end) : []);
  if (how === 'current') return take(h.current);
  if (how === 'incoming') return take(h.incoming);
  if (how === 'base') return take(h.base);
  return [...take(h.current), ...take(h.incoming)];
}
