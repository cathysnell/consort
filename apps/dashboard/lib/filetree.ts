// Pure directory-tree builder for the drill-down Code pane: turns a flat list of file paths into an
// ordered, depth-indented render list of directory headers + file rows (the template's .tree-dir /
// .tree-file). No React — kept standalone so it is unit-tested directly.

export interface FileTreeRow {
  kind: "dir" | "file";
  /** Segment to display: a directory name, or a file's basename. */
  name: string;
  /** Full path for a `file` (used to select/fetch it); the directory prefix for a `dir`. */
  path: string;
  /** Indent depth; 0 = top level. */
  depth: number;
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: string[]; // basenames at this level
}

function emptyNode(): TreeNode {
  return { dirs: new Map(), files: [] };
}

/**
 * Build an ordered, flat render list from file paths. Each directory emits a `dir` row followed by
 * its subdirectories (recursively) and then its files, everything sorted and depth-indented; a file
 * sits one level deeper than its directory. Root-level files (no `/`) render at depth 0 with no
 * header. A leading `./` or `/` is stripped, blank paths and duplicates are dropped.
 */
export function buildFileTree(paths: string[]): FileTreeRow[] {
  const root = emptyNode();
  for (const raw of paths) {
    const clean = String(raw ?? "").replace(/^\.\//, "").replace(/^\/+/, "").trim();
    if (!clean) continue;
    const segs = clean.split("/").filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = segs[i];
      let next = node.dirs.get(dir);
      if (!next) {
        next = emptyNode();
        node.dirs.set(dir, next);
      }
      node = next;
    }
    const file = segs[segs.length - 1];
    if (!node.files.includes(file)) node.files.push(file);
  }

  const rows: FileTreeRow[] = [];
  const walk = (node: TreeNode, prefix: string, depth: number): void => {
    for (const dir of [...node.dirs.keys()].sort()) {
      const path = prefix ? `${prefix}/${dir}` : dir;
      rows.push({ kind: "dir", name: dir, path, depth });
      walk(node.dirs.get(dir)!, path, depth + 1);
    }
    for (const file of [...node.files].sort()) {
      const path = prefix ? `${prefix}/${file}` : file;
      rows.push({ kind: "file", name: file, path, depth });
    }
  };
  walk(root, "", 0);
  return rows;
}
