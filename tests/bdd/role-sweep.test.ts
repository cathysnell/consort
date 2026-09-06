// role-sweep + role-sweep-report: the per-role sweep runner + its before/after report, exercised
// hermetically with a FAKE chain runner (canned turns) + a STUB judge, so the sweep logic ,
// candidate iteration, conformance gating, QUALITY gating vs a baseline, crash-disqualify,
// ranking – is proven without spawning a model.

import { describe, it, expect } from "vitest";
import { runRoleSweep, type ChainRunner, type ChainRunResult } from "../optimization/role-sweep";
import { reportRoleSweep, formatRoleSweepReport } from "../optimization/role-sweep-report";
import { roleCandidates } from "../optimization/role-levers";
import { ROLE_CHAINS } from "../../consort/optimize/role-chains";
import type { SemanticJudge } from "../../consort/evaluation/semantic-gate";
import type { ManifestTurn } from "../../consort/orchestrator/runners/manifest-runner";

const CHAIN = ROLE_CHAINS["test-strategist"];

/** A canned chain run: the seed + live turns, plus the captured artifact the quality gate scores. */
function fakeRun(chain = CHAIN, opts: { ms: number; produced?: boolean; violations?: string[]; kind?: string; artifact?: string } = { ms: 1000 }): ChainRunResult {
  const produced = opts.produced ?? true;
  const kind = opts.kind ?? "design-complete";
  const turns: ManifestTurn[] = [
    { manifestId: `${chain.dir}-seed`, action: { kind: "invoke-role", role: "product-owner", mode: "author-requests" } as never, result: { bounded: { action: { kind: "invoke-role", role: "test-strategist", story: "S1" } } as never, producedPaths: [], violations: [] } },
    {
      manifestId: `${chain.dir}-live`,
      action: { kind: "invoke-role", role: "test-strategist", story: "S1" } as never,
      result: {
        bounded: { action: { kind } } as never,
        producedPaths: produced ? [`/ws/${chain.outputFile}`] : [],
        violations: opts.violations ?? [],
      },
      telemetry: { role: "test-strategist", outerDurationMs: opts.ms, agentResult: { usage: { inputTokens: 4, outputTokens: 100, durationMs: opts.ms - 200, numTurns: 3, costUsd: 0.1 } } },
    },
  ];
  const artifact = opts.artifact ?? (produced ? '{"items":[1,2,3]}' : undefined);
  const producedArtifacts = artifact !== undefined ? { [chain.outputFile]: artifact } : {};
  return { turns, producedArtifacts };
}

/** A stub judge that scores by artifact marker: contains "THIN" -> 0.5 (below bar); else 0.95. */
const stubJudge: SemanticJudge = async ({ candidate }) => ({ score: candidate.includes("THIN") ? 0.5 : 0.95, missing: candidate.includes("THIN") ? ["dropped coverage"] : [] });

describe("runRoleSweep: iterate candidates, gate on conformance, disqualify crashers", () => {
  it("runs every candidate + gate-passes a clean conformant turn (no quality gate)", async () => {
    const runner: ChainRunner = async () => fakeRun(CHAIN, { ms: 500 });
    const trials = await runRoleSweep(CHAIN, roleCandidates("sonnet"), runner);
    expect(trials.length).toBe(roleCandidates("sonnet").length);
    expect(trials[0].candidateId).toBe("baseline");
    expect(trials.every((t) => t.gatePassed)).toBe(true);
  });

  it("does NOT gate-pass a turn with violations or a missing artifact", async () => {
    const bad: ChainRunner = async () => fakeRun(CHAIN, { ms: 500, violations: ["test-list: bad shape"] });
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }], bad);
    expect(trials[0].gatePassed).toBe(false);

    const noArtifact: ChainRunner = async () => fakeRun(CHAIN, { ms: 500, produced: false });
    const t2 = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }], noArtifact);
    expect(t2[0].gatePassed).toBe(false);
  });

  it("DISQUALIFIES a crashing candidate + continues the sweep", async () => {
    let n = 0;
    const flaky: ChainRunner = async () => {
      n += 1;
      if (n === 2) throw new Error("boom (candidate 2 crashed)");
      return fakeRun(CHAIN, { ms: 500 });
    };
    const trials = await runRoleSweep(CHAIN, roleCandidates("sonnet").slice(0, 3), flaky);
    expect(trials.length).toBe(3);
    expect(trials[1].disqualified).toBe(true);
    expect(trials[1].reason).toMatch(/boom/);
    expect(trials[0].gatePassed).toBe(true);
    expect(trials[2].gatePassed).toBe(true);
  });
});

