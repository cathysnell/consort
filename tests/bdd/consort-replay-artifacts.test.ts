// replayDesignTurn copies a design role's recorded output per-turn so the
// fast-forward driver VISITS every stage (not pre-seed-and-skip). The key
// faithfulness property: the Spec Author turn copies each AC VERBATIM (the spec
// author authors `layer`), and the Architect turn – when dispatched – re-copies
// them idempotently + adds architecture.json. The design probe dispatches/skips
// the Architect on architectural_notes + architecture.json + the canon, NOT on
// `layer`, so the Spec Author must not strip it (a cleanly-mapping story gets its
// notes PROJECTED with no Architect turn to restore a stripped layer). A story the
// corpus lacks returns false: the caller (drive.cli.ts) treats a replay corpus miss
// as a HARD FAILURE (ReplayCorpusMissError) – a replay is a recording and must never
// fall through to a live agent.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replayDesignTurn, restoreReflectVerdict, REPLAYABLE_DESIGN_ROLES } from "../../consort/logging/replay-artifacts.js";

const F = "F1-file-bug";
const S = "S1-file-bug";
let corpus: string;
let tdd: string;

function wj(p: string, o: unknown) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
}

beforeEach(() => {
  corpus = mkdtempSync(join(tmpdir(), "ff-corpus-"));
  tdd = mkdtempSync(join(tmpdir(), "ff-tdd-"));
  const cf = join(corpus, "features", F);
  wj(join(cf, "feature-spec.json"), { id: F, stories: [{ id: S }] });
  writeFileSync(join(cf, "feature-spec.md"), "# spec\n");
  mkdirSync(join(cf, "stories", S), { recursive: true });
  wj(join(cf, "stories", S, "story.json"), { id: S, title: "file a bug" });
  writeFileSync(join(cf, "stories", S, "story.md"), "# story\n");
  wj(join(cf, "stories", S, "acs", "AC1.json"), { id: "AC1", given: "g", layer: "E2E" });
  wj(join(cf, "architecture.json"), { feature_id: F, layers: [] });
  writeFileSync(join(cf, "architecture.md"), "# arch\n");
  wj(join(cf, "db-design.json"), { feature_id: F, tables: [{ name: "bugs" }], realizes_invariants: [] });
  writeFileSync(join(cf, "db-design.md"), "# db-design\n");
  wj(join(cf, "test-list.json"), { feature_id: F, items: [{ id: "T1", ac_id: "AC1" }] });
  writeFileSync(join(cf, "test-list.md"), "# tests\n");
  mkdirSync(join(corpus, "design"), { recursive: true });
  wj(join(corpus, "design", "design-guide.json"), { tokens: {} });
  mkdirSync(join(corpus, "planning"), { recursive: true });
  writeFileSync(join(corpus, "planning", "feature-proposals.md"), "# proposals\n");
  wj(join(corpus, "planning", "estimates.json"), { estimates: [{ feature_id: "FP1", size: "M" }] });
});

afterEach(() => {
  rmSync(corpus, { recursive: true, force: true });
  rmSync(tdd, { recursive: true, force: true });
});

const acFile = () => join(tdd, "features", F, "stories", S, "acs", "AC1.json");

