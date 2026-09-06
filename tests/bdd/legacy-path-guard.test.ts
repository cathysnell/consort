// The hard-stop guard (#732): a real AGENT turn must never run on the legacy commandsForAction path
// (it would skip the executor's recording + validation + routing contract – silent corruption).
// assertNotStrandedAgentTurn throws for an invoke-role action that is neither executor-dispatched
// nor a sanctioned deterministic-agentless action. These guards pin exactly that boundary.

import { describe, it, expect } from "vitest";
import { assertNotStrandedAgentTurn, deterministicAgentless, executorDispatched } from "../../consort/orchestrator/drive/executor-dispatch";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary";

const A = (o: Record<string, unknown>): WorkflowAction => ({ kind: "invoke-role", ...o }) as WorkflowAction;

describe("deterministicAgentless: the sanctioned no-LLM invoke-role actions", () => {
  it("recognizes estimate-committed (and nothing else — author-requests is now a metered turn)", () => {
    expect(deterministicAgentless(A({ role: "architect-reviewer", mode: "estimate-committed" }))).toBe(true);
    // author-requests is NO LONGER deterministic-agentless: it is a metered executor-dispatched PO turn.
    expect(deterministicAgentless(A({ role: "product-owner", mode: "author-requests" }))).toBe(false);
    // a real agent turn is NOT deterministic-agentless
    expect(deterministicAgentless(A({ role: "spec-author", mode: "breakdown" }))).toBe(false);
    expect(deterministicAgentless(A({ role: "navigator", story: "S1" }))).toBe(false);
    expect(deterministicAgentless({ kind: "dispatch", story: "S1" } as WorkflowAction)).toBe(false);
  });
});

describe("assertNotStrandedAgentTurn: hard-stop on an agent turn stranded on legacy", () => {
  it("PASSES (no throw) for an executor-dispatched agent turn", () => {
    const a = A({ role: "spec-author", mode: "breakdown" });
    expect(executorDispatched(a)).toBe(true);
    expect(() => assertNotStrandedAgentTurn(a)).not.toThrow();
  });

  it("PASSES for a sanctioned deterministic-agentless action (estimate-committed) + the metered author-requests turn", () => {
    // estimate-committed is agentless; author-requests now passes because it IS executor-dispatched.
    expect(() => assertNotStrandedAgentTurn(A({ role: "architect-reviewer", mode: "estimate-committed" }))).not.toThrow();
    expect(() => assertNotStrandedAgentTurn(A({ role: "product-owner", mode: "author-requests" }))).not.toThrow();
  });

  it("PASSES for a non-invoke-role deterministic drive action (gate / dispatch / phase transition)", () => {
    expect(() => assertNotStrandedAgentTurn({ kind: "dispatch", story: "S1" } as WorkflowAction)).not.toThrow();
    expect(() => assertNotStrandedAgentTurn({ kind: "planning-complete" } as WorkflowAction)).not.toThrow();
    expect(() => assertNotStrandedAgentTurn({ kind: "set-phase", phase: "deploy" } as unknown as WorkflowAction)).not.toThrow();
  });

  it("THROWS LOUD for a real agent turn that is neither executor-dispatched nor sanctioned", () => {
    // An invoke-role turn with an unknown mode/role: not on the executor allowlist, not agentless.
    // This is the stranded-agent-on-legacy case the guard exists to catch.
    const stranded = A({ role: "spec-author", mode: "totally-unknown-mode" });
    expect(executorDispatched(stranded)).toBe(false);
    expect(deterministicAgentless(stranded)).toBe(false);
    expect(() => assertNotStrandedAgentTurn(stranded)).toThrow(/LEGACY AGENT-PATH GUARD/);
  });

  it("THROWS for an un-storied build turn (navigator with no story – escaped the executor allowlist)", () => {
    const stranded = A({ role: "navigator" }); // no story => executorDispatched false
    expect(executorDispatched(stranded)).toBe(false);
    expect(() => assertNotStrandedAgentTurn(stranded)).toThrow(/must NEVER run on the legacy/);
  });
});
