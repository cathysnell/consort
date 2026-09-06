#!/usr/bin/env node
// optimize-role: the per-CHAIN lever sweep CLI – INTERNAL agent performance-tuning tooling (NOT a
// published bin; it lives under tests/optimization/ and is invoked via scripts/optimize-role.sh).
// It sweeps one or MANY manifest turn-chains: each chain runs its isolated chain (recorded inputs
// replayed in, only that role's turn live) once per candidate lever patch (model tiers x effort
// rungs x scan-tight), gates each on the role's conformance validator + a reference-example quality
// judge, and reports the fastest quality-holding candidate vs the baseline. Every chain is measured
// STANDALONE against its recorded reference – so chains AND candidates fan out in parallel with zero
// shared mutable state (each candidate's runIntegrationChain mkdtemps its own workspace; levers ride
// in-memory on the ClaudeStepAgent). This is the lightweight sibling of consort-optimize; it needs
// NO cloud project (the design + navigator tiers), only the isolation substrate + recorded corpus.
//
//   scripts/optimize-role.sh --chains design [--concurrency 3] [--base-model sonnet] [--telemetry-dir DIR]
//   scripts/optimize-role.sh --chains spec-author-story,architect-reviewer [--concurrency 4]
//   scripts/optimize-role.sh --role test-strategist            # back-compat: single chain
//
// --chains is a SET: "design" (every design role chain), or a comma list of chain handles. --role is
//   the back-compat single-chain alias. --concurrency caps in-flight candidates ACROSS the whole run
//   (1 = sequential, the prior behavior). --base-model overrides the per-chain recorded default.
//   Each candidate's telemetry + produced artifacts survive to <telemetry-dir>/<chain>/<candidate>/.
//
// LIVE + LEAN: every candidate is a real `claude -p` turn, tool-scoped out of Bash, reporting via
// the agent-report channel, in a throwaway .sftdd workspace – nothing to tear down.

import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { ROLE_CHAINS, runRoleChainLive, INTAKE_REL, type RoleChain } from "../../consort/optimize/role-chains.js";
import { BUILD_ROLE_CHAINS, runBuildRoleChainLive, BUILD_CORPUS_REL, BUILD_MANIFESTS_REL, type BuildRoleChain } from "../../consort/optimize/build-role-chains.js";
import { roleCandidates, testStrategistCandidates, driverGreenCandidates } from "./role-levers.js";
import { deployPortForIndex } from "./driver-green-enforcement.js";
import { runRoleSweep, type SweepTrial, type ChainRunner, type ChainRunResult, type QualityGate, type QualityVerdict, type SweepableChain } from "./role-sweep.js";
import { reportRoleSweep, formatRoleSweepReport, type SweepReport } from "./role-sweep-report.js";
import { scaffoldDriverGreenProject, teardownDriverGreenProject, runDriverGreenOnScaffold, runLeanReplayTurn, sweepDriverGreenOrphans, DRIVER_GREEN_BUNDLE_S2, replayBundleFromTurn, CORPUS_TURNS, CORPUS_RA, type RunDriverGreenResult, type DriverGreenBundle, type ScaffoldedDriverProject } from "../integration/live/driver-build-support.js";
import { ARTIFACT_ROOT } from "../../consort/config/consort-paths.js";
import type { RoleLeverPatch } from "./role-levers.js";
import { loadExperimentConfig } from "./experiment-config.js";
import { makeOpusJudge, makeVerdictAlignmentJudge, parseVerdictFile, makeBuildDiscriminatorJudge, parseNavigatorAssessMarker, makeSupersessionDeltaJudge, makeRegressionFidelityJudge, evaluateNavigatorAssessAlignment, evaluateNextStepDetermination, FUNCTIONAL_THRESHOLD, SEMANTIC_THRESHOLD, type BuildOutputKind, type VerdictOutput } from "../../consort/evaluation/semantic-gate.js";
import { enabledAnalysts } from "../../consort/test-list/test-analyst-catalogue.js";
import { RECOMMENDED_MODELS, type SpawnableAgentRole } from "../../consort/config/agent-models.js";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest.js";
import type { StepAgent } from "../../consort/orchestrator/agents/agent-types.js";
import { snapshotTree } from "../../consort/orchestrator/scenarios/integration-chain.js";

/** A driver turn the sweep can exercise, and the CONTAINED next-step navigator determination it is
 *  judged against. `evaluatorKind` picks the directional comparison (assess for green/repair, review
 *  for refactor); `refRel` is the camp-relative dir holding the recorded determination (copied into
 *  consort/evaluation/reference-assets/stockflow/next-step/ – the corpus is assumed deleted). */
export interface DriverTurnSpec {
  driverTurn: "green" | "repair" | "refactor";
  evaluatorKind: "assess" | "review";
  /** Camp-relative dir (under BUILD_CORPUS_REL) with the recorded next-step determination. */
  refRel: string;
  /** The RECORDED original turn's wall-clock (ms), from the corpus agent-log – the fixed baseline the
   *  sweep scores each candidate's time against (same/better/worse), so we compare to the recording
   *  (not a noisy fresh baseline run). Absent => fall back to the live baseline candidate's median. */
  recordedBaselineMs?: number;
}
export const DRIVER_TURN_SPECS: Record<string, DriverTurnSpec> = {
  "driver-green": { driverTurn: "green", evaluatorKind: "assess", refRel: "next-step/driver-green" },
  // The S2-drop-combined MIGRATION thrasher pin (the turn where the full-suite waste is large enough to
  // exceed the S3 variance; see DRIVER-GREEN-LEVERS.md). Same green turn, its OWN bundle + judge reference.
  // recordedBaselineMs = the recorded original 002-driver green wall-clock (stockflow-full agent-log,
  // S2-drop-combined-code, first `green` phase = 667.2s) – the fixed time baseline for same/better/worse.
  "driver-green-s2": { driverTurn: "green", evaluatorKind: "assess", refRel: "next-step/driver-green-s2", recordedBaselineMs: 667200 },
  "driver-repair": { driverTurn: "repair", evaluatorKind: "assess", refRel: "next-step/driver-repair" },
  "driver-refactor": { driverTurn: "refactor", evaluatorKind: "review", refRel: "next-step/driver-refactor" },
};

/** The chain SET keywords that expand to a group of handles. "design" = every design role chain
 *  (the lean, no-cloud tier); "navigator" = navigator build chains (red/assess/review/reflect);
 *  "driver" = driver LIVE lever sweeps (requires RUN_LIVE_STEP + LAKEBASE_TEST_E2E). */
const CHAIN_SETS: Record<string, string[]> = {
  design: Object.keys(ROLE_CHAINS),
  navigator: Object.keys(BUILD_ROLE_CHAINS),
  driver: Object.keys(DRIVER_TURN_SPECS), // driver-green, driver-repair, driver-refactor
};

/** Combined universe of all chains (design + build + driver). Used for validation. The driver handles
 *  (driver-green/-repair/-refactor) are synthetic – they route to sweepDriverGreen (the ONE sweep engine),
 *  each seeded to its own flagged pre-turn state + judged by its next-step navigator determination. */
function allChains(): Record<string, RoleChain | BuildRoleChain | { id: string }> {
  const driver = Object.fromEntries(Object.keys(DRIVER_TURN_SPECS).map((h) => [h, { id: h }]));
  return { ...ROLE_CHAINS, ...BUILD_ROLE_CHAINS, ...driver };
}

/** Expand a --chains spec (a set keyword OR a comma list of handles) into concrete chain handles,
 *  validated against ROLE_CHAINS + BUILD_ROLE_CHAINS + synthetic handles (driver-green). Pure + exported for a unit test.
 *  De-dupes while preserving order. */
export function expandChains(spec: string, chains: Record<string, unknown> = allChains()): string[] {
  const raw = CHAIN_SETS[spec] ?? spec.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of raw) {
    if (!chains[h]) {
      throw new Error(`optimize-role: unknown chain "${h}". Sets: ${Object.keys(CHAIN_SETS).join(", ")}. Handles: ${Object.keys(chains).join(", ")}`);
    }
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  if (out.length === 0) throw new Error(`optimize-role: --chains "${spec}" expanded to nothing`);
  return out;
}

/** Parsed CLI args. `chains` is the resolved handle list (one or many). */
export interface OptimizeRoleArgs {
  chains: string[];
  baseModel?: string;
  telemetryDir?: string;
  concurrency?: number;
  /** Optional candidate-id subset (comma list). When set, only these candidates run – used to
   *  RESUME a partial driver-green sweep (run just the ones a crash didn't complete). Their trials
   *  MERGE with any per-candidate trials already persisted under the run dir, so the rollup covers
   *  the full set. Absent => every candidate runs. */
  candidates?: string[];
  /** Replicate each SELECTED candidate N times, as `<id>-r1..-rN` (unique ids => unique deterministic
   *  ports). Used to measure a single lever's VARIANCE by running it N times IN PARALLEL in one trial
   *  (pair with --concurrency N). Absent/1 => no replication. */
  replicas?: number;
  /** Path to an externalized EXPERIMENT config (turn + candidates + levers). When set (driver chains),
   *  it SUPPLIES the candidates + the corpus turn (preconditions) + concurrency/replicas – the run picks
   *  up the config instead of the hardcoded driverGreenCandidates()/default turn. See experiment-config. */
  experiment?: string;
}

/** Parse argv (pure + exported for a unit test). Accepts --chains <set|list> OR the back-compat
 *  single --role <handle>. Throws loud on an unknown/absent chain. */
