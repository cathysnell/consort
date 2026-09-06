// P2b optimize-harness: runChampionWalk, the sequential per-handoff champion walk.
// For each handoff K: snapshot the pre-turn state ONCE, run each candidate N
// trials from that identical state, gate + time each trial, keep the FASTEST
// gate-passing candidate as the winner, overlay the winner once more (recorded),
// and continue from the winner's state. Every discarded attempt is reported to
// experiments/; only the winner advances.
//
// The engine is pure orchestration over INJECTED steps (runTrial + a
// snapshot factory), so the walk's decision logic – trials per candidate, median
// selection, gate-failure discarding, winner selection + tie-breaks – is unit-
// tested with no cloud, no model, no git. The real steps are wired by the CLI.

import { describe, expect, it } from "vitest";

import {
  runChampionWalk,
  type ChampionWalkDeps,
  type TrialResult,
  type HandoffPlan,
} from "../../consort/optimize/optimize-harness";
import { generateCandidates } from "../../consort/optimize/optimize-candidates";

/** A scripted runTrial: looks up a fixed outcome per (handoff, candidate id, trial). */
function scriptedDeps(
  script: Record<string, Record<string, TrialResult[]>>,
): { deps: ChampionWalkDeps; log: string[] } {
  const log: string[] = [];
  const trialCursor: Record<string, number> = {};
  return {
    log,
    deps: {
      async snapshot(handoff) {
        log.push(`snapshot:${handoff.id}`);
        return {
          async restore() {
            log.push(`restore:${handoff.id}`);
          },
          dispose() {
            log.push(`dispose:${handoff.id}`);
          },
        };
      },
      async runTrial({ handoff, candidate, trial }) {
        const key = `${handoff.id}|${candidate.id}`;
        const i = trialCursor[key] ?? 0;
        trialCursor[key] = i + 1;
        log.push(`trial:${handoff.id}:${candidate.id}:${trial}`);
        const outcome = script[handoff.id][candidate.id][i];
        // A THROWN trial (not a fail RESULT): the candidate's turn crashed – the
        // real ArtifactOutOfRootError / spawn failure. The engine must treat this
        // like a disqualification, not let it kill the whole walk.
        if (outcome === THROWS) throw new Error("simulated candidate crash (ArtifactOutOfRootError)");
        return outcome;
      },
      async recordWinner({ handoff, candidate, artifactsRef }) {
        log.push(`recordWinner:${handoff.id}:${candidate.id}${artifactsRef !== undefined ? `:artifacts=${String(artifactsRef)}` : ""}`);
      },
    },
  };
}

function pass(ms: number): TrialResult {
  return { gatePassed: true, durationMs: ms, costUsd: ms / 1000 };
}
/** A passing trial that CAPTURED artifacts (tagged so the test can see which trial's
 *  artifacts recordWinner received). */
function passA(ms: number, ref: string): TrialResult {
  return { gatePassed: true, durationMs: ms, costUsd: ms / 1000, artifactsRef: ref };
}
function fail(ms: number): TrialResult {
  return { gatePassed: false, durationMs: ms, costUsd: ms / 1000, gateReason: "gate failed" };
}
/** Sentinel: a trial that THROWS (the turn crashed) rather than returning a
 *  fail RESULT. The engine must not let one crashing candidate kill the walk. */
const THROWS = Symbol("throws") as unknown as TrialResult;

const handoff: HandoffPlan = { id: "S1-green", role: "driver", story: "S1", buildMode: "green" };

