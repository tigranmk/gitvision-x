/** Changed files as a tree: folders first, single-child folder chains compressed (`src/lib`). */
import type { GraphFile } from '@gvx/protocol';

export interface TreeNode {
  name: string;
  /** Folder path or file path; unique within a tree. */
  path: string;
  children?: TreeNode[];
  file?: GraphFile;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export function buildTree(files: GraphFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = dir.children!.find((c) => c.children && c.path === path);
      if (!next) dir.children!.push((next = { name: parts[i]!, path, children: [] }));
      dir = next;
    }
    dir.children!.push({ name: parts.at(-1)!, path: f.path, file: f });
  }
  return sortAndCompress(root).children!;
}

function sortAndCompress(n: TreeNode): TreeNode {
  if (!n.children) return n;
  n.children = n.children.map(sortAndCompress).map((c) => {
    // A folder whose only child is a folder merges with it: src → lib becomes "src/lib".
    while (c.children && c.children.length === 1 && c.children[0]!.children) {
      const only = c.children[0]!;
      c = { name: `${c.name}/${only.name}`, path: only.path, children: only.children };
    }
    return c;
  });
  n.children.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
  return n;
}

/** Visible rows, skipping the contents of collapsed folders. */
export function flatten(nodes: TreeNode[], collapsed: ReadonlySet<string>, depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children && !collapsed.has(node.path)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}
