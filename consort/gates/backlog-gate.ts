// The backlog gate: the HITL checkpoint AFTER the Architect sizes the proposals and BEFORE the
// metered Product Owner author-requests turn. The human SELECTS which proposed features enter the
// sprint and commits them; only then does planning advance to authoring each committed
// feature-request.md.
//
// The commit itself is the SELECTION written to sprints/<s>/requested.json (the single membership
// declaration syncBacklog scopes the backlog to) — supplied headless by the Human Proxy (from the
// recorded pairs) or by a human-in-the-loop PO (consort-sync-backlog). backlogCommitted is DERIVED
// from that file (deriveSprintPlanningState), so there is no separate approval marker; this door's
// job is to LOG gate.approved("backlog") so the dashboard + telemetry see the commit, mirroring
// every other gate door via the shared logGateApproved.
//
// Shared by BOTH doors so they behave identically: the human CLI (consort-approve-gate --sprint
// --gate backlog) and, headless, the Human Proxy (consort-human-proxy --sprint --gate backlog, which
// ALSO supplies the recorded requests before logging). Interactive, the drive PARKS at the gate; the
// human commits + the drive advances once requested.json declares the selection.

import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { logGateApproved } from "../../consort/logging/gate-decision-log.js";

/** Approve the backlog gate: log gate.approved("backlog") to the shared agent-log trail, so the
 *  human's sprint-backlog commit is observable exactly like every other gate. The SELECTION itself
 *  (requested.json) is written by the caller/proxy; backlogCommitted is derived from it. `consortDir`
 *  resolves to the project's artifact dir when omitted, matching approveIntakeGate/approveSprintPlanGate. */
export function approveBacklogGate(consortDir: string | undefined, approver: string): void {
  const dir = consortDir ?? resolveConsortDir();
  logGateApproved({ consortDir: dir, gate: "backlog", approver });
}