describe("runRoleSweep parallel: candidates fan out under a concurrency cap, order stays stable", () => {
  /** A runner that tracks peak concurrency by holding each call for a tick, so overlapping calls
   *  register a peak >1. Records the candidate order it was invoked with. */
  function trackingRunner(peak: { value: number }, order: string[]): ChainRunner {
    let inFlight = 0;
    return async (_c, _a, candidateId) => {
      inFlight += 1;
      if (inFlight > peak.value) peak.value = inFlight;
      order.push(candidateId);
      await new Promise((r) => setTimeout(r, 5)); // hold so siblings overlap
      inFlight -= 1;
      return fakeRun(CHAIN, { ms: 100 });
    };
  }

  it("honors the concurrency cap (peak in-flight <= cap) and returns ALL trials", async () => {
    const cands = roleCandidates("sonnet"); // 8 candidates
    const peak = { value: 0 };
    const order: string[] = [];
    const trials = await runRoleSweep(CHAIN, cands, trackingRunner(peak, order), { concurrency: 3 });
    expect(trials.length).toBe(cands.length);
    expect(peak.value).toBeGreaterThan(1); // actually ran in parallel
    expect(peak.value).toBeLessThanOrEqual(3); // never exceeded the cap
    expect(trials.every((t) => t.gatePassed)).toBe(true);
  });

  it("returns trials in CANDIDATE order (baseline first) regardless of completion order", async () => {
    const cands = roleCandidates("sonnet");
    // A runner whose duration is INVERSE to index, so later candidates finish first – the pool
    // returns completion order, but runRoleSweep must re-sort to candidate order.
    const runner: ChainRunner = async (_c, _a, candidateId) => {
      const idx = cands.findIndex((c) => c.id === candidateId);
      await new Promise((r) => setTimeout(r, (cands.length - idx) * 3));
      return fakeRun(CHAIN, { ms: 100 });
    };
    const trials = await runRoleSweep(CHAIN, cands, runner, { concurrency: 4 });
    expect(trials.map((t) => t.candidateId)).toEqual(cands.map((c) => c.id));
    expect(trials[0].candidateId).toBe("baseline");
  });

  it("DISQUALIFIES a crashing candidate under parallelism WITHOUT aborting siblings", async () => {
    const cands = roleCandidates("sonnet").slice(0, 4);
    const runner: ChainRunner = async (_c, _a, candidateId) => {
      if (candidateId === cands[1].id) throw new Error("boom (parallel candidate crashed)");
      return fakeRun(CHAIN, { ms: 100 });
    };
    const trials = await runRoleSweep(CHAIN, cands, runner, { concurrency: 4 });
    expect(trials.length).toBe(4);
    expect(trials[1].disqualified).toBe(true);
    expect(trials[1].reason).toMatch(/boom/);
    // siblings still ran + gate-passed.
    expect(trials[0].gatePassed).toBe(true);
    expect(trials[2].gatePassed).toBe(true);
    expect(trials[3].gatePassed).toBe(true);
  });

  it("fires onStart + onDone for every candidate under parallelism", async () => {
    const cands = roleCandidates("sonnet").slice(0, 4);
    const started = new Set<string>();
    const done = new Set<string>();
    await runRoleSweep(CHAIN, cands, async () => fakeRun(CHAIN, { ms: 50 }), {
      concurrency: 4,
      onStart: (c) => started.add(c.id),
      onDone: (t) => done.add(t.candidateId),
    });
    expect(started.size).toBe(4);
    expect(done.size).toBe(4);
  });

  it("concurrency 1 (default) is the sequential path: strict candidate order, one at a time", async () => {
    const cands = roleCandidates("sonnet").slice(0, 3);
    const peak = { value: 0 };
    const order: string[] = [];
    const trials = await runRoleSweep(CHAIN, cands, trackingRunner(peak, order), { concurrency: 1 });
    expect(peak.value).toBe(1); // never overlapped
    expect(order).toEqual(cands.map((c) => c.id)); // strict order
    expect(trials.map((t) => t.candidateId)).toEqual(cands.map((c) => c.id));
  });
});

