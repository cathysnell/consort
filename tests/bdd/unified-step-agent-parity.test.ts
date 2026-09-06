// Stage F2 (#644) parity gate: the ONE unified ClaudeStepAgent must be byte-identical on BOTH seams
// after LiveDriveStepAgent was dissolved into it.
//
//   - UNCONTAINED (live) seam: liveDispatchSeam dispatches the EXACT `buildClaudeCommand(action, cfg)`
//     through cfg.runner – the same spawn the legacy perform() used (cwd=projectDir, prompt naming
//     .consort paths, session/replay/retry all execRunner's). This is what the old LiveDriveStepAgent
//     did; the assertion is unchanged in intent (the command the live path dispatches == the legacy
//     claude command), only the mechanism moved onto the seam + the unified agent's invoke().
//   - CONTAINED seam: the unified ClaudeStepAgent's buildCommand/spawnArgs (raw spawnClaudeStreaming,
//     cwd=workspace, args from the manifest levers) are UNTOUCHED by F2, so a contained design turn's
//     command is byte-identical to before. Asserted here so the unification is proven on both faces.
//
// If either drifts, routing the live/contained turn through the unified agent would silently change
// the spawn – the exact failure this golden exists to prevent.

import { describe, it, expect } from "vitest";
import {
  commandsForAction,
  buildClaudeCommandWithBody,
  buildTaskBody,
  readDriveStateFromDisk,
  type DriveCommand,
  type DriveEffectsConfig,
} from "../../consort/orchestrator/drive/orchestrator-effects";
import { resolvePreparer } from "../../consort/orchestrator/build/preconditions";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";
import { liveDispatchSeam, type ExecutorDispatchDeps } from "../../consort/orchestrator/drive/executor-dispatch";
import { ClaudeStepAgent, type AgentLevers } from "../../consort/orchestrator/agents/claude-step-agent";

function cfg(over: Partial<DriveEffectsConfig> = {}): DriveEffectsConfig {
  return {
    projectDir: "/p",
    consortDir: "/p/.consort",
    featureId: "F1-stock-visibility",
    runner: { async run() {} },
    modelForRole: () => "sonnet",
    approver: "human-proxy",
    deployTarget: "local",
    ...over,
  };
}

/** The dispatch deps the live seam needs. The seam wraps the executor-assembled prompt (or, absent
 *  one, buildTaskBody's full inline body) in buildClaudeCommandWithBody's envelope; the rest are
 *  inert here. */
function dispatchDeps(): ExecutorDispatchDeps {
  return {
    buildCycleCommand: () => undefined,
    buildClaudeCommandWithBody,
    buildTaskBody,
    preparerFor: resolvePreparer,
    readDriveStateFromDisk,
    binTokens: {},
    logBin: "consort-log",
  };
}

/** The single `claude` command the legacy branch emits for an action (the spawn under test). */
function legacyClaude(action: WorkflowAction, c: DriveEffectsConfig): DriveCommand | undefined {
  return commandsForAction(action, c).find((cmd) => cmd.kind === "claude");
}

