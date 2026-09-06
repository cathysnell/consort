// The universal turn recorder captures EVERY state-machine turn (design + build
// + gates + ...) as a replayable timeline: turns/<NNNN>-<label>/ (manifest + the
// .consort/code delta produced) + a cumulative recorded-artifacts mirror the existing
// replayDesignTurn consumes. These hermetic tests drive recordTurn across
// simulated turns and assert the timeline, the delta, the mirror, the ordered
// index, and a record -> replay round-trip.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurn, labelForAction, seedRecorderBaseline, relativizeProjectPaths, PROJECT_ROOT_TOKEN } from "../../consort/logging/turn-recorder.js";
import { replayDesignTurn } from "../../consort/logging/replay-artifacts.js";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive.js";

const tmpDirs: string[] = [];
function mkProject(): { proj: string; consort: string; record: string } {
  const proj = mkdtempSync(join(tmpdir(), "turn-rec-proj-"));
  tmpDirs.push(proj);
  const consort = join(proj, ".consort");
  mkdirSync(consort, { recursive: true });
  const record = mkdtempSync(join(tmpdir(), "turn-rec-out-"));
  tmpDirs.push(record);
  return { proj, consort, record };
}
const act = (o: Record<string, unknown>): WorkflowAction => o as unknown as WorkflowAction;
function writeConsort(consort: string, rel: string, body: string): void {
  const f = join(consort, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
}
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("labelForAction", () => {
  it("labels role turns by role (+ mode when present)", () => {
    expect(labelForAction(act({ kind: "invoke-role", role: "spec-author", mode: "propose" }))).toBe("spec-author-propose");
    expect(labelForAction(act({ kind: "invoke-role", role: "ux-designer" }))).toBe("ux-designer");
    expect(labelForAction(act({ kind: "invoke-role", role: "driver", buildMode: "green" }))).toBe("driver-green");
  });
  it("labels gates + falls back to kind", () => {
    expect(labelForAction(act({ kind: "approve-plan-gate" }))).toBe("gate-plan");
    expect(labelForAction(act({ kind: "approve-gate", story: "S1" }))).toBe("gate-spec");
    expect(labelForAction(act({ kind: "approve-deploy-gate" }))).toBe("gate-deploy");
    expect(labelForAction(act({ kind: "approve-promote-gate" }))).toBe("gate-promote");
    expect(labelForAction(act({ kind: "cut-experiment", story: "S1" }))).toBe("cut-experiment");
    expect(labelForAction(act({ kind: "prepare-pr" }))).toBe("prepare-pr");
    // `done` is the terminal turn (parent checkout + feature-branch delete): it must
    // label to its kind so a faithful capture ends at a recorded `done`, not `merge`.
    expect(labelForAction(act({ kind: "done" }))).toBe("done");
  });
});

describe("recordTurn: per-turn timeline + cumulative .consort mirror", () => {
  it("records each turn's delta, mirrors .consort, and keeps an ordered index", () => {
    const { proj, consort, record } = mkProject();

    // Turn 0 – a design turn writes a feature spec under .consort.
    writeConsort(consort, "features/F1/feature-spec.json", JSON.stringify({ id: "F1" }));
    const t0 = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "spec-author", mode: "breakdown", story: "S1" }) });
    expect(t0.ordinal).toBe(0);
    expect(t0.dir).toBe("0000-spec-author-breakdown");
    expect(t0.produced).toContain(".consort/features/F1/feature-spec.json");
    // manifest + delta copy + cumulative mirror
    const m0 = readJson(join(record, "turns", t0.dir, "turn.json"));
    expect(m0.role).toBe("spec-author");
    expect(m0.story).toBe("S1");
    expect(existsSync(join(record, "turns", t0.dir, "files", ".consort/features/F1/feature-spec.json"))).toBe(true);
    expect(existsSync(join(record, "recorded-artifacts", "features/F1/feature-spec.json"))).toBe(true);

    // Turn 1 – a build turn writes production code (NOT under .consort).
    writeFileSync(join(proj, "main.py"), "x = 1\n");
    const t1 = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 1, action: act({ kind: "invoke-role", role: "driver", buildMode: "green" }) });
    expect(t1.ordinal).toBe(1);
    expect(t1.produced).toContain("main.py");
    expect(existsSync(join(record, "turns", t1.dir, "files", "main.py"))).toBe(true);
    // code is NOT mirrored into recorded-artifacts (that is .consort-only; code -> recorded-build)
    expect(existsSync(join(record, "recorded-artifacts", "main.py"))).toBe(false);

    // Turn 2 – modify an existing .consort artifact: delta picks up only the change.
    writeConsort(consort, "features/F1/feature-spec.json", JSON.stringify({ id: "F1", v: 2 }));
    const t2 = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 2, action: act({ kind: "invoke-role", role: "architect-reviewer", story: "S1" }) });
    expect(t2.produced).toEqual([".consort/features/F1/feature-spec.json"]);
    expect(readJson(join(record, "recorded-artifacts", "features/F1/feature-spec.json")).v).toBe(2);

    // Ordered index has all three turns.
    const index = readJson(join(record, "turns", "index.json")).turns;
    expect(index.map((t: { ordinal: number }) => t.ordinal)).toEqual([0, 1, 2]);
    expect(index.map((t: { label: string }) => t.label)).toEqual(["spec-author-breakdown", "driver-green", "architect-reviewer"]);
  });

  it("records a terminal `done` turn (zero-delta) so the capture ends at done, not merge", () => {
    const { proj, consort, record } = mkProject();
    // A prior real turn, then the terminal `done` (parent checkout + branch delete)
    // produces no .consort delta but MUST still be a recorded turn (the CLI recorder
    // used to early-return on `done` as a "no-op", dropping the terminal step from
    // every capture). recordTurn tolerates a zero produced/deleted turn, as merge/
    // gate turns already do.
    recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "spec-author" }) });
    const done = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 1, action: act({ kind: "done" }) });
    expect(done.produced).toEqual([]);
    expect(done.deleted).toEqual([]);
    const index = readJson(join(record, "turns", "index.json")).turns;
    expect(index[index.length - 1].label).toBe("done");
    expect(index[index.length - 1].kind).toBe("done");
  });

  it("records deletions + removes them from the cumulative mirror", () => {
    const { proj, consort, record } = mkProject();
    writeConsort(consort, "features/F1/stories/S1/story.json", JSON.stringify({ id: "S1" }));
    recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "spec-author" }) });
    expect(existsSync(join(record, "recorded-artifacts", "features/F1/stories/S1/story.json"))).toBe(true);

    rmSync(join(consort, "features/F1/stories/S1/story.json"));
    const t = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 1, action: act({ kind: "invoke-role", role: "spec-author" }) });
    expect(t.deleted).toContain(".consort/features/F1/stories/S1/story.json");
    expect(existsSync(join(record, "recorded-artifacts", "features/F1/stories/S1/story.json"))).toBe(false);
  });

  it("seedRecorderBaseline makes turn 0 report only what that turn produced (not pre-existing scaffold)", () => {
    const { proj, consort, record } = mkProject();
    // Pre-existing scaffold + intake (present before any turn).
    writeConsort(consort, "product-overview.md", "# overview");
    writeFileSync(join(proj, "pyproject.toml"), "[project]\n");
    // Seed the baseline (what withTurnRecording does at construction).
    expect(seedRecorderBaseline({ recordDir: record, projectDir: proj, consortDir: consort })).toBe(true);
    // Re-seed is a no-op once a baseline exists.
    expect(seedRecorderBaseline({ recordDir: record, projectDir: proj, consortDir: consort })).toBe(false);
    // Turn 0 produces ONE new artifact.
    writeConsort(consort, "planning/feature-proposals.md", "# proposals");
    const t = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "spec-author", mode: "propose" }) });
    expect(t.produced).toEqual([".consort/planning/feature-proposals.md"]); // ONLY the new file
    expect(t.produced).not.toContain(".consort/product-overview.md"); // pre-existing, not attributed
  });

  it("does not record the append-only agent-log as a produced artifact", () => {
    const { proj, consort, record } = mkProject();
    writeFileSync(join(consort, "agent-log.jsonl"), '{"e":1}\n');
    writeConsort(consort, "design/design-guide.json", "{}");
    const t = recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "ux-designer" }) });
    expect(t.produced).toContain(".consort/design/design-guide.json");
    expect(t.produced).not.toContain(".consort/agent-log.jsonl");
  });
});

