// The shared gate-decision emitter (logging/gate-decision-log.ts) and its wiring into the two gate
// doors that used to clear silently — the sprint plan gate (approveSprintPlanGate) and, elsewhere,
// the per-story spec gate. G4b: a human-live run approves gates out-of-band via the CLI, so every
// door must log the decision or the dashboard cannot show the gate as PASSED. Hermetic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logGateApproved, logGateRejected } from "../../consort/logging/gate-decision-log";
import { approveSprintPlanGate } from "../../consort/gates/sprint-gates";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "gate-decision-log-"));
});
afterEach(() => rmSync(tdd, { recursive: true, force: true }));

/** Read every agent-log event written under the temp consort dir. */
function readLog(): Array<Record<string, any>> {
  const log = join(tdd, "agent-log.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("logGateApproved / logGateRejected", () => {
  it("writes a gate.approved event with the gate, approver, and validated flag", () => {
    logGateApproved({ consortDir: tdd, gate: "deploy", approver: "kev", featureId: "F1" });
    const [e] = readLog();
    expect(e.event).toBe("gate.approved");
    expect(e.metadata.feature_id).toBe("F1");
    expect(e.metadata.gate).toBe("deploy");
    expect(e.metadata.approver).toBe("kev");
    expect(e.metadata.validated).toBe(true);
    expect(e.role).toBe("product-owner"); // the human's seat, by default
  });

  it("includes story only when the gate is story-scoped", () => {
    logGateApproved({ consortDir: tdd, gate: "spec", approver: "kev", featureId: "F1", story: "S3" });
    logGateApproved({ consortDir: tdd, gate: "plan", approver: "kev" }); // sprint-level, no story
    const [scoped, sprintLevel] = readLog();
    expect(scoped.metadata.story).toBe("S3");
    expect(sprintLevel.metadata.story).toBeUndefined();
  });

  it("writes a gate.rejected event for a hold/refusal", () => {
    logGateRejected({ consortDir: tdd, gate: "spec", approver: "kev", reason: "AC gap", featureId: "F1" });
    const [e] = readLog();
    expect(e.event).toBe("gate.rejected");
    expect(e.metadata.reason).toBe("AC gap");
    expect(e.metadata.validated).toBe(false);
  });
});

describe("approveSprintPlanGate logs the plan gate approval (G4b)", () => {
  const SPRINT = "sprint-1";
  const PROPOSAL = ["# Sprint 1 backlog", "", "## Proposed features", "- v1 initial domain", ""].join("\n");
  function writeProposal(): void {
    const dir = join(tdd, "planning");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "feature-proposals.md"), PROPOSAL);
  }

  it("emits gate.approved{plan} on a fresh approval", () => {
    writeProposal();
    approveSprintPlanGate({ sprint: SPRINT, approver: "kev", hitlApproved: true, consortDir: tdd });
    const approved = readLog().filter((e) => e.event === "gate.approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].metadata.gate).toBe("plan");
    expect(approved[0].metadata.approver).toBe("kev");
  });

  it("does NOT re-emit on an already-approved (idempotent) re-approval", () => {
    writeProposal();
    approveSprintPlanGate({ sprint: SPRINT, approver: "kev", hitlApproved: true, consortDir: tdd });
    approveSprintPlanGate({ sprint: SPRINT, approver: "kev", hitlApproved: true, consortDir: tdd });
    const approved = readLog().filter((e) => e.event === "gate.approved");
    expect(approved).toHaveLength(1); // only the first, real approval logged
  });
});
