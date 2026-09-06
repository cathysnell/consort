#!/usr/bin/env node
// ⚠️ DEPRECATED (superseded 2026-08-07) – use `scripts/optimize-role.sh` instead.
// This bin drives the CHAMPION-WALK engine (optimize-harness + optimize-live), which ranks
// candidates on the fastest gate-passing turn and does NOT run a mandatory LLM judge on every
// candidate (build handoffs bypass any judge). That violates the standing evaluation invariant
// (every candidate judged vs the recorded reference + output preserved; see memory
// feedback_every_evaluation_judge_and_preserve). The sanctioned engine is `runRoleSweep`
// (tests/optimization/role-sweep.ts), invoked ONLY through the ONE launcher
// `scripts/optimize-role.sh`. This bin remains published for back-compat + is slated for removal
// once optimize-apply's winner-persist path is re-homed onto the judged engine.
//
// consort-optimize: the per-handoff optimization re-record CLI. It drives
// the champion walk (optimize-harness) over a scenario's handoffs, trying config +
// content/scope candidates per handoff and keeping the fastest gate-passing turn.
//
//   consort-optimize --scenario <dir> --feature <id> [--handoff <id>]
//                           [--only design|build] --candidates <spec> --trials N
//                           [--dry-run]
//
// The DETERMINISTIC core (arg + sweep parsing, action -> HandoffPlan mapping) is
// exported + unit-tested. The LIVE glue wires the harness's injected steps to the
// real drive: runTrial applies a candidate's config + agent overlay + suffixes,
// plans the ONE next handoff (planNextAction), runs only that handoff's commands
// through execRunner, then gates + times it; recordWinner re-runs the winner with
// recording on. That glue runs against real cloud (build turns) or hermetically
// (a single design handoff, P2d), so it is exercised by those validations, not by
// a unit test that would spawn a model.
//
// SAFETY: the harness NEVER pushes/merges/releases; it only forks/drops throwaway
// child branches. It must NEVER set LAKEBASE_CONSORT_REPLAY_BUILD_DIR during a trial
// (that swaps in the trust-verifier and would FAKE a GREEN); every trial runs the
// REAL honest-GREEN verifier.

import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";
import { join, resolve } from "node:path";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive.js";
import { generateCandidates, defaultLaneCandidates, BASELINE_CANDIDATE_ID, type SweepSpec, type Candidate } from "../../consort/optimize/optimize-candidates.js";
import { runChampionWalk, type HandoffPlan, type HandoffResult } from "../../consort/optimize/optimize-harness.js";
import type { BuildTurn, EffortLevel } from "../../consort/orchestrator/settings/project-settings.js";
import type { SpawnableAgentRole } from "../../consort/config/agent-models.js";
import { buildCfg, execRunner } from "../../consort/orchestrator/drive/claude-runner.js";
import { planNextAction, buildDriveEffects, turnKeyForAction } from "../../consort/orchestrator/drive/orchestrator-effects.js";
import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { consortEnv, ENV_PREFIXES } from "../../consort/config/consort-env.js";
import { kitRoot } from "../../consort/config/kit-bin.js";
import { evaluateSemanticGate, makeOpusJudge } from "../../consort/evaluation/semantic-gate.js";
import { makeChampionWalkDeps, makeLiveSpawnTurn, makeBuildGate, makeBuildSnapshotDeps, positionToBuildHandoff, positionToNextHandoff, runLaneSweep, readLastTurnTokens, SWEEP_ROUTER_DEPS, type OptimizeLiveCtx } from "../../consort/optimize/optimize-live.js";
import { actionLane } from "../../consort/orchestrator/drive/orchestrator-drive.js";
import { readWorkflowState } from "@databricks-solutions/lakebase-scm-utils/lakebase";
import { buildChampionWalkReport, formatChampionWalkReport } from "../../consort/optimize/optimize-report.js";
import { actionToHandoffPlan, isBuildHandoff } from "../../consort/optimize/handoff.js";

