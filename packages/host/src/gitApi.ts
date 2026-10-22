/** The subset of the built-in vscode.git extension API we use (see vscode/extensions/git/src/api/git.d.ts). */
import type { Event, Uri } from 'vscode';

export interface GitRepository {
  readonly rootUri: Uri;
  /** Fires when vscode.git refreshes the repository (HEAD, refs, index, working tree). */
  readonly state: { readonly onDidChange: Event<void> };
}
export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
  /** A git: URI for `uri` at `ref`, readable by the built-in git content provider. */
  toGitUri(uri: Uri, ref: string): Uri;
}
export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}