export function parseArgs(argv: string[], chains: Record<string, unknown> = allChains()): OptimizeRoleArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const chainsSpec = get("--chains");
  const role = get("--role");
  if (!chainsSpec && !role) {
    throw new Error(`optimize-role: --chains <set|list> (or --role <handle>) is required. Sets: ${Object.keys(CHAIN_SETS).join(", ")}. Handles: ${Object.keys(chains).join(", ")}`);
  }
  const resolved = chainsSpec ? expandChains(chainsSpec, chains) : expandChains(role!, chains);
  const conc = get("--concurrency");
  const cands = get("--candidates");
  const reps = get("--replicas");
  return {
    chains: resolved,
    ...(get("--base-model") ? { baseModel: get("--base-model") } : {}),
    ...(get("--telemetry-dir") ? { telemetryDir: get("--telemetry-dir") } : {}),
    ...(conc !== undefined ? { concurrency: Math.max(1, Number(conc) || 1) } : {}),
    ...(cands ? { candidates: cands.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(reps !== undefined ? { replicas: Math.max(1, Number(reps) || 1) } : {}),
    ...(get("--experiment") ? { experiment: get("--experiment") } : {}),
  };
}

/** Replicate each candidate N times as `<id>-r1..-rN` (same levers, unique ids). N<=1 => unchanged.
 *  Pure + exported for a unit test. The unique ids give each replica its own deterministic deploy port. */
export function expandReplicas<C extends { id: string }>(cands: C[], replicas?: number): C[] {
  const n = Math.max(1, replicas ?? 1);
  if (n === 1) return cands;
  return cands.flatMap((c) => Array.from({ length: n }, (_, k) => ({ ...c, id: `${c.id}-r${k + 1}` })));
}

/** The role's baseline model: the CLI override, else RECOMMENDED_MODELS, else sonnet. */
function baseModelFor(role: string, override?: string): string {
  if (override) return override;
  // The chain handle is the spawnable role for the design roles; the plan-lane handles
  // (spec-author-propose -> spec-author, architect-estimator -> architect-reviewer) map to their
  // spawnable role for the recommended-model lookup.
  const spawnable: Record<string, SpawnableAgentRole> = {
    "spec-author-story": "spec-author",
    "spec-author-propose": "spec-author",
    "architect-reviewer": "architect-reviewer",
    "architect-estimator": "architect-reviewer",
    dba: "dba",
    "test-strategist": "test-strategist",
  };
  const r = spawnable[role];
  return (r && RECOMMENDED_MODELS[r]) || "sonnet";
}

/** The driver-green sweep: a CLOUD LIVE run (requires RUN_LIVE_STEP + LAKEBASE_TEST_E2E to be set).
 *  Each candidate runs a FULL driver-GREEN cycle with the levers patched, gates on honest-GREEN, is
 *  JUDGED (code discriminator vs the 003-driver pin), and PRESERVED – all via the ONE sweep engine. */

/** Resolve which candidates a driver-green run executes: all of them, or the named subset (a resume of a
 *  partial sweep). Throws loud on an unknown id BEFORE any scaffold is spun up – a typo in a resume must
 *  not burn a live scaffold. Pure + exported for a unit test. */
export function selectDriverCandidates<C extends { id: string }>(all: C[], subset?: string[]): C[] {
  if (!subset?.length) return all;
  const missing = subset.filter((id) => !all.some((c) => c.id === id));
  if (missing.length) {
    throw new Error(`optimize-role: unknown driver-green candidate(s): ${missing.join(", ")}. Known: ${all.map((c) => c.id).join(", ")}`);
  }
  return all.filter((c) => subset.includes(c.id));
}

/** ONE per-candidate replay dispatcher for BOTH substrates – the convergence point. Given the corpus
 *  turn's bundle + the substrate, it runs the candidate through the SAME shared pieces (replay-set
 *  preconditions + recorded prompt + swept agent) and returns the SAME ChainRunResult that runRoleSweep
 *  consumes – so the sweep engine, judge, telemetry, and cost recording are identical for driver (cloud)
 *  and navigator/design (lean). Cloud: a per-candidate worktree + Lakebase branch + honest-GREEN + the
 *  next-turn navigator eval (the discriminator). Lean: a throwaway workspace, the single turn, no cloud
 *  (usage rides turns[].agentResult). */
async function runReplayCandidate(args: {
  substrate: "cloud" | "lean";
  bundle: DriverGreenBundle | undefined;
  project: ScaffoldedDriverProject | undefined;
  candidateId: string;
  levers: RoleLeverPatch;
  agentFor: (m: StepManifest) => StepAgent | undefined;
  idx: number;
  driverTurn: "green" | "repair" | "refactor";
  pfx: string;
  /** The chain's manifest dir – required for the lean substrate (the per-chain manifest subdir). */
  manifestDir?: string;
}): Promise<ChainRunResult> {
  if (args.substrate === "lean") {
    if (!args.bundle) throw new Error("lean replay requires a bundle (the corpus turn to replay)");
    if (!args.manifestDir) throw new Error("lean replay requires a manifestDir (the chain's manifest subdir)");
    // The lean lane's usage rides turns[].agentResult (the design-lane telemetry path), so cost is
    // recorded identically. Supply a STRUCTURAL gate (passed) – same as the cloud path: reaching here
    // means the turn ran + produced its determination, which is a valid SCORABLE turn (the judge scores
    // it same/better/worse vs the recorded marker; a thin/empty determination is the judge's call, not a
    // gate skip). Without this, role-sweep derives a DESIGN-shaped gate (producedOk on chain.outputFile +
    // design-complete) that a replayed build turn does not fit, wrongly skipping the mandatory judge.
    const { turns, producedArtifacts } = await runLeanReplayTurn(args.bundle, args.agentFor, args.manifestDir);
    return { turns, producedArtifacts, gate: { passed: true } };
  }
  // CLOUD: the driver's live cycle (scaffold worktree + Lakebase branch + honest-GREEN + navigator eval).
  const result = (await runDriverGreenOnScaffold(args.project!, {
    experimentSlug: `${args.pfx}-${args.driverTurn}-${args.candidateId}`,
    branch: `experiment/${args.pfx.toUpperCase()}-${args.driverTurn}-${args.candidateId}`,
    driverTurn: args.driverTurn,
    port: deployPortForIndex(args.idx),
    ...(args.bundle ? { bundle: args.bundle } : {}),
    ...(Object.keys(args.levers).length ? { leverOverride: args.levers } : {}),
  })) as RunDriverGreenResult | undefined;
  if (!result) throw new Error(`runDriverGreenOnScaffold returned void (expected RunDriverGreenResult)`);
  // Merge the captured next-step navigator marker into producedArtifacts under the reserved prefix so the
  // judge reads it without widening the ChainRunResult seam; the app/+tests stay for preservation.
  const producedArtifacts: Record<string, string> = { ...result.producedArtifacts };
  for (const [k, v] of Object.entries(result.nextStepMarker)) producedArtifacts[`${NEXT_STEP_MARKER_PREFIX}${k.split("/").pop()}`] = v;
  // Surface the honest-GREEN outcome so a code-equivalence judge can GATE on "the repair resolved" (the
  // objective signal) without a fresh subjective review. Preserved per candidate; read by the repair judge.
  producedArtifacts["repair-honest-green.json"] = JSON.stringify({ passed: result.honestGreen });
  return {
    turns: [],
    producedArtifacts,
    gate: { passed: true },
    durationMs: result.durationMs,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
  };
}

/** The CORPUS-FAITHFUL lean judge: compares the candidate's produced assess marker to the SAME corpus
 *  turn's RECORDED marker (its files/.consort snapshot), same/better/worse – the discriminator principle,
 *  vs the replayed turn's own recorded determination (not the curated reference-assets). Mirrors
 *  buildDriverNextStepJudge but the reference is the replayed turn itself. */
function buildReplayTurnJudge(turnLabel: string, feature: string, story: string, ac: string, discriminator: "assess" | "review" | "red"): QualityGate {
  const cwd = process.cwd();
  if (discriminator === "red") {
    // navigator-RED: functional coverage of the candidate's authored tests vs the tests the REPLAYED
    // corpus turn recorded (the corpus-faithful reference – what THAT turn produced, not curated
    // reference-assets). A faster/cheaper lever HOLDS the score when its tests cover the SAME behaviors
    // (score >= FUNCTIONAL_THRESHOLD); missing coverage drops the score. Mirrors the reference-assets red
    // path (makeOpusJudge functional:"tests") but the reference is the replayed turn's own test tree.
    const judge = makeOpusJudge({ cwd });
    const RED_EXTS = [".py", ".ts", ".tsx", ".feature"] as const;
    // The recorded turn's authored test tree: pytest under tests/, Vitest under client/tests/, Gherkin
    // .feature. snapshotTree loads files/ into the SAME {relpath -> contents} shape concatTreeFiles reads.
    const recMap = snapshotTree(join(CORPUS_TURNS, turnLabel, "files"), join(CORPUS_TURNS, turnLabel, "files"));
    const reference = concatTreeFiles(recMap, "tests/", RED_EXTS) + "\n" + concatTreeFiles(recMap, "client/tests/", RED_EXTS);
    if (!reference.trim()) {
      throw new Error(`buildReplayTurnJudge(red): recorded turn ${turnLabel} has no test tree under files/tests|client/tests – cannot judge.`);
    }
    return {
      judgeCandidate: async ({ producedArtifacts }) => {
        const candidate = concatTreeFiles(producedArtifacts, "tests/", RED_EXTS) + "\n" + concatTreeFiles(producedArtifacts, "client/tests/", RED_EXTS);
        if (!candidate.trim()) return { passed: false, reason: "no tests produced to judge" };
        const v = await judge({ step: "test-list" as never, reference, candidate, functional: "tests" as BuildOutputKind });
        return { passed: v.score >= FUNCTIONAL_THRESHOLD, score: v.score };
      },
    };
  }
  if (discriminator === "review") {
    // "review" compares review-verdict.json (recordedReviewDirective vs candidateReview) – wired when a
    // refactor/review turn is first targeted; assess + red are what's live now.
    throw new Error(`buildReplayTurnJudge: discriminator "${discriminator}" not yet wired (assess + red only)`);
  }
  const deltaJudge = makeSupersessionDeltaJudge({ cwd });
  const verdictJudge = makeVerdictAlignmentJudge({ cwd });
  // Regression-fidelity judge: when both determinations are `regression`, grade the diagnosis + fixDirective
  // CONTENT against the recorded ground truth (not just the class), so a candidate that lands the regression
  // class with a WRONG root cause FAILS instead of silently passing (the panel finding). Same fixed-opus
  // judge family as deltaJudge.
  const regressionJudge = makeRegressionFidelityJudge({ cwd });
  const recSrc = join(CORPUS_TURNS, turnLabel, "files", ARTIFACT_ROOT, "cycles", feature, story, ac);
  const MARKER_FILES = ["regression-assessment.json", "superseded-tests.json"];
  // The recorded failed-verify summary (green-failure.json) gives the fidelity judge the failure context.
  const failureSummary = ((): string | undefined => {
    const p = join(recSrc, "green-failure.json");
    if (!existsSync(p)) return undefined;
    try {
      const g = JSON.parse(readFileSync(p, "utf8")) as { summary?: unknown };
      return typeof g.summary === "string" ? g.summary : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    judgeCandidate: async ({ producedArtifacts }) => {
      const recDir = mkdtempSync(join(tmpdir(), "rec-assess-"));
      const candDir = mkdtempSync(join(tmpdir(), "cand-assess-"));
      try {
        // Recorded reference: the corpus turn's own produced assess markers.
        for (const f of MARKER_FILES) {
          const p = join(recSrc, f);
          if (existsSync(p)) writeFileSync(join(recDir, f), readFileSync(p, "utf8"));
        }
        // Candidate: the assess markers this run produced (from the .consort snapshot).
        const cyclePrefix = join(ARTIFACT_ROOT, "cycles", feature, story, ac) + "/";
        for (const [k, v] of Object.entries(producedArtifacts)) {
          const base = k.startsWith(cyclePrefix) ? k.slice(cyclePrefix.length) : undefined;
          if (base && MARKER_FILES.includes(base)) writeFileSync(join(candDir, base), v);
        }
        const outcome = await evaluateNextStepDetermination({
          evaluatorKind: "assess",
          deltaJudge,
          verdictJudge,
          regressionJudge,
          ...(failureSummary ? { failureSummary } : {}),
          recordedMarkerDir: recDir,
          candidateMarkerDir: candDir,
        });
        const passed = outcome.verdict !== "fail";
        const classification = outcome.verdict === "pass-with-honors" ? "pass-with-honors" : outcome.candidateClass;
        return { passed, classification, nextStep: outcome.verdict, reason: outcome.reason };
      } finally {
        rmSync(recDir, { recursive: true, force: true });
        rmSync(candDir, { recursive: true, force: true });
      }
    },
  };
}

/** Read the review-verdict the corpus recorded for the turn IMMEDIATELY AFTER the replayed repair turn ,
 *  the recorded NEXT-STEP determination the two-turn quality comparison judges against. */
function readRecordedNextReview(turnLabel: string, feature: string, story: string): VerdictOutput {
  const ord = Number(turnLabel.split("-")[0]);
  const next = readdirSync(CORPUS_TURNS).filter((d) => Number(d.split("-")[0]) === ord + 1).sort()[0];
  if (!next) throw new Error(`readRecordedNextReview: no turn after ${turnLabel} (ordinal ${ord + 1}) in ${CORPUS_TURNS}`);
  const rv = join(CORPUS_TURNS, next, "files", ARTIFACT_ROOT, "cycles", feature, story, "review-verdict.json");
  if (!existsSync(rv)) throw new Error(`readRecordedNextReview: turn-after ${next} has no story-level review-verdict at ${rv} (the repair's recorded next step is not a review)`);
  return parseVerdictFile(readFileSync(rv, "utf8"));
}

/** Read the recorded review DIRECTIVE that PROMPTED a refactor (the smells the refactor must resolve). The
 *  refactor's recorded NEXT turn is acceptance (no review-verdict), so – unlike repair – the reference is
 *  the UPSTREAM review-verdict, read from the corpus recorded-artifacts (the cumulative .consort mirror).
 *  The harness FORCES a fresh post-refactor review (resets the story review state after the refactor so the
 *  drive re-reviews the refactored code); that verdict is compared to THIS directive – clean (refactor:false)
 *  == the refactor resolved the directive's smells in one step. */
function readRecordedRefactorDirective(feature: string, story: string): VerdictOutput {
  const rv = join(CORPUS_RA, "cycles", feature, story, "review-verdict.json");
  if (!existsSync(rv)) throw new Error(`readRecordedRefactorDirective: no story-level review-verdict at ${rv} (the refactor's recorded directive)`);
  return parseVerdictFile(readFileSync(rv, "utf8"));
}

/** The CORPUS-FAITHFUL post-turn REVIEW-quality judge – the QUALITY method (NOT code-equivalence, which
 *  always has non-deterministic diffs; the navigator's review prompts already gauge quality). It is a
 *  TWO-TURN review: after the driver turn, the drive runs the navigator's ACTUAL review of the resolved
 *  story – run with the navigator's CONFIGURED model (the applied-winner lever, NOT a pinned opus-high – see
 *  runDriverGreenOnScaffold) – and this judge compares that review-verdict to the recorded review directive
 *  via evaluateNextStepDetermination(review): clean (refactor:false) => PASS (resolved), smells remaining =>
 *  FAIL. Gated on honest-GREEN (the turn kept the story green). The two callers differ ONLY in which recorded
 *  review is the directive (repair: the turn-AFTER review it routes to; refactor: the UPSTREAM review it must
 *  resolve). See consort/optimize/DRIVER-REPAIR-TURN-REPLAY.md. */
function buildReviewResolutionJudge(recordedReviewDirective: VerdictOutput): QualityGate {
  const cwd = process.cwd();
  const deltaJudge = makeSupersessionDeltaJudge({ cwd });
  const verdictJudge = makeVerdictAlignmentJudge({ cwd });
  return {
    judgeCandidate: async ({ producedArtifacts }) => {
      // GATE: the turn must have kept the story honest-GREEN. Prefer the explicit marker; fall back to
      // "a next-step review-verdict was produced" (the drive only routes to review when the story is green).
      let resolved: boolean;
      const hg = producedArtifacts["repair-honest-green.json"];
      if (hg !== undefined) {
        try { resolved = (JSON.parse(hg) as { passed?: unknown }).passed === true; } catch { resolved = false; }
      } else {
        resolved = producedArtifacts[`${NEXT_STEP_MARKER_PREFIX}review-verdict.json`] !== undefined;
      }
      if (!resolved) return { passed: false, reason: "driver turn did not hold honest-GREEN – not the same quality as the recorded resolved turn" };
      const candRaw = producedArtifacts[`${NEXT_STEP_MARKER_PREFIX}review-verdict.json`];
      if (candRaw === undefined) return { passed: false, reason: "no next-step review-verdict captured – the navigator's next review did not run/produce a verdict" };
      const candidateReview = parseVerdictFile(candRaw);
      // Two-turn quality: does the candidate's next-turn review reach the same-or-better determination as the
      // recorded directive? (review evaluator – clean=resolved=PASS; the actual navigator model, not opus-high.)
      const outcome = await evaluateNextStepDetermination({ evaluatorKind: "review", deltaJudge, verdictJudge, recordedReviewDirective, candidateReview });
      const passed = outcome.verdict !== "fail";
      const classification = outcome.verdict === "pass-with-honors" ? "pass-with-honors" : outcome.candidateClass;
      return { passed, classification, nextStep: outcome.verdict, reason: outcome.reason };
    },
  };
}

/** Repair-turn judge: reference = the recorded turn-AFTER review (the repair's recorded next step). */
function buildDriverRepairNextStepJudge(turnLabel: string, feature: string, story: string): QualityGate {
  return buildReviewResolutionJudge(readRecordedNextReview(turnLabel, feature, story));
}

/** Refactor-turn judge: reference = the recorded UPSTREAM review directive the refactor must resolve. The
 *  tuning target is a CLEAN one-step refactor (post-refactor review clean => no follow-on refactor loop). */
function buildDriverRefactorNextStepJudge(feature: string, story: string): QualityGate {
  return buildReviewResolutionJudge(readRecordedRefactorDirective(feature, story));
}

export async function sweepDriverGreen(
  handle: string,
  runRoot: string,
  opts: { concurrency?: number; candidates?: string[]; replicas?: number; experiment?: string } = {},
): Promise<{ summary: ChainSummary }> {
  // GATED: only meaningful with a live test env (RUN_LIVE_STEP + LAKEBASE_TEST_E2E).
  if (!process.env.RUN_LIVE_STEP || !process.env.LAKEBASE_TEST_E2E) {
    throw new Error(
      `optimize-role: driver sweep requires RUN_LIVE_STEP=1 LAKEBASE_TEST_E2E=1 (live cloud gate). ` +
        `This is a LIVE driver harness, not a lean chain run. Use the driver-build-support harness directly or set the gates.`,
    );
  }
  const spec = DRIVER_TURN_SPECS[handle];
  if (!spec) throw new Error(`optimize-role: unknown driver handle "${handle}" (known: ${Object.keys(DRIVER_TURN_SPECS).join(", ")})`);

  const runDir = join(runRoot, handle);
  mkdirSync(runDir, { recursive: true });

  // Candidate subset (resume a partial sweep): run only the named ids; their trials MERGE with any
  // per-candidate dirs already persisted from a prior (crashed) run in the SAME run dir. Absent => all.
  // Driver turns use the ENFORCEMENT + CONTEXT lever set (DRIVER-GREEN-LEVERS.md) – the run-17 analysis
  // showed the driver's wall-clock is tool-churn (orientation + redundant self-verification), not model
  // tier (already sonnet), so the interesting levers are behavioral, not the generic model/effort grid.
  // Externalized experiment config (--experiment): SUPPLIES the candidates + the corpus turn (fixed
  // preconditions) + concurrency/replicas – the run picks it up instead of the hardcoded candidate set +
  // default turn. Its driverTurn must match this handle (the handle names the judge + turn kind). Absent
  // => the built-in driverGreenCandidates() + the default corpus turn for this handle.
  const experiment = opts.experiment ? loadExperimentConfig(opts.experiment) : undefined;
  if (experiment && experiment.driverTurn !== spec.driverTurn) {
    throw new Error(`experiment "${experiment.name}" driverTurn=${experiment.driverTurn} does not match handle ${handle} (driverTurn=${spec.driverTurn})`);
  }
  const experimentBundle: DriverGreenBundle | undefined = experiment ? replayBundleFromTurn(experiment.turn, experiment.ac) : undefined;
  const all = experiment ? experiment.roleCandidates : driverGreenCandidates();
  // Select the subset, then REPLICATE (--replicas N) into <id>-r1..-rN so one lever can be run N times
  // in parallel to measure its variance (each replica gets a unique id => unique deterministic port).
  const replicas = experiment?.replicas ?? opts.replicas;
  const candidates = expandReplicas(selectDriverCandidates(all, opts.candidates), replicas);
  const concurrency = experiment?.concurrency ?? opts.concurrency;

  // eslint-disable-next-line no-console
  console.log(`[optimize-role] ${handle}: CLOUD LIVE driver-GREEN sweep${experiment ? ` [experiment: ${experiment.name} @ turn ${experiment.turn}]` : ""}, ${candidates.length} candidate(s)${opts.candidates?.length ? ` (subset: ${opts.candidates.join(",")})` : ""}${(replicas ?? 1) > 1 ? ` x${replicas} replicas` : ""}, concurrency=${concurrency ?? 1}. run dir: ${runDir}`);

  // The MANDATORY driver-turn judge (SHARED with the re-judge harness): the recorded corpus ALSO
  // evaluated this driver turn (the navigator turn that followed it). buildDriverNextStepJudge re-runs
  // that SAME evaluation LIVE on the candidate (the harness drives the opus-high navigator eval; its
  // determination rides producedArtifacts under navigator-eval/) and compares the candidate's
  // determination to the RECORDED one at the same step – the discriminator is SAME / BETTER / WORSE
  // (evaluateNextStepDetermination). PASS (same) / PASS-WITH-HONORS (fewer/no issues, better) / FAIL (worse).
  // A REPAIR experiment is judged CORPUS-FAITHFULLY: a repair resolves (honest-GREEN passes => state-derived
  // next step is a REVIEW) and that review must be NO-WORSE than the recorded turn-after's review (green +
  // review is the quality bar). buildDriverNextStepJudge's fixed reference-assets ref is a DIFFERENT
  // (legacy) scenario, so for a repair experiment use the review judge vs the replayed turn's own next
  // review. See consort/optimize/DRIVER-REPAIR-TURN-REPLAY.md.
  const quality: QualityGate =
    experiment && experimentBundle && spec.driverTurn === "repair"
      ? buildDriverRepairNextStepJudge(experiment.turn, experimentBundle.feature, experimentBundle.story)
      : experiment && experimentBundle && spec.driverTurn === "refactor"
        ? buildDriverRefactorNextStepJudge(experimentBundle.feature, experimentBundle.story)
        : buildDriverNextStepJudge(handle);

  // The driver chain as a ChainRunner for the ONE sweep engine: scaffold ONCE (the #589 model), each
  // candidate cuts its own worktree + Lakebase branch off it, drives its DRIVER TURN + the live
  // next-step navigator eval (opus-high), and returns producedArtifacts (app/+tests) MERGED with the
  // captured next-step marker (under NEXT_STEP_MARKER_PREFIX) + gate:{honestGreen}. runRoleSweep then
  // PRESERVES + JUDGES it identically to every other chain (no second engine).
  const project = await scaffoldDriverGreenProject();
  const driverChain: SweepableChain = { dir: handle, outputFile: "app", prompt: `driver ${spec.driverTurn} (live, shared scaffold)` };
  // Slug/branch prefix DERIVED from the pinned bundle's story (S2-drop-combined -> "s2", S3-stock-shows
  // -> "s3") so the worktree + Lakebase branch names name the RIGHT story – no hardcoded "s3" that
  // mislabels an S2 sweep for the results reader.
  // The bundle for this sweep: the experiment config's corpus turn (when given) else the S2 legacy pin
  // else the handle's default replay turn (resolved inside runDriverGreenOnScaffold).
  const pinnedBundle = experimentBundle ?? (handle === "driver-green-s2" ? DRIVER_GREEN_BUNDLE_S2 : undefined);
  const pfx = (pinnedBundle?.story ?? "S3-stock-shows-split-fields").split("-")[0].toLowerCase();
  const runChain: ChainRunner = async (_c, agentFor, candidateId, levers) => {
    // Deterministic per-candidate deploy port (base + index) so parallel candidates never collide on the
    // shared :8000 the honest-GREEN verify binds. Route through the ONE dispatcher (cloud substrate here).
    const idx = Math.max(0, candidates.findIndex((c) => c.id === candidateId));
    return runReplayCandidate({
      substrate: "cloud",
      bundle: pinnedBundle,
      project,
      candidateId,
      levers,
      agentFor: agentFor as (m: StepManifest) => StepAgent | undefined,
      idx,
      driverTurn: spec.driverTurn,
      pfx,
    });
  };

  let trials: SweepTrial[];
  try {
    trials = await runRoleSweep(driverChain, candidates, runChain, {
      ...(concurrency ? { concurrency } : {}),
      quality,
      onStart: (candidate, i, total) => {
        // eslint-disable-next-line no-console
        console.log(`[optimize-role] ${handle} (${i}/${total}) running ${candidate.id} ...`);
      },
      onDone: (trial, i, total) => {
        // PRESERVE every candidate's produced code + verdict the instant it finishes (crash-resilient).
        persistTrial(runDir, driverChain as unknown as RoleChain, "sonnet", trial);
        const q = trial.qualityPassed === undefined ? "" : trial.qualityPassed ? ` judge PASSED (${trial.telemetry?.classification ?? "?"})` : ` judge FAILED (${trial.telemetry?.classification ?? "?"})`;
        const status = trial.disqualified ? `DISQUALIFIED (${trial.reason})` : trial.gatePassed ? "honest-GREEN" : "not-green";
        // eslint-disable-next-line no-console
        console.log(`[optimize-role] ${handle} (${i}/${total}) ${trial.candidateId}: ${status}${q}${trial.telemetry?.outerDurationMs ? ` – ${(trial.telemetry.outerDurationMs / 1000).toFixed(1)}s` : ""}`);
      },
    });
  } finally {
    await teardownDriverGreenProject(project);
    // Orphan backstop (a killed candidate can leak a Lakebase project despite per-candidate teardown).
    await sweepDriverGreenOrphans();
  }

  // Winner via the SHARED report: the fastest candidate that passed BOTH conformance (honest-GREEN)
  // AND the mandatory judge – NOT wall-clock among honest-GREEN (the prior, judge-less bug).
  // Score time SAME/BETTER/WORSE against the RECORDED original turn (spec.recordedBaselineMs), not a
  // fresh baseline run – the recording is the fixed reference (its pre/post-state + duration are in the
  // corpus). Falls back to the live baseline candidate when the spec has no recorded time.
  const report = reportRoleSweep(trials, spec.recordedBaselineMs);
  writeFileSync(join(runDir, "report.txt"), formatRoleSweepReport(report) + "\n");
  const summary = buildChainSummary(handle, "sonnet", trials, report);
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`\n[${handle}]\n` + formatRoleSweepReport(report));

  return { summary };
}

/** Read a required recorded reference from the CAMP; throw loud if absent (the evaluation cannot
 *  run without its reference – never a silent skip). */
function readCampReference(relFromCorpusRoot: string, what: string): string {
  const p = join(process.cwd(), BUILD_CORPUS_REL, relFromCorpusRoot);
  if (!existsSync(p)) {
    throw new Error(`optimize-role: MISSING recorded reference for ${what} at ${p} – the LLM judge is mandatory and cannot run without it. Extract it from the corpus into the camp first.`);
  }
  return readFileSync(p, "utf8");
}

/** The camp-relative path to the recorded driver-GREEN code pin (003-driver's app/ DIRECTORY). The
 *  driver-green sweep judges every candidate's produced app/ against this. Exported so a hermetic
 *  test can assert it resolves to non-empty concatenated .py text (guards the dir-vs-file EISDIR
 *  the live path hit: readFileSync on this directory throws, so it MUST go through readCampAppDir). */
export const DRIVER_GREEN_CODE_PIN_REL =
  "recorded-build/features/F6-split-tracking-code/stories/S1-split-columns-migration/turns/003-driver/code/app";

/** producedArtifacts key-prefix carrying the candidate's NEXT-STEP NAVIGATOR EVALUATION marker files
 *  (superseded-tests.json / regression-assessment.json / review-verdict.json, relpath -> contents) from
 *  the harness. It rides producedArtifacts so (a) the judge closure reads it without widening the
 *  ChainRunResult seam, and (b) persistTrial DURABLY stores it per candidate at
 *  `<runDir>/<candidate>/artifacts/navigator-eval/<file>` – a first-class, legibly-named record of the
 *  navigator's evaluation of this driver output. That stored evaluation is a REUSABLE SAMPLE for a
 *  separate test OF THE NAVIGATOR itself (how the navigator assessed/reviewed each driver candidate),
 *  so the prefix is a real path segment, not an opaque marker. */
const NEXT_STEP_MARKER_PREFIX = "navigator-eval/";

/** Concatenate the produced files under `prefix` with a matching extension into ONE deterministic text
 *  (sorted by relpath). Used to reconstruct the judged text when a chain's outputFile is a DIRECTORY
 *  (navigator-red's "tests"), where `producedArtifacts[outputFile]` is always undefined (snapshotTree
 *  only keys individual files). Exported so a hermetic guard can prove the reconstruction is non-empty
 *  (the latent bug: a bare-key lookup made the red judge always short-circuit to "no tests produced"). */
export function concatTreeFiles(producedArtifacts: Record<string, string>, prefix: string, exts: readonly string[]): string {
  return Object.entries(producedArtifacts)
    .filter(([k]) => k.startsWith(prefix) && exts.some((e) => k.endsWith(e)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .join("\n");
}

/** Read a required recorded-code reference that is an app/ DIRECTORY (a tree of .py files) from the
 *  CAMP and concatenate its .py contents into ONE text, the SAME shape the driver-green judge builds
 *  from the candidate's produced app/ (its `app/**\/*.py` joined). Sorted by relpath so the reference
 *  text is deterministic across runs. Throws loud if the dir is absent or holds no .py (the code
 *  judge is mandatory and cannot run without its reference – never a silent skip). Exported for a
 *  hermetic guard test. */
export function readCampAppDir(relFromCorpusRoot: string, what: string): string {
  const dir = join(process.cwd(), BUILD_CORPUS_REL, relFromCorpusRoot);
  if (!existsSync(dir)) {
    throw new Error(`optimize-role: MISSING recorded reference for ${what} at ${dir} – the LLM judge is mandatory and cannot run without it. Extract it from the corpus into the camp first.`);
  }
  const tree = snapshotTree(dir, dir); // { relpath -> contents } for every file under the app dir
  const text = Object.entries(tree)
    .filter(([k]) => k.endsWith(".py"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .join("\n");
  if (!text.trim()) {
    throw new Error(`optimize-role: recorded reference for ${what} at ${dir} has no .py files – cannot judge produced code against an empty reference.`);
  }
  return text;
}

/** Build the MANDATORY per-chain judge (a QualityGate closure). Every chain kind routes to its OWN
 *  existing discriminator in consort/evaluation/semantic-gate, comparing the candidate's produced
 *  output to the committed recorded reference. There is NO judge-less branch – an LLM judge is a hard
 *  requirement of every evaluation (the guarantee of product-result equivalence). A missing reference
 *  throws (evaluation invalid), never a silent skip. */
export function buildChainJudge(chain: RoleChain | BuildRoleChain, handle: string, isBuildChain: boolean): QualityGate {
  const cwd = process.cwd();
  if (!isBuildChain) {
    // DESIGN chains: opus semantic judge vs the recorded per-turn artifact (camp).
    const reference = readReference(chain as RoleChain, handle);
    if (reference === undefined) {
      throw new Error(`optimize-role: MISSING recorded reference for design chain '${handle}' – the LLM judge is mandatory. Point the chain's referenceFile at a committed recorded per-turn output.`);
    }
    const judge = makeOpusJudge({ cwd });
    return {
      judgeCandidate: async ({ primary }) => {
        if (primary === undefined) return { passed: false, reason: "no primary artifact to judge" };
        const v = await judge({ step: "acs" as never, reference, candidate: primary });
        return { passed: v.score >= SEMANTIC_THRESHOLD, score: v.score };
      },
    };
  }

  const b = chain as BuildRoleChain;
  if (b.assertKind === "red") {
    // navigator-red: functional coverage of the produced tests vs the recorded test-list.
    const reference = readCampReference("recorded-artifacts/features/F6-split-tracking-code/test-list.json", "navigator-red test-list");
    const judge = makeOpusJudge({ cwd });
    return {
      judgeCandidate: async ({ primary, producedArtifacts }) => {
        // navigator-red's outputFile is the "tests" DIRECTORY, not a single file, so
        // `primary = producedArtifacts["tests"]` is ALWAYS undefined (snapshotTree only ever keys
        // individual files, tests/foo.py). Reconstruct the judged text by concatenating the produced
        // tests/**.{py,ts,tsx} (sorted, deterministic – concatTreeFiles). This was a latent bug: the
        // bare-key lookup made red ALWAYS return "no tests produced" => passed:false, so it never
        // actually scored. Fall back to `primary` for a file-shaped outputFile.
        const testsText = primary ?? concatTreeFiles(producedArtifacts, "tests/", [".py", ".ts", ".tsx"]);
        if (!testsText.trim()) return { passed: false, reason: "no tests produced to judge" };
        const v = await judge({ step: "test-list" as never, reference, candidate: testsText, functional: "tests" as BuildOutputKind });
        return { passed: v.score >= FUNCTIONAL_THRESHOLD, score: v.score };
      },
    };
  }
  if (b.assertKind === "assess") {
    // navigator-assess: align the candidate's marker to the RECORDED assess ground truth, via the
    // SHARED evaluateNavigatorAssessAlignment (classification-match hard gate + supersession delta
    // judge). Both parseNavigatorAssessMarker + the alignment read a DIR; the sweep captures the
    // produced marker as in-memory text (its mkdtemp workspace is already gone), so write the
    // candidate's marker files to a scratch dir and align against the recorded verdict.
    const recordedVerdict = parseNavigatorAssessMarker(
      join(cwd, BUILD_CORPUS_REL, "recorded-build/features/F6-split-tracking-code/stories/S1-split-columns-migration/turns/004-navigator-assess-AC1-batch-serial-columns-added/tdd/cycles/F6-split-tracking-code/S1-split-columns-migration/AC1-batch-serial-columns-added"),
    );
    const deltaJudge = makeSupersessionDeltaJudge({ cwd });
    return {
      judgeCandidate: async ({ candidateId, producedArtifacts }) => {
        const markerDir = mkdtempSync(join(tmpdir(), `assess-marker-${candidateId}-`));
        try {
          let wroteMarker = false;
          for (const name of ["superseded-tests.json", "regression-assessment.json"]) {
            const key = Object.keys(producedArtifacts).find((k) => k.endsWith(name));
            if (key !== undefined) { writeFileSync(join(markerDir, name), producedArtifacts[key]); wroteMarker = true; }
          }
          // No marker => the candidate judged the code clean (equivalent), which parseNavigatorAssessMarker
          // reads from an empty dir – a legitimate verdict, not a missing artifact.
          void wroteMarker;
          const outcome = await evaluateNavigatorAssessAlignment({ recordedVerdict, navigatorMarkerDir: markerDir, deltaJudge });
          return { passed: outcome.passed, classification: outcome.classificationMatch ? recordedVerdict.classification : "insufficient", reason: outcome.reason };
        } finally {
          rmSync(markerDir, { recursive: true, force: true });
        }
      },
    };
  }
  // navigator-review / navigator-reflect: verdict-alignment vs the recorded verdict (camp).
  const isReview = b.assertKind === "review";
  const refRel = isReview
    ? "recorded-build/features/F6-split-tracking-code/stories/S3-stock-shows-split-fields/turns/001-navigator-reflect/tdd/cycles/F6-split-tracking-code/S1-split-columns-migration/AC1-batch-serial-columns-added/review-verdict.json"
    : "recorded-artifacts/features/F6-split-tracking-code/stories/S3-stock-shows-split-fields/reflect-verdict.json";
  const recordedVerdict = parseVerdictFile(readCampReference(refRel, `navigator-${b.assertKind} verdict`));
  const alignJudge = makeVerdictAlignmentJudge({ cwd });
  return {
    judgeCandidate: async ({ producedArtifacts }) => {
      const key = b.verdictFile && producedArtifacts[b.verdictFile] !== undefined
        ? b.verdictFile
        : Object.keys(producedArtifacts).find((k) => k.endsWith(isReview ? "review-verdict.json" : "reflect-verdict.json"));
      if (!key) return { passed: false, reason: `no ${b.assertKind}-verdict produced to judge` };
      const candidateVerdict = parseVerdictFile(producedArtifacts[key]);
      const v = await alignJudge({ recordedVerdict, candidateVerdict, kind: isReview ? "review" : "reflect" });
      return { passed: v.passed, reason: v.reason };
    },
  };
}

/** The MANDATORY per-DRIVER-TURN judge (a QualityGate closure), SHARED by the live sweep (sweepDriverGreen)
 *  and the re-judge harness so BOTH score a driver candidate identically: run the candidate's captured
 *  NEXT-STEP navigator determination (marker files under NEXT_STEP_MARKER_PREFIX in producedArtifacts)
 *  through evaluateNextStepDetermination, comparing it to the CONTAINED recorded determination for that
 *  driver turn (assume corpus gone). Reuses makeSupersessionDeltaJudge (assess set-delta) +
 *  makeVerdictAlignmentJudge (review). Maps the directional verdict: pass + pass-with-honors => passed
 *  (honors surfaced via classification + nextStep); fail => not passed. A missing reference throws.
 *
 *  INVARIANT – the discriminator is the NAVIGATOR DETERMINATION, never a turn OUTPUT signal. DO NOT wrap
 *  this judge with an honest-GREEN (or any driver-output) shortcut that returns pass/pass-with-honors
 *  WITHOUT consulting the navigator determination. The corpus recorded not just the driver output but how
 *  the navigator EVALUATED it at that step; the trial re-runs that SAME evaluation live and this judge
 *  compares the two, SAME / BETTER / WORSE. Whether the driver's own green passed is a report signal only
 *  – a green that ignored a supersession is WORSE (it breaks prior tests), not "better", and ONLY the
 *  navigator determination tells them apart. A shortcut here silently mis-scores that case. This invariant
 *  is locked by "buildDriverNextStepJudge is the discriminator (no output shortcut)" in
 *  tests/bdd/optimize-role-cli.test.ts – keep it green. See consort/optimize/DRIVER-GREEN-LEVERS.md. */
export function buildDriverNextStepJudge(handle: string): QualityGate {
  const spec = DRIVER_TURN_SPECS[handle];
  if (!spec) throw new Error(`optimize-role: buildDriverNextStepJudge – unknown driver handle "${handle}"`);
  const cwd = process.cwd();
  const deltaJudge = makeSupersessionDeltaJudge({ cwd });
  const verdictJudge = makeVerdictAlignmentJudge({ cwd });
  // Regression-fidelity judge (parity with buildReplayTurnJudge): grade the diagnosis + fixDirective
  // content when both determinations are `regression`, so a class-only match with a wrong root cause fails.
  const regressionJudge = makeRegressionFidelityJudge({ cwd });
  const recordedRefDir = join(cwd, BUILD_CORPUS_REL, spec.refRel);
  if (!existsSync(recordedRefDir)) {
    throw new Error(`optimize-role: MISSING contained next-step reference for ${handle} at ${recordedRefDir} – the LLM judge is mandatory and cannot run without it.`);
  }
  const driverFailureSummary = ((): string | undefined => {
    const p = join(recordedRefDir, "green-failure.json");
    if (!existsSync(p)) return undefined;
    try {
      const g = JSON.parse(readFileSync(p, "utf8")) as { summary?: unknown };
      return typeof g.summary === "string" ? g.summary : undefined;
    } catch {
      return undefined;
    }
  })();
  const recordedReviewDirective: VerdictOutput | undefined =
    spec.evaluatorKind === "review" ? parseVerdictFile(readCampReference(join(spec.refRel, "review-verdict.json"), `${handle} recorded review directive`)) : undefined;
  return {
    judgeCandidate: async ({ candidateId, producedArtifacts }) => {
      // Materialize the candidate's captured next-step marker files into a scratch dir (strip the prefix).
      const markerDir = mkdtempSync(join(tmpdir(), `nextstep-${candidateId}-`));
      try {
        for (const [k, v] of Object.entries(producedArtifacts)) {
          if (k.startsWith(NEXT_STEP_MARKER_PREFIX)) writeFileSync(join(markerDir, k.slice(NEXT_STEP_MARKER_PREFIX.length)), v);
        }
        const outcome = await evaluateNextStepDetermination({
          evaluatorKind: spec.evaluatorKind,
          deltaJudge,
          verdictJudge,
          regressionJudge,
          ...(driverFailureSummary ? { failureSummary: driverFailureSummary } : {}),
          ...(spec.evaluatorKind === "assess"
            ? { recordedMarkerDir: recordedRefDir, candidateMarkerDir: markerDir }
            : {
                recordedReviewDirective,
                candidateReview: parseVerdictFile(producedArtifacts[`${NEXT_STEP_MARKER_PREFIX}review-verdict.json`] ?? "{}"),
              }),
        });
        // ENFORCED INVARIANT – the discriminator IS the next-turn assessment, nothing else. `outcome`
        // above is evaluateNextStepDetermination: the RECORDED next-turn navigator determination vs the
        // candidate's captured next-turn determination, ranked same / better / worse. The next-turn agent
        // (navigator assess/review) AND the orchestrator's deterministic assessment (honest-GREEN verify,
        // supersession pre-localization, smell/refactor detection) ALREADY evaluate the code results – do
        // NOT re-implement any of that here (no code scanning, no honest-GREEN shortcut, no bespoke
        // milestone/resolution overlay). This maps `outcome` straight through, and that is the WHOLE judge.
        // Any richer evaluation belongs in the next-turn assessment / orchestrator, not this closure.
        // Locked by "buildDriverNextStepJudge IS the next-turn assessment" in tests/bdd/optimize-role-cli.test.ts.
        const passed = outcome.verdict !== "fail";
        const classification = outcome.verdict === "pass-with-honors" ? "pass-with-honors" : outcome.candidateClass;
        return { passed, classification, nextStep: outcome.verdict, reason: outcome.reason };
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
      }
    },
  };
}

/** Sweep ONE chain end to end + persist its evidence + report under <runRoot>/<handle>/. Returns
 *  the chain's report (for the multi-chain roll-up). LIVE – each candidate spawns a real claude
 *  turn; candidates fan out under `concurrency`. Handles both design role chains and build chains. */
export async function sweepOneChain(
  handle: string,
  runRoot: string,
  opts: { baseModel?: string; concurrency?: number; baselineDir?: string; experiment?: string } = {},
): Promise<SweepReport> {
  // Determine if this is a design or build chain.
  const isBuildChain = handle in BUILD_ROLE_CHAINS;
  const chain = isBuildChain ? BUILD_ROLE_CHAINS[handle] : ROLE_CHAINS[handle];
  if (!chain) {
    throw new Error(`optimize-role: unknown chain "${handle}"`);
  }

  const baseModel = baseModelFor(handle, opts.baseModel);
  // The test-strategist is a SUPERVISOR – its optimization target is the per-analyst SUBAGENT levers,
  // not its own model. Its candidate set permutes ALL enabled analysts (behavior/fitness/client);
  // every other chain uses the single-role model/effort set.
  // Externalized experiment config (--experiment): SUPPLIES the candidates + the corpus turn (fixed
  // preconditions) – the LEAN lane replays the recorded replay-set (recorded prompt + pre-project) via the
  // ONE dispatcher (runReplayCandidate substrate:"lean"), not the curated reference-assets + regenerated
  // prompt. Absent => the built-in candidate set + the reference-assets chain (legacy). The judge stays the
  // per-chain discriminator either way.
  const experiment = opts.experiment ? loadExperimentConfig(opts.experiment) : undefined;
  if (experiment && experiment.substrate !== "lean") {
    throw new Error(`experiment "${experiment.name}" (role ${experiment.role}) is substrate=${experiment.substrate}; a lean chain sweep needs a lean turn (use the driver-green handle for a cloud turn)`);
  }
  const experimentBundle: DriverGreenBundle | undefined = experiment ? replayBundleFromTurn(experiment.turn, experiment.ac) : undefined;
  const candidates = experiment
    ? experiment.roleCandidates
    : handle === "test-strategist"
      ? testStrategistCandidates(enabledAnalysts({ projectDir: "", uiTrack: true }).map((a) => a.kind))
      : roleCandidates(baseModel);
  const runDir = join(runRoot, handle);
  mkdirSync(runDir, { recursive: true });

  // MANDATORY per-chain JUDGE – every chain kind supplies its OWN existing discriminator (an LLM
  // judge is required for every evaluation; it is the only guarantee of product-result equivalence).
  // A missing recorded reference is a HARD ERROR here (the evaluation cannot run without it), never a
  // silent skip. The closure is handed to runRoleSweep, which judges every conformant candidate and
  // DISQUALIFIES any with no verdict. Judges are the SHARED ones in consort/evaluation/semantic-gate.
  // Experiment: the CORPUS-FAITHFUL discriminator (candidate marker vs the REPLAYED turn's recorded
  // marker); otherwise the legacy per-chain judge (reference-assets). Both are mandatory LLM judges.
  const quality: QualityGate =
    experiment && experimentBundle
      ? buildReplayTurnJudge(experiment.turn, experimentBundle.feature, experimentBundle.story, experimentBundle.ac, experiment.discriminator ?? "assess")
      : buildChainJudge(chain, handle, isBuildChain);

  // eslint-disable-next-line no-console
  console.log(
    `[optimize-role] ${handle}: ${isBuildChain ? "BUILD" : "DESIGN"} chain, baseline model=${baseModel}, ${candidates.length} candidates, concurrency=${opts.concurrency ?? 1}. ` +
      `quality judge: MANDATORY (per-chain discriminator). run dir: ${runDir}`,
  );

  const runChain: ChainRunner = experiment
    ? // LEAN REPLAY: the ONE dispatcher, replaying the corpus turn's recorded state + prompt (no cloud).
      async (_c, agentFor, candidateId, levers) =>
        runReplayCandidate({
          substrate: "lean",
          bundle: experimentBundle,
          project: undefined,
          candidateId,
          levers,
          agentFor: agentFor as (m: StepManifest) => StepAgent | undefined,
          idx: 0,
          driverTurn: "green",
          pfx: "",
          // The per-chain manifest subdir (e.g. navigator-assess-chain) – the lean turn's manifests.
          manifestDir: join(process.cwd(), BUILD_MANIFESTS_REL, chain.dir),
        })
    : isBuildChain
      ? async (c, agentFor, _id, levers) =>
          runBuildRoleChainLive(c as BuildRoleChain, {
            agentFor: agentFor as (m: StepManifest) => StepAgent | undefined,
          })
      : async (c, agentFor, _id, levers) =>
          runRoleChainLive(c as RoleChain, {
            agentFor: agentFor as (m: StepManifest) => StepAgent | undefined,
            // TEST-STRATEGIST: forward the candidate's per-analyst overrides into the roster preparer.
            ...(levers.analystOverrides ? { analystOverrides: levers.analystOverrides } : {}),
          });
  const trials = await runRoleSweep(chain, candidates, runChain, {
    ...(quality ? { quality } : {}),
    ...((experiment?.concurrency ?? opts.concurrency) ? { concurrency: experiment?.concurrency ?? opts.concurrency } : {}),
    onStart: (candidate, i, total) => {
      // eslint-disable-next-line no-console
      console.log(`[optimize-role] ${handle} (${i}/${total}) running ${candidate.id} – levers ${JSON.stringify(candidate.levers)} ...`);
    },
    // PRESERVE each candidate's full result AS IT COMPLETES (not batched at the end): its
    // telemetry, its produced artifacts (the actual files), and a replay.json (levers + seed
    // corpus ref) – so the experiment is reproducible + re-judgeable, and an interrupted sweep
    // still leaves every finished candidate's evidence on disk.
    onDone: (trial, i, total) => {
      persistTrial(runDir, chain, baseModel, trial);
      const q = trial.qualityPassed === undefined ? "" : trial.qualityPassed ? " quality PASSED" : ` quality FAILED (${trial.telemetry?.semanticScore?.toFixed(2)})`;
      const status = trial.disqualified ? `DISQUALIFIED (${trial.reason})` : trial.gatePassed ? "gate PASSED" : "gate failed";
      // eslint-disable-next-line no-console
      console.log(`[optimize-role] ${handle} (${i}/${total}) ${trial.candidateId}: ${status}${q}${trial.telemetry?.outerDurationMs ? ` – ${(trial.telemetry.outerDurationMs / 1000).toFixed(1)}s` : ""}`);
    },
  });

  const report = reportRoleSweep(trials);
  // Write the report itself into the chain's run dir – the run's own summary lives with its evidence.
  writeFileSync(join(runDir, "report.txt"), formatRoleSweepReport(report) + "\n");

  // Write a machine-readable summary.json (winner + per-candidate median/gate) in the SAME shape the
  // committed design-lane corpus (examples/replay/optimize-results/<handle>/summary.json) uses, so a
  // run is durable + diffable. When a PRIOR summary exists for this chain (a baseline / last run),
  // print the delta so "repeat + compare" is a first-class output, not a manual diff.
  const summary = buildChainSummary(handle, baseModel, trials, report);
  const prior = opts.baselineDir ? readPriorSummary(opts.baselineDir, handle) : undefined;
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  // eslint-disable-next-line no-console
  console.log(`\n[${handle}]\n` + formatRoleSweepReport(report));
  if (prior) {
    // eslint-disable-next-line no-console
    console.log(formatBaselineDelta(handle, prior, summary));
  }
  return report;
}

/** One chain's durable summary – winner + per-candidate median ms / gate / quality. Mirrors the
 *  committed examples/replay/optimize-results/<handle>/summary.json shape so both corpora are diffable. */
interface ChainSummary {
  chain: string;
  baseModel: string;
  winner: string | null;
  baselineMs: number | null;
  capturedAt: string;
  candidates: Array<{ candidate: string; gatePassed: boolean; qualityPassed?: boolean; medianMs: number | null; disqualified?: boolean }>;
}

function buildChainSummary(handle: string, baseModel: string, trials: SweepTrial[], report: ReturnType<typeof reportRoleSweep>): ChainSummary {
  return {
    chain: handle,
    baseModel,
    winner: report.winner?.candidateId ?? null,
    baselineMs: report.baselineMs ?? null,
    capturedAt: new Date().toISOString(),
    candidates: trials.map((t) => ({
      candidate: t.candidateId,
      gatePassed: t.gatePassed,
      ...(t.qualityPassed !== undefined ? { qualityPassed: t.qualityPassed } : {}),
      medianMs: t.telemetry?.outerDurationMs ?? null,
      ...(t.disqualified ? { disqualified: true } : {}),
    })),
  };
}

/** Read a prior run's summary.json for a chain (the baseline to compare against), if present. */
function readPriorSummary(baselineDir: string, handle: string): ChainSummary | undefined {
  const p = join(baselineDir, handle, "summary.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ChainSummary;
  } catch {
    return undefined;
  }
}

/** A human delta line comparing this run's summary to a prior one: winner change + baseline wall-clock drift. */
function formatBaselineDelta(handle: string, prior: ChainSummary, now: ChainSummary): string {
  const winnerChange = prior.winner === now.winner ? `winner unchanged (${now.winner ?? "none"})` : `winner CHANGED: ${prior.winner ?? "none"} -> ${now.winner ?? "none"}`;
  const ms = (v: number | null) => (v == null ? "?" : `${(v / 1000).toFixed(1)}s`);
  const drift =
    prior.baselineMs != null && now.baselineMs != null
      ? ` – baseline ${ms(prior.baselineMs)} -> ${ms(now.baselineMs)} (${(((now.baselineMs - prior.baselineMs) / prior.baselineMs) * 100).toFixed(0)}%)`
      : "";
  return `[compare] ${handle}: ${winnerChange}${drift} – prior run ${prior.capturedAt}`;
}

/** Run the sweep for EVERY requested chain, each standalone against its reference example, and
 *  print a per-chain report + a roll-up. Returns the reports keyed by handle. LIVE. Chains run in
 *  sequence; each chain's candidates fan out under `concurrency` (a global cap – the chains do not
 *  overlap, so N concurrency is N in-flight candidates at any moment). */
export async function runOptimizeRole(args: OptimizeRoleArgs): Promise<Record<string, SweepReport | { summary: unknown }>> {
  // Results land in the VISIBLE, git-tracked corpus (examples/replay/optimize-results/), NOT a hidden
  // dir – so a run is durable + reviewable + diffable. Each run gets a timestamped subdir under runs/
  // so prior runs accumulate; the newest prior run (if any) is the BASELINE this run's summary.json is
  // compared against + a delta printed. Override with --telemetry-dir for an ad-hoc scratch run.
  const resultsHome = join(process.cwd(), "examples/replay/optimize-results");
  const runsDir = join(resultsHome, "runs");
  const baselineDir = latestRunDir(runsDir); // the most recent prior run, or undefined on the first
  const runRoot = args.telemetryDir ?? join(runsDir, runStamp());
  mkdirSync(runRoot, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`[optimize-role] sweeping ${args.chains.length} chain(s): ${args.chains.join(", ")} – run root ${runRoot}${baselineDir ? ` (baseline: ${baselineDir})` : " (no prior run – this is the baseline)"}`);

  const reports: Record<string, SweepReport | { summary: unknown }> = {};
  for (const handle of args.chains) {
    if (handle in DRIVER_TURN_SPECS) {
      reports[handle] = await sweepDriverGreen(handle, runRoot, {
        ...(args.concurrency ? { concurrency: args.concurrency } : {}),
        ...(args.candidates?.length ? { candidates: args.candidates } : {}),
        ...(args.replicas ? { replicas: args.replicas } : {}),
        ...(args.experiment ? { experiment: args.experiment } : {}),
      });
    } else {
      reports[handle] = await sweepOneChain(handle, runRoot, {
        ...(args.baseModel ? { baseModel: args.baseModel } : {}),
        ...(args.concurrency ? { concurrency: args.concurrency } : {}),
        ...(baselineDir ? { baselineDir } : {}),
        ...(args.experiment ? { experiment: args.experiment } : {}),
      });
    }
  }

  // Roll-up: one winner line per chain, written to the run root + printed.
  // The driver handles are CLOUD LIVE with a different result shape, so they are skipped from the
  // role-sweep rollup + summarized separately below.
  const rollupChains = args.chains.filter((h) => !(h in DRIVER_TURN_SPECS));
  const rollup = rollupChains
    .map((h) => {
      const rep = reports[h] as SweepReport | undefined;
      if (!rep) return `${h}: (no report)`;
      const w = rep.winner;
      return w
        ? `${h}: winner ${w.candidateId} (${(w.outerDurationMs / 1000).toFixed(1)}s vs baseline ${(rep.baselineMs / 1000).toFixed(1)}s, saved ${w.speedupPct.toFixed(0)}%)`
        : `${h}: no winner (no quality-holding candidate beat the baseline)`;
    })
    .join("\n");

  // Driver-handle summaries (if present).
  for (const h of args.chains.filter((c) => c in DRIVER_TURN_SPECS)) {
    const driverResult = reports[h];
    if (driverResult && "summary" in driverResult) {
      const s = (driverResult.summary as { winner?: string | null; candidates?: Array<{ candidate: string }> }) ?? {};
      const w = s.winner;
      // eslint-disable-next-line no-console
      console.log(`\n[${h}]\n${w ? `${h}: winner ${w}` : `${h}: no winner`}`);
    }
  }

  if (rollup) {
    writeFileSync(join(runRoot, "rollup.txt"), rollup + "\n");
    // eslint-disable-next-line no-console
    console.log(`\n=== ROLL-UP ===\n${rollup}\n\n(full evidence per chain -> ${runRoot}/<handle>/)`);
  }
  return reports;
}

/** A compact UTC run stamp so repeat sweeps land in distinct, non-clobbering dirs. */
function runStamp(): string {
  // YYYYMMDDHHMMSS (14 digits). toISOString -> 2026-08-07T13:46:37.123Z; strip separators + the
  // fractional-seconds tail so the dir name is clean (no trailing dot from slicing mid-fraction).
  return new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");
}

/** The most recent prior run dir under runs/ (the baseline this run compares against), or undefined
 *  on the first-ever run. Run dirs are timestamp-named (runStamp), so lexical max = newest. */
function latestRunDir(runsDir: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  const dirs = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const newest = dirs[dirs.length - 1];
  return newest ? join(runsDir, newest) : undefined;
}

/** The recorded reference the quality gate scores a candidate against. An explicit `referenceFile`
 *  is the RECORDED PER-TURN OUTPUT extracted into the CAMP (recorded-turns/<NNNN>-<role>/...), the
 *  honest same-scope reference – resolved against the camp root. Absent, fall back to the produced
 *  artifact's recorded form in the seed corpus (intake). Absent there too -> undefined (gate skipped).
 *  This is the #705 correction: judge against what the turn ACTUALLY recorded, never a hand-carved
 *  slice. See feedback_judge_against_recorded_turn_output + the camp README. */
function readReference(chain: RoleChain, _role: string): string | undefined {
  if (chain.referenceFile) {
    const camp = join(process.cwd(), BUILD_CORPUS_REL, chain.referenceFile);
    if (existsSync(camp)) return readFileSync(camp, "utf8");
  }
  const p = join(process.cwd(), INTAKE_REL, chain.referenceFile ?? chain.outputFile);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

/** Persist ONE candidate's full evidence under <runDir>/<candidate>/: telemetry.json, the
 *  produced artifact tree (artifacts/<relpath>), and replay.json (levers + seed corpus ref +
 *  base model), so the experiment can be reproduced + independently re-judged. */
function persistTrial(runDir: string, chain: RoleChain, baseModel: string, trial: SweepTrial): void {
  const dir = join(runDir, trial.candidateId);
  mkdirSync(dir, { recursive: true });
  if (trial.telemetry) writeFileSync(join(dir, "telemetry.json"), JSON.stringify(trial.telemetry, null, 2) + "\n");
  // The actual produced files (the outputs) – the evidence telemetry alone can't provide.
  for (const [rel, contents] of Object.entries(trial.producedArtifacts ?? {})) {
    const dest = join(dir, "artifacts", rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  // Whether this trial durably stored a NAVIGATOR EVALUATION of the driver output (driver chains only):
  // the navigator-eval/ marker files under artifacts/. Indexed in replay.json so a separate test OF THE
  // NAVIGATOR can discover the samples (which driver candidates the navigator assessed/reviewed, and how).
  const navigatorEvalFiles = Object.keys(trial.producedArtifacts ?? {})
    .filter((k) => k.startsWith("navigator-eval/"))
    .map((k) => k.slice("navigator-eval/".length));
  // How to recreate this exact trial.
  const replay = {
    role: chain.dir,
    candidateId: trial.candidateId,
    baseModel,
    levers: trial.levers,
    seedCorpus: `${INTAKE_REL} (recorded intake replayed into the chain)`,
    gatePassed: trial.gatePassed,
    ...(trial.qualityPassed !== undefined ? { qualityPassed: trial.qualityPassed } : {}),
    ...(trial.telemetry?.classification ? { classification: trial.telemetry.classification } : {}),
    ...(navigatorEvalFiles.length ? { navigatorEval: { dir: "artifacts/navigator-eval", files: navigatorEvalFiles } } : {}),
    ...(trial.disqualified ? { disqualified: true, reason: trial.reason } : {}),
  };
  writeFileSync(join(dir, "replay.json"), JSON.stringify(replay, null, 2) + "\n");
}

// ── INDEPENDENT RE-JUDGE: re-score a PRESERVED run's outputs through their OWN discriminator ──────────
//
// The "everything preserved so an independent judge can re-evaluate" invariant, made executable. For a
// persisted run dir (<runRoot>/<chain>/<candidate>/artifacts/...), read each candidate's produced output
// back off disk, resolve the SAME discriminator the live sweep uses (buildChainJudge for design/navigator,
// buildDriverNextStepJudge for driver), re-run it against the SAME recorded reference, and compare the
// fresh verdict to the stored telemetry.json. NO live drive, NO cloud project, NO green cycle – just the
// opus judge over preserved bytes, so it is safe to run independently (does not touch a live sweep's
// substrate). Writes rejudge.json per candidate + prints a reproduce report.

/** Load a candidate's preserved artifacts/ tree back into a producedArtifacts map (relpath -> contents),
 *  the SAME shape the live judge consumed. Pure (fs read). Empty when the dir is absent. */
export function loadPreservedArtifacts(candidateDir: string): Record<string, string> {
  const root = join(candidateDir, "artifacts");
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out[relative(root, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

/** A judge verdict whose reason signals its JUDGED TARGET was absent (the produced artifact the judge
 *  scores – the primary file / the tests tree / the review-or-reflect verdict / the app code). During a
 *  re-judge of PRESERVED data this is NOT a real FAIL: it means that target was not preserved (the run
 *  preserved SOME files but not the one the judge reads – e.g. navigator-reflect kept its code tree but
 *  not reflect-verdict.json). So it is "not rejudgeable (judge target not preserved)", same category as
 *  an entirely-empty artifacts/ dir, never a fresh FAIL. Matches the judges' own "no ... to judge" family
 *  (buildChainJudge + buildDriverNextStepJudge); a genuine content FAIL never carries these reasons. */
export function isMissingJudgeTarget(reason: string | undefined): boolean {
  if (!reason) return false;
  return /no primary artifact to judge|no tests produced to judge|-verdict produced to judge|no app\/ code produced to judge|no .*code produced to judge/i.test(reason);
}

/** Classify a re-judge outcome vs the stored verdict. Keys on whether a stored verdict VALUE exists
 *  (classification OR score) – a telemetry.json can exist verdict-less for a never-judged run, which is
 *  "first-verdict", NOT a reproduce. Compares the right KIND: classification-based judges (build
 *  discriminator) by EXACT class; score-based judges (design/red) by |Δ| <= tol (opus judges are
 *  near-deterministic, not bit-identical – default tol 0.1). Pure + exported for a hermetic guard. */
export function classifyReproduce(
  stored: { storedClass?: string; storedScore?: number },
  fresh: { classification?: string; score?: number },
  tol = 0.1,
): string {
  const hasStoredVerdict = stored.storedClass !== undefined || stored.storedScore !== undefined;
  if (!hasStoredVerdict) return "first-verdict (never judged before)";
  if (stored.storedClass !== undefined || fresh.classification !== undefined) {
    return stored.storedClass === fresh.classification ? "REPRODUCED" : `DIVERGED (stored=${stored.storedClass ?? "?"} fresh=${fresh.classification ?? "?"})`;
  }
  const delta = Math.abs((stored.storedScore ?? 0) - (fresh.score ?? 0));
  return delta <= tol ? `REPRODUCED (Δscore=${delta.toFixed(2)})` : `DIVERGED (stored=${stored.storedScore} fresh=${fresh.score}, Δ=${delta.toFixed(2)})`;
}

/** Re-judge every candidate of every chain under a preserved run dir. For each candidate: reconstruct
 *  producedArtifacts from artifacts/, resolve the chain's discriminator, re-run it vs the recorded
 *  reference, and compare to the stored telemetry verdict. Writes <candidate>/rejudge.json + prints a
 *  reproduce report. LOCAL (opus judges only) – safe to run alongside nothing-live. */
export async function runRejudge(runRoot: string, experimentPath?: string): Promise<void> {
  if (!existsSync(runRoot)) throw new Error(`optimize-role --rejudge: run dir not found: ${runRoot}`);
  // eslint-disable-next-line no-console
  console.log(`[rejudge] re-judging preserved outputs under ${runRoot}${experimentPath ? ` [experiment: ${experimentPath}]` : ""}`);
  // EXPERIMENT rejudge: when --experiment is given, the matching chain dir is re-scored through the SAME
  // corpus-faithful replay discriminator the sweep used (buildReplayTurnJudge vs the replayed turn's
  // recorded marker), NOT buildChainJudge (reference-assets). This is how the tightened assess judge
  // (regression fidelity) re-scores preserved outputs without re-running any agent.
  const experiment = experimentPath ? loadExperimentConfig(experimentPath) : undefined;
  const experimentBundle = experiment ? replayBundleFromTurn(experiment.turn, experiment.ac) : undefined;
  const chainDirs = readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const handle of chainDirs) {
    const chainDir = join(runRoot, handle);
    const isDriver = handle in DRIVER_TURN_SPECS;
    const isBuildChain = handle in BUILD_ROLE_CHAINS;
    const chain = isDriver ? undefined : (isBuildChain ? BUILD_ROLE_CHAINS[handle] : ROLE_CHAINS[handle]);
    // A DRIVER-REPAIR experiment is judged by the corpus-faithful CODE-equivalence judge (candidate code vs
    // the recorded repaired output, gated on honest-GREEN) – NOT the lean replay judge and NOT a fresh
    // review. A LEAN experiment's chain dir is the experiment turn's chain (turn label ends with the handle,
    // e.g. "0157-navigator-assess" -> "navigator-assess") – score it through the replay judge. Otherwise
    // require a known chain (driver / build / design).
    const driverSpec = DRIVER_TURN_SPECS[handle];
    const isRepairExperiment = !!(experiment && experimentBundle && driverSpec?.driverTurn === "repair");
    const isRefactorExperiment = !!(experiment && experimentBundle && driverSpec?.driverTurn === "refactor");
    const isExperimentChain = !!(experiment && experimentBundle && !isDriver && experiment.turn.endsWith(handle));
    if (!isDriver && !chain && !isExperimentChain) { console.log(`[rejudge] ${handle}: not a known chain, skipping`); continue; }
    // Resolve the SAME discriminator the live sweep used – repair/refactor-experiment: the two-turn review-
    // resolution judge (post-turn navigator review vs the recorded directive); lean experiment: the corpus-
    // faithful replay judge; driver: buildDriverNextStepJudge; else buildChainJudge.
    let quality: QualityGate;
    try {
      quality = isRepairExperiment
        ? buildDriverRepairNextStepJudge(experiment!.turn, experimentBundle!.feature, experimentBundle!.story)
        : isRefactorExperiment
        ? buildDriverRefactorNextStepJudge(experimentBundle!.feature, experimentBundle!.story)
        : isExperimentChain
          ? buildReplayTurnJudge(experiment!.turn, experimentBundle!.feature, experimentBundle!.story, experimentBundle!.ac, experiment!.discriminator ?? "assess")
          : isDriver ? buildDriverNextStepJudge(handle) : buildChainJudge(chain!, handle, isBuildChain);
    } catch (e) {
      console.log(`[rejudge] ${handle}: cannot resolve discriminator (${e instanceof Error ? e.message : String(e)}); skipping`);
      continue;
    }
    const outputFile = isDriver ? "app" : (chain as RoleChain | BuildRoleChain).outputFile;
    const candDirs = readdirSync(chainDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const candidateId of candDirs) {
      const candDir = join(chainDir, candidateId);
      const producedArtifacts = loadPreservedArtifacts(candDir);
      if (Object.keys(producedArtifacts).length === 0) {
        console.log(`[rejudge] ${handle}/${candidateId}: NO preserved artifacts – cannot re-judge (output not preserved)`);
        writeFileSync(join(candDir, "rejudge.json"), JSON.stringify({ handle, candidateId, rejudgeable: false, reason: "no preserved artifacts" }, null, 2) + "\n");
        continue;
      }
      const stored = existsSync(join(candDir, "telemetry.json"))
        ? (JSON.parse(readFileSync(join(candDir, "telemetry.json"), "utf8")) as { semanticScore?: number; classification?: string })
        : undefined;
      const primary = producedArtifacts[outputFile];
      let verdict: QualityVerdict;
      try {
        verdict = await quality.judgeCandidate({ candidateId, primary, producedArtifacts });
      } catch (e) {
        console.log(`[rejudge] ${handle}/${candidateId}: judge threw: ${e instanceof Error ? e.message : String(e)}`);
        writeFileSync(join(candDir, "rejudge.json"), JSON.stringify({ handle, candidateId, rejudgeable: true, error: e instanceof Error ? e.message : String(e) }, null, 2) + "\n");
        continue;
      }
      // The judge short-circuited because its JUDGED TARGET was not preserved (some artifacts exist, but
      // not the specific file/tree this judge scores – e.g. navigator-reflect kept its code tree but not
      // reflect-verdict.json). That is NOT a real FAIL: it is not-rejudgeable, same as an empty dir.
      if (!verdict.passed && isMissingJudgeTarget(verdict.reason)) {
        console.log(`[rejudge] ${handle}/${candidateId}: NOT rejudgeable – judge target not preserved (${verdict.reason})`);
        writeFileSync(join(candDir, "rejudge.json"), JSON.stringify({ handle, candidateId, rejudgeable: false, reason: `judge target not preserved: ${verdict.reason}` }, null, 2) + "\n");
        continue;
      }
      // Reproduce check – see classifyReproduce: keys on whether a stored verdict VALUE exists (not the
      // telemetry FILE, which can exist verdict-less for a never-judged run), compares the right KIND per
      // judge (classification exact; score within tolerance), flags first-verdict when nothing was stored.
      const storedClass = stored?.classification;
      const storedScore = stored?.semanticScore;
      const reproduce = classifyReproduce({ storedClass, storedScore }, { classification: verdict.classification, score: verdict.score });
      const hasStoredVerdict = storedClass !== undefined || storedScore !== undefined;
      const report = { handle, candidateId, rejudgeable: true, fresh: { passed: verdict.passed, score: verdict.score, classification: verdict.classification, reason: verdict.reason }, stored: hasStoredVerdict ? { score: storedScore, classification: storedClass } : null, reproduce };
      writeFileSync(join(candDir, "rejudge.json"), JSON.stringify(report, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.log(`[rejudge] ${handle}/${candidateId}: fresh=${verdict.passed ? "PASS" : "FAIL"}${verdict.classification ? ` (${verdict.classification})` : ""}${verdict.score !== undefined ? ` score=${verdict.score.toFixed(2)}` : ""} – ${reproduce}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[rejudge] done. Per-candidate rejudge.json written under ${runRoot}.`);
}

if (isCliEntry(import.meta.url)) {
  // --rejudge <runDir> : re-score a preserved run's outputs through their own discriminator (LOCAL, no
  // live drive). Otherwise run the normal sweep.
  const rejudgeIdx = process.argv.indexOf("--rejudge");
  const expIdx = process.argv.indexOf("--experiment");
  const experimentArg = expIdx >= 0 && expIdx + 1 < process.argv.length ? process.argv[expIdx + 1] : undefined;
  const entry = rejudgeIdx >= 0 && rejudgeIdx + 1 < process.argv.length
    ? runRejudge(process.argv[rejudgeIdx + 1], experimentArg)
    : runOptimizeRole(parseArgs(process.argv.slice(2)));
  entry
    .then(() => process.exit(0)) // a sweep with no winner is still a successful run
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`[optimize-role] FAILED: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
