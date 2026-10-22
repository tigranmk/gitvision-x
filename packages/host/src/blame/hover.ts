/** Hover for the ghost text: commit details, actions, and a mini-timeline of the line's history. */
import * as vscode from 'vscode';
import type { LineHistoryEntry } from '@gvx/protocol';
import { isYou, relativeTime, sparklinePositions, truncate, type LineBlame } from './format';

export const HOVER_COMMANDS = ['gitvision.blame.openCommitDiff', 'gitvision.blame.copySha'] as const;

export interface DiffArgs {
  root: string;
  sha: string;
  /** Path at `sha`. */
  path: string;
  /** Previous revision of the file (from blame), when known. */
  prev?: { sha: string; path: string };
}

const SPARK_WIDTH = 28;

const cmd = (id: (typeof HOVER_COMMANDS)[number], arg: unknown) => `command:${id}?${encodeURIComponent(JSON.stringify([arg]))}`;
const short = (sha: string) => sha.slice(0, 7);
/** Escapes text for Markdown so commit messages cannot inject links or formatting. */
const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
/** Inline code: backslash escapes do not apply inside code spans, so only backticks need care. */
const code = (s: string) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

export function blameHover(opts: {
  info: LineBlame;
  root: string;
  path: string;
  userEmail: string | null;
  history: LineHistoryEntry[] | null;
  nowSec: number;
  locale?: string;
}): vscode.MarkdownString {
  const { info, root, path, userEmail, history, nowSec, locale } = opts;
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [...HOVER_COMMANDS] };
  md.supportHtml = true;

  if (info.kind === 'pending') {
    md.appendMarkdown('$(loading~spin) Blaming…');
    return md;
  }
  if (info.kind === 'uncommitted') {
    md.appendMarkdown('**Not committed yet**');
    return md;
  }
  const c = info.commit;
  const who = isYou(c, userEmail) ? `You (${esc(c.author)})` : esc(c.author);
  const date = new Date(c.authorTime * 1000).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  md.appendMarkdown(`**${who}**, ${relativeTime(c.authorTime, nowSec, locale)} (${date})\n\n`);
  md.appendMarkdown(`${esc(c.summary)}\n\n`);
  const diff: DiffArgs = { root, sha: c.sha, path: info.origPath, prev: c.previous };
  md.appendMarkdown(
    `\`${short(c.sha)}\` &nbsp; [$(diff) Open diff](${cmd('gitvision.blame.openCommitDiff', diff)} "Open the change") &nbsp; ` +
      `[$(copy) Copy SHA](${cmd('gitvision.blame.copySha', c.sha)} "Copy the full SHA")`,
  );
  if (info.origPath !== path) md.appendMarkdown(`\n\n$(arrow-right) moved from ${code(info.origPath)}`);

  md.appendMarkdown('\n\n---\n\n');
  if (!history) {
    md.appendMarkdown('$(loading~spin) Loading line history…');
    return md;
  }
  if (!history.length) return md;
  // Sparkline: one tick per commit on a time axis, oldest left; the blamed commit is filled.
  const pos = sparklinePositions(history, SPARK_WIDTH);
  const cells: string[] = Array.from({ length: SPARK_WIDTH }, () => '·');
  history.forEach((h, i) => {
    const tick = h.sha === c.sha ? '●' : '○';
    const title = `${short(h.sha)} · ${relativeTime(h.authorTime, nowSec, locale)} · ${h.author}: ${truncate(h.summary, 50)}`.replace(/"/g, "'");
    cells[pos[i]!] = `[${tick}](${cmd('gitvision.blame.openCommitDiff', { root, sha: h.sha, path })} "${title}")`;
  });
  md.appendMarkdown(`History of this line, last ${history.length}: &nbsp;${cells.join('')}\n\n`);
  for (const h of history) {
    const mark = h.sha === c.sha ? '●' : '○';
    md.appendMarkdown(
      `${mark} [\`${short(h.sha)}\`](${cmd('gitvision.blame.openCommitDiff', { root, sha: h.sha, path })} "Open the change") ` +
        `${relativeTime(h.authorTime, nowSec, locale)} · ${esc(h.author)}: ${esc(truncate(h.summary, 60))} ` +
        `[$(copy)](${cmd('gitvision.blame.copySha', h.sha)} "Copy SHA")  \n`,
    );
  }
  return md;
}
