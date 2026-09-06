// A mid-run kit upgrade must leave the working tree CLEAN, or the run's next experiment/feature
// fork refuses (paired-branch rejects uncommitted tracked files that would ride onto the branch).
// commitRefreshedSurface commits EXACTLY the kit-owned surface refreshSurface + pinBoth rewrite ,
// never the app code or the .consort corpus – so the fork sees a clean tree. Real temp git repo.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRefreshedSurface } from "../../consort/lakebase/upgrade";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-commit-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "commit", "--allow-empty", "-q", "-m", "root");
  return dir;
}
function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("commitRefreshedSurface (mid-run upgrade leaves a clean tree)", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("commits the refreshed kit surface but NOT app code or the .consort corpus", () => {
    // Baseline: the kit surface already tracked + committed.
    write(dir, ".claude/commands/start.md", "old");
    write(dir, ".claude/agents/spec-author.md", "old");
    write(dir, ".lakebase/kit-ref", "v0.3.45\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "baseline surface");

    // The upgrade rewrites the kit surface AND the run has its own dirt (app edit + corpus churn).
    write(dir, ".claude/commands/start.md", "new for v0.3.46");
    write(dir, ".lakebase/kit-ref", "v0.3.46\n");
    write(dir, "server/app.py", "print('mid-edit')");   // untracked APP code – must NOT be committed
    write(dir, ".consort/run-state.json", "{}");          // corpus churn – must NOT be committed

    const res = commitRefreshedSurface(dir, "v0.3.46");
    expect(res.committed).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(dir, "log", "-1", "--pretty=%s").trim()).toBe("chore(kit): refresh scaffolded surface to v0.3.46");
    // The committed content is the NEW surface.
    expect(git(dir, "show", "HEAD:.claude/commands/start.md")).toContain("v0.3.46");
    expect(git(dir, "show", "HEAD:.lakebase/kit-ref")).toContain("v0.3.46");
    // App code + corpus are still UNTRACKED (not swept into the kit commit). -uall lists
    // untracked FILES individually (plain --porcelain collapses a wholly-untracked dir).
    const porcelain = git(dir, "status", "--porcelain", "-uall").trim();
    expect(porcelain).toContain("server/app.py");
    expect(porcelain).toContain(".consort/run-state.json");
    expect(porcelain).not.toContain(".claude/commands");
    expect(porcelain).not.toContain(".lakebase/kit-ref");
  });

  it("is a no-op when the kit surface is already clean", () => {
    write(dir, ".claude/commands/start.md", "x");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "surface");
    expect(commitRefreshedSurface(dir, "v0.3.46")).toMatchObject({ committed: false, reason: "nothing-to-commit" });
  });

  it("is a no-op (nothing-to-commit) when no kit surface exists at all", () => {
    expect(commitRefreshedSurface(dir, "v0.3.46")).toMatchObject({ committed: false, reason: "nothing-to-commit" });
  });

  it("is a safe no-op outside a git repo", () => {
    const bare = mkdtempSync(join(tmpdir(), "upgrade-nogit-"));
    try {
      expect(commitRefreshedSurface(bare, "v0.3.46")).toMatchObject({ committed: false, reason: "not-a-git-repo" });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
