/** Time-travel commands: the editor-title QuickPick scrubber, stepping, pin, exit, and the revision hover. */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { relativeTime } from '@gvx/protocol';
import { TimeTravelController } from './controller';
import { SCHEME } from './revisionUri';

/** Debounce for live preview while moving through the QuickPick. */
const PREVIEW_MS = 120;

export function registerTimeTravelCommands(tt: TimeTravelController): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('gitvision.timeTravel.pick', () => pick(tt)),
    vscode.commands.registerCommand('gitvision.timeTravel.back', async () => {
      if (tt.session || (await tt.start())) await tt.step(-1);
    }),
    vscode.commands.registerCommand('gitvision.timeTravel.forward', () => tt.step(1)),
    vscode.commands.registerCommand('gitvision.timeTravel.exit', () => tt.exit()),
    vscode.commands.registerCommand('gitvision.timeTravel.togglePin', () => tt.togglePin()),
    // From the blame hover: travel to the revision that last changed the line.
    vscode.commands.registerCommand('gitvision.timeTravel.openAt', async (a: { root: string; path: string; sha: string }) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(a.root, a.path)));
      const editor = await vscode.window.showTextDocument(doc);
      if (!tt.session && !(await tt.start(editor))) return;
      const i = tt.session!.revisions.findIndex((r) => r.sha === a.sha);
      await tt.go(i >= 0 ? i : 0);
    }),
    vscode.languages.registerHoverProvider({ scheme: SCHEME }, {
      provideHover(doc, pos) {
        const lines = tt.removedAt(doc.uri, pos.line);
        if (!lines) return undefined;
        const md = new vscode.MarkdownString(`**${lines.length} line${lines.length === 1 ? '' : 's'} removed here**\n\n`);
        md.appendCodeblock(lines.join('\n'), doc.languageId);
        return new vscode.Hover(md);
      },
    }),
  );
}

/**
 * The QuickPick scrubber (D3 fallback for the timeline view): moving through the list previews each
 * revision; Enter keeps it; Escape returns to where the reader was.
 */
async function pick(tt: TimeTravelController): Promise<void> {
  const wasTravelling = !!tt.session;
  if (!tt.session && !(await tt.start())) return;
  const s = tt.session!;
  const startIndex = s.index;
  const now = Math.floor(Date.now() / 1000);
  type Item = vscode.QuickPickItem & { index: number };
  const items: Item[] = [
    { label: '$(file) Working copy', description: 'the file as it is now', index: -1 },
    ...s.revisions.map((r, index) => ({
      label: `$(git-commit) ${r.subject}`,
      description: `${r.author}, ${relativeTime(r.time, now)}`,
      detail: `${r.sha.slice(0, 7)} · ${new Date(r.time * 1000).toLocaleDateString()}${r.path !== s.path ? ` · was ${r.path}` : ''}`,
      index,
    })),
  ];
  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.placeholder = `History of ${path.basename(s.path)}: ${s.revisions.length} revisions. Moving previews; Enter keeps; Escape goes back.`;
  qp.activeItems = [items[startIndex + 1]!];
  let accepted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  qp.onDidChangeActive(([item]) => {
    clearTimeout(timer);
    if (item) timer = setTimeout(() => void tt.go(item.index), PREVIEW_MS);
  });
  qp.onDidAccept(() => {
    accepted = true;
    clearTimeout(timer);
    const item = qp.activeItems[0];
    qp.hide();
    if (item) void tt.go(item.index);
  });
  qp.onDidHide(() => {
    clearTimeout(timer);
    qp.dispose();
    if (accepted) return;
    if (wasTravelling) void tt.go(startIndex);
    else void tt.exit();
  });
  qp.show();
}
