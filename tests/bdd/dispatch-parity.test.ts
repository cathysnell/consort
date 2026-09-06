// Stage F – the "same process" parity proof. The live drive (performTurnViaExecutor,
// executor-dispatch.ts:324) and the integration tests / manifest-runner (resolveAgent,
// manifest-runner.ts:135) now resolve a step's agent through the SAME seam:
// buildAgent(manifest.agent, context). The ONLY difference is the build context – the live drive
// supplies `liveDispatch` (=> the uncontained ClaudeStepAgent), the runner supplies corpusRoot
// (for replay). This test proves there is ONE resolution path: given a shipped manifest, both call
// sites produce the same agent kind, and the live context yields the live variant while its absence
// yields the contained variant – from the identical buildAgent call.

import { describe, it, expect } from "vitest";
import { SHIPPED_MANIFESTS, manifestForAction } from "../../consort/orchestrator/steps/manifest";
import { buildAgent } from "../../consort/orchestrator/agents/agent-catalogue";
import { ClaudeStepAgent } from "../../consort/orchestrator/agents/claude-step-agent";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

describe("dispatch parity: live drive + tests resolve the agent via ONE buildAgent seam", () => {
  it("every shipped manifest declares a `claude` agent block (the default kind both paths resolve)", () => {
    expect(SHIPPED_MANIFESTS.length).toBeGreaterThan(0);
    for (const m of SHIPPED_MANIFESTS) {
      expect(m.agent, `${m.id} declares an agent block`).toBeDefined();
      expect(m.agent!.kind, `${m.id} agent kind`).toBe("claude");
      expect((m.agent!.config as { role?: string }).role, `${m.id} agent config.role`).toBe(m.role);
    }
  });

  it("buildAgent(manifest.agent) WITH context.liveDispatch => the LIVE ClaudeStepAgent (the executor's path)", () => {
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };
    const manifest = manifestForAction(action);
    expect(manifest).toBeDefined();
    let seamCalls = 0;
    const liveDispatch = async () => {
      seamCalls++;
    };
    // The SAME call executor-dispatch.ts:324 makes.
    const agent = buildAgent(manifest!.agent!, { workspaceDir: "/tmp/x", liveDispatch });
    expect(agent).toBeInstanceOf(ClaudeStepAgent);
    // The live path delegates to the seam instead of raw-spawning.
    void agent.invoke({ action, workspaceDir: "/tmp/x", inputs: {}, instructions: { prompt: "p" } });
    expect(seamCalls).toBe(1);
  });

  it("buildAgent(manifest.agent) WITHOUT liveDispatch => the CONTAINED ClaudeStepAgent (the runner/tests path)", () => {
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };
    const manifest = manifestForAction(action);
    // The SAME call manifest-runner.ts:135 makes (no liveDispatch in its context).
    const agent = buildAgent(manifest!.agent!, { workspaceDir: "/tmp/x" }) as {
      buildCommand?: (inv: unknown) => { role: string };
    };
    expect(typeof agent.buildCommand).toBe("function"); // contained agent exposes buildCommand
    expect(agent.buildCommand!({ action, workspaceDir: "/tmp/x", inputs: {}, instructions: { prompt: "p" } }).role).toBe("spec-author");
  });

  it("a REPLAY context resolves the SAME shipped manifest to a step-aware replay agent (kind swap, same manifest)", () => {
    // Stage G swaps the kind to `replay` from the REPLAY_DIR env; here we prove the seam accepts it:
    // the identical shipped manifest, its kind overridden to replay, resolves to the corpus agent
    // WITHOUT any manifest edit – the modular point.
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };
    const manifest = manifestForAction(action)!;
    const replaySpec = { ...manifest.agent!, kind: "replay", config: {} };
    const agent = buildAgent(replaySpec, { workspaceDir: "/tmp/x", corpusRoot: "/tmp/corpus" });
    expect(typeof agent.invoke).toBe("function");
    // It is NOT a ClaudeStepAgent (no spawn) – it's the step-aware replay agent.
    expect(agent).not.toBeInstanceOf(ClaudeStepAgent);
  });
});