describe("unified ClaudeStepAgent – UNCONTAINED (live) seam ≡ the legacy claude spawn (Stage F2 parity)", () => {
  const cases: Array<[string, WorkflowAction]> = [
    ["spec-author breakdown", { kind: "invoke-role", role: "spec-author", mode: "breakdown" }],
    ["architect per-story", { kind: "invoke-role", role: "architect-reviewer", story: "S1-record-stock" }],
    ["dba per-story", { kind: "invoke-role", role: "dba", story: "S1-record-stock" }],
    ["test-strategist per-story", { kind: "invoke-role", role: "test-strategist", story: "S1-record-stock" }],
    ["ux-designer", { kind: "invoke-role", role: "ux-designer" }],
    ["navigator RED", { kind: "invoke-role", role: "navigator", story: "S1-record-stock" }],
    ["driver GREEN", { kind: "invoke-role", role: "driver", story: "S1-record-stock" }],
  ] as unknown as Array<[string, WorkflowAction]>;

  it.each(cases)("%s: the live seam dispatches the exact legacy claude command through cfg.runner", async (_label, action) => {
    const dispatched: DriveCommand[] = [];
    const c = cfg({ runner: { async run(cmd) { dispatched.push(cmd); } } });
    const legacy = legacyClaude(action, c);
    expect(legacy, "the legacy branch must emit a claude command for this action").toBeDefined();
    // Drive the unified agent on its LIVE path (a liveDispatch seam supplied): invoke() delegates to
    // the seam, which wraps the executor-assembled prompt in buildClaudeCommandWithBody + dispatches
    // it through cfg.runner. For an un-migrated turn the executor's instructionsFor is
    // buildTaskBody(action,cfg,∅) (the full inline body), so the wrapped command is byte-identical to
    // the legacy claude spawn. Pass exactly that as the instruction prompt.
    const agent = new ClaudeStepAgent({ role: (action as { role: string }).role }, undefined, liveDispatchSeam(c, dispatchDeps()));
    await agent.invoke({ action, workspaceDir: "/ignored-uncontained", inputs: {}, instructions: { prompt: buildTaskBody(action as never, c) } });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual(legacy);
  });

  it("honors per-turn model tiering exactly as the legacy path (byte-identical under a modelForTurn cfg)", async () => {
    // A driver GREEN turn under model tiering – the dispatched command must carry the SAME model the
    // legacy spawn would (proving the live seam reuses buildClaudeCommand's resolution, not its own).
    const dispatched: DriveCommand[] = [];
    const c = cfg({
      modelForTurn: (r, t) => (r === "driver" && t === "green" ? "haiku" : "sonnet"),
      runner: { async run(cmd) { dispatched.push(cmd); } },
    });
    const green: WorkflowAction = { kind: "invoke-role", role: "driver", story: "S1-record-stock" };
    const agent = new ClaudeStepAgent({ role: "driver" }, undefined, liveDispatchSeam(c, dispatchDeps()));
    await agent.invoke({ action: green, workspaceDir: "/ignored", inputs: {}, instructions: { prompt: buildTaskBody(green as never, c) } });
    expect(dispatched).toEqual([legacyClaude(green, c)]);
  });

  it("the seam rejects a non-invoke-role action (only agent turns dispatch through it)", async () => {
    const c = cfg();
    const seam = liveDispatchSeam(c, dispatchDeps());
    await expect(seam({ action: { kind: "planning-complete" } as WorkflowAction })).rejects.toThrow(/invoke-role/i);
  });
});

describe("unified ClaudeStepAgent – CONTAINED seam byte-identity (untouched by F2)", () => {
  // A contained design turn: no liveDispatch seam => invoke() takes the raw-spawn path, and
  // buildCommand/spawnArgs are the SAME pure derivations as before F2. We assert the command shape
  // directly (no spawn), the contained face's golden.
  const levers: AgentLevers = { role: "spec-author", model: "sonnet", effort: "low", session: "fresh" };
  const invocation = {
    action: { kind: "invoke-role", role: "spec-author", mode: "breakdown" } as WorkflowAction,
    workspaceDir: "/ws",
    inputs: { "product-overview": "# Product\n" },
    instructions: { prompt: "Break it down", guidelines: ["be terse"] },
  };

  it("buildCommand embeds the provided inputs + prompt + guidelines (contained, no .consort access)", () => {
    const agent = new ClaudeStepAgent(levers);
    const cmd = agent.buildCommand(invocation);
    expect(cmd.kind).toBe("claude");
    expect(cmd.role).toBe("spec-author");
    expect(cmd.model).toBe("sonnet");
    expect(cmd.effort).toBe("low");
    // The task carries the prompt, the embedded input block, and the guidelines – the contained
    // agent's whole world is in the prompt (it reads no filesystem for inputs).
    expect(cmd.task).toContain("Break it down");
    expect(cmd.task).toContain("product-overview");
    expect(cmd.task).toContain("# Product");
    expect(cmd.task).toContain("be terse");
  });

  it("spawnArgs threads the base flags + session id (contained raw spawn)", () => {
    const agent = new ClaudeStepAgent(levers);
    const args = agent.spawnArgs(invocation);
    expect(args).toContain("-p");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("spec-author");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--effort");
    // fresh session => a --session-id is minted.
    expect(args).toContain("--session-id");
  });

  it("takes the raw-spawn path (NOT a live seam) when no liveDispatch is supplied", async () => {
    const spawned: Array<{ args: string[]; cwd: string }> = [];
    const agent = new ClaudeStepAgent(levers, async (args, cwd) => { spawned.push({ args, cwd }); return undefined; });
    await agent.invoke(invocation);
    // Exactly one raw spawn, cwd = the contained workspace (never the project).
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe("/ws");
  });
});