describe("runRoleSweep with the MANDATORY judge: every conformant candidate is judged; no verdict => disqualified", () => {
  it("a thorough artifact passes quality; a THIN one fails it (but conformance still passed)", async () => {
    // baseline is thorough; the one candidate produces a THIN artifact. The judgeCandidate closure
    // scores the primary via the (stub) semantic judge, threshold 0.75.
    const runner: ChainRunner = async (_c, _a, candidateId) =>
      fakeRun(CHAIN, { ms: 200, artifact: candidateId === "m-haiku" ? '{"items":[1] THIN}' : '{"items":[1,2,3]}' });
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }, { id: "m-haiku", levers: { model: "haiku" } }], runner, {
      quality: {
        judgeCandidate: async ({ primary }) => {
          const v = await stubJudge({ step: "test-list" as never, reference: '{"items":[1,2,3,4]}', candidate: primary ?? "" });
          return { passed: v.score >= 0.75, score: v.score };
        },
      },
    });
    const baseline = trials.find((t) => t.candidateId === "baseline")!;
    const haiku = trials.find((t) => t.candidateId === "m-haiku")!;
    expect(baseline.gatePassed).toBe(true);
    expect(baseline.qualityPassed).toBe(true);
    expect(baseline.telemetry?.semanticScore).toBeCloseTo(0.95, 2);
    expect(haiku.gatePassed).toBe(true); // conformant
    expect(haiku.qualityPassed).toBe(false); // but THIN vs baseline
    expect(haiku.telemetry?.semanticScore).toBeCloseTo(0.5, 2);
  });

  it("NO judge configured => a conformant candidate is DISQUALIFIED (an LLM judge is required for every evaluation)", async () => {
    const runner: ChainRunner = async () => fakeRun(CHAIN, { ms: 200 });
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }], runner);
    expect(trials[0].gatePassed).toBe(true); // conformance still passed
    expect(trials[0].disqualified).toBe(true); // but no judge => not a valid evaluation
    expect(trials[0].reason).toMatch(/judge is required/i);
  });

  it("a judge that THROWS disqualifies the candidate (never silently unscored)", async () => {
    const runner: ChainRunner = async () => fakeRun(CHAIN, { ms: 200 });
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }], runner, {
      quality: { judgeCandidate: async () => { throw new Error("judge unavailable"); } },
    });
    expect(trials[0].disqualified).toBe(true);
    expect(trials[0].reason).toMatch(/judge threw/i);
  });

  // The driver-green shape: a runner returns turns:[] (its work is a full GREEN cycle, not a single
  // ManifestTurn), plus a runner-supplied gate (honest-GREEN) AND a measured durationMs. Without the
  // durationMs override, trialTelemetry reads 0 off the empty turns => all candidates 0ms => the winner
  // can't be ranked (the live Stage-5 bug: 8 equivalent candidates, "no winner"). This asserts the
  // runner-supplied duration lands on the telemetry so the report can rank on speed.
  it("a runner-supplied durationMs (turns:[] driver-green shape) overrides the turn-derived 0ms so candidates rank", async () => {
    const driverRun = (ms: number): ChainRunResult => ({ turns: [], producedArtifacts: { [CHAIN.outputFile]: '{"ok":1}' }, gate: { passed: true }, durationMs: ms });
    const runner: ChainRunner = async (_c, _a, candidateId) => driverRun(candidateId === "m-haiku" ? 120000 : 300000);
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }, { id: "m-haiku", levers: { model: "haiku" } }], runner, {
      quality: { judgeCandidate: async () => ({ passed: true, classification: "equivalent" }) },
    });
    const baseline = trials.find((t) => t.candidateId === "baseline")!;
    const haiku = trials.find((t) => t.candidateId === "m-haiku")!;
    expect(baseline.gatePassed).toBe(true);
    expect(baseline.qualityPassed).toBe(true);
    // the runner-supplied wall-clock is what lands on telemetry (NOT 0 from the empty turns array).
    expect(baseline.telemetry?.outerDurationMs).toBe(300000);
    expect(haiku.telemetry?.outerDurationMs).toBe(120000);
  });

  it("DISCRIMINATOR verdict: a clean 'equivalent' candidate is quality-PASS + records the classification (clean=best, not a miss)", async () => {
    // The judge closure returns a classification-driven verdict (build discriminator): a clean
    // 'equivalent' passes; 'insufficient' fails. Not score>=threshold.
    const trials = await runRoleSweep(CHAIN, [{ id: "baseline", levers: {} }, { id: "m-haiku", levers: { model: "haiku" } }],
      async (_c, _a, candidateId) => fakeRun(CHAIN, { ms: 200, artifact: candidateId === "m-haiku" ? '{"x":"BROKEN"}' : '{"x":"clean"}' }),
      {
        quality: {
          judgeCandidate: async ({ primary }) =>
            (primary ?? "").includes("BROKEN")
              ? { passed: false, score: 0.2, classification: "insufficient", nextStep: "escalate" }
              : { passed: true, score: 0.6, classification: "equivalent", nextStep: "accept" },
        },
      });
    const baseline = trials.find((t) => t.candidateId === "baseline")!;
    const haiku = trials.find((t) => t.candidateId === "m-haiku")!;
    expect(baseline.qualityPassed).toBe(true);
    expect(baseline.telemetry?.classification).toBe("equivalent");
    expect(baseline.telemetry?.nextStep).toBe("accept");
    expect(haiku.qualityPassed).toBe(false);
    expect(haiku.telemetry?.classification).toBe("insufficient");
  });
});

