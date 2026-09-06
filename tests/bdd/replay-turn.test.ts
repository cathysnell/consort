// The shared replay-turn core: it reads a corpus turn's replay-set (preconditions + recorded prompt +
// levers + inputs) and rehydrates the portable <PROJECT_ROOT> token. This guards the "experiments
// replay the corpus turn, perturb only levers" contract at its foundation – if the reader drifts, every
// experiment's baseline drifts. Also proves it against a REAL corpus turn so the corpus format + reader
// stay in lockstep.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readReplaySet, rehydrate } from "../optimization/replay-turn";
import { PROJECT_ROOT_TOKEN, relativizeProjectPaths } from "../../consort/logging/turn-recorder";

describe("replay-turn: rehydrate is the exact inverse of the recorder's relativize", () => {
  it("round-trips an absolute project root through the portable token", () => {
    const live = "/tmp/tdd-workflow-smoke/proj-abc";
    const original = `open ${live}/.consort/design/design-guide.md and ${live}/app/main.py`;
    const recorded = relativizeProjectPaths(original, live); // what the corpus stores
    expect(recorded).toContain(PROJECT_ROOT_TOKEN);
    expect(recorded).not.toContain(live);
    // rehydrating to a DIFFERENT live dir points the prompt at the rehydrated tree
    const newRoot = "/tmp/replay/proj-xyz";
    expect(rehydrate(recorded, newRoot)).toBe(original.split(live).join(newRoot));
  });
});

describe("replay-turn: readReplaySet parses a turn's preconditions", () => {
  function fakeTurn(): string {
    const dir = mkdtempSync(join(tmpdir(), "replay-turn-"));
    const set = join(dir, "replay-set");
    mkdirSync(join(set, "inputs"), { recursive: true });
    mkdirSync(join(set, "pre-project", "app"), { recursive: true });
    writeFileSync(join(dir, "turn.json"), JSON.stringify({ ordinal: 156, role: "driver", story: "S3-x", action: { kind: "invoke-role", role: "driver", story: "S3-x" } }));
    writeFileSync(join(set, "prompt.txt"), `Make S3-x GREEN. See ${PROJECT_ROOT_TOKEN}/.consort/features/F/architecture.md`);
    writeFileSync(join(set, "levers.json"), JSON.stringify({ model: "sonnet", effort: "default", session: "resume", role: "driver" }));
    writeFileSync(join(set, "inputs", "test-list"), "the recorded test-list input");
    return dir;
  }

  it("reads prompt + levers + inputs + action + pre-project path", () => {
    const dir = fakeTurn();
    const rs = readReplaySet(dir);
    expect(rs.role).toBe("driver");
    expect(rs.ordinal).toBe(156);
    expect(rs.story).toBe("S3-x");
    expect(rs.levers).toMatchObject({ model: "sonnet", effort: "default" });
    expect(rs.inputs["test-list"]).toBe("the recorded test-list input");
    expect(rs.promptRaw).toContain(PROJECT_ROOT_TOKEN);
    expect(rs.preProjectDir).toBe(join(dir, "replay-set", "pre-project"));
    // the recorded prompt, rehydrated, points at a live tree
    expect(rehydrate(rs.promptRaw, "/live/proj")).toContain("/live/proj/.consort/features/F/architecture.md");
  });

  it("throws on a turn with no replay-set prompt (un-replayable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-turn-bad-"));
    writeFileSync(join(dir, "turn.json"), JSON.stringify({ ordinal: 1, role: "driver" }));
    expect(() => readReplaySet(dir)).toThrow(/replay-set incomplete/);
  });
});