describe("replayDesignTurn: each stage's output is replayed per-turn", () => {
  it("spec-author breakdown copies feature-spec + story stubs, NOT the ACs", () => {
    expect(replayDesignTurn({ turn: { role: "spec-author", mode: "breakdown" }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(existsSync(join(tdd, "features", F, "feature-spec.json"))).toBe(true);
    expect(existsSync(join(tdd, "features", F, "stories", S, "story.json"))).toBe(true);
    expect(existsSync(acFile())).toBe(false); // ACs are the per-story Spec Author turn
  });

  it("spec-author per-story copies the ACs VERBATIM, preserving `layer` (the spec author authors it)", () => {
    expect(replayDesignTurn({ turn: { role: "spec-author", story: S }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(existsSync(acFile())).toBe(true);
    expect(JSON.parse(readFileSync(acFile(), "utf8")).layer).toBe("E2E");
  });

  it("architect-reviewer re-copies the ACs (idempotent) + copies architecture", () => {
    replayDesignTurn({ turn: { role: "spec-author", story: S }, replayDir: corpus, consortDir: tdd, featureId: F });
    expect(replayDesignTurn({ turn: { role: "architect-reviewer", story: S }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(JSON.parse(readFileSync(acFile(), "utf8")).layer).toBe("E2E");
    expect(existsSync(join(tdd, "features", F, "architecture.json"))).toBe(true);
  });

  it("dba copies the feature db-design (json + md) so the DBA turn is replayed, not spawned live", () => {
    // The design lane dispatches the DBA per-story (architect -> dba -> test-strategist).
    // A corpus captured with the DBA role MUST replay db-design.json from disk; a
    // fall-through to a live DBA spawn would diverge the schema and can fail the spec gate.
    expect(replayDesignTurn({ turn: { role: "dba", story: S }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(existsSync(join(tdd, "features", F, "db-design.json"))).toBe(true);
    expect(existsSync(join(tdd, "features", F, "db-design.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(tdd, "features", F, "db-design.json"), "utf8")).tables[0].name).toBe("bugs");
  });

  it("test-strategist copies the feature test-list; ux-designer copies the design guide", () => {
    expect(replayDesignTurn({ turn: { role: "test-strategist", story: S }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(existsSync(join(tdd, "features", F, "test-list.json"))).toBe(true);
    expect(replayDesignTurn({ turn: { role: "ux-designer" }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(true);
    expect(existsSync(join(tdd, "design", "design-guide.json"))).toBe(true);
  });

  it("a story the corpus does not cover returns false (a corpus miss; the driver hard-fails, never runs a live agent)", () => {
    expect(replayDesignTurn({ turn: { role: "spec-author", story: "S2-not-recorded" }, replayDir: corpus, consortDir: tdd, featureId: F })).toBe(false);
  });

  // PLANNING-lane turns (no feature scope): the Spec Author PROPOSE + the Architect ESTIMATE /
  // ESTIMATE-COMMITTED are sprint-scoped (featureId is EMPTY), so they must replay from
  // planning/*.json, NOT features/<f>/. A planning replay (--sprint) drives these; the legacy
  // path missed estimate/estimate-committed (it tried features//architecture.json), causing a
  // REPLAY CORPUS MISS on a --sprint replay. The recorded estimate turns produce planning/estimates.json;
  // sync-backlog (a separate command) re-derives the sprint backlog from it, so only estimates.json
  // needs restoring here.
  it("spec-author propose replays planning/feature-proposals.md (feature-less)", () => {
    expect(replayDesignTurn({ turn: { role: "spec-author", mode: "propose" }, replayDir: corpus, consortDir: tdd, featureId: "" })).toBe(true);
    expect(existsSync(join(tdd, "planning", "feature-proposals.md"))).toBe(true);
  });

  it("architect-reviewer estimate + estimate-committed replay planning/estimates.json (feature-less, NOT a corpus miss)", () => {
    expect(replayDesignTurn({ turn: { role: "architect-reviewer", mode: "estimate" }, replayDir: corpus, consortDir: tdd, featureId: "" })).toBe(true);
    expect(existsSync(join(tdd, "planning", "estimates.json"))).toBe(true);
    // estimate-committed re-sizes the committed features into the SAME estimates.json.
    expect(replayDesignTurn({ turn: { role: "architect-reviewer", mode: "estimate-committed" }, replayDir: corpus, consortDir: tdd, featureId: "" })).toBe(true);
  });

  // Anti-recurrence guard: every design role the router can dispatch must be
  // replayable, else the drive falls through to a live model spawn on replay (the
  // exact DBA gap that let a live DBA turn diverge a captured corpus's schema).
  it("every dispatchable DesignRole is in REPLAYABLE_DESIGN_ROLES", () => {
    // Mirrors orchestrator-drive.ts `DesignRole` (kept in lockstep by hand: a new
    // design role added there without a replay case here trips this test).
    const dispatchableDesignRoles = ["spec-author", "architect-reviewer", "dba", "test-strategist"];
    for (const role of dispatchableDesignRoles) {
      expect(REPLAYABLE_DESIGN_ROLES.has(role)).toBe(true);
    }
  });
});

describe("restoreReflectVerdict: the reflect turn's .sftdd verdict (filtered by the code-only build restore)", () => {
  it("restores the recorded reflect-verdict.json from the design corpus into the project", () => {
    // The reflect turn replays as a build turn (code only, .sftdd filtered), so its
    // verdict must be brought back from recorded-artifacts or the drive aborts.
    const src = join(corpus, "features", F, "stories", S, "reflect-verdict.json");
    wj(src, { version: 1, passed: true, findings: [] });
    expect(restoreReflectVerdict({ replayDir: corpus, consortDir: tdd, featureId: F, story: S })).toBe(true);
    const dst = join(tdd, "features", F, "stories", S, "reflect-verdict.json");
    expect(existsSync(dst)).toBe(true);
    expect(JSON.parse(readFileSync(dst, "utf8")).passed).toBe(true);
  });

  it("returns false when the corpus has no verdict (a corpus miss; the driver hard-fails, never runs the reflect live)", () => {
    expect(restoreReflectVerdict({ replayDir: corpus, consortDir: tdd, featureId: F, story: S })).toBe(false);
  });
});
