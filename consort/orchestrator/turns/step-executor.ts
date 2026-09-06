// StepExecutor: the ONE standard step-execution process – the Template Method the
// orchestrator (a state machine) runs for EVERY substep. Everything the orchestrator does
// per step is unified into this fixed, no-exception 7-phase sequence:
//
//   1. resolve-inputs      read each input's CONTENTS from .consort (via deps.resolveInputs).
//                          FAIL LOUD naming the missing logical id BEFORE any spawn.
//   2. provision-workspace create/point the contained workspaceDir (+ output locations).
//   2.5 prepare-preconditions  PREPARE each precondition the step DECLARES (via deps.prepare)
//                          and APPEND the projected block to the step's instructions, so a
//                          fresh-session heavy role is pre-conditioned (context-pack / green-
//                          failure advisory) without rediscovering context. A declared-but-
//                          empty preparer is a logged anomaly ("always something"), never a
//                          hard fail. Skipped entirely when deps.prepare is absent (default).
//   2.7 pre-turn-effects   deterministic side effects the step declares BEFORE the spawn (e.g.
//                          reset-breakdown). deps.preTurnEffects; no-op when absent.
//   3. dispatch-agent      invoke the step's injected agent, contained to the workspace
//                          (wait; the monitor/timeout envelope wires in at the spawn seam).
//   4. capture-outputs     the step reports the produced artifact path(s) it found.
//   5. validate-outputs    run each output's in-code validator; a failure is a HARD reject
//                          with named violations, NOT an agent follow-up.
//   6. record/log          emit the turn record (deps.onRecord).
//   6.5 post-turn-effects  deterministic side effects the step declares AFTER a CLEAN validation
//                          (e.g. sync-breakdown + reconcile). deps.postTurnEffects; gated on no
//                          violations; no-op when absent.
//   7. route               ask the step where it proposes to go, then reconcile through
//                          validateAndBound (the orchestrator's authority over routing).
//
// The Template Method is EXTENSIBLE: pre/post-turn-effects are added phases, not bolt-ons – the
// legacy commandsForAction bundled `before`/`after` CLIs with the spawn, and expressing them as
// their own phases is how execute() owns the WHOLE turn. All added phases default to no-op, so a
// caller that wires none gets the byte-identical original 7-phase behavior.
//
// The phase ORDER, the fail-loud input gate, containment, and validateAndBound's authority
// are the orchestrator-owned INVARIANT – the StepContract/manifest/registry only fill the
// hooks. Phases 3+4 are the step's run(); 5+7 use the step's outputs()/route(); the rest is
// orchestrator-owned. Nothing here reaches outside what the deps provide.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateAndBound } from "../steps/step-contract.js";
import type { WorkflowAction, DriveState } from "../workflow/workflow-vocabulary.js";
import type { DriveEffectsConfig } from "../drive/orchestrator-effects.js";
import type { StepContract, StepPrecondition, BoundedRoute, ValidateBoundDeps, RouteProposal } from "../steps/step-contract.js";
import type { StepInstructions } from "../agents/agent-types.js";
import type { ProvidedStepRun, ProvidedStepResult } from "../steps/step-run-types.js";
import { resolveChannelRoot } from "../provisioning/channels.js";

/** A step the executor can run: the routing/IO contract PLUS the contained run() body that
 *  the concrete step (Step, or a bespoke class) implements. */
export type RunnableStep = StepContract & {
  run(provided: ProvidedStepRun): Promise<ProvidedStepResult>;
};

/** The read-only context one step execution runs against. */
export interface StepCtx {
  action: WorkflowAction;
  cfg: DriveEffectsConfig;
  state: DriveState;
  /** The SAME bounds runDriver builds (allowed transition + revise/retry ledgers). The
   *  executor never invents routing authority – it reconciles through validateAndBound. */
  validateBoundDeps: ValidateBoundDeps;
}

