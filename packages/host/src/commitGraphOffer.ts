/**
 * D11b: in large repos without changed-path Bloom filters, offer once to let git build them.
 * It cuts the history walk behind a file's first blame by ~40% (measured on the 100k fixture). It writes into .git, so it is
 * never done without asking.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitGraphStatus } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from './repoRegistry';

export const OFFER_MIN_COMMITS = 10_000;
const DECLINED_KEY = 'gitvision.commitGraphDeclined';

export function shouldOffer(opts: { commitCount: number; status: CommitGraphStatus; declined: boolean; enabled: boolean }): boolean {
  return opts.enabled && !opts.declined && opts.commitCount >= OFFER_MIN_COMMITS && !opts.status.bloom;
}

export function registerCommitGraphOffer(
  context: vscode.ExtensionContext,
  pool: WorkerPool,
  repos: RepoRegistry,
  log: vscode.LogOutputChannel,
): vscode.Disposable {
  const asked = new Set<string>(); // once per repo per session
  return repos.onDidSync(async ({ session, stats }) => {
    const root = session.root;
    if (asked.has(root) || stats.commitCount < OFFER_MIN_COMMITS) return;
    asked.add(root);
    const declined = context.globalState.get<string[]>(DECLINED_KEY, []).includes(root);
    const enabled = vscode.workspace.getConfiguration('gitvision.blame').get('offerCommitGraph', true);
    if (!enabled || declined) return;
    const status = await pool.request('repo.commitGraph', { root }, { affinity: root }).catch(() => null);
    if (!status || !shouldOffer({ commitCount: stats.commitCount, status, declined, enabled })) return;

    const name = path.basename(root);
    const choice = await vscode.window.showInformationMessage(
      `${name} has ${stats.commitCount.toLocaleString()} commits. Let git build its commit-graph with changed-path Bloom filters? ` +
        'Blaming old lines for the first time gets roughly 40% faster. This runs `git commit-graph write` and adds a file under .git.',
      'Build It',
      'Not Now',
      "Don't Ask for This Repo",
    );
    if (choice === "Don't Ask for This Repo") {
      await context.globalState.update(DECLINED_KEY, [...context.globalState.get<string[]>(DECLINED_KEY, []), root]);
      return;
    }
    if (choice !== 'Build It') return;
    try {
      const { durationMs } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `GitVision: building the commit-graph for ${name}…` },
        () => pool.request('repo.writeCommitGraph', { root }, { affinity: root }),
      );
      log.info(`commit-graph with Bloom filters written for ${root} in ${durationMs} ms`);
      void vscode.window.showInformationMessage(`Commit-graph built for ${name} in ${(durationMs / 1000).toFixed(1)} s.`);
    } catch (e) {
      log.error(`commit-graph write failed for ${root}: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`GitVision could not build the commit-graph: ${(e as Error).message}`);
    }
  });
}