export interface OptimizeArgs {
  scenario?: string;
  feature?: string;
  /** A single handoff id to optimize (else the whole feature's handoffs). */
  handoff?: string;
  /** Restrict to one lane. */
  only?: "design" | "build";
  /** The sweep spec string (see parseSweepSpec). */
  candidates?: string;
  /** Trials per candidate (median of passing). Default 3. */
  trials: number;
  /** Print the plan (handoffs + generated candidates) and exit; no spawns. */
  dryRun?: boolean;
  /** Propose-only: run + rank + report, but do NOT overlay/record a winner. The
   *  human reviews the ranked candidates and runs optimize-apply to persist one. */
  proposeOnly?: boolean;
  /** Sweep EVERY role handoff in a lane (design|build), sequentially, with per-role
   *  default candidates (defaultLaneCandidates) – not just the one handoff the drive
   *  sits on. Overrides the single-handoff path. */
  sweepLane?: "design" | "build";
  /** With --sweep-lane: the handoff id OR role to START sweeping from. Handoffs before
   *  it are already-settled (winner applied to the kit) – ADVANCED once at baseline to
   *  reach the target, NOT re-swept. Lets a lane resume at the next unsettled role. */
  from?: string;
  projectDir?: string;
}

/** Parse the CLI flags. Pure. */
export function parseOptimizeArgs(argv: string[]): OptimizeArgs {
  const out: OptimizeArgs = { trials: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i];
    switch (a) {
      case "--scenario": out.scenario = next(); break;
      case "--feature": out.feature = next(); break;
      case "--handoff": out.handoff = next(); break;
      case "--only": {
        const v = next();
        if (v === "design" || v === "build") out.only = v;
        break;
      }
      case "--candidates": out.candidates = next(); break;
      case "--trials": out.trials = Math.max(1, Number(next()) || 3); break;
      case "--project-dir": out.projectDir = next(); break;
      case "--dry-run": out.dryRun = true; break;
      case "--propose-only": out.proposeOnly = true; break;
      case "--sweep-lane": {
        const v = next();
        if (v === "design" || v === "build") out.sweepLane = v;
        break;
      }
      case "--from": out.from = next(); break;
    }
  }
  return out;
}

/** Parse a sweep spec string into a SweepSpec. The grammar is `;`-separated
 *  dimensions, each `key=v1,v2,...`:
 *    <role>.<turn>.model=<m>,...      per-turn model tiering
 *    <role>.<turn>.effort=<e>,...     per-turn effort
 *    build.sessionScope=story,cycle   session warmth (scope)
 *    build.loopGranularity=story,ac   loop granularity
 *    env.CONTEXT_FREE_FRACTION=0.3,.. session warmth (fraction, on env)
 *  All model/effort dimensions share ONE role (the last one named wins); the
 *  sweep targets a single role's turns, matching the plan's navigator/driver focus.
 *  Content variants (Family 2) are supplied programmatically, not via this string. */
export function parseSweepSpec(spec: string): SweepSpec {
  const out: SweepSpec = {};
  const trimmed = spec.trim();
  if (!trimmed) return out;
  for (const dim of trimmed.split(";")) {
    const [key, rawVals] = dim.split("=");
    if (!key || rawVals === undefined) continue;
    const vals = rawVals.split(",").map((v) => v.trim()).filter(Boolean);
    if (vals.length === 0) continue;
    const parts = key.trim().split(".");

    if (parts[0] === "build" && parts[1] === "sessionScope") {
      out.sessionScopes = vals.filter((v): v is "story" | "cycle" => v === "story" || v === "cycle");
    } else if (parts[0] === "build" && parts[1] === "loopGranularity") {
      out.loopGranularities = vals.filter((v): v is "story" | "ac" | "hybrid-a" => v === "story" || v === "ac" || v === "hybrid-a");
    } else if (parts[0] === "env" && parts[1] === "CONTEXT_FREE_FRACTION") {
      out.contextFreeFractions = vals.map(Number).filter((n) => !Number.isNaN(n));
    } else if (parts.length === 3 && (parts[2] === "model" || parts[2] === "effort")) {
      // <role>.<turn>.<model|effort>
      out.role = parts[0] as SpawnableAgentRole;
      const turn = parts[1] as BuildTurn;
      if (parts[2] === "model") {
        out.models = { ...(out.models ?? {}), [turn]: vals };
      } else {
        out.efforts = { ...(out.efforts ?? {}), [turn]: vals as EffortLevel[] };
      }
    }
  }
  return out;
}

/** Assemble the live OptimizeLiveCtx for a single handoff over the real drive:
 *  spawnTurn runs the handoff's commands via execRunner; a BUILD handoff also wires
 *  the git + re-fork snapshot substrate + the honest post-turn gate (from SCM
 *  state). Returns {error} when a build handoff lacks a claimed feature. Shared by
 *  the single-handoff path AND the lane sweep (each handoff gets its own ctx). */
