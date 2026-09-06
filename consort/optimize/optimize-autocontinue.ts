// ⚠️ DEPRECATED (superseded 2026-08-07) – do NOT extend or build new work on this module.
// This is the UNATTENDED champion-walk driver (sweep -> apply -> rebuild -> advance over the live
// drive), layered on the deprecated optimize-live engine. It is superseded by the ONE judged sweep
// engine `runRoleSweep` (tests/optimization/role-sweep.ts) via `scripts/optimize-role.sh`. The
// champion walk it drives ranks on conformance + wall-clock and does NOT run a mandatory LLM judge
// on every candidate (build handoffs bypass any judge), which VIOLATES the standing evaluation
// invariant (every candidate judged vs the recorded reference + output preserved; see memory
// feedback_every_evaluation_judge_and_preserve). Kept only for the existing bin + tests; slated for
// removal alongside optimize-live. New unattended sweeps ride the judged engine's launcher.
//
// optimize-autocontinue: the UNATTENDED driver that walks the orchestrator's lane
// end to end – per role handoff: sweep candidates, pick the winner, auto-apply it to
// the kit + rebuild (so the NEXT role runs on the optimized kit), let the winner's
// artifacts advance the drive, then re-plan the next handoff. Continues through the
// design lane then the build lane to feature-complete, with NO human in the loop.
//
// This module is the PURE ORCHESTRATION SHELL: every side effect (position, sweep,
// apply+rebuild, advance) is injected as a dep, so the loop's control flow – what to
// do on a viable winner, a non-viable candidate set, a systemic failure, a stop bound
// – is unit-tested hermetically with no cloud, no model, no git. The live deps are
// wired by the CLI (optimize-live's positionToNextHandoff + runChampionWalk +
// optimize-apply's applyWinnerToManifests + npm build + git commit).
//
// SAFETY (unattended): a SYSTEMIC failure (auth expiry, Lakebase fork collision,
// runner death – distinct from a candidate merely not self-healing) HALTS the loop
// with a written status instead of burning tokens. A candidate set where NOTHING is
// viable is NOT systemic – it is logged, the baseline advances, and the loop
// continues (a role we could not optimize is not a reason to abandon the lane). The
// loop is resumable: it re-derives its position from disk each iteration, so a restart
// after the ~55min background cap picks up where it left off.

import type { HandoffPlan, HandoffResult } from "./optimize-harness.js";

/** Why the auto-continue loop stopped. */
export type AutoContinueStopReason =
  | "lane-complete" // positionNext returned null at the feature boundary – success
  | "stop-after-story" // hit the configured story bound (first-run cap)
  | "systemic-halt" // an injected step raised a SystemicFailure – halted, not burned
  | "max-handoffs"; // safety backstop (a lane that never advances)

/** A systemic (infra) failure that must HALT the unattended loop – auth expiry, a
 *  Lakebase fork collision, a runner death. Distinct from a candidate failing to
 *  self-heal (that is a normal DQ, not systemic). Injected steps throw this to halt. */
export class SystemicFailure extends Error {
  constructor(
    readonly detail: string,
    readonly stage: "position" | "sweep" | "apply" | "advance",
  ) {
    super(`systemic failure during ${stage}: ${detail}`);
    this.name = "SystemicFailure";
  }
}

/** The outcome of sweeping one handoff: the winner + whether ANY candidate was viable.
 *  `viable:false` means no candidate passed its gate (design) / self-healed to GREEN +
 *  functional (build) – the role could not be optimized; the loop logs it and advances
 *  at baseline rather than halting. */
export interface SweepOutcome {
  result: HandoffResult;
  /** true when at least one candidate qualified (a real winner); false = baseline
   *  fallback (nothing beat/matched baseline, or nothing was viable). */
  viable: boolean;
  /** The winning candidate id (baseline id when not viable). */
  winnerId: string;
}

export interface AutoContinueDeps {
  /** Advance to + return the next role handoff the orchestrator points at, or null at
   *  the feature boundary. Re-derived from disk each call (resumable). Throws
   *  SystemicFailure on an infra fault. */
  positionNext(): Promise<HandoffPlan | null>;
  /** Champion-walk ONE handoff (design: semantic-gated; build: honest-GREEN + full
   *  self-heal loop + functional-gated, trials per config). Returns the winner +
   *  viability. Throws SystemicFailure on an infra fault (NOT on a candidate merely
   *  failing to self-heal – that is a non-viable outcome, not a throw). */
  sweepOne(handoff: HandoffPlan): Promise<SweepOutcome>;
  /** Apply the winner's lever to the kit overlay + rebuild dist + local commit, so the
   *  NEXT handoff runs on the optimized kit. No-op for a baseline/non-viable winner
   *  (nothing to persist). Throws SystemicFailure only on an infra fault (e.g. build
   *  broke). */
  applyAndRebuild(outcome: SweepOutcome, handoff: HandoffPlan): Promise<void>;
  /** Record the winner's artifacts + advance the drive one role (recordWinner). Throws
   *  SystemicFailure on an infra fault. */
  advance(outcome: SweepOutcome, handoff: HandoffPlan): Promise<void>;
  /** Append a structured line to the run journal (progress + decisions + halts), so an
   *  unattended run leaves an auditable trail the operator reads on return. */
  journal(entry: AutoContinueJournalEntry): void;
}

export interface AutoContinueJournalEntry {
  handoffId: string;
  role: string;
  event: "swept" | "advanced-baseline" | "applied" | "halt" | "stop-bound" | "done";
  winnerId?: string;
  viable?: boolean;
  detail?: string;
}