/** What phase 2 hands back: the workspace + the optional per-channel roots + output locations. */
export interface ProvisionedWorkspace {
  workspaceDir: string;
  /** Root for `artifact`-channel outputs (the .consort design docs), when provisioned. MAY be
   *  contained. Absent => artifact falls back to workspaceDir. */
  artifactDir?: string;
  /** The CONTAINED zone for `meta`-channel outputs (orchestration bookkeeping – raw report /
   *  verdict / marker). Absent => meta falls back to workspaceDir. A `product` output always
   *  resolves under workspaceDir (the real code tree). With neither artifactDir nor metaDir set,
   *  every channel resolves to workspaceDir – byte-identical to the pre-channel executor. */
  metaDir?: string;
  /** Output-id -> workspace-relative path the produced artifact will be found at (the step
   *  falls back to the bare output filename when an id is absent). */
  outputPaths?: Record<string, string>;
}

/** The record/log payload phase 6 emits (turn outcome, for the orchestrator's logging). */
export interface StepRecord {
  action: WorkflowAction;
  producedPaths: string[];
  violations: string[];
  /** The orchestrator's OUTER wall-clock for the step's dispatch+capture (phases 3+4), ms.
   *  Always present. Distinct from the agent's self-reported duration (which lives on
   *  agentResult.usage.durationMs when the agent reported it). */
  outerDurationMs?: number;
  /** The step's agent result for the turn (usage tokens/cost/num_turns + final text), when the
   *  step exposes one (a live ClaudeStepAgent does; a mock/replay agent does not). Read
   *  duck-typed via the step's optional lastAgentResult(), so the record carries the telemetry
   *  the per-role live tests survive + print. */
  agentResult?: { usage?: import("../../session/claude-usage.js").TurnUsage; finalText?: string };
}

/**
 * The orchestrator-provided seams the executor drives. These are the "how to get the things
 * the step needs" the state machine owns – input resolution from .consort, workspace
 * provisioning, instruction sourcing, and turn logging. The executor NEVER resolves .consort
 * itself (containment): it calls these.
 */
export interface StepExecutorDeps {
  /** Phase 1: resolve the action's declared inputs to CONTENTS, or report the missing id. */
  resolveInputs(action: WorkflowAction, cfg: DriveEffectsConfig): Record<string, string> | { missing: string };
  /** Phase 2: provision (or point at) the contained workspace + output locations. */
  provisionWorkspace(action: WorkflowAction, cfg: DriveEffectsConfig): ProvisionedWorkspace;
  /** Phase 2.5: PREPARE one declared precondition – project its context block from on-disk
   *  `.consort` (the preparer registry, resolved by kind). Returns the text block appended to
   *  the step's instructions. Optional: when absent the PREPARE-PRECONDITIONS phase is a
   *  no-op (the default/byte-identical executor path). The orchestrator owns the registry
   *  wiring; the executor stays generic. */
  prepare?(kind: string, precondition: StepPrecondition, action: WorkflowAction, cfg: DriveEffectsConfig): string;
  /** Phase 3 input: the instruction bundle the orchestrator sourced for this step. */
  instructionsFor(action: WorkflowAction, cfg: DriveEffectsConfig): StepInstructions;
  /** Between capture (4) and validate (5): the orchestrator MATERIALIZES any output the
   *  agent authored as raw content but could not produce in conformant form itself (a
   *  sandboxed spawned agent cannot run the shared formatter subprocess). Concretely: format
   *  the agent-authored .agent-report.json into a conformant agent-log.jsonl. Runs
   *  orchestrator-side (unsandboxed), so validate-outputs then sees the real, conformant
   *  file. Optional – default no-op, so the byte-identical default + existing steps are
   *  unaffected. */
  materializeOutputs?(workspaceDir: string, action: WorkflowAction, cfg: DriveEffectsConfig): void | Promise<void>;
  /** Phase 2.7 PRE-TURN EFFECTS: deterministic side effects the step declares to run BEFORE the
   *  agent spawn (e.g. the spec-author breakdown's `reset-breakdown` – clear a partial breakdown
   *  so the re-dispatch regenerates clean). Expands the Template Method: the legacy
   *  commandsForAction bundled these `before` CLIs with the spawn; making them their own phase is
   *  how execute() owns the WHOLE turn, not just the spawn. Optional – default no-op (byte-identical). */
  preTurnEffects?(action: WorkflowAction, cfg: DriveEffectsConfig): Promise<void>;
  /** Phase 6.5 POST-TURN EFFECTS: deterministic side effects the step declares to run AFTER a
   *  CLEAN validation (e.g. spec-author breakdown's `sync-breakdown` – seed the pipeline from the
   *  story dirs the agent wrote; the `reconcile` log). Runs ONLY when validation passed (a blocked
   *  turn re-issues without side effects), so a nonconformant artifact never triggers downstream
   *  projection. The other half of the Template-Method expansion – the legacy path's `after` CLIs.
   *  Optional – default no-op (byte-identical). */
  postTurnEffects?(action: WorkflowAction, cfg: DriveEffectsConfig): Promise<void>;
  /** Phase 6: emit the turn record (usage/progress/violations). Optional (tests may omit). */
  onRecord?(record: StepRecord): void;
  /** Phase 2.5 anomaly channel: a declared precondition that PREPARED EMPTY (the preparer
   *  degraded – e.g. conventions.json absent). Surfaced as a WARNING so an empty pack is
   *  visible + auditable ("always something, never silently empty"), never a hard fail.
   *  Optional; default swallow. */
  onWarn?(warning: string): void;
}

