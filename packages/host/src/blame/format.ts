/** Pure text formatting for inline blame: no vscode imports, unit-tested directly. */
import type { BlameCommit, BlameResult, LineHistoryEntry } from '@gvx/protocol';

const SUMMARY_MAX = 60;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(thenSec: number, nowSec: number, locale = 'en'): string {
  const diff = thenSec - nowSec;
  const abs = Math.abs(diff);
  if (abs < 45) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const sign = diff < 0 ? -1 : 1;
  // Round the magnitude: Math.round(-1.5) is -1, which would turn 90 s ago into "1 minute ago".
  for (const [unit, sec] of UNITS) {
    if (abs >= sec) return fmt.format(sign * Math.round(abs / sec), unit);
  }
  return fmt.format(sign, 'minute');
}

export function truncate(s: string, max = SUMMARY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function isYou(commit: Pick<BlameCommit, 'authorMail'>, userEmail: string | null): boolean {
  return !!userEmail && commit.authorMail.toLowerCase() === userEmail.toLowerCase();
}

export const NOT_COMMITTED = 'Not committed yet';

/** Per buffer line: what the ghost text and hover describe. `pending`: git has not reached it yet. */
export type LineBlame =
  | { kind: 'uncommitted' }
  | { kind: 'pending' }
  | { kind: 'commit'; commit: BlameCommit; headLine: number; origLine: number; origPath: string };

/** A final BlameResult, or the part streamed so far (unattributed lines hold UNKNOWN_LINE). */
export type BlameView = Pick<BlameResult, 'commits' | 'files'> & {
  lineCommit: ArrayLike<number>;
  lineOrig: ArrayLike<number>;
  lineFile: ArrayLike<number>;
  /** False while git is still streaming entries. */
  complete: boolean;
};
export const UNKNOWN_LINE = 0xffffffff;

/** Buffer line → blame of the HEAD blob, through the remap (`null` = buffer equals the blob). */
export function lineBlame(blame: BlameView, map: Int32Array | null, bufferLine: number): LineBlame {
  const headLine = map ? (map[bufferLine] ?? -1) : bufferLine;
  if (headLine < 0) return { kind: 'uncommitted' };
  if (headLine >= blame.lineCommit.length || blame.lineCommit[headLine] === UNKNOWN_LINE) {
    return blame.complete ? { kind: 'uncommitted' } : { kind: 'pending' };
  }
  const commit = blame.commits[blame.lineCommit[headLine]!]!;
  if (commit.uncommitted) return { kind: 'uncommitted' };
  return { kind: 'commit', commit, headLine, origLine: blame.lineOrig[headLine]!, origPath: blame.files[blame.lineFile[headLine]!]! };
}

/** `You, 3 days ago • Fix token refresh (#412)` */
export function ghostText(info: LineBlame, userEmail: string | null, nowSec: number, locale?: string): string {
  if (info.kind === 'pending') return '';
  if (info.kind === 'uncommitted') return NOT_COMMITTED;
  const { commit } = info;
  const who = isYou(commit, userEmail) ? 'You' : commit.author;
  return `${who}, ${relativeTime(commit.authorTime, nowSec, locale)} • ${truncate(commit.summary)}`;
}

export interface Aggregate {
  lines: number;
  authors: { name: string; lines: number }[];
  oldest: number | null;
  newest: number | null;
}

/** Blame summary of a multi-line selection: authors by line share, oldest and newest change. */
export function aggregate(infos: LineBlame[], userEmail: string | null): Aggregate {
  const byAuthor = new Map<string, number>();
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const info of infos) {
    if (info.kind === 'pending') continue;
    const name = info.kind === 'uncommitted' ? NOT_COMMITTED : isYou(info.commit, userEmail) ? 'You' : info.commit.author;
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
    if (info.kind === 'commit') {
      const t = info.commit.authorTime;
      if (oldest === null || t < oldest) oldest = t;
      if (newest === null || t > newest) newest = t;
    }
  }
  const authors = [...byAuthor].map(([name, lines]) => ({ name, lines })).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  return { lines: infos.length, authors, oldest, newest };
}

/** `3 authors · You 60%, Ann 30% · oldest 2 years ago · newest 3 days ago` */
export function aggregateText(a: Aggregate, nowSec: number, locale?: string): string {
  const pct = (n: number) => `${Math.round((n / a.lines) * 100)}%`;
  const parts = [
    a.authors.length === 1 ? `${a.authors[0]!.name}` : `${a.authors.length} authors`,
    ...(a.authors.length > 1 ? [a.authors.slice(0, 2).map((x) => `${x.name} ${pct(x.lines)}`).join(', ')] : []),
  ];
  if (a.oldest !== null && a.newest !== null) {
    if (a.oldest === a.newest) parts.push(relativeTime(a.oldest, nowSec, locale));
    else parts.push(`oldest ${relativeTime(a.oldest, nowSec, locale)}`, `newest ${relativeTime(a.newest, nowSec, locale)}`);
  }
  return `${a.lines} lines: ${parts.join(' · ')}`;
}

/** Age bucket 0 (newest) … 4 (oldest) for the gutter heatmap. */
export function ageBucket(info: LineBlame, nowSec: number): number {
  if (info.kind !== 'commit') return 0;
  const age = nowSec - info.commit.authorTime;
  if (age < 7 * 86400) return 0;
  if (age < 30 * 86400) return 1;
  if (age < 182 * 86400) return 2;
  if (age < 365 * 86400) return 3;
  return 4;
}

/**
 * Tick positions (0..width-1) of history entries on a time axis, oldest left. Entries at the same
 * position are nudged apart so every commit keeps its own tick.
 */
export function sparklinePositions(history: Pick<LineHistoryEntry, 'authorTime'>[], width: number): number[] {
  if (!history.length) return [];
  if (history.length === 1) return [width - 1];
  const times = history.map((h) => h.authorTime);
  const min = Math.min(...times);
  const span = Math.max(...times) - min || 1;
  // Newest first in → oldest first for placement, then back to the input order.
  const order = history.map((_, i) => i).sort((a, b) => times[a]! - times[b]! || b - a);
  const pos = new Array<number>(history.length);
  let last = -1;
  for (const i of order) {
    const p = Math.max(last + 1, Math.round(((times[i]! - min) / span) * (width - 1)));
    pos[i] = p;
    last = p;
  }
  // Nudging can push past the right edge: pull back right-to-left.
  let limit = width - 1;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    pos[i] = Math.min(pos[i]!, limit);
    limit = pos[i]! - 1;
  }
  return pos;
}
