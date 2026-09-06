// turn-events: the ONE vocabulary of PROCESS EVENTS a turn may raise and a later turn requires.
//
// The build lane is producers→consumers, but the coupling was IMPLICIT: one turn wrote an
// ad-hoc JSON marker (green-failure.json, superseded-tests.json, …) and a later ROUTE happened
// to require it, with nothing tying the producer, the route, and the consumer together. When a
// route fired toward a turn whose marker was absent (or written at a different scope), the run
// failed LATE with a bare "missing input", blaming the turn and not the route that mis-selected
// it. This module promotes those markers to FIRST-CLASS declared EVENTS: a turn declares "I may
// raise event E" (StepContract.raises), a turn declares "I require event E" (requiresEvents), and
// the route→contract table (turn-contract-table.ts) ties producer→event→consumer into one
// checkable chain. This file is the single source of the event kinds + their on-disk SCOPE.
//
// Scope matters: an event artifact lives at a SPECIFIC level of the .consort tree. green-failure
// lives per-CYCLE (<F>/<S>/<AC>/green-failure.json), NOT per-story – declaring the scope here
// (once) is what lets the resolver + the pre-dispatch check look in the RIGHT place instead of
// re-deriving a path per call site (the class of bug this whole model exists to prevent).
//
// Scope is ACTION-AWARE, not a static field: most events sit at a fixed scope regardless of the
// action, but review-verdict is dual-scoped – per-CYCLE when the loop runs per-AC (the action
// carries an `ac`), per-STORY otherwise (matching `acReviewVerdictJson` vs `storyReviewVerdictJson`
// in config/consort-paths.ts). So each event declares a `scopeFor(action)` resolver: the fixed-scope
// events ignore the action, review-verdict keys off `action.ac`. One event kind, honest dual scope.

import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";

/**
 * The scope at which an event's artifact is written + read, relative to `.consort`. Mirrors the
 * path builders in `config/consort-paths.ts`: `feature` = the feature dir, `story` = `storyResolved`,
 * `ac`/`cycle` = `cycleDir(f, s, ac)` (an AC and its cycle share a dir; both names read naturally
 * at a call site). A consumer/producer never hard-codes the path – it resolves via `scopeFor`.
 */
export type EventScope = "feature" | "story" | "ac" | "cycle";

/**
 * The closed set of process events the build lane raises. Each is a marker one turn writes and a
 * later turn's ROUTE depends on:
 *   - green-failure          : the Driver's honest-GREEN verify FAILED – the Navigator ASSESS turn
 *                              discriminates supersession vs regression from it.
 *   - superseded-tests       : the Navigator flagged prior tests the new AC supersedes – the Driver
 *                              green-superseded turn permissively refactors them.
 *   - regression-assessment  : the Navigator diagnosed a genuine regression (+ optional fixDirective)
 *                              – the Driver repair turn acts on it.
 *   - review-verdict         : the Navigator's REVIEW verdict (refactor yes/no + notes) – the Driver
 *                              refactor turn consumes it.
 */
export type TurnEventKind =
  | "green-failure"
  | "superseded-tests"
  | "regression-assessment"
  | "review-verdict";

/**
 * The declared shape of one process event: its kind, an action-aware SCOPE resolver, the filename
 * within that scope dir, and a human description (diagnostics + the route-satisfiable error). The
 * `filename` + resolved scope together are the single truth a resolver uses to locate the artifact.
 */
export interface TurnEventSpec {
  kind: TurnEventKind;
  /** The scope this event's artifact lives at FOR a given action. Fixed-scope events return a
   *  constant; review-verdict returns "cycle" when the action carries an `ac`, else "story". */
  scopeFor(action: WorkflowAction): EventScope;
  /** The artifact filename within the resolved scope dir (e.g. "green-failure.json"). */
  filename: string;
  /** Human description of what the event signals (for diagnostics + route-satisfiable messages). */
  description: string;
}

/** An action carries an `ac` when the loop is running per-AC (vs per-story). */
const hasAc = (action: WorkflowAction): boolean =>
  typeof (action as { ac?: unknown }).ac === "string" && (action as { ac: string }).ac.length > 0;

/**
 * The ONE registry mapping each event kind to its spec, pinned to `TurnEventKind` at COMPILE time:
 * `satisfies Record<TurnEventKind, TurnEventSpec>` fails tsc if a kind is added to the union without
 * a spec here, or if a key here is not a real kind. So the scope of an event is declared exactly
 * once; `requiresEvents(action): TurnEventKind[]` resolves the scope THROUGH this table rather than
 * re-stating it per turn (one scope-truth). To ADD an event: extend TurnEventKind AND add its spec.
 */
export const TURN_EVENTS = {
  "green-failure": {
    kind: "green-failure",
    scopeFor: () => "cycle",
    filename: "green-failure.json",
    description: "The failed honest-GREEN verify marker the Navigator ASSESS turn discriminates.",
  },
  "superseded-tests": {
    kind: "superseded-tests",
    scopeFor: () => "cycle",
    filename: "superseded-tests.json",
    description: "The prior tests the new AC supersedes, for the Driver's permissive refactor.",
  },
  "regression-assessment": {
    kind: "regression-assessment",
    scopeFor: () => "cycle",
    filename: "regression-assessment.json",
    description: "The Navigator's regression diagnosis (+ optional fixDirective) for the Driver repair.",
  },
  "review-verdict": {
    kind: "review-verdict",
    // Dual-scoped: per-CYCLE when the loop runs per-AC (the action carries an `ac`), per-STORY
    // otherwise – matching acReviewVerdictJson vs storyReviewVerdictJson (consort-paths.ts:83-94).
    scopeFor: (action) => (hasAc(action) ? "cycle" : "story"),
    filename: "review-verdict.json",
    description: "The Navigator's REVIEW verdict (refactor yes/no + notes) the Driver refactor consumes.",
  },
} satisfies Record<TurnEventKind, TurnEventSpec>;
