// P3-prep: the build-handoff leaves for the live champion walk. Build turns mutate
// three things (git commit + paired Lakebase branch + branch DB rows), so the walk
// needs (a) buildSnapshotDeps – capture the pre-turn git SHA, reset the tree to it,
// and (only for GREEN/REFACTOR) re-fork a clean paired branch – and (b) a build gate
// that reads the honest post-turn signal (an unresolved story escalation = the
// honest-GREEN verify failed / the turn halted). Both are hermetic here: git +
// cutExperiment are injected, and the gate reads a temp .sftdd escalations dir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeBuildSnapshotDeps, makeBuildGate } from "../../consort/optimize/optimize-live";

describe("makeBuildSnapshotDeps (git + re-fork injected)", () => {
  it("captureSha delegates to the injected git.sha; resetHard resets to it; reFork re-forks", async () => {
    const calls: string[] = [];
    const deps = makeBuildSnapshotDeps({
      projectDir: "/p",
      story: "S1",
      cutArgs: { instance: "inst", consortDir: "/p/.sftdd", featureId: "F1", experimentSlug: "s1-opt", branch: "feat", parentBranch: "staging" },
      git: {
        sha: async () => {
          calls.push("sha");
          return "abc123";
        },
        resetHard: async (sha) => {
          calls.push(`reset:${sha}`);
        },
      },
      reForkImpl: async (args) => {
        calls.push(`refork:${args.resetStaleBranch ? "reset" : "plain"}`);
      },
    });
    const sha = await deps.captureSha();
    expect(sha).toBe("abc123");
    await deps.resetHard("abc123");
    await deps.reFork();
    expect(calls).toEqual(["sha", "reset:abc123", "refork:reset"]);
  });

  it("reFork always passes resetStaleBranch (a candidate's discarded branch must be dropped before re-fork)", async () => {
    let resetStale: boolean | undefined;
    const deps = makeBuildSnapshotDeps({
      projectDir: "/p",
      story: "S1",
      cutArgs: { instance: "inst", consortDir: "/p/.sftdd", featureId: "F1", experimentSlug: "s1-opt", branch: "feat", parentBranch: "staging" },
      git: { sha: async () => "x", resetHard: async () => {} },
      reForkImpl: async (args) => {
        resetStale = args.resetStaleBranch;
      },
    });
    await deps.reFork();
    expect(resetStale).toBe(true);
  });
});

describe("makeBuildGate (honest post-turn signal)", () => {
  let consortDir: string;
  const featureId = "F1";
  const story = "S1";
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "optimize-buildgate-"));
    consortDir = join(root, ".sftdd");
    mkdirSync(join(consortDir, "escalations"), { recursive: true });
  });
  afterEach(() => rmSync(join(consortDir, ".."), { recursive: true, force: true }));

  function writeEscalation(id: string, resolved: boolean, storyId: string | undefined = story): void {
    writeFileSync(
      join(consortDir, "escalations", `${id}.json`),
      JSON.stringify({ id, source: "driver-green", feature_id: featureId, story_id: storyId, ...(resolved ? { resolved_at: "2026-08-02T00:00:00Z" } : {}) }),
    );
  }

  it("PASSES when no unresolved story escalation exists after the turn", () => {
    const gate = makeBuildGate(consortDir, featureId);
    expect(gate({ handoff: { id: "S1-driver-green", role: "driver", story, buildMode: "green" } })).toEqual({ passed: true });
  });

  it("FAILS when the turn raised an unresolved escalation for this story (honest-GREEN halt)", () => {
    writeEscalation("e1", false);
    const gate = makeBuildGate(consortDir, featureId);
    const r = gate({ handoff: { id: "S1-driver-green", role: "driver", story, buildMode: "green" } });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/escalation/i);
  });

  it("ignores a RESOLVED escalation (the self-heal cleared it, so the turn is honest-green)", () => {
    writeEscalation("e1", true);
    const gate = makeBuildGate(consortDir, featureId);
    expect(gate({ handoff: { id: "S1-driver-green", role: "driver", story, buildMode: "green" } }).passed).toBe(true);
  });

  it("ignores an escalation for a DIFFERENT story", () => {
    writeEscalation("e2", false, "S2");
    const gate = makeBuildGate(consortDir, featureId);
    expect(gate({ handoff: { id: "S1-driver-green", role: "driver", story, buildMode: "green" } }).passed).toBe(true);
  });
});
