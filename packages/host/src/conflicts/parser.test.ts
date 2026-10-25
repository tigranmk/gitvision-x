import { describe, expect, it } from 'vitest';
import { parseConflicts, resolveHunk } from './parser';

const merge = ['a', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs', '>>>>>>> feature', 'z'].join('\n');
const diff3 = ['<<<<<<< HEAD', 'ours', '||||||| merged common ancestors', 'base', '=======', 'theirs', '>>>>>>> feature'].join('\n');

describe('parseConflicts', () => {
  it('finds merge-style hunks with their sections and labels', () => {
    const [h, ...rest] = parseConflicts(merge);
    expect(rest).toEqual([]);
    expect(h).toEqual({
      start: 1,
      end: 6,
      current: { marker: 1, start: 2, end: 4, label: 'HEAD' },
      base: null,
      incoming: { marker: 4, start: 5, end: 6, label: 'feature' },
    });
    const lines = merge.split('\n');
    expect(resolveHunk(lines, h!, 'current')).toEqual(['ours 1', 'ours 2']);
    expect(resolveHunk(lines, h!, 'incoming')).toEqual(['theirs']);
    expect(resolveHunk(lines, h!, 'both')).toEqual(['ours 1', 'ours 2', 'theirs']);
  });

  it('reads diff3 / zdiff3 base sections', () => {
    const [h] = parseConflicts(diff3);
    expect(h!.base).toEqual({ marker: 2, start: 3, end: 4, label: 'merged common ancestors' });
    expect(resolveHunk(diff3.split('\n'), h!, 'base')).toEqual(['base']);
  });

  it('handles several hunks, CRLF, empty sections and custom marker sizes', () => {
    const text = ['<<<<<<< a', '=======', 'x', '>>>>>>> b', 'mid', '<<<<<<< a', 'y', '=======', '>>>>>>> b'].join('\r\n');
    const hs = parseConflicts(text);
    expect(hs.map((h) => [h.current.end - h.current.start, h.incoming.end - h.incoming.start])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    const big = ['<<<<<<<<<< ours', 'o', '==========', 't', '>>>>>>>>>> theirs'].join('\n');
    expect(parseConflicts(big)).toHaveLength(1);
  });

  it('ignores marker-like lines that are not conflicts', () => {
    expect(parseConflicts(['<<<<<<< x', 'never closed', '======='].join('\n'))).toEqual([]);
    expect(parseConflicts(['=======', '>>>>>>> nope'].join('\n'))).toEqual([]);
    // A heading underline inside a hunk is longer than the marker size: not a separator.
    const md = ['<<<<<<< HEAD', 'Title', '==========', 'more', '=======', 'theirs', '>>>>>>> b'].join('\n');
    const [h] = parseConflicts(md);
    expect(h!.current).toMatchObject({ start: 1, end: 4 });
  });
});