/** What one step execution returns to runDriver's loop. */
export interface StepResult {
  /** The reconciled next move – feeds the loop exactly like today's pendingProposal. */
  bounded: BoundedRoute;
  /** Absolute path(s) to the produced artifact(s) in the workspace. */
  producedPaths: string[];
  /** Non-empty => at least one output failed its in-code validator (a hard reject). */
  violations: string[];
}

/** A fail-loud error for a missing input – raised in phase 1 before any agent spawn. */
export class MissingInputError extends Error {
  constructor(readonly inputId: string, action: WorkflowAction) {
    super(`missing input "${inputId}" for step ${JSON.stringify(action)} – the orchestrator did not provide it (fail loud before spawning the agent)`);
    this.name = "MissingInputError";
  }
}

/**
 * Run one step through the fixed 7-phase Template Method. See the file header for the
 * ownership split. The default no-contract drive never calls this; it is opt-in per step
 * (wired into runDriver behind a flag in a later slice), so the byte-identical default
 * stands until a manifest + the executor are turned on for an action.
 */
export async function execute(step: RunnableStep, ctx: StepCtx, deps: StepExecutorDeps): Promise<StepResult> {
  const { action, cfg, state, validateBoundDeps } = ctx;

  // Phase 1: resolve-inputs – fail loud, BEFORE provisioning or spawning.
  const resolved = deps.resolveInputs(action, cfg);
  if ("missing" in resolved) {
    throw new MissingInputError(resolved.missing, action);
  }

  // Phase 2: provision-workspace – the workspace + output locations (+ the optional per-channel
  // roots: artifactDir for .consort design docs, metaDir for orchestration bookkeeping).
  const { workspaceDir, artifactDir, metaDir, outputPaths } = deps.provisionWorkspace(action, cfg);

  // Phase 2.5: PREPARE-PRECONDITIONS – project each DECLARED precondition (context-pack /
  // green-failure advisory) and APPEND its block to the step's instructions, so a fresh-
  // session heavy role is pre-conditioned by the SAME mechanism no matter which track
  // dispatched it. Runs only when the orchestrator wired deps.prepare (the default executor
  // path leaves the prompt byte-identical). A declared-but-empty preparer is a logged anomaly
  // ("always something"), never a hard fail – the block simply appends nothing.
  const instructions = deps.instructionsFor(action, cfg);
  // REPLAY: when a verbatim body override is in effect for this turn (an experiment driving the corpus
  // turn's recorded prompt), the recorded prompt ALREADY carries its context – SKIP phase-2.5 so a
  // manifest-declared context-pack is not re-injected on top of it.
  const overridden = action.kind === "invoke-role" && cfg.instructionsOverride?.(action) !== undefined;
  if (deps.prepare && !overridden) {
    const preconditions = step.preconditions(action);
    // POSITION-AWARE injection: a precondition rides BEFORE ("prepend") or AFTER ("append", default)
    // the step's base instruction prompt – preserving the legacy inline positioning (the design
    // context-pack appended after the directive; the green-failure advisory prepended before the
    // "ASSESS ..." directive) so the executor-assembled prompt stays BYTE-IDENTICAL to that inline
    // assembly when a turn adopts the declared face. Blocks accrue in declared order within each side.
    let prependBlocks = "";
    let appendBlocks = "";
    for (const pre of preconditions) {
      const block = deps.prepare(pre.kind, pre, action, cfg);
      if (block && block.length) {
        if (pre.position === "prepend") prependBlocks += block;
        else appendBlocks += block;
      } else {
        deps.onWarn?.(`declared precondition "${pre.id}" (${pre.kind}) prepared EMPTY – its source artifact may be absent (${pre.description})`);
      }
    }
    if (prependBlocks) instructions.prompt = prependBlocks + instructions.prompt;
    if (appendBlocks) instructions.prompt = instructions.prompt + appendBlocks;
  }

  // Phase 2.7: PRE-TURN EFFECTS – deterministic side effects the step declares to run BEFORE the
  // spawn (e.g. reset-breakdown). Part of the Template Method's expanded sequence: the legacy
  // commandsForAction ran these `before` CLIs ahead of the claude command; here they are their own
  // phase, so execute() owns them too. No-op unless the orchestrator wired deps.preTurnEffects.
  await deps.preTurnEffects?.(action, cfg);

  // Phase 3+4: dispatch-agent (contained) + capture-outputs – both inside the step's run().
  // Time the outer wall-clock across run() (the orchestrator's own measure of the turn, which
  // always exists, vs the agent's self-reported duration which only a live agent emits).
  const startedMs = Date.now();
  const runResult = await step.run({ action, workspaceDir, ...(artifactDir ? { artifactDir } : {}), ...(metaDir ? { metaDir } : {}), inputs: resolved, instructions, outputPaths });
  const outerDurationMs = Date.now() - startedMs;
  const producedPaths = runResult.producedPaths ?? [];
  // Read the step's agent result (usage + final text) duck-typed via an optional accessor – a
  // Step backed by a live ClaudeStepAgent exposes it; a mock/replay step does not.
  const agentResult = (step as { lastAgentResult?: () => StepRecord["agentResult"] }).lastAgentResult?.();

  // Between capture (4) and validate (5): materialize orchestrator-formatted outputs from
  // the agent's raw authored content (e.g. .agent-report.json -> conformant agent-log.jsonl),
  // so validate-outputs below sees the real file. No-op unless the orchestrator supplies it.
  await deps.materializeOutputs?.(workspaceDir, action, cfg);

  // Phase 5: validate-outputs – run each output's in-code validator on its produced path.
  // A missing REQUIRED primary artifact (run reported produced:false) or any validator failure is a
  // HARD reject with named violations – never an agent follow-up. An OPTIONAL output that is
  // legitimately absent is NOT a violation (a self-heal turn may write no marker + escalate), so a
  // run whose ONLY declared output is optional does not block just because run() reported no primary.
  const outputSpecs = step.outputs(action);
  // A turn has NO REQUIRED PRIMARY when it declares zero outputs OR its primary output is optional.
  // Zero-outputs is the review/refactor case: the turn's result is an EVENT (review-verdict, raised +
  // handled by the postTurn cycle CLI + routing), NOT a workspace artifact the agent writes. A clean
  // "looks good" review legitimately produces no file, so runResult.produced is false – and with no
  // declared output there is nothing that was "supposed" to be produced. Treating that as the "primary
  // output not produced" violation is a FALSE violation that blocks the turn, gates its own postTurn
  // (the verdict-writing CLI) behind the block, and dead-locks into the retry-budget abort – the
  // systemic navigator-review PROTOCOL VIOLATION. (The prior guard only spared an optional primary,
  // which requires outputSpecs.length > 0, so a zero-output turn fell through to the violation.)
  const noRequiredPrimary = outputSpecs.length === 0 || outputSpecs[0].optional === true;
  const violations: string[] = [];
  if (!runResult.produced) {
    if (runResult.missingInput) {
      // Defensive: run() also gates inputs; surface it as a violation rather than crash.
      violations.push(`missing input "${runResult.missingInput}"`);
    } else if (!noRequiredPrimary) {
      violations.push("the step's primary output was not produced in the workspace");
    }
    // noRequiredPrimary + absent => the legitimate no-marker/escalate/looks-good route: NOT a violation.
  }
  for (const spec of outputSpecs) {
    const rel = outputPaths?.[spec.id] ?? spec.filename;
    // Resolve the output in ITS channel's root via the shared channel model (product ->
    // workspaceDir; artifact/meta -> their contained root, falling back to workspaceDir).
    const root = resolveChannelRoot(spec.channel, { workspaceDir, artifactDir, metaDir });
    // An output EXISTS if its declared file is on disk – regardless of whether the AGENT
    // wrote it (producedPaths) or the ORCHESTRATOR materialized it in phase 4.5 (e.g. the
    // formatted agent-log.jsonl). Prefer the path the agent reported; else the declared
    // channel-root-relative path. Checking the filesystem (not just producedPaths) is what lets
    // an orchestrator-materialized output count as produced.
    const abs = producedPaths.find((p) => p.endsWith(rel)) ?? join(root, rel);
    if (!existsSync(abs)) {
      // An OPTIONAL output that is absent is a clean PASS (the turn legitimately produced nothing on
      // this branch – e.g. assess escalating a genuine regression). A REQUIRED declared output that
      // never appeared is a violation – but only when the primary is otherwise present (a wholly-
      // empty required run is already flagged above; don't double-count).
      if (!spec.optional && runResult.produced) violations.push(`declared output "${spec.id}" (${spec.filename}) was not produced`);
      continue;
    }
    // PRESENT (optional or required): it must still be conformant – a present-but-malformed marker
    // is a real defect even for an optional output.
    const res = spec.validate(abs);
    if (!res.ok) violations.push(...res.violations.map((v) => `${spec.id}: ${v}`));
  }

  // Phase 6: record/log – always runs (records the outcome incl. any violations + the turn's
  // measured telemetry: outer wall-clock always, the agent's usage/finalText when it exposed one).
  deps.onRecord?.({ action, producedPaths, violations, outerDurationMs, ...(agentResult ? { agentResult } : {}) });

  // Phase 6.5: POST-TURN EFFECTS – deterministic side effects the step declares to run AFTER a
  // CLEAN validation (e.g. sync-breakdown to seed the pipeline from the story dirs the agent wrote,
  // + the reconcile log). Gated on NO violations: a blocked turn re-issues without firing downstream
  // projection off a nonconformant artifact (the legacy path only reached its `after` CLIs on a
  // turn that produced its artifact). The Template Method's expanded sequence, mirroring the legacy
  // `after` CLIs. No-op unless the orchestrator wired deps.postTurnEffects.
  if (violations.length === 0) {
    await deps.postTurnEffects?.(action, cfg);
  }

  // Phase 7: route – the step proposes; validateAndBound reconciles vs the pure transition +
  // the existing revise/retry bounds. A validation failure overrides the step's proposal to
  // a BOUNDED retry (blocked), so a nonconformant output re-issues the step rather than
  // advancing on a bad artifact.
  const proposal: RouteProposal =
    violations.length === 0
      ? step.route(action, { state, feature: cfg.featureId })
      : { outcome: "blocked", proposedNext: action, reason: violations.join("; ") };
  const bounded = validateAndBound(proposal, action, state, validateBoundDeps);

  return { bounded, producedPaths, violations };
}
