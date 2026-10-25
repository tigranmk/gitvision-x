/** FileSystemProvider for gitvision: revision documents (read-only; blobs come from the git engine). */
import * as vscode from 'vscode';
import type { WorkerPool } from '@gvx/git-engine';
import { SCHEME, parseRevisionUri } from './revisionUri';

export function registerRevisionFs(pool: WorkerPool): vscode.Disposable {
  const never = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const readonly = () => {
    throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
  };
  const read = async (uri: vscode.Uri) => {
    const r = parseRevisionUri(uri);
    if (!r) throw vscode.FileSystemError.FileNotFound(uri);
    try {
      return (await pool.request('file.blob', { root: r.root, rev: r.rev }, { affinity: r.root })).bytes;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  };
  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: never.event,
    watch: () => new vscode.Disposable(() => {}),
    async stat(uri) {
      const bytes = await read(uri);
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.length, permissions: vscode.FilePermission.Readonly };
    },
    readFile: read,
    readDirectory: () => [],
    createDirectory: readonly,
    writeFile: readonly,
    delete: readonly,
    rename: readonly,
  };
  return vscode.Disposable.from(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isReadonly: true, isCaseSensitive: true }),
    never,
  );
}