describe("record -> replay round-trip", () => {
  it("recorded-artifacts produced by the recorder is consumable by replayDesignTurn", () => {
    const { proj, consort, record } = mkProject();
    // Record a ux-designer turn that produced the design guide + ia.
    writeConsort(consort, "design/design-guide.json", JSON.stringify({ tokens: { color: "#111" } }));
    writeConsort(consort, "design/design-guide.md", "# Guide\n");
    writeConsort(consort, "design/ia.md", "# IA\n");
    recordTurn({ recordDir: record, projectDir: proj, consortDir: consort, step: 0, action: act({ kind: "invoke-role", role: "ux-designer" }) });

    // Replay that design turn into a FRESH project .consort from the recorded-artifacts mirror.
    const fresh = mkdtempSync(join(tmpdir(), "turn-rec-replay-"));
    tmpDirs.push(fresh);
    const freshConsort = join(fresh, ".consort");
    mkdirSync(freshConsort, { recursive: true });
    const ok = replayDesignTurn({
      turn: { role: "ux-designer" },
      replayDir: join(record, "recorded-artifacts"),
      consortDir: freshConsort,
      featureId: "F1",
    });
    expect(ok).toBe(true);
    expect(existsSync(join(freshConsort, "design", "design-guide.json"))).toBe(true);
    expect(readJson(join(freshConsort, "design", "design-guide.json")).tokens.color).toBe("#111");
  });
});

