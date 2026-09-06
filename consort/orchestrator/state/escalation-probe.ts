// escalation-probe: derive the manifest runner's DriveState.escalation from the workspace's
// .sftdd on disk – the SAME authority the legacy orchestrator uses. This is the "derive
// DriveState from disk" family: the manifest runner is a standalone caller with no pure
// transition graph of its own, so to reach the revise/escalate route space a step's route()
// needs a REAL escalation on ctx.state (not the { phase: "feature" } stub). Rather than
// re-derive the escalation-file + smell + revise-budget logic, this wraps the one authority:
// diskArtifactProbe(...).pendingEscalation() (orchestrator-probe.ts). DRY – one source of truth.

import { diskArtifactProbe } from "./orchestrator-probe.js";
import type { DriveEscalation, DriveState } from "../workflow/workflow-vocabulary.js";

/**
 * Read the unresolved blocking escalation for a feature from `.consort` (escalation files +
 * blocking smells + the revise-budget classification), or null when there is none. Delegates
 * entirely to the legacy disk probe – the classification of routable (spec smell, budget left
 * -> revise-route) vs terminal (build smell / explicit file / budget spent -> raise-to-hil)
 * lives there, so the manifest path and nextTransition agree by construction.
 *
 * @param consortDir     the workspace's resolved .consort dir.
 * @param featureId    the feature under design.
 * @param buildActive  the story the build lane is on (scopes a story-less smell), if any.
 */
export function deriveEscalation(
  consortDir: string,
  featureId: string,
  buildActive: string | null = null,
): DriveEscalation | null {
  return diskArtifactProbe(consortDir, featureId, buildActive).pendingEscalation();
}

/**
 * Build the DriveState the manifest runner hands to a step's route()/validateAndBound. The
 * runner's design turns run in the "feature" phase; the ONE field that changes the route space
 * is `escalation`, derived from disk here. Everything else stays the minimal stub the runner
 * already used, so with no escalation on disk this is behaviorally identical to the old
 * `{ phase: "feature" }` (plus the explicit empty design fields DriveState requires).
 */
export function probeDriveState(
  consortDir: string,
  featureId: string,
  buildActive: string | null = null,
): DriveState {
  return {
    phase: "feature",
    breakdownDone: true,
    storyOrder: [],
    stories: {},
    buildActive,
    escalation: deriveEscalation(consortDir, featureId, buildActive),
  };
}
