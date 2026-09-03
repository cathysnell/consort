// #3 fail-closed guard: a `consort-experiment cut` on a DIRTY working tree must hard-fail BEFORE it
// forks/records the experiment. Otherwise createPairedBranch's git checkout is blocked (or silently
// skipped, like its best-effort .env sync), leaving the tree on the FEATURE branch while the
// experiment is recorded as active , so the next role (Navigator RED) runs on the wrong branch,
// finds a prior pass's files, and burns its budget into a PROTOCOL VIOLATION. Refusing before any
// mutation keeps experimentCut false, so the lane halts/retries instead of building on a branch that
// was never checked out. A clean tree (the normal path) is unaffected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutExperiment } from "../../consort/experiment/experiment.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cut-dirty-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.co");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const args = () => ({
  instance: "inst-1",
  consortDir: join(dir, ".lakebase"),
  projectDir: dir,
  featureId: "F1-x",
  storyId: "S1-x",
  experimentSlug: "exp1",
  branch: "experiment/F1-x/S1-x/exp1",
  parentBranch: "feature/F1-x",
});

describe("cutExperiment is fail-closed on uncommitted TRACKED source, but tolerates untracked + .consort churn (#3)", () => {
  it("throws BEFORE forking on an uncommitted TRACKED source change (createPairedBranch never called)", async () => {
    writeFileSync(join(dir, "README.md"), "uncommitted change\n"); // modify a TRACKED file
    let forked = false;
    await expect(
      cutExperiment(args(), {
        createPairedBranch: (async () => {
          forked = true;
          return {} as never;
        }) as never,
        deletePairedBranch: (async () => {}) as never,
      }),
    ).rejects.toThrow(/dirty|uncommitted|working tree/i);
    expect(forked, "createPairedBranch must NOT run on a dirty tree (no fork, no record)").toBe(false);
  });

  it("gets PAST the dirty guard to the paired cut when the tree is clean (control)", async () => {
    // Clean tree (only committed files): the guard passes, so createPairedBranch is reached. A
    // sentinel throw from it proves reach without needing a full valid paired-branch return.
    let forked = false;
    await expect(
      cutExperiment(args(), {
        createPairedBranch: (async () => {
          forked = true;
          throw new Error("REACHED_PAIRED_CUT");
        }) as never,
        deletePairedBranch: (async () => {}) as never,
      }),
    ).rejects.toThrow(/REACHED_PAIRED_CUT/);
    expect(forked, "a clean tree reaches createPairedBranch").toBe(true);
  });

  it("TOLERATES untracked files (a new design artifact / unrelated tool config) , the normal design->build handoff is not blocked", async () => {
    // Untracked files ride onto the fork harmlessly (the build's allow-list commit never stages
    // them); only uncommitted TRACKED source is the fork-corrupting case. So an untracked file must
    // NOT block the cut , this is the over-block the blanket check caused, now fixed.
    writeFileSync(join(dir, "brand-new-untracked.txt"), "not committed, not tracked\n");
    writeFileSync(join(dir, ".isaac-config.json"), "{}\n"); // an unrelated tool's untracked config
    let forked = false;
    await expect(
      cutExperiment(args(), {
        createPairedBranch: (async () => {
          forked = true;
          throw new Error("REACHED_PAIRED_CUT");
        }) as never,
        deletePairedBranch: (async () => {}) as never,
      }),
    ).rejects.toThrow(/REACHED_PAIRED_CUT/);
    expect(forked, "untracked files are tolerated , the cut reaches createPairedBranch").toBe(true);
  });
});
