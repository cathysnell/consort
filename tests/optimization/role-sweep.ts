// role-sweep: run a per-role lever sweep over the isolation substrate. For each candidate (a
// lever patch from role-levers), run the role's chain ONCE with the live-role agent's config
// patched (model/effort/tool scope), gate the result on conformance (the SAME bar the live test
// asserts), and record a RoleTelemetry trial. A crashing candidate is DISQUALIFIED + the sweep
// continues (the optimize lesson: one bad candidate must not kill the run). The baseline is just
// the first candidate (empty patch), measured under the same machinery – an apples-to-apples
// "before". Ranking is role-sweep-report's job; this only runs + gates + records.
//
// The chain RUNNER is injected (runChain) so the sweep is unit-testable hermetically (a fake
// runner returns canned turns); the live CLI passes runRoleChainLive. Applying a candidate's
// patch = build a ClaudeStepAgent from the live manifest's base agent.config MERGED with the
// patch, and return it from agentFor for the live-role manifest (undefined elsewhere – the seed
// falls through to its replay).

import { ClaudeStepAgent, type AgentLevers } from "../../consort/orchestrator/agents/claude-step-agent.js";
import { runExperimentsInParallel } from "../../consort/experiment/parallel-runner.js";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest.js";
import type { StepAgent } from "../../consort/orchestrator/agents/agent-types.js";
import type { ManifestTurn } from "../../consort/orchestrator/runners/manifest-runner.js";
import type { RoleCandidate, RoleLeverPatch } from "./role-levers.js";
import type { RoleTelemetry, RoleAgentUsage } from "../../consort/optimize/role-telemetry.js";

/** The structural minimum a sweepable chain must expose – the subset the sweep engine reads (the
 *  manifest dir names the seed/live ids, outputFile is the primary artifact the gate + telemetry
 *  key on, prompt rides the telemetry transcript). Both the design `RoleChain` and the build
 *  `BuildRoleChain` satisfy this, so ONE engine sweeps either family (a build chain judges via a
 *  different quality gate the CLI supplies, but the RUN loop is identical). */
export interface SweepableChain {
  dir: string;
  outputFile: string;
  prompt: string;
}

/** What one chain run returns: the turns PLUS the PRESERVED produced-artifact tree ({relpath ->
 *  contents}, every file the run wrote, captured before teardown). The whole tree is kept – a
 *  run's outputs must survive so the result is reproducible + re-judgeable, not just its
 *  telemetry (the preserve-experiment-artifacts rule). The quality gate scores the primary file. */
export interface ChainRunResult {
  turns: ManifestTurn[];
  producedArtifacts: Record<string, string>;
  /** OPTIONAL conformance verdict supplied by the runner when the design/navigator-shaped derivation
   *  (produced outputFile + no violations + terminated at design-complete) does NOT apply – e.g. a
   *  DRIVER-GREEN chain whose conformance is honest-GREEN (alembic + pytest vs a live branch), not a
   *  design-complete terminal. When present it IS the gate; when absent the template derives it from
   *  the turns. So the ONE sweep engine handles design, navigator, AND driver with no second engine. */
  gate?: { passed: boolean; reason?: string };
  /** OPTIONAL wall-clock duration (ms) supplied by the runner when the sweep cannot read it off a live
   *  turn's telemetry – e.g. a DRIVER-GREEN chain that returns `turns: []` (its work is a full GREEN
   *  cycle measured by the driver harness, not a single ManifestTurn). When present it OVERRIDES the
   *  turn-derived `outerDurationMs` so the report can RANK candidates (the winner is the fastest
   *  quality-holding candidate); absent => the turn-derived value stands (design/navigator chains). */
  durationMs?: number;
  /** OPTIONAL agent usage (cost + tokens + numTurns + agent duration) supplied by the runner when the
   *  sweep cannot read it off a live ManifestTurn – e.g. a DRIVER-GREEN chain (turns: []). When present
   *  it POPULATES telemetry.agent so EVERY run records cost with the consistent attribute set (parity
   *  with the design-lane sweep). Absent => the turn-derived usage stands. */
  usage?: RoleAgentUsage;
  /** OPTIONAL tool-call count supplied by the runner (the driver turn's transcript tool count). */
  toolCalls?: number;
}

