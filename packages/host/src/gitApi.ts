/** The subset of the built-in vscode.git extension API we use (see vscode/extensions/git/src/api/git.d.ts). */
import type { Event, Uri } from 'vscode';

export interface GitRepository {
  readonly rootUri: Uri;
}
export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}
export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}
