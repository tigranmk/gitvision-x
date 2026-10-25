import { describe, expect, it } from 'vitest';
import type { GraphFile } from '@gvx/protocol';
import { buildTree, flatten } from './fileTree';

const f = (path: string): GraphFile => ({ path, status: 'M', added: 1, removed: 0, binary: false, open: false });

describe('file tree', () => {
  it('puts folders first, sorts by name and compresses single-folder chains', () => {
    const tree = buildTree([f('src/lib/util/a.ts'), f('src/lib/util/b.ts'), f('README.md'), f('src/main.ts'), f('docs/x/y/z.md')]);
    const rows = flatten(tree, new Set()).map((r) => `${'  '.repeat(r.depth)}${r.node.name}`);
    expect(rows).toEqual(['docs/x/y', '  z.md', 'src', '  lib/util', '    a.ts', '    b.ts', '  main.ts', 'README.md']);
  });

  it('hides the contents of collapsed folders', () => {
    const tree = buildTree([f('src/a.ts'), f('src/b.ts'), f('top.ts')]);
    expect(flatten(tree, new Set(['src'])).map((r) => r.node.path)).toEqual(['src', 'top.ts']);
  });
});