function buildCtxForHandoff(
  handoff: HandoffPlan,
  loc: { projectDir: string; consortDir: string; featureId: string; recordDir?: string },
): { ctx: OptimizeLiveCtx } | { error: string } {
  const { projectDir, consortDir, featureId } = loc;
  const ctx: OptimizeLiveCtx = {
    projectDir,
    consortDir,
    featureId,
    experimentsDir: join(projectDir, "experiments"),
    spawnTurn: makeLiveSpawnTurn(featureId, {
      buildCfg: (fid) => buildCfg({ feature: fid, projectDir } as never, fid),
      // Dispatch the PINNED turn THROUGH the executor (buildDriveEffects.performViaExecutor) ,
      // the SAME primitive the live drive + lean chains use, so the sweep survives J5's deletion
      // of commandsForAction. It runs the handoff's OWN role turn (+ its post-turn substrate), NOT
      // planNextAction's "what's next" (which would advance to the next role once the artifact lands).
      buildEffects: (cfg) => buildDriveEffects(cfg as never),
      // Only the WINNER capture records into the corpus. makeLiveSpawnTurn sets
      // RECORD_DIR for record:true and clears it for trials, so a losing candidate
      // never pollutes the shippable corpus. The corpus dir is the runbook's
      // LAKEBASE_CONSORT_RECORD_DIR (read ONCE here, not left ambient), so the
      // recorder never fires for a trial even if the shell exported it.
      ...(loc.recordDir ? { recordDir: loc.recordDir } : {}),
    }),
    now: () => Date.now(),
    // Prompt-weight signal for the report's pass-2 trim targeting: the role's last
    // turn.usage input/cache-read tokens from the project agent-log.
    readTurnTokens: ({ handoff }) => readLastTurnTokens(consortDir, handoff.role),
    // SEMANTIC quality bar (design turns only): after the structural gate passes, judge
    // the candidate's artifact against the recorded reference at this step with a FIXED
    // opus judge (constant across candidates). Wired only when the step has a recorded
    // reference (turnKeyForAction resolves a design step); build turns / no-reference
    // steps get undefined and fall through to the structural gate alone.
    ...((): Pick<OptimizeLiveCtx, "semanticGate"> => {
      const step = handoff.action ? turnKeyForAction(handoff.action) : undefined;
      if (!step) return {};
      const judge = makeOpusJudge({ cwd: projectDir });
      return {
        semanticGate: () =>
          evaluateSemanticGate({ kitRoot: kitRoot(), consortDir, featureId, step, judge }),
      };
    })(),
    // The corpus dir recordWinner records the restored winning-trial artifacts into
    // (recordTurn from state, no re-spawn) when the ambient RECORD_DIR env is unset.
    ...(loc.recordDir ? { recordDir: loc.recordDir } : {}),
  };
  if (isBuildHandoff(handoff)) {
    const scm = readWorkflowState(projectDir);
    if (!scm?.project_id || !scm.branch) {
      return { error: "[optimize] build handoff needs a claimed feature (project_id + branch in .lakebase/workflow-state.json); claim + drive to the build turn first.\n" };
    }
    ctx.gateBuild = makeBuildGate(consortDir, featureId);
    ctx.buildSnapshotDeps = makeBuildSnapshotDeps({
      projectDir,
      story: handoff.story ?? "",
      cutArgs: {
        instance: scm.project_id,
        consortDir,
        featureId,
        experimentSlug: `${handoff.story}-optimize`,
        branch: scm.branch,
        ...(scm.parent_branch ? { parentBranch: scm.parent_branch } : {}),
      },
    });
  }
  return { ctx };
}

