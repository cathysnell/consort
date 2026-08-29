#!/usr/bin/env node
import { W as WorkflowAction } from '../../workflow-vocabulary-Ch8LHLiD.cjs';

/** Compose the interactive pause message for the planning `author-requests` step.
 *  NOTHING has been approved/committed, so this must never read as "complete".
 *  But the human's ACTION depends on disk state, and conflating the two is what
 *  makes this pause look like the orchestrator is "confused":
 *   - No `feature-request.md` yet   -> author them, then commit the backlog.
 *   - Requests ALREADY authored (staged first-project, or a prior propose turn)
 *     -> there is nothing to author; the human only COMMITS which of the existing
 *     requests are in this sprint. We branch on the real state and name the exact
 *     commit command (pre-filling the proposed features when planning proposed a
 *     set), so a pre-seeded backlog is never mislabeled as "author the requests".
 *  Pure (returns the string) so the branching is unit-testable off a fixture dir. */
declare function composeInputPause(action: WorkflowAction, sprint?: string, consortDir?: string): string;

export { composeInputPause };
