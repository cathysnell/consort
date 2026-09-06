// The drive-live-log classifier – the robust replacement for a session's brittle
// hand-rolled `tail -f … | while read; case …` monitor. Asserted against the EXACT
// line formats the drive writes (claude-runner.ts + drive.cli.ts), so a format
// change that this misclassifies fails the build, not a user's run.

import { describe, it, expect } from "vitest";
import { classifyDriveLine } from "../../consort/orchestrator/drive/watch-classify";

describe("classifyDriveLine – progress lines (relay, keep tailing)", () => {
  it("per-action dispatch line => dispatch, prefix trimmed, no stop", () => {
    const c = classifyDriveLine("[drive] 000 dispatch spec-author for design");
    expect(c).toMatchObject({ kind: "dispatch", text: "dispatch spec-author for design", stop: false });
  });

  it("turn-done line => turn-done, no stop", () => {
    const c = classifyDriveLine("[drive] driver turn 42.1s (claude-opus-4-8)");
    expect(c).toMatchObject({ kind: "turn-done", stop: false });
    expect(c?.text).toContain("driver turn 42.1s");
  });

  it("sprint feature claim => feature, no stop", () => {
    expect(classifyDriveLine("[sprint] feature 1: F1-stock-visibility")).toMatchObject({
      kind: "feature",
      stop: false,
    });
  });

  it("sprint feature skip => skip, no stop", () => {
    expect(
      classifyDriveLine("[sprint] feature 2: F2-stock-adjustment – already shipped, skipping"),
    ).toMatchObject({ kind: "skip", stop: false });
  });

  it("turn stalled => stalled warn, no stop (it retries)", () => {
    expect(classifyDriveLine("[drive] turn stalled: no agent output for ~600s; killing pid 123")).toMatchObject({
      kind: "stalled",
      stop: false,
    });
  });
});

describe("classifyDriveLine – STOP points (control returns to the human)", () => {
  it("GATE line => gate, STOP", () => {
    expect(classifyDriveLine("[drive] GATE awaiting human approval: approve the spec gate for F1.")).toMatchObject({
      kind: "gate",
      stop: true,
      outcome: "gate",
    });
  });

  it("PAUSED line => pause, STOP", () => {
    expect(
      classifyDriveLine("[drive] PAUSED – awaiting the Product Owner's sprint backlog. This is a DECISION"),
    ).toMatchObject({ kind: "pause", stop: true, outcome: "pause" });
  });

  it("holding line => pause, STOP", () => {
    expect(classifyDriveLine("[drive] holding – write Y to .consort/answer when ready.")).toMatchObject({
      kind: "pause",
      stop: true,
    });
  });

  it("sprint paused on a feature => pause, STOP", () => {
    expect(classifyDriveLine("[sprint] paused on F1-stock-visibility")).toMatchObject({ kind: "pause", stop: true });
  });

  it("RAISED TO HIL headline => escalation, STOP (on the line itself)", () => {
    expect(classifyDriveLine("[sprint] RAISED TO HIL on F1-stock-visibility – halting sprint s1.")).toMatchObject({
      kind: "escalation",
      stop: true,
      outcome: "escalation",
    });
    expect(classifyDriveLine("[drive] RAISED TO HIL after 12 actions – awaiting HIL decision.")).toMatchObject({
      kind: "escalation",
      stop: true,
    });
  });

  it("ABORTED headline (unexpected crash) => escalation, STOP – never a silent, skipped line", () => {
    // Regression: a deterministic CLI effect (wait-ci / merge) or an unexpected error
    // used to die as a bare, unprefixed "<bin> exited N" line that classifyDriveLine
    // returned null for, so a Monitor tailing drive-live.log never surfaced the CI
    // failure and the run looked like it was "still waiting on CI" after it had died.
    const c = classifyDriveLine("[drive] ABORTED – unexpected error: something broke");
    expect(c).toMatchObject({ kind: "escalation", stop: true, outcome: "escalation" });
    expect(c?.text).toContain("ABORTED");
  });

  it("a CLI-effect failure that raised to HIL (wait-ci) => escalation, STOP", () => {
    expect(
      classifyDriveLine("[drive] RAISED TO HIL – lakebase-scm-wait-ci failed."),
    ).toMatchObject({ kind: "escalation", stop: true, outcome: "escalation" });
  });

  it("escalation (recorded under escalations/) => escalation, STOP", () => {
    const c = classifyDriveLine(
      "        recorded under stockflow/escalations/ ; resolve it, then re-run to resume.",
    );
    expect(c).toMatchObject({ kind: "escalation", stop: true, outcome: "escalation" });
  });

  it("sprint complete => done, STOP", () => {
    expect(classifyDriveLine("[sprint] s1 complete: 4 feature(s)")).toMatchObject({ kind: "done", stop: true });
  });

  it("drive done in N actions => done, STOP", () => {
    expect(classifyDriveLine("[drive] done in 37 actions")).toMatchObject({ kind: "done", stop: true, outcome: "done" });
  });
});

describe("classifyDriveLine – [consort] disclosures are surfaced (not dropped)", () => {
  it("a [consort] telemetry-briefing line => notice, shown, no stop", () => {
    // Regression: the notice lands in drive-live.log but the classifier used to return
    // null for non-[drive]/[sprint] lines, so consort-watch dropped the L1/L2 briefing
    // the orchestrator contract requires surfacing – the human was never briefed.
    const c = classifyDriveLine("[consort] Anonymous* usage telemetry is on (no PII).");
    expect(c).toMatchObject({ kind: "notice", stop: false });
    expect(c?.text).toContain("usage telemetry is on");
  });
});

describe("classifyDriveLine – create + refresh narration relays through the SAME watcher", () => {
  // One relay follows create / refresh / drive. create narrates provisioning as
  // bracketed stage lines (NOT [drive]/[sprint]); the guard used to drop them, so a
  // session watching `lakebase-create-project` saw nothing. Any bracketed stage line
  // now relays as info; raw npm/pytest noise still skips.
  it.each([
    "[doctor] verifying environment before provisioning...",
    "[Creating GitHub repository...]",
    "[Scaffolding project files...]",
    "[Project created successfully!]",
  ])("create stage line %j => info, shown, no stop", (line) => {
    const c = classifyDriveLine(line);
    expect(c).toMatchObject({ kind: "info", stop: false });
    expect(c?.text.length).toBeGreaterThan(0);
  });

  it("a `lk:` install-heartbeat line (backgrounded --refresh) => info, shown, no stop", () => {
    const c = classifyDriveLine("lk: still downloading the Consort toolkit (15s)...");
    expect(c).toMatchObject({ kind: "info", stop: false });
    expect(c?.text).toBe("still downloading the Consort toolkit (15s)...");
  });
});

describe("classifyDriveLine – non-narration lines are skipped", () => {
  it.each(["", "  ", "raw pytest output", "{\"event\":\"x\"}", "npm warn something"])(
    "returns null for %j",
    (line) => {
      expect(classifyDriveLine(line)).toBeNull();
    },
  );
});