describe("reportRoleSweep: rank winners by wall-clock among QUALITY-HOLDING candidates", () => {
  it("a faster candidate that FAILS quality is NOT the winner", () => {
    const trials = [
      { candidateId: "baseline", levers: {}, gatePassed: true, qualityPassed: true, telemetry: { role: "test-strategist", chain: "x#baseline", levers: {}, outerDurationMs: 600000, outcome: "produced", semanticScore: 0.95 } },
      // faster but THIN (quality failed) – must NOT win despite being fastest.
      { candidateId: "m-haiku", levers: { model: "haiku" }, gatePassed: true, qualityPassed: false, telemetry: { role: "test-strategist", chain: "x#m-haiku", levers: { model: "haiku" }, outerDurationMs: 190000, outcome: "produced", semanticScore: 0.5 } },
      // slower than haiku but holds quality – the legitimate winner.
      { candidateId: "m-opus", levers: { model: "opus" }, gatePassed: true, qualityPassed: true, telemetry: { role: "test-strategist", chain: "x#m-opus", levers: { model: "opus" }, outerDurationMs: 300000, outcome: "produced", semanticScore: 0.9 } },
    ];
    const r = reportRoleSweep(trials);
    expect(r.winner?.candidateId).toBe("m-opus"); // NOT m-haiku (failed quality)
    expect(r.winner?.speedupPct).toBeCloseTo(50, 0);
    const report = formatRoleSweepReport(r);
    expect(report).toMatch(/m-opus/);
    // the thin faster one is surfaced as rejected-for-quality, not silently dropped.
    expect(report).toMatch(/m-haiku/);
    expect(report).toMatch(/quality/i);
  });

  it("surfaces a clean-converged (equivalent) candidate as a POSITIVE note, not merely 'passed'", () => {
    const trials = [
      { candidateId: "baseline", levers: {}, gatePassed: true, qualityPassed: true, telemetry: { role: "driver", chain: "x#baseline", levers: {}, outerDurationMs: 600000, outcome: "produced", classification: "regression", nextStep: "driver-repair-with-directive" } },
      { candidateId: "m-sonnet", levers: { model: "sonnet" }, gatePassed: true, qualityPassed: true, telemetry: { role: "driver", chain: "x#m-sonnet", levers: { model: "sonnet" }, outerDurationMs: 300000, outcome: "produced", classification: "equivalent", nextStep: "accept" } },
    ];
    const r = reportRoleSweep(trials);
    const report = formatRoleSweepReport(r);
    expect(report).toMatch(/converged clean/i);
    expect(report).toMatch(/driver-fixable regression|regression/i);
  });

  it("falls back to conformance-only ranking when no candidate has a quality verdict", () => {
    const trials = [
      { candidateId: "baseline", levers: {}, gatePassed: true, telemetry: { role: "r", chain: "x#baseline", levers: {}, outerDurationMs: 600000, outcome: "produced" } },
      { candidateId: "m-opus", levers: { model: "opus" }, gatePassed: true, telemetry: { role: "r", chain: "x#m-opus", levers: { model: "opus" }, outerDurationMs: 300000, outcome: "produced" } },
    ];
    const r = reportRoleSweep(trials);
    expect(r.winner?.candidateId).toBe("m-opus");
  });
});
