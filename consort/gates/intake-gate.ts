// The intake gate: the HITL checkpoint AFTER the Product Owner drafts the project intake
// (product-overview.md / nfrs.md / design-brief.md) and BEFORE the Spec Author proposes from it.
// The human reviews / edits / requests changes, then approves; only then does planning advance.
//
// Approval is recorded by a simple marker (`.consort/intake/approved`) rather than the gates.json /
// sprint-gates model, because the intake docs are project-level (not per-feature, not per-sprint):
// the marker's presence is the single source of "intake approved". Its emit mirrors every other gate
// door via the shared logGateApproved, so the dashboard + telemetry see gate.approved("intake").
//
// Shared by BOTH doors so they behave identically: the human CLI (consort-approve-gate --gate intake)
// and, headless, the Human Proxy (the drive PERFORMS the gate by calling consort-human-proxy --gate
// intake). Interactive, the drive PARKS at the gate; the human runs the CLI; the marker advances it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { intakeApprovedMarker, resolveConsortDir } from "../../consort/config/consort-paths.js";
import { logGateApproved } from "../../consort/logging/gate-decision-log.js";

/** Approve the intake gate: write the approval marker (so the drive advances past the gate to the
 *  Spec Author's propose) and log gate.approved("intake") to the shared agent-log trail. Idempotent
 *  (re-writing the marker is harmless). `consortDir` resolves to the project's artifact dir when
 *  omitted, matching approveSprintPlanGate so both gate doors accept an unset --consort-dir. */
export function approveIntakeGate(consortDir: string | undefined, approver: string): void {
  const dir = consortDir ?? resolveConsortDir();
  const marker = intakeApprovedMarker(dir);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()} approved-by:${approver}\n`);
  logGateApproved({ consortDir: dir, gate: "intake", approver });
}
