/**
 * git: URIs for vscode.git's content provider. We key repos by their resolved path (what git prints),
 * but vscode.git knows a repo by the path it opened, which may go through a symlink (macOS /var →
 * /private/var). Its provider only resolves files under a root it knows, so build URIs from that root.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitAPI } from './gitApi';
import { realDir, sameFsPath } from './repoRegistry';

/** `file` (repo-relative) at `ref`, as a git: URI vscode.git can read. */
export function gitUri(api: GitAPI, root: string, file: string, ref: string): vscode.Uri {
  const repo = api.repositories.find((r) => sameFsPath(realDir(r.rootUri.fsPath), root));
  const base = repo ? repo.rootUri.fsPath : root;
  return api.toGitUri(vscode.Uri.file(path.join(base, file)), ref);
}
