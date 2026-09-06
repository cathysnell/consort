// assert-route-satisfiable: the PRE-DISPATCH check that a routed turn's required process events
// were actually produced – the seam that ties the ROUTE to the turn's input contract.
//
// The router (nextTransition/nextBuildAction) selects the next turn from state flags; the executor,
// much later, presence-checks the turn's declared inputs and fails with a bare "missing input". That
// late error blames the TURN and not the ROUTE that mis-selected it, and it fired only because a
// declared input happened to be absent – the class of bug behind green-failure / feature-request /
// design "missing input" failures. This module closes that gap: BEFORE dispatch, it resolves the
// routed action's manifest, reads its `requiresEvents` (the process events a route to it depends on),
// and asserts each event's artifact exists at ITS scope (via TURN_EVENTS + the .consort path
// builders). If one is absent it throws a RouteContractError that names the ROUTE + the missing EVENT
// + where it was expected – so the failure points at the routing gap, not a downstream symptom.
//
// It is the SINGLE source's consumer: the required events live on the manifest (Step.requiresEvents),
// the scope lives on TURN_EVENTS, the paths live in consort-paths – nothing is restated here. The
// check is advisory-by-placement: wired as an OPTIONAL DriveEffects hook the loop calls before
// dispatch, so the default (unwired) path is byte-identical, and the executor's own presence-check
// stays as defense-in-depth.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cycleDir, cyclesRootDir, featuresDir } from "../../config/consort-paths.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
import { TURN_EVENTS, type EventScope, type TurnEventKind, type TurnEventSpec } from "./turn-events.js";

/** Thrown when a route selected a turn whose REQUIRED process event was not produced. Names the
 *  route (the action), the missing event, and the path it was expected at – so the diagnosis points
 *  at the routing gap ("this route should not have fired yet"), not the downstream missing input. */
export class RouteContractError extends Error {
  constructor(
    readonly action: WorkflowAction,
    readonly event: TurnEventKind,
    readonly expectedPath: string,
  ) {
    super(
      `route selected turn ${JSON.stringify(action)} but its required process event "${event}" was ` +
        `not produced (expected at ${expectedPath}). A prior turn must RAISE "${event}" before this ` +
        `route may fire – the router chose this turn on stale/derived state. Fix the route or the ` +
        `producer, not this turn's inputs.`,
    );
    this.name = "RouteContractError";
  }
}

/** What the check needs to locate an event artifact: the resolved .consort dir + the run's ids. The
 *  effects layer (which owns these) supplies them; the checker stays pure + testable. */
export interface RouteContractContext {
  consortDir: string;
  featureId: string;
}

/** How a step declares the events a route to it requires. `Step.requiresEvents(action)` returns this;
 *  a mock/test supplies the same shape. Kept minimal so the checker does not depend on the full
 *  StepContract surface. */
export interface RequiresEventsFace {
  requiresEvents(action: WorkflowAction): TurnEventKind[];
}

/** Resolve the on-disk path of an event artifact for a given action, keyed by the event's own scope
 *  (TURN_EVENTS.scopeFor) – the ONE scope-truth. `feature` roots at the feature dir, `story` at the
 *  CYCLES story-root (sibling of the per-AC cycle dirs – where the story-loop review-verdict lands,
 *  matching storyReviewVerdictJson; NOT the features/<f>/stories/<s> design dir), `ac`/`cycle` at the
 *  per-cycle dir. */
function eventArtifactPath(
  event: TurnEventKind,
  action: WorkflowAction,
  ctx: RouteContractContext,
): string {
  const spec: TurnEventSpec = TURN_EVENTS[event];
  const scope: EventScope = spec.scopeFor(action);
  const story = "story" in action && typeof action.story === "string" ? action.story : undefined;
  const ac = "ac" in action && typeof action.ac === "string" ? action.ac : undefined;
  const f = ctx.featureId;
  switch (scope) {
    case "feature":
      return join(featuresDir(ctx.consortDir), f, spec.filename);
    case "story":
      if (!story) return join(ctx.consortDir, spec.filename); // no story – resolve at root (will miss + name it)
      // Story-scoped events (review-verdict for the whole-story loop) land at the CYCLES story-root
      // (cycles/<f>/<s>/), sibling of the per-AC cycle dirs – the same place storyReviewVerdictJson
      // writes – NOT the features/<f>/stories/<s> design dir.
      return join(cyclesRootDir(ctx.consortDir), f, story, spec.filename);
    case "ac":
    case "cycle":
      if (!story || !ac) return join(ctx.consortDir, spec.filename); // no story/ac – root (will miss + name it)
      return join(cycleDir(ctx.consortDir, f, story, ac), spec.filename);
  }
}

/**
 * Assert every process event a route to `action` REQUIRES exists before dispatch. Resolves the step's
 * `requiresEvents` (from the manifest, via the injected face), and for each event presence-checks its
 * artifact at the event's scope. Throws RouteContractError (naming route + event + path) on the first
 * missing one. A turn with no required events (the plain RED/GREEN turns, every design turn) is a
 * no-op. `exists` is injectable for tests; defaults to fs.existsSync.
 */
export function assertRouteSatisfiable(
  action: WorkflowAction,
  step: RequiresEventsFace,
  ctx: RouteContractContext,
  exists: (p: string) => boolean = existsSync,
): void {
  for (const event of step.requiresEvents(action)) {
    const p = eventArtifactPath(event, action, ctx);
    if (!exists(p)) throw new RouteContractError(action, event, p);
  }
}
