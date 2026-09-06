// The unattended auto-continue driver: pure control flow over injected steps. Because
// it runs with NO human watching, its decisions are exhaustively tested – a viable
// winner is applied + advanced; a non-viable sweep advances at baseline and CONTINUES
// (an un-optimizable role does not abandon the lane); a SystemicFailure HALTS (does not
// burn on); a story bound stops cleanly; a non-advancing lane halts instead of spinning.

import { describe, expect, it } from "vitest";
import {
  runAutoContinue,
  SystemicFailure,
  type AutoContinueDeps,
  type SweepOutcome,
  type AutoContinueJournalEntry,
} from "../../consort/optimize/optimize-autocontinue";
import type { HandoffPlan, HandoffResult } from "../../consort/optimize/optimize-harness";

function hp(id: string, role: string, story?: string): HandoffPlan {
  return { id, role, ...(story ? { story } : {}) };
}
function hr(id: string, winnerId: string): HandoffResult {
  return { handoffId: id, baselineMs: 1000, candidates: [], winner: { candidateId: winnerId, medianMs: 500, medianCostUsd: 1 } };
}
function viable(id: string, winnerId: string): SweepOutcome {
  return { result: hr(id, winnerId), viable: true, winnerId };
}
function nonViable(id: string): SweepOutcome {
  return { result: hr(id, "baseline"), viable: false, winnerId: "baseline" };
}

/** A scripted harness: positionNext walks a fixed handoff list; sweepOne/apply/advance
 *  record their calls; a per-handoff outcome map drives viable/non-viable/throw. */
function harness(
  handoffs: (HandoffPlan | null)[],
  outcomes: Record<string, SweepOutcome | Error>,
  hooks: Partial<AutoContinueDeps> = {},
) {
  let i = 0;
  const calls = { swept: [] as string[], applied: [] as string[], advanced: [] as string[] };
  const journal: AutoContinueJournalEntry[] = [];
  const deps: AutoContinueDeps = {
    positionNext: async () => handoffs[Math.min(i++, handoffs.length - 1)],
    sweepOne: async (h) => {
      calls.swept.push(h.id);
      const o = outcomes[h.id];
      if (o instanceof Error) throw o;
      return o ?? viable(h.id, `${h.role}-win`);
    },
    applyAndRebuild: async (o, h) => { calls.applied.push(h.id); },
    advance: async (o, h) => { calls.advanced.push(h.id); },
    journal: (e) => journal.push(e),
    ...hooks,
  };
  return { deps, calls, journal };
}

describe("runAutoContinue", () => {
  it("viable winner per handoff: sweeps, applies, advances, to lane-complete", async () => {
    const { deps, calls } = harness(
      [hp("S1-architect", "architect-reviewer", "S1"), hp("S1-dba", "dba", "S1"), null],
      {},
    );
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("lane-complete");
    expect(calls.swept).toEqual(["S1-architect", "S1-dba"]);
    expect(calls.applied).toEqual(["S1-architect", "S1-dba"]); // both viable -> applied
    expect(calls.advanced).toEqual(["S1-architect", "S1-dba"]);
  });

  it("non-viable sweep: advances at baseline + CONTINUES (does not abandon the lane)", async () => {
    const { deps, calls } = harness(
      [hp("S1-architect", "architect-reviewer", "S1"), hp("S1-dba", "dba", "S1"), null],
      { "S1-architect": nonViable("S1-architect") },
    );
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("lane-complete");
    expect(r.nonViable).toEqual(["S1-architect"]);
    // still advanced past the non-viable one, and swept + applied the next.
    expect(calls.advanced).toEqual(["S1-architect", "S1-dba"]);
    expect(calls.applied).toEqual(["S1-dba"]); // non-viable is NOT applied (nothing won)
  });

  it("systemic failure during sweep: HALTS with status (does not burn on)", async () => {
    const { deps, calls } = harness(
      [hp("S1-architect", "architect-reviewer", "S1"), hp("S1-dba", "dba", "S1"), null],
      { "S1-architect": new SystemicFailure("OAuth expired", "sweep") },
    );
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("systemic-halt");
    expect(r.halt?.stage).toBe("sweep");
    expect(r.halt?.detail).toMatch(/OAuth expired/);
    // did NOT proceed to the next handoff.
    expect(calls.swept).toEqual(["S1-architect"]);
    expect(calls.advanced).toEqual([]);
  });

  it("systemic failure during apply (broken build) halts", async () => {
    const { deps } = harness(
      [hp("S1-architect", "architect-reviewer", "S1"), null],
      {},
      { applyAndRebuild: async () => { throw new SystemicFailure("tsup build failed", "apply"); } },
    );
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("systemic-halt");
    expect(r.halt?.stage).toBe("apply");
  });

  it("stopAfterStory: stops cleanly before sweeping a later story's handoff", async () => {
    const { deps, calls } = harness(
      [hp("S1-dba", "dba", "S1"), hp("S2-architect", "architect-reviewer", "S2"), null],
      {},
    );
    const r = await runAutoContinue(deps, { stopAfterStory: "S1" });
    expect(r.stopReason).toBe("stop-after-story");
    expect(calls.swept).toEqual(["S1-dba"]); // S2 never swept
  });

  it("halts a non-advancing lane (same handoff twice) instead of spinning", async () => {
    const stuck = hp("S1-architect", "architect-reviewer", "S1");
    const { deps } = harness([stuck, stuck, stuck, null], {});
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("systemic-halt");
    expect(r.halt?.detail).toMatch(/did not advance/);
  });

  it("lane-complete immediately when positionNext returns null", async () => {
    const { deps, calls } = harness([null], {});
    const r = await runAutoContinue(deps);
    expect(r.stopReason).toBe("lane-complete");
    expect(calls.swept).toEqual([]);
  });

  it("journals swept/applied/advanced/halt events for the unattended audit trail", async () => {
    const { deps, journal } = harness([hp("S1-dba", "dba", "S1"), null], {});
    await runAutoContinue(deps);
    const events = journal.map((e) => e.event);
    expect(events).toContain("swept");
    expect(events).toContain("applied");
    expect(events).toContain("done");
  });

  it("feature-scope handoff (no story) is not caught by the stopAfterStory bound", async () => {
    // ux-designer has no story; a story bound must not trip on it.
    const { deps, calls } = harness([hp("ux-designer", "ux-designer"), hp("S1-dba", "dba", "S1"), null], {});
    const r = await runAutoContinue(deps, { stopAfterStory: "S1" });
    expect(r.stopReason).toBe("lane-complete");
    expect(calls.swept).toEqual(["ux-designer", "S1-dba"]);
  });
});