/** The runner seam: run ONE chain with an optional per-manifest agent override + return the
 *  turns + the preserved artifact tree. The candidateId is passed for logging/routing; the
 *  candidate's full lever PATCH is passed so a runner can thread non-agent levers (the
 *  test-strategist's per-analyst `analystOverrides`, which ride the roster preparer, not the
 *  supervisor's AgentLevers). The live CLI binds runRoleChainLive; tests bind a fake. */
export type ChainRunner = (
  chain: SweepableChain,
  agentFor: (m: StepManifest) => StepAgent | undefined,
  candidateId: string,
  levers: RoleLeverPatch,
) => Promise<ChainRunResult>;

/** One candidate's judge verdict. `passed` is the pass bar (>= threshold for a semantic/functional
 *  score judge; classification != "insufficient" for a discriminator/verdict-alignment judge). The
 *  optional fields carry the discriminator/verdict-alignment detail so the report + summary can
 *  surface WHY (a clean "equivalent"/accept is a positive, not merely "passed"). */
export interface QualityVerdict {
  passed: boolean;
  score?: number;
  classification?: string;
  nextStep?: string;
  reason?: string;
}

/** The MANDATORY quality gate for a sweep: a per-chain judge CLOSURE that scores a conformant
 *  candidate's produced output against the recorded reference and returns a QualityVerdict. This is
 *  a closure (not a fixed reference+judge pair) so EVERY chain kind supplies its OWN discriminator ,
 *  design/red use the opus text judge, assess uses the marker-alignment discriminator, review/reflect
 *  use the verdict-alignment judge, driver-green uses the build-code discriminator. The judge is
 *  REQUIRED: a conformant candidate whose judge is absent, throws, or yields no verdict is DISQUALIFIED
 *  (never silently unscored) – an LLM judge is a hard requirement of every evaluation, the only thing
 *  that guarantees product-result equivalence. `producedArtifacts` is the candidate's captured output
 *  tree, so a judge that needs more than the primary file (a code/verdict tree) can read it. */
export interface QualityGate {
  judgeCandidate: (args: { candidateId: string; primary: string | undefined; producedArtifacts: Record<string, string> }) => Promise<QualityVerdict>;
}

/** One candidate's measured outcome. `gatePassed` is the conformance bar (no violations + the
 *  artifact produced + the chain terminated at design-complete); `qualityPassed` is the
 *  quality-vs-baseline bar (undefined when no quality gate ran); `telemetry` is the trial record;
 *  `disqualified` (+ reason) marks a crash or a chain that never reached the live turn. */
export interface SweepTrial {
  candidateId: string;
  levers: RoleLeverPatch;
  gatePassed: boolean;
  qualityPassed?: boolean;
  telemetry?: RoleTelemetry;
  /** The PRESERVED produced-artifact tree for this candidate ({relpath -> contents}), so the
   *  caller persists the actual outputs to a durable per-candidate dir – not just telemetry.
   *  Empty on a disqualified/crashed candidate that produced nothing. */
  producedArtifacts?: Record<string, string>;
  disqualified?: boolean;
  reason?: string;
}

/** Build the agentFor override for a candidate: for the live-role manifest, a ClaudeStepAgent
 *  from the manifest's base agent.config MERGED with the candidate patch; undefined otherwise. */
function agentForCandidate(chain: SweepableChain, patch: RoleLeverPatch): (m: StepManifest) => StepAgent | undefined {
  const liveId = `${chain.dir}-live`;
  return (m: StepManifest) => {
    if (m.id !== liveId) return undefined; // seed + others fall through to the catalogue
    const base = (m.agent?.config ?? {}) as Partial<AgentLevers> & { role?: string };
    const levers: AgentLevers = {
      role: base.role ?? m.role,
      ...(base.model !== undefined ? { model: base.model } : {}),
      ...(base.effort !== undefined ? { effort: base.effort } : {}),
      ...(base.session !== undefined ? { session: base.session } : {}),
      ...(base.allowedTools !== undefined ? { allowedTools: base.allowedTools } : {}),
      ...(base.disallowedTools !== undefined ? { disallowedTools: base.disallowedTools } : {}),
      // the candidate patch WINS over the base for the swept axes
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.session !== undefined ? { session: patch.session } : {}),
      ...(patch.allowedTools !== undefined ? { allowedTools: patch.allowedTools } : {}),
      ...(patch.disallowedTools !== undefined ? { disallowedTools: patch.disallowedTools } : {}),
    };
    return new ClaudeStepAgent(levers);
  };
}