async function main(): Promise<number> {
  process.stderr.write(
    "[optimize] ⚠️ DEPRECATED: consort-optimize (champion walk) is superseded by the judged sweep " +
      "engine. Its ranking is conformance + wall-clock and it does NOT run a mandatory LLM judge on " +
      "every candidate. Use `scripts/optimize-role.sh` instead (one judged engine, output preserved).\n",
  );
  const args = parseOptimizeArgs(process.argv.slice(2));
  if (!args.scenario || !args.feature) {
    process.stderr.write("usage: consort-optimize --scenario <dir> --feature <id> [--handoff <id>] [--only design|build] --candidates <spec> --trials N [--dry-run]\n");
    return 2;
  }
  const projectDir = resolve(args.projectDir ?? process.cwd());
  const consortDir = resolveConsortDir(projectDir);
  const featureId = args.feature;
  const sweep = parseSweepSpec(args.candidates ?? "");
  const candidates = generateCandidates(sweep);

  // The corpus record dir: read ONCE here and CLEAR it from the ambient env, so the
  // recorder only fires for a WINNER capture (makeLiveSpawnTurn re-sets it per
  // record:true spawn) and NEVER for a trial. Leaving it ambient (as the runbook
  // used to export it) made every losing candidate's turn record into the shippable
  // corpus – the pollution this fixes. recordDir is threaded into each handoff ctx.
  const recordDir = consortEnv("RECORD_DIR")?.trim() || undefined;
  // Clear EVERY prefix variant (current + legacy) so no record-dir leaks ambient
  // into a trial's child spawn regardless of which name the runbook exported.
  for (const p of ENV_PREFIXES) delete process.env[`${p}RECORD_DIR`];

  process.stderr.write(
    `[optimize] scenario=${args.scenario} feature=${featureId} trials=${args.trials}` +
      `${args.only ? ` only=${args.only}` : ""}${args.handoff ? ` handoff=${args.handoff}` : ""}\n`,
  );
  process.stderr.write(`[optimize] ${candidates.length} candidate(s): ${candidates.map((c) => c.id).join(", ")}\n`);

  // ── Lane sweep: optimize EVERY role handoff in a lane, sequentially ──
  // Each handoff's winner is recorded (advancing the drive) before the next is
  // positioned, so the design lane's inter-turn dependencies (a winner's artifact
  // feeds the next turn) are honored. Per-handoff candidates come from
  // defaultLaneCandidates (the reflect critic gets baseline-only).
  if (args.sweepLane) {
    const lane = args.sweepLane;
    process.stderr.write(`[optimize] SWEEP LANE '${lane}': optimizing every role handoff sequentially (propose-only=${!!args.proposeOnly}).\n`);
    const laneWalk: HandoffResult[] = [];
    const allCandidates: Candidate[] = [];
    const result = await runLaneSweep({
      positionNext: () =>
        positionToNextHandoff({
          lane,
          planNext: async () => {
            const cfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
            const { action: a, commands } = await planNextAction(cfg);
            return { action: a, commands };
          },
          perform: async (commands) => {
            const cfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
            const runner = execRunner(cfg as never) as { run(cmd: unknown): Promise<void> };
            for (const cmd of commands as unknown[]) await runner.run(cmd);
          },
        }),
      sweepOne: async (h) => {
        const hCands = defaultLaneCandidates(h);
        allCandidates.push(...hCands);
        const ctxRes = buildCtxForHandoff(h, { projectDir, consortDir, featureId, recordDir });
        if ("error" in ctxRes) throw new Error(ctxRes.error.trim());
        // Reflect/critic turns (baseline-only) still "sweep" trivially so the walk
        // records + advances past them; a >1 candidate handoff is a real A/B.
        process.stderr.write(`[optimize] handoff ${h.id}: ${hCands.length} candidate(s)\n`);
        // alwaysAdvance: a LANE sweep MUST record each handoff's winner locally so
        // the next handoff plans from it (the design lane's inter-turn dependency),
        // even under propose-only. proposeOnly here governs only kit persistence (the
        // separate optimize-apply step the sweep never runs). Winner-only recording
        // is enforced by makeLiveSpawnTurn's record flag (trials never touch the corpus).
        const walk = await runChampionWalk(
          { handoffs: [h], candidates: hCands, trials: args.trials, proposeOnly: args.proposeOnly, alwaysAdvance: true },
          makeChampionWalkDeps(ctxRes.ctx),
        );
        return walk.walk[0];
      },
      // advanceOne: a settled upstream handoff (before --from) whose winner is already
      // applied to the kit – run its baseline turn to move the drive forward, do NOT
      // re-sweep. Dispatched THROUGH the executor (the SAME performViaExecutor the sweep +
      // live drive use), which runs the agent turn AND its post-turn substrate (e.g.
      // breakdown's sync-breakdown populates pipeline.json), advancing the drive exactly as
      // a normal turn would. The BoundedRoute is ignored (advance runs one turn, the lane
      // sweep re-positions). undefined => action not executor-dispatched; fall to perform.
      advanceOne: async (h) => {
        if (!h.action) throw new Error(`optimize advanceOne: handoff '${h.id}' has no pinned action to advance.`);
        process.stderr.write(`[optimize] handoff ${h.id}: ADVANCE (settled upstream; full baseline turn, not swept)\n`);
        const cfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
        const eff = buildDriveEffects(cfg as never);
        const state = await eff.readState();
        const bounded = await eff.performViaExecutor?.(h.action as never, state, SWEEP_ROUTER_DEPS);
        if (bounded === undefined) await eff.perform(h.action as never);
      },
    }, args.from ? { startFrom: args.from } : {});
    laneWalk.push(...result.walk);
    const report = buildChampionWalkReport({ walk: laneWalk }, allCandidates);
    process.stdout.write(formatChampionWalkReport(report));
    if (args.proposeOnly) {
      process.stderr.write(
        `[optimize] propose-only lane sweep: no winners recorded. Review the ranked report + experiments/, ` +
          `then persist per handoff with consort-optimize-apply --project-dir ${projectDir} --handoff <id> --candidate <id>\n`,
      );
    }
    return 0;
  }

  // The next handoff the drive is positioned on (the harness optimizes ONE handoff
  // per invocation; the runbook advances the drive between invocations). Read the
  // current disk state via planNextAction with a throwaway cfg.
  const probeCfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
  const { action } = await planNextAction(probeCfg);
  let handoff = actionToHandoffPlan(action);

  // Build-lane positioning: the design-complete boundary lands on a build-lane
  // SUBSTRATE action (dispatch, then cut-experiment), not a role turn. When the
  // next action is a build-lane substrate step, advance through those (performing
  // the fork) to sit ON the first build role turn – unless --only design, which
  // must not enter the build lane.
  if (!handoff && actionLane(action) === "build" && args.only !== "design") {
    handoff = await positionToBuildHandoff({
      planNext: async () => {
        const cfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
        const { action: a, commands } = await planNextAction(cfg);
        return { action: a, commands };
      },
      perform: async (commands) => {
        const cfg = buildCfg({ feature: featureId, projectDir } as never, featureId);
        const runner = execRunner(cfg as never) as { run(cmd: unknown): Promise<void> };
        for (const cmd of commands as unknown[]) await runner.run(cmd);
      },
    });
  }

  if (!handoff) {
    process.stderr.write(`[optimize] the next action (${action.kind}) is not an optimizable role handoff; nothing to sweep. Drive design + gates first (or use --only build once past the gate).\n`);
    return 0;
  }
  if (args.only === "build" && !isBuildHandoff(handoff)) {
    process.stderr.write(`[optimize] --only build but the next handoff (${handoff.id}) is a design turn; skipping.\n`);
    return 0;
  }
  if (args.only === "design" && isBuildHandoff(handoff)) {
    process.stderr.write(`[optimize] --only design but the next handoff (${handoff.id}) is a build turn; skipping.\n`);
    return 0;
  }

  if (args.dryRun) {
    process.stderr.write(`[optimize] --dry-run: next handoff = ${handoff.id} (${handoff.role}${handoff.buildMode ? "/" + handoff.buildMode : ""}); no turns spawned.\n`);
    return 0;
  }

  // Candidates for THIS handoff. An explicit --candidates spec wins (build-turn
  // model/effort tiering). With no spec, fall back to defaultLaneCandidates(handoff)
  // – the same per-role default set the lane sweep uses (baseline + cheaper-model +
  // effort-low + scan-tighten). This is what lets a SINGLE-handoff sweep exercise a
  // DESIGN role's scalar model/effort levers, which the --candidates grammar (keyed
  // on build turns) cannot express. So `optimize --feature F ... ` on a positioned
  // design handoff sweeps its real levers without the multi-handoff lane loop.
  const handoffCandidates = args.candidates?.trim() ? candidates : defaultLaneCandidates(handoff);

  // Assemble the live champion-walk deps for THIS handoff over the real drive.
  const ctxResult = buildCtxForHandoff(handoff, { projectDir, consortDir, featureId, recordDir });
  if ("error" in ctxResult) {
    process.stderr.write(ctxResult.error);
    return 2;
  }
  const deps = makeChampionWalkDeps(ctxResult.ctx);
  const result = await runChampionWalk(
    { handoffs: [handoff], candidates: handoffCandidates, trials: args.trials, proposeOnly: args.proposeOnly },
    deps,
  );

  const report = buildChampionWalkReport(result, candidates);
  process.stdout.write(formatChampionWalkReport(report));
  if (args.proposeOnly) {
    process.stderr.write(
      `[optimize] propose-only: no winner recorded. Review the ranked candidates + experiments/${handoff.id}/, ` +
        `then persist your choice with: consort-optimize-apply --project-dir ${projectDir} --handoff ${handoff.id} --candidate <id>\n`,
    );
  }
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