describe("runChampionWalk: winner selection", () => {
  it("keeps the fastest gate-passing candidate (median of N passing trials)", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const { deps } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000), pass(1000), pass(1000)],
        fast: [pass(400), pass(500), pass(600)], // median 500
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 3 }, deps);
    expect(result.walk[0].winner.candidateId).toBe("fast");
    expect(result.walk[0].winner.medianMs).toBe(500);
    // baseline is reported for the before/after diff
    expect(result.walk[0].baselineMs).toBe(1000);
  });

  it("advances with the WINNING TRIAL's captured artifacts (its fastest passing trial), not a re-run", async () => {
    // Once a winner is selected, the next role must run against the winner's ACTUAL
    // output. runChampionWalk hands recordWinner the winning candidate's fastest
    // passing trial's artifactsRef, so the live impl restores those exact artifacts
    // instead of re-spawning (which would produce different output).
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const { deps, log } = scriptedDeps({
      "S1-green": {
        baseline: [passA(1000, "base-t0"), passA(1000, "base-t1")],
        // fast wins; its fastest passing trial is t1 (400 < 600) -> its artifacts win.
        fast: [passA(600, "fast-t0"), passA(400, "fast-t1")],
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 2 }, deps);
    expect(result.walk[0].winner.candidateId).toBe("fast");
    expect(log).toContain("recordWinner:S1-green:fast:artifacts=fast-t1");
  });

  it("a candidate that fails the gate on ANY trial is discarded (never wins)", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "flaky", configOverrides: {} },
    ];
    const { deps } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000), pass(1000), pass(1000)],
        flaky: [pass(100), fail(50), pass(100)], // one gate failure => disqualified
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 3 }, deps);
    expect(result.walk[0].winner.candidateId).toBe("baseline");
    // the disqualified candidate is still reported as an attempt
    const flaky = result.walk[0].candidates.find((c) => c.candidateId === "flaky");
    expect(flaky?.disqualified).toBe(true);
  });

  it("a candidate whose trial THROWS is disqualified, and the walk still records a winner", async () => {
    // The real crash: a candidate's turn errors (e.g. the role wrote its artifact
    // to a malformed sibling root -> ArtifactOutOfRootError). Before this fix the
    // throw propagated out of runChampionWalk and killed the ENTIRE sweep (exit 3),
    // discarding every completed handoff. It must instead disqualify just that
    // candidate and let the honest baseline win.
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "crasher", configOverrides: {} },
    ];
    const { deps, log } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000), pass(1000)],
        crasher: [THROWS, pass(300)], // trial 0 throws
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 2 }, deps);
    // The walk completed (did not throw) and picked the honest baseline.
    expect(result.walk[0].winner.candidateId).toBe("baseline");
    const crasher = result.walk[0].candidates.find((c) => c.candidateId === "crasher");
    expect(crasher?.disqualified).toBe(true);
    // The pre-turn state was still restored after the crashing trial (so the next
    // candidate/trial forks clean), and the snapshot was disposed.
    expect(log).toContain("restore:S1-green");
    expect(log).toContain("dispose:S1-green");
  });

  it("does not abort the multi-handoff walk when a candidate throws on an early handoff", async () => {
    // A crash on handoff 1's candidate must not lose handoff 2.
    const h1: HandoffPlan = { id: "S1-spec", role: "spec-author" };
    const h2: HandoffPlan = { id: "S1-arch", role: "architect" };
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "crasher", configOverrides: {} },
    ];
    const { deps } = scriptedDeps({
      "S1-spec": { baseline: [pass(900)], crasher: [THROWS] },
      "S1-arch": { baseline: [pass(800)], crasher: [pass(400)] },
    });
    const result = await runChampionWalk({ handoffs: [h1, h2], candidates: cands, trials: 1 }, deps);
    expect(result.walk).toHaveLength(2);
    expect(result.walk[0].winner.candidateId).toBe("baseline"); // crasher DQ'd
    expect(result.walk[1].winner.candidateId).toBe("crasher"); // faster, no crash
  });

  it("falls back to baseline when NO candidate beats it", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "slower", configOverrides: {} },
    ];
    const { deps } = scriptedDeps({
      "S1-green": {
        baseline: [pass(500), pass(500), pass(500)],
        slower: [pass(900), pass(900), pass(900)],
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 3 }, deps);
    expect(result.walk[0].winner.candidateId).toBe("baseline");
  });

  it("tie on median => lower cost wins", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "a", configOverrides: {} },
      { id: "b", configOverrides: {} },
    ];
    const { deps } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000), pass(1000), pass(1000)],
        a: [{ gatePassed: true, durationMs: 500, costUsd: 9 }, { gatePassed: true, durationMs: 500, costUsd: 9 }, { gatePassed: true, durationMs: 500, costUsd: 9 }],
        b: [{ gatePassed: true, durationMs: 500, costUsd: 1 }, { gatePassed: true, durationMs: 500, costUsd: 1 }, { gatePassed: true, durationMs: 500, costUsd: 1 }],
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 3 }, deps);
    expect(result.walk[0].winner.candidateId).toBe("b");
  });
});