/** Assemble a RoleTelemetry from a candidate's live turns (the last turn is the live role's). */
function trialTelemetry(chain: SweepableChain, candidate: RoleCandidate, turns: ManifestTurn[]): { gatePassed: boolean; telemetry: RoleTelemetry } {
  const liveTurn = turns[turns.length - 1];
  const t = liveTurn?.telemetry;
  const usage = t?.agentResult?.usage;
  const producedOk = !!liveTurn && liveTurn.result.producedPaths.some((p) => p.endsWith(chain.outputFile));
  const cleanViolations = !!liveTurn && liveTurn.result.violations.length === 0;
  const terminated = liveTurn?.result.bounded.action.kind === "design-complete";
  const gatePassed = producedOk && cleanViolations && terminated;
  const telemetry: RoleTelemetry = {
    role: t?.role ?? chain.dir.replace(/-chain$/, ""),
    chain: `${chain.dir}#${candidate.id}`,
    // The candidate's model (when it patches one) is the meaningful "model this trial ran on";
    // absent patch => baseline model, which the report reads from the baseline trial.
    ...(candidate.levers.model ? { model: candidate.levers.model } : {}),
    levers: { ...candidate.levers },
    outerDurationMs: t?.outerDurationMs ?? 0,
    ...(usage
      ? {
          agent: {
            ...(usage.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
            ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
          },
        }
      : {}),
    outcome: gatePassed ? "produced" : (liveTurn?.result.bounded.action.kind ?? "no-live-turn"),
    producedFile: chain.outputFile,
    ...(t?.agentResult?.finalText ? { transcript: { prompt: chain.prompt, finalText: t.agentResult.finalText, tools: [] } } : {}),
  };
  return { gatePassed, telemetry };
}

/**
 * Run a full per-role sweep: every candidate, in order (baseline first), each a real live chain
 * run with the candidate's levers patched onto the live-role agent. Returns one SweepTrial per
 * candidate. A candidate whose run THROWS (a crash, an infra error) is disqualified with the
 * error message + the sweep continues – never aborts the whole run on one bad candidate.
 */
export interface SweepHooks {
  /** Called BEFORE each candidate runs (progress logging). */
  onStart?(candidate: RoleCandidate, index: number, total: number): void;
  /** Called AFTER each candidate completes (pass, gate-fail, or disqualify), with its trial.
   *  The CLI persists the trial's telemetry HERE – incrementally – so a long sweep that is
   *  interrupted still has every completed candidate's record on disk (not batched at the end). */
  onDone?(trial: SweepTrial, index: number, total: number): void;
}

/** Options for a sweep: progress hooks + an OPTIONAL quality gate (score each conformant
 *  candidate's produced artifact against a recorded baseline). Both optional – omitting quality
 *  is the conformance-only sweep (prior behavior). Back-compat: a bare SweepHooks is accepted.
 *  `concurrency` caps in-flight candidates: 1 (default) = the sequential loop, byte-identical to
 *  the prior behavior; >1 fans candidates out over runExperimentsInParallel. Safe to parallelize
 *  because each candidate's runChain (runIntegrationChain) mkdtemps its OWN isolated workspace and
 *  the candidate levers ride IN-MEMORY on the ClaudeStepAgent – no shared config file / env / .md. */
export interface SweepOptions extends SweepHooks {
  quality?: QualityGate;
  concurrency?: number;
}

/** Run ONE candidate end to end: chain run + conformance telemetry + optional quality gate. NEVER
 *  throws – a crash (infra error, a chain that never reached the live turn) becomes a disqualified
 *  SweepTrial, so one bad candidate never aborts the sweep (the optimize lesson) and never rejects
 *  into the parallel pool. Pure w.r.t. shared state: the only mutation is inside runChain's own
 *  mkdtemp workspace. */
async function runOneCandidate(
  chain: SweepableChain,
  candidate: RoleCandidate,
  runChain: ChainRunner,
  quality: QualityGate | undefined,
): Promise<SweepTrial> {
  try {
    const { turns, producedArtifacts, gate, durationMs, usage, toolCalls } = await runChain(chain, agentForCandidate(chain, candidate.levers), candidate.id, candidate.levers);
    const derived = trialTelemetry(chain, candidate, turns);
    // A runner-supplied gate (driver-green's honest-GREEN) overrides the design/navigator-shaped
    // derivation; otherwise the derived gate stands. ONE engine, all chain kinds.
    const gatePassed = gate ? gate.passed : derived.gatePassed;
    const telemetry = derived.telemetry;
    // A runner-supplied wall-clock (driver-green returns turns:[], so the turn-derived duration is 0)
    // OVERRIDES the derived outerDurationMs so the report can RANK the candidates. Absent => keep the
    // turn-derived value (design/navigator chains, whose duration IS the live turn's). The report reads
    // outerDurationMs, so this is the single place the driver's measured cycle time enters the ranking.
    if (durationMs !== undefined) telemetry.outerDurationMs = durationMs;
    // Runner-supplied usage (driver-green: turns:[] carries no ManifestTurn usage) POPULATES the agent
    // usage so EVERY run records cost + the consistent attributes (parity). toolCalls rides alongside.
    if (usage || toolCalls !== undefined) {
      telemetry.agent = { ...(telemetry.agent ?? {}), ...(usage ?? {}), ...(toolCalls !== undefined ? { toolCalls } : {}) };
    }
    // PRESERVE the produced artifacts on the trial so the caller persists the actual outputs.
    const trial: SweepTrial = { candidateId: candidate.id, levers: candidate.levers, gatePassed, telemetry, producedArtifacts };
    // MANDATORY QUALITY JUDGE: every conformant candidate MUST be judged against the recorded
    // reference – an LLM judge is a hard requirement of the evaluation (the only guarantee of
    // product-result equivalence). A judge that is absent, throws, or yields no verdict DISQUALIFIES
    // the candidate (never silently unscored). Only a candidate that failed the CONFORMANCE gate is
    // exempt (it produced nothing conformant to judge; it's already not winner-eligible).
    if (gatePassed) {
      const primary = producedArtifacts[chain.outputFile];
      if (!quality) {
        trial.disqualified = true;
        trial.reason = "no judge configured – an LLM judge is required for every evaluation";
        return trial;
      }
      let verdict: QualityVerdict;
      try {
        verdict = await quality.judgeCandidate({ candidateId: candidate.id, primary, producedArtifacts });
      } catch (e) {
        trial.disqualified = true;
        trial.reason = `judge threw: ${e instanceof Error ? e.message : String(e)}`;
        return trial;
      }
      trial.qualityPassed = verdict.passed;
      if (trial.telemetry) {
        if (verdict.score !== undefined) trial.telemetry.semanticScore = verdict.score;
        if (verdict.classification) trial.telemetry.classification = verdict.classification;
        if (verdict.nextStep) trial.telemetry.nextStep = verdict.nextStep;
      }
    }
    return trial;
  } catch (e) {
    return {
      candidateId: candidate.id,
      levers: candidate.levers,
      gatePassed: false,
      disqualified: true,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runRoleSweep(
  chain: SweepableChain,
  candidates: RoleCandidate[],
  runChain: ChainRunner,
  options: SweepOptions = {},
): Promise<SweepTrial[]> {
  const hooks = options;
  const quality = options.quality;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const total = candidates.length;

  // Sequential (concurrency 1): the prior behavior, byte-identical – baseline first, onStart then
  // onDone per candidate in order. Kept as its own path so the default sweep is unchanged.
  if (concurrency === 1) {
    const trials: SweepTrial[] = [];
    let index = 0;
    for (const candidate of candidates) {
      index += 1;
      hooks.onStart?.(candidate, index, total);
      const trial = await runOneCandidate(chain, candidate, runChain, quality);
      trials.push(trial);
      hooks.onDone?.(trial, index, total);
    }
    return trials;
  }

  // Parallel: fan candidates out over the bounded-concurrency pool. Each candidate maps to one
  // experiment keyed by its 1-based index (so results re-sort to candidate order regardless of
  // completion order). runOneCandidate never throws, so the pool's failure path never fires; the
  // hooks fire around each candidate's own run. Isolation is by runChain's per-call mkdtemp.
  const trialByIndex = new Map<number, SweepTrial>();
  await runExperimentsInParallel<SweepTrial>({
    concurrency,
    experiments: candidates.map((_, i) => ({ slug: String(i + 1) })),
    runner: async ({ slug }) => {
      const index = Number(slug);
      const candidate = candidates[index - 1];
      hooks.onStart?.(candidate, index, total);
      const trial = await runOneCandidate(chain, candidate, runChain, quality);
      trialByIndex.set(index, trial);
      hooks.onDone?.(trial, index, total);
      return trial;
    },
  });
  // Re-sort into candidate (baseline-first) order – the pool returns completion order.
  return candidates.map((_, i) => trialByIndex.get(i + 1)!);
}
