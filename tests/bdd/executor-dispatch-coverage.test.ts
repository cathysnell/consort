// J1 anti-recurrence guard: the executor is now the DEFAULT + sole agent-dispatch path
// (useManifestSteps defaults ON). That is only SAFE if the executor allowlist
// (`executorDispatched`) and the shipped-manifest set are in BIJECTION: every action the
// allowlist claims MUST resolve a shipped manifest (else it would dispatch with no manifest),
// and every shipped manifest's action MUST be allowlisted (else the manifest is unreachable
// via the executor). The `every-manifest-executor-dispatch` matrix proves manifest -> executor;
// this proves the two directions AGREE, so no agent turn can slip to a missing manifest when the
// flag is on. When commandsForAction's agent-spawn arm is deleted (J5), this guard is what keeps
// a newly-allowlisted action from having no dispatch home.

import { describe, it, expect } from "vitest";
import { executorDispatched, deterministicAgentless, assertNotStrandedAgentTurn } from "../../consort/orchestrator/drive/executor-dispatch";
import { SHIPPED_MANIFESTS, manifestForAction, type StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

const STORY = "S1-file-stock";
const AC = "AC1-file-stock-record";

// Reconstruct a representative action from a manifest's `match` (null = "field absent"), adding the
// story/ac the story-scoped roles carry in the real drive , the SAME reconstruction the matrix uses.
const STORY_SCOPED = new Set(["dba", "test-strategist", "driver", "spec-author", "architect-reviewer", "navigator"]);
function actionFromMatch(m: StepManifest): Extract<WorkflowAction, { kind: "invoke-role" }> {
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.match)) {
    if (v === null) continue;
    a[k] = v;
  }
  const hasMode = "mode" in m.match && m.match.mode !== null;
  const hasBuildMode = "buildMode" in m.match && m.match.buildMode !== null;
  if (STORY_SCOPED.has(m.role) && !hasMode && !("story" in a)) a.story = STORY;
  if (hasBuildMode && m.match.buildMode === "assess" && !("ac" in a)) a.ac = AC;
  return a as unknown as Extract<WorkflowAction, { kind: "invoke-role" }>;
}

describe("executor dispatch coverage: allowlist <-> shipped manifests are in bijection", () => {
  it.each(SHIPPED_MANIFESTS.map((m) => [m.id, m] as [string, StepManifest]))(
    "%s: its action is executorDispatched AND resolves a shipped manifest",
    (_id, manifest) => {
      const action = actionFromMatch(manifest);
      // (forward) the allowlist claims this agent action , it will take the executor path.
      expect(executorDispatched(action), `${manifest.id} action must be executorDispatched`).toBe(true);
      // (reverse) the action resolves a shipped manifest , so the executor has one to run. This is
      // what makes flipping useManifestSteps ON safe: no allowlisted action falls through to a
      // missing manifest (and, post-J5, to a deleted commandsForAction agent arm).
      expect(manifestForAction(action), `${manifest.id} action must resolve a shipped manifest`).toBeDefined();
    },
  );

  it("the two non-spawn planning turns stay OFF the executor allowlist (deterministic, no manifest-agent spawn)", () => {
    // author-requests is human-input; estimate-committed re-syncs the backlog. Both are deterministic
    // (commandsForAction / the J5 deterministic helper), never an executor agent spawn.
    const authorRequests = { kind: "invoke-role", role: "product-owner", mode: "author-requests" } as unknown as WorkflowAction;
    const estimateCommitted = { kind: "invoke-role", role: "architect-reviewer", mode: "estimate-committed" } as unknown as WorkflowAction;
    expect(executorDispatched(authorRequests)).toBe(false);
    expect(executorDispatched(estimateCommitted)).toBe(false);
  });

  it("product-owner `intake` is an EXECUTOR-dispatched metered turn (tracked via turn.usage), not agentless", () => {
    // Intake is now a real, metered PO turn: it DRAFTS the intake docs from the human's gathered
    // answers, so it runs through the executor (turn.usage logs its tokens/cost; model from its
    // manifest agentOptions). It is therefore ON the executor allowlist and NOT deterministic-agentless
    // , and the stranded-turn guard is satisfied because it IS executor-dispatched (has a manifest).
    const intake = { kind: "invoke-role", role: "product-owner", mode: "intake" } as unknown as WorkflowAction;
    expect(executorDispatched(intake)).toBe(true);
    expect(deterministicAgentless(intake)).toBe(false);
    expect(() => assertNotStrandedAgentTurn(intake)).not.toThrow();
  });
});
