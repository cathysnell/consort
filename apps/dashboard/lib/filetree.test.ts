import { describe, it, expect } from "vitest";
import { buildFileTree } from "./filetree";

describe("buildFileTree", () => {
  it("nests dirs, indents files one level deeper, dirs-before-files, all sorted", () => {
    expect(buildFileTree(["src/index.ts", "src/db/pool.ts", "README.md"])).toEqual([
      { kind: "dir", name: "src", path: "src", depth: 0 },
      { kind: "dir", name: "db", path: "src/db", depth: 1 },
      { kind: "file", name: "pool.ts", path: "src/db/pool.ts", depth: 2 },
      { kind: "file", name: "index.ts", path: "src/index.ts", depth: 1 },
      { kind: "file", name: "README.md", path: "README.md", depth: 0 },
    ]);
  });

  it("renders root-level files at depth 0 with no header, sorted", () => {
    expect(buildFileTree(["b.txt", "a.txt"])).toEqual([
      { kind: "file", name: "a.txt", path: "a.txt", depth: 0 },
      { kind: "file", name: "b.txt", path: "b.txt", depth: 0 },
    ]);
  });

  it("strips a leading ./ or /, drops blanks, and dedupes", () => {
    expect(buildFileTree(["./src/a.ts", "/src/a.ts", "", "src/a.ts"])).toEqual([
      { kind: "dir", name: "src", path: "src", depth: 0 },
      { kind: "file", name: "a.ts", path: "src/a.ts", depth: 1 },
    ]);
  });

  it("keeps a full file path for selection while displaying only the basename", () => {
    const rows = buildFileTree(["app/services/orders.ts"]);
    const file = rows.find((r) => r.kind === "file")!;
    expect(file.name).toBe("orders.ts");
    expect(file.path).toBe("app/services/orders.ts");
  });

  it("returns [] for no paths", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
