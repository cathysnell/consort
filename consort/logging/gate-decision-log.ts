// The ONE emitter for HITL gate-decision agent-log events (gate.approved / gate.rejected).
//
// A gate approval is the human's (or the Human Proxy's) decision, and every gate door must log it
// the same way so the observability trail is complete on every run — regardless of WHICH door
// cleared the gate. Before this module the emit lived privately inside human-proxy.ts, so only the
// feature-gate proxy path (deploy/promote/feature-spec) logged an approval; the sprint plan gate
// (approveSprintPlanGate) and the per-story spec gate (approveStoryGateFromDisk) cleared silently.
// On a human-live run that left the dashboard unable to show those gates as PASSED (it had to infer
// approval from a later gate surfacing — see apps/dashboard/app/OrchestratorLane.tsx storyGateStatus).
//
// This is the shared source: human-proxy delegates here, and every human-facing door calls it. Pure
// observability — best-effort, and a logging failure NEVER breaks a gate approval.

import { emitAgentLogEvent, type AgentRole } from "./agent-log.js";

/** A single HITL gate approval, as it should appear in the agent log. `gate` is the gate name
 *  (plan / spec / acceptance / deploy / promote / test_list); `story` scopes a per-story gate;
 *  `role` defaults to product-owner — the human's seat that owns the decision. */
export interface GateApprovalLog {
  consortDir: string;
  gate: string;
  approver: string;
  featureId?: string;
  story?: string;
  /** The artifacts the approval bound (names or hashes), when the door captured them. */
  artifacts?: string[];
  role?: AgentRole;
}

/** A single HITL gate rejection (a hold / refusal), mirroring {@link logGateApproved}. */
export interface GateRejectionLog {
  consortDir: string;
  gate: string;
  approver: string;
  reason: string;
  featureId?: string;
  story?: string;
  role?: AgentRole;
}

/** Emit `gate.approved` for a cleared HITL gate. Best-effort: swallows any logging error so the
 *  approval it records is never jeopardised by observability. */
export function logGateApproved(a: GateApprovalLog): void {
  try {
    emitAgentLogEvent(
      {
        role: a.role ?? "product-owner",
        level: "info",
        event: "gate.approved",
        feature_id: a.featureId,
        slots: {
          gate: a.gate,
          ...(a.story ? { story: a.story } : {}),
          ...(a.artifacts ? { artifacts: a.artifacts } : {}),
          approver: a.approver,
          validated: true,
        },
      },
      { consortDir: a.consortDir },
    );
  } catch {
    // Observability, not a gate. Never let it break approval.
  }
}

/** Emit `gate.rejected` for a held/refused HITL gate. Best-effort, like {@link logGateApproved}. */
export function logGateRejected(a: GateRejectionLog): void {
  try {
    emitAgentLogEvent(
      {
        role: a.role ?? "product-owner",
        level: "warn",
        event: "gate.rejected",
        feature_id: a.featureId,
        slots: {
          gate: a.gate,
          ...(a.story ? { story: a.story } : {}),
          reason: a.reason,
          approver: a.approver,
          validated: false,
        },
      },
      { consortDir: a.consortDir },
    );
  } catch {
    // Observability, not a gate.
  }
}
