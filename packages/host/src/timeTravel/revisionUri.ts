/**
 * Read-only documents for file revisions: gitvision://<sha>/<absolute path at that revision>?<repo root>.
 * The path is the file's path at that revision (it may predate a rename), so the root rides in the query.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RevisionRef } from '@gvx/protocol';

export const SCHEME = 'gitvision';

export function revisionUri(root: string, rev: RevisionRef): vscode.Uri {
  const abs = path.posix.join(root.replace(/\\/g, '/'), rev.path);
  return vscode.Uri.from({ scheme: SCHEME, authority: rev.sha, path: abs.startsWith('/') ? abs : `/${abs}`, query: root });
}

/** The repo root and revision a gitvision: URI names, or null for anything else. */
export function parseRevisionUri(uri: vscode.Uri): { root: string; rev: RevisionRef } | null {
  if (uri.scheme !== SCHEME || !/^[0-9a-f]{40}$/.test(uri.authority) || !uri.query) return null;
  const root = uri.query.replace(/\\/g, '/').replace(/\/$/, '');
  const abs = uri.path.replace(/^\/(?=[A-Za-z]:)/, ''); // /C:/x → C:/x on Windows
  const base = root.replace(/^\/(?=[A-Za-z]:)/, '');
  // VS Code lower-cases a Windows drive letter in URI paths (c:/…) but not in the query: compare paths the
  // way the file system does (case-insensitively on Windows and macOS).
  const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  if (!fold(abs).startsWith(`${fold(base)}/`)) return null;
  const rel = abs.slice(base.length + 1);
  if (!rel) return null;
  return { root, rev: { sha: uri.authority, path: rel } };
}
