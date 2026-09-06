// Handoff mapping – the pure functions that map a drive WorkflowAction to the champion walk's
// HandoffPlan unit and classify a handoff as a build vs design turn. These are shared by BOTH the
// optimize.cli bin AND optimize-live.ts, so they live in a lib here (not in the bin): a library must
// never import a value from a bin, and both consumers import these DOWN from this module.

import type { WorkflowAction } from "../orchestrator/drive/orchestrator-drive.js";
import type { HandoffPlan } from "./optimize-harness.js";

/** Map a drive action to a HandoffPlan (the champion walk's unit), or null when
 *  the action is not an optimizable role turn (a gate / project-notes / dispatch
 *  step the walk skips). The id is deterministic + filesystem-safe so it names the
 *  experiments/ subdir + the report row. */
export function actionToHandoffPlan(action: WorkflowAction): HandoffPlan | null {
  if (action.kind !== "invoke-role") return null;
  const role = action.role;
  const story = "story" in action ? action.story : undefined;
  const buildMode = "buildMode" in action ? action.buildMode : undefined;

  // Build turns: driver's plain turn is GREEN (no explicit buildMode); navigator's
  // plain turn is RED. A carried buildMode (review/refactor/...) names itself.
  // The `action` is carried so the walk runs THIS pinned turn (never re-plans).
  if (role === "driver" || role === "navigator") {
    const mode = buildMode ?? (role === "driver" ? "green" : "red");
    return { id: `${story}-${role}-${mode}`, role, story, buildMode: mode, action };
  }

  // Design turns: story-scoped roles carry a story; feature-scoped (ux-designer)
  // + planning-mode turns do not.
  const idParts = [story, role].filter(Boolean);
  return { id: idParts.join("-"), role, story, action };
}

/** Whether a handoff plan is a BUILD turn (navigator/driver with a buildMode). */
export function isBuildHandoff(plan: HandoffPlan): boolean {
  return (plan.role === "driver" || plan.role === "navigator") && !!plan.buildMode;
}
