import { describe, expect, it, vi } from 'vitest';

// A minimal vscode.Uri: enough for building and parsing gitvision: URIs.
vi.mock('vscode', () => {
  class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query: string) {}
    static from(c: { scheme: string; authority: string; path: string; query: string }) {
      return new Uri(c.scheme, c.authority, c.path, c.query);
    }
  }
  return { Uri };
});

const sha = 'a'.repeat(40);

describe('revision URIs', () => {
  it('round-trips a revision, renamed paths included', async () => {
    const { parseRevisionUri, revisionUri } = await import('./revisionUri');
    const uri = revisionUri('/repo/root', { sha, path: 'src/old name.ts' });
    expect(uri.path).toBe('/repo/root/src/old name.ts');
    expect(parseRevisionUri(uri)).toEqual({ root: '/repo/root', rev: { sha, path: 'src/old name.ts' } });
  });

  it('accepts a Windows drive letter VS Code lower-cased in the path', async () => {
    const { parseRevisionUri } = await import('./revisionUri');
    const { Uri } = await import('vscode');
    const uri = Uri.from({ scheme: 'gitvision', authority: sha, path: '/c:/Users/me/repo/lib/a.ts', query: 'C:/Users/me/repo' });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(parseRevisionUri(uri)).toEqual({ root: 'C:/Users/me/repo', rev: { sha, path: 'lib/a.ts' } });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('rejects other schemes, bad ids and paths outside the root', async () => {
    const { parseRevisionUri } = await import('./revisionUri');
    const { Uri } = await import('vscode');
    expect(parseRevisionUri(Uri.from({ scheme: 'file', authority: '', path: '/repo/a', query: '' }))).toBeNull();
    expect(parseRevisionUri(Uri.from({ scheme: 'gitvision', authority: 'HEAD', path: '/repo/a', query: '/repo' }))).toBeNull();
    expect(parseRevisionUri(Uri.from({ scheme: 'gitvision', authority: sha, path: '/elsewhere/a', query: '/repo' }))).toBeNull();
    expect(parseRevisionUri(Uri.from({ scheme: 'gitvision', authority: sha, path: '/repository/a', query: '/repo' }))).toBeNull();
  });
});