describe("runChampionWalk: state discipline", () => {
  it("snapshots once per handoff, restores after every trial, records the winner", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const { deps, log } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000)],
        fast: [pass(400)],
      },
    });
    await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 1 }, deps);
    // one snapshot for the handoff
    expect(log.filter((l) => l === "snapshot:S1-green")).toHaveLength(1);
    // a restore after each of the 2 trials
    expect(log.filter((l) => l === "restore:S1-green")).toHaveLength(2);
    // winner recorded once
    expect(log).toContain("recordWinner:S1-green:fast");
    // snapshot disposed at the end
    expect(log).toContain("dispose:S1-green");
  });

  it("propose-only: ranks + reports the winner but does NOT record/advance", async () => {
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const { deps, log } = scriptedDeps({
      "S1-green": {
        baseline: [pass(1000)],
        fast: [pass(400)],
      },
    });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 1, proposeOnly: true }, deps);
    // The winner is still selected + reported...
    expect(result.walk[0].winner.candidateId).toBe("fast");
    // ...but recordWinner is NEVER called (no overlay, no advance).
    expect(log.some((l) => l.startsWith("recordWinner"))).toBe(false);
    // trials + restores still ran, and the snapshot was disposed.
    expect(log.filter((l) => l === "restore:S1-green")).toHaveLength(2);
    expect(log).toContain("dispose:S1-green");
  });

  it("alwaysAdvance overrides propose-only: the winner IS recorded so the LANE can advance", async () => {
    // A multi-handoff LANE sweep MUST advance between handoffs (each winner's
    // artifact feeds the next turn's planNextAction). propose-only means "do not
    // PERSIST to the kit" (the separate optimize-apply step), NOT "do not advance
    // the local walk". So alwaysAdvance=true records the winner even under
    // proposeOnly; without it, a propose-only lane sweep stalls after handoff #1
    // (the drive never advances -> the next positionNext re-plans the same handoff).
    const cands = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const { deps, log } = scriptedDeps({
      "S1-green": { baseline: [pass(1000)], fast: [pass(400)] },
    });
    const result = await runChampionWalk(
      { handoffs: [handoff], candidates: cands, trials: 1, proposeOnly: true, alwaysAdvance: true },
      deps,
    );
    expect(result.walk[0].winner.candidateId).toBe("fast");
    // The winner IS recorded (advance) despite propose-only.
    expect(log).toContain("recordWinner:S1-green:fast");
  });

  it("runs handoffs sequentially, each with its own snapshot", async () => {
    const h2: HandoffPlan = { id: "S1-review", role: "navigator", story: "S1", buildMode: "review" };
    const cands = [{ id: "baseline", configOverrides: {} }];
    const { deps, log } = scriptedDeps({
      "S1-green": { baseline: [pass(100)] },
      "S1-review": { baseline: [pass(100)] },
    });
    await runChampionWalk({ handoffs: [handoff, h2], candidates: cands, trials: 1 }, deps);
    expect(log.indexOf("snapshot:S1-green")).toBeLessThan(log.indexOf("snapshot:S1-review"));
    expect(log).toContain("recordWinner:S1-green:baseline");
    expect(log).toContain("recordWinner:S1-review:baseline");
  });
});

describe("runChampionWalk: integrates with generateCandidates", () => {
  it("accepts a generated candidate list", async () => {
    const cands = generateCandidates({ role: "driver", models: { green: ["haiku"] } });
    const script: Record<string, TrialResult[]> = {};
    for (const c of cands) script[c.id] = [pass(c.id === "baseline" ? 1000 : 300)];
    const { deps } = scriptedDeps({ "S1-green": script });
    const result = await runChampionWalk({ handoffs: [handoff], candidates: cands, trials: 1 }, deps);
    expect(result.walk[0].candidates).toHaveLength(cands.length);
  });
});