describe("recordTurn: agent transcript (demo/visualization)", () => {
  it("writes transcript.md (prompt + tools + final reasoning) and summarizes it in turn.json + index", () => {
    const { proj, consort, record } = mkProject();
    writeConsort(consort, "features/F1/db-design.json", JSON.stringify({ feature_id: "F1" }));
    const t = recordTurn({
      recordDir: record,
      projectDir: proj,
      consortDir: consort,
      step: 0,
      action: act({ kind: "invoke-role", role: "dba", story: "S1" }),
      transcript: {
        prompt: "Realize the physical schema for F1/S1 into db-design.json.",
        role: "dba",
        model: "opus",
        finalText: "Done – db-design.json written with a unique (sku, location) constraint.",
        tools: ["Read .consort/features/F1/architecture.json", "Write db-design.json"],
      },
    });

    const md = readFileSync(join(record, "turns", t.dir, "transcript.md"), "utf8");
    expect(md).toMatch(/## Prompt/);
    expect(md).toMatch(/Realize the physical schema/);
    expect(md).toMatch(/## Tools used/);
    expect(md).toMatch(/Write db-design\.json/);
    expect(md).toMatch(/## Final reasoning/);
    expect(md).toMatch(/unique \(sku, location\) constraint/);

    // turn.json carries a compact summary (not the full text).
    const m = readJson(join(record, "turns", t.dir, "turn.json"));
    expect(m.transcript).toEqual({ role: "dba", model: "opus", toolCount: 2, finalTextChars: expect.any(Number) });

    // index flags the transcript so a consumer knows without opening the dir.
    const idx = readJson(join(record, "turns", "index.json"));
    expect(idx.turns[t.ordinal].hasTranscript).toBe(true);
  });

  it("omits transcript fields entirely for a non-agent turn (no transcript passed)", () => {
    const { proj, consort, record } = mkProject();
    writeConsort(consort, "features/F1/gates.json", JSON.stringify({ spec: "approved" }));
    const t = recordTurn({
      recordDir: record,
      projectDir: proj,
      consortDir: consort,
      step: 0,
      action: act({ kind: "approve-gate", story: "S1" }),
    });
    expect(existsSync(join(record, "turns", t.dir, "transcript.md"))).toBe(false);
    const m = readJson(join(record, "turns", t.dir, "turn.json"));
    expect(m.transcript).toBeUndefined();
    const idx = readJson(join(record, "turns", "index.json"));
    expect(idx.turns[t.ordinal].hasTranscript).toBeUndefined();
  });
});

describe("relativizeProjectPaths: recorded text never embeds the ephemeral project root", () => {
  const proj = "/Users/kevin.hartman/code/consort-workflow-smoke/stockflow-instrumented-20260809-105157";

  it("rewrites the live project root to PROJECT_ROOT_TOKEN (with + without trailing path)", () => {
    const prompt = `Read ${proj}/.consort/product-overview.md and write to ${proj}/.consort/planning/x.md. Root is ${proj}.`;
    const out = relativizeProjectPaths(prompt, proj);
    expect(out).not.toContain(proj); // no dangling absolute path survives
    expect(out).toContain(`${PROJECT_ROOT_TOKEN}/.consort/product-overview.md`);
    expect(out).toContain(`${PROJECT_ROOT_TOKEN}/.consort/planning/x.md`);
    expect(out).toContain(`Root is ${PROJECT_ROOT_TOKEN}.`); // bare root (no trailing slash) too
  });

  it("is a no-op on empty text or empty projectDir", () => {
    expect(relativizeProjectPaths("", proj)).toBe("");
    expect(relativizeProjectPaths("some text", "")).toBe("some text");
  });

  it("leaves unrelated absolute paths untouched", () => {
    const t = "See /Users/other/thing.md and ~/.claude/settings.json";
    expect(relativizeProjectPaths(t, proj)).toBe(t);
  });
});

describe("recordTurn: LIVE index (snapshotContent:false) – .consort as an always-on timeline", () => {
  it("records the transcript + produced/deleted INDEX but snapshots NO content", () => {
    const { proj, consort, record } = mkProject();
    seedRecorderBaseline({ recordDir: record, projectDir: proj, consortDir: consort });
    // A turn that produces two .consort artifacts + a code file.
    writeConsort(consort, "product-overview.md", "# Overview\n");
    writeConsort(consort, "nfrs.md", "# NFRs\n");
    mkdirSync(join(proj, "app"), { recursive: true });
    writeFileSync(join(proj, "app", "main.py"), "print('hi')\n");

    const rec = recordTurn({
      recordDir: record,
      projectDir: proj,
      consortDir: consort,
      action: act({ kind: "invoke-role", role: "product-owner", mode: "intake" }),
      step: 0,
      transcript: { role: "product-owner", model: "opus", prompt: "draft the intake", finalText: "done", tools: ["Read x", "Write y"] },
      snapshotContent: false,
    });

    // The INDEX is captured: produced paths + a transcript summary.
    expect(rec.produced).toContain(".consort/product-overview.md");
    const turnJson = readJson(join(record, "turns", rec.dir, "turn.json"));
    expect(turnJson.snapshotted).toBe(false);
    expect(turnJson.produced.length).toBe(3); // two .consort artifacts + one code file
    expect(turnJson.transcript).toMatchObject({ role: "product-owner", model: "opus", toolCount: 2 });
    // The transcript IS persisted (prompt/tools/reasoning are viewable).
    expect(existsSync(join(record, "turns", rec.dir, "transcript.md"))).toBe(true);
    // But NO content snapshot: no files/ delta dir, no recorded-artifacts mirror.
    expect(existsSync(join(record, "turns", rec.dir, "files"))).toBe(false);
    expect(existsSync(join(record, "recorded-artifacts"))).toBe(false);
    // The ordered index still lists the turn.
    const idx = readJson(join(record, "turns", "index.json"));
    expect(idx.turns.at(-1)).toMatchObject({ ordinal: rec.ordinal, role: "product-owner", hasTranscript: true });
  });

  it("does NOT record the drive's own transient sinks (drive-live.log / next.json) as produced artifacts", () => {
    const { proj, consort, record } = mkProject();
    seedRecorderBaseline({ recordDir: record, projectDir: proj, consortDir: consort });
    // The turn authors one real artifact, but the drive ALSO writes its narration + advisory sinks
    // into .consort during the turn (the tee writes drive-live.log live; next.json is rewritten on
    // stop). Those are the drive's bookkeeping, NOT the turn's deliverables.
    writeConsort(consort, "product-overview.md", "# Overview\n");
    writeConsort(consort, "drive-live.log", "[drive] 000 dispatch product-owner for intake\n");
    writeConsort(consort, "next.json", "{}\n");
    const rec = recordTurn({
      recordDir: record,
      projectDir: proj,
      consortDir: consort,
      action: act({ kind: "invoke-role", role: "product-owner", mode: "intake" }),
      step: 0,
      transcript: { role: "product-owner", model: "opus", prompt: "draft", finalText: "done", tools: [] },
      snapshotContent: false,
    });
    expect(rec.produced).toContain(".consort/product-overview.md");
    expect(rec.produced).not.toContain(".consort/drive-live.log");
    expect(rec.produced).not.toContain(".consort/next.json");
  });

  it("default (snapshotContent omitted) still snapshots content – recorded corpora unchanged", () => {
    const { proj, consort, record } = mkProject();
    seedRecorderBaseline({ recordDir: record, projectDir: proj, consortDir: consort });
    writeConsort(consort, "design/ia.md", "# IA\n");
    const rec = recordTurn({
      recordDir: record,
      projectDir: proj,
      consortDir: consort,
      action: act({ kind: "invoke-role", role: "spec-author" }),
      step: 0,
    });
    // Content IS snapshotted: the files/ delta + recorded-artifacts mirror exist, snapshotted flag absent.
    expect(existsSync(join(record, "turns", rec.dir, "files"))).toBe(true);
    expect(existsSync(join(record, "recorded-artifacts", "design", "ia.md"))).toBe(true);
    expect(readJson(join(record, "turns", rec.dir, "turn.json")).snapshotted).toBeUndefined();
  });
});