export interface AutoContinueOptions {
  /** Stop the loop once the NEXT handoff would be for a story whose id is NOT this
   *  one (the first-run cap: optimize S1's build turns, then halt before S2's).
   *  Compared against handoff.story. Undefined = no story bound. */
  stopAfterStory?: string;
  /** Safety backstop against a non-advancing lane (same handoff id twice). Default 200
   *  (a full design+build lane for a few stories is well under). */
  maxHandoffs?: number;
}

export interface AutoContinueResult {
  stopReason: AutoContinueStopReason;
  /** Per-handoff winners in order (viable + baseline-advanced alike). */
  walk: HandoffResult[];
  /** Handoffs whose sweep found NO viable candidate (advanced at baseline). */
  nonViable: string[];
  /** Set on a systemic halt: what failed + where. */
  halt?: { detail: string; stage: string; handoffId?: string };
}

/**
 * Run the unattended auto-continue loop. Pure control flow over injected deps.
 *
 * Per iteration: position on the next handoff (null => lane-complete). If a
 * stopAfterStory bound is set and the next handoff belongs to a DIFFERENT story,
 * stop cleanly (stop-after-story). Otherwise sweep it; apply + rebuild the winner
 * (so the next role uses the optimized kit); advance the drive; journal; repeat.
 *
 * A SystemicFailure thrown by any step HALTS with a written status (does not burn on).
 * A non-viable sweep (no candidate qualified) is logged, advances at baseline, and
 * the loop CONTINUES (an un-optimizable role does not abandon the lane).
 */
export async function runAutoContinue(deps: AutoContinueDeps, options: AutoContinueOptions = {}): Promise<AutoContinueResult> {
  const maxHandoffs = options.maxHandoffs ?? 200;
  const walk: HandoffResult[] = [];
  const nonViable: string[] = [];
  let prevId: string | undefined;

  for (let i = 0; ; i++) {
    if (i >= maxHandoffs) {
      deps.journal({ handoffId: prevId ?? "?", role: "?", event: "halt", detail: `exceeded ${maxHandoffs} handoffs` });
      return { stopReason: "max-handoffs", walk, nonViable };
    }

    let handoff: HandoffPlan | null;
    try {
      handoff = await deps.positionNext();
    } catch (e) {
      return systemicHalt(deps, e, "position", walk, nonViable, prevId);
    }

    if (!handoff) {
      deps.journal({ handoffId: "-", role: "-", event: "done" });
      return { stopReason: "lane-complete", walk, nonViable };
    }

    // Story bound (first-run cap): stop BEFORE sweeping a handoff for a later story.
    if (options.stopAfterStory !== undefined && handoff.story !== undefined && handoff.story !== options.stopAfterStory) {
      deps.journal({ handoffId: handoff.id, role: handoff.role, event: "stop-bound", detail: `next story ${handoff.story} != ${options.stopAfterStory}` });
      return { stopReason: "stop-after-story", walk, nonViable };
    }

    // Non-advance backstop: the same handoff twice means the drive did not move after
    // the last advance (a stuck gate). Treat as systemic – halt, do not spin.
    if (handoff.id === prevId) {
      return systemicHalt(deps, new SystemicFailure(`handoff "${handoff.id}" did not advance after its winner was recorded`, "advance"), "advance", walk, nonViable, prevId);
    }

    let outcome: SweepOutcome;
    try {
      outcome = await deps.sweepOne(handoff);
    } catch (e) {
      return systemicHalt(deps, e, "sweep", walk, nonViable, handoff.id);
    }
    walk.push(outcome.result);
    if (!outcome.viable) {
      nonViable.push(handoff.id);
      deps.journal({ handoffId: handoff.id, role: handoff.role, event: "advanced-baseline", viable: false, winnerId: outcome.winnerId, detail: "no viable candidate; advancing at baseline" });
    } else {
      deps.journal({ handoffId: handoff.id, role: handoff.role, event: "swept", viable: true, winnerId: outcome.winnerId });
    }

    // Apply the winner (overlay + rebuild + commit) so the NEXT role runs on the
    // optimized kit – ONLY for a viable winner. A non-viable/baseline outcome has
    // nothing to persist, so skip the (expensive) rebuild+commit entirely. Systemic
    // on a broken build.
    if (outcome.viable) {
      try {
        await deps.applyAndRebuild(outcome, handoff);
        deps.journal({ handoffId: handoff.id, role: handoff.role, event: "applied", winnerId: outcome.winnerId });
      } catch (e) {
        return systemicHalt(deps, e, "apply", walk, nonViable, handoff.id);
      }
    }

    // Advance the drive with the winner's actual artifacts (recordWinner).
    try {
      await deps.advance(outcome, handoff);
    } catch (e) {
      return systemicHalt(deps, e, "advance", walk, nonViable, handoff.id);
    }

    prevId = handoff.id;
  }
}

function systemicHalt(
  deps: AutoContinueDeps,
  e: unknown,
  stage: "position" | "sweep" | "apply" | "advance",
  walk: HandoffResult[],
  nonViable: string[],
  handoffId?: string,
): AutoContinueResult {
  const detail = e instanceof Error ? e.message : String(e);
  deps.journal({ handoffId: handoffId ?? "?", role: "?", event: "halt", detail: `${stage}: ${detail}` });
  return { stopReason: "systemic-halt", walk, nonViable, halt: { detail, stage, ...(handoffId ? { handoffId } : {}) } };
}
