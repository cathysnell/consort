// LIVE validation of the FIRST concrete StepContract end to end (gated behind
// RUN_LIVE_STEP=1; not part of the normal suite).
//
//   RUN_LIVE_STEP=1 npx vitest run tests/live/spec-author-step-live.test.ts
//
// It exercises the whole contained design exactly as the orchestrator will drive it:
//   1. INPUTS: the orchestrator reads the 3 PO artifacts and PROVIDES their CONTENTS to
//      the step (the step never resolves .sftdd itself).
//   2. WORKSPACE: the orchestrator PROVISIONS a workspace. Two facts a live run surfaced:
//        (a) the spec-author agent def bakes a `.sftdd/features/<F>/` (cwd-relative) output
//            path, so the workspace must be .sftdd-shaped and the orchestrator DECLARES the
//            step's output path there (outputPaths);
//        (b) the agent runs its self-check + logs via the shared `./scripts/lk` kit scripts,
//            so the orchestrator must PROVIDE them – here by copying scripts/lk in + pointing
//            LAKEBASE_KIT_DIR at the kit (the dev override the shim honors). The prompt then
//            instructs the agent to use them. This is "provide the checker to the agent".
//   3. AGENT: a ClaudeStepAgent built from the levers (role/model/effort/session[+scope/
//      fallback/budget]) – everything to start + manage the agent. Injected into the step.
//   4. RUN + VALIDATE: the step runs the agent contained to the workspace; the orchestrator
//      then runs the output's OWN in-code conformance checker on the produced feature-spec.
//
// Local design turn only – no Lakebase, no GitHub.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeStepAgent } from "../../consort/orchestrator/agents/claude-step-agent.js";
import { Step } from "../../consort/orchestrator/steps/step.js";
import { manifestForAction } from "../../consort/orchestrator/steps/manifest.js";
import { execute, type StepExecutorDeps, type StepCtx } from "../../consort/orchestrator/turns/step-executor.js";
import type { ValidateBoundDeps } from "../../consort/orchestrator/steps/step-contract.js";
import type { DriveState } from "../../consort/orchestrator/drive/orchestrator-drive.js";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive.js";
import { resolveKitSingleSource } from "../integration/live/kit-resolution.js";

const KIT = process.cwd();
const CORPUS = join(KIT, "examples/replay/corpora/stockflow/recorded-artifacts");
const FEATURE = "F1-stock-visibility";
// The agent's baked, cwd-relative output layout – the orchestrator knows + declares it.
const SPEC_REL = `.sftdd/features/${FEATURE}/feature-spec.json`;
const LOG_REL = ".sftdd/agent-log.jsonl";

const BREAKDOWN: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

/** Provision an .sftdd-shaped workspace with the kit scripts provided, read the 3 PO input
 *  CONTENTS, and build the passed-through instruction bundle – exactly what the orchestrator
 *  does before a step runs. Shared by both the direct-step and the executor-path cases. */
function setupLiveBreakdown(): { workspaceDir: string; inputs: Record<string, string>; instructions: { prompt: string; guidelines: string[] } } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "live-step-ws-"));
  mkdirSync(join(workspaceDir, ".sftdd", "features", FEATURE), { recursive: true });
  mkdirSync(join(workspaceDir, ".claude", "agents"), { recursive: true });
  cpSync(join(KIT, "skills/consort/agents/spec-author.md"), join(workspaceDir, ".claude", "agents", "spec-author.md"));
  mkdirSync(join(workspaceDir, "scripts"), { recursive: true });
  const standingProj = join(process.env.HOME ?? "", "code/tdd-workflow-smoke", (process.env.LIVE_STEP_PROJECT ?? ""));
  const lkSrc = existsSync(join(standingProj, "scripts/lk")) ? join(standingProj, "scripts/lk") : join(KIT, "examples/replay/lk");
  if (existsSync(lkSrc)) {
    cpSync(lkSrc, join(workspaceDir, "scripts", "lk"));
    chmodSync(join(workspaceDir, "scripts", "lk"), 0o755);
  }
  resolveKitSingleSource(KIT);

  const inputs: Record<string, string> = {
    "product-overview": existsSync(join(CORPUS, "product-overview.md"))
      ? readFileSync(join(CORPUS, "product-overview.md"), "utf8")
      : "# StockFlow\nAn inventory app: operators record stock by SKU + location and view current levels.\n",
    nfrs: existsSync(join(CORPUS, "nfrs.md"))
      ? readFileSync(join(CORPUS, "nfrs.md"), "utf8")
      : "# NFRs\n## Required\n- R1: existing stock rows survive every additive migration (durability).\n",
    "feature-request": readFileSync(join(CORPUS, "features", FEATURE, "feature-request.md"), "utf8"),
  };

  const instructions = {
    prompt:
      `Break feature ${FEATURE} down into its stories from the provided inputs. WRITE ` +
      `${SPEC_REL} (id, name, status "draft", tdd_mode, NON-EMPTY stories[]) + a stub dir per ` +
      `story under .sftdd/features/${FEATURE}/stories/<S>/ (story.md + story.json). Then run your ` +
      `self-check: ./scripts/lk consort-response-formatter --role spec-author --feature ` +
      `${FEATURE} --tdd-dir .sftdd – and FIX anything it flags before returning. Then log what you ` +
      `did: ./scripts/lk consort-log --role spec-author --level info --event artifact.written ` +
      `--message "<what you wrote>" --tdd-dir .sftdd (use --level warn to surface any ambiguity). ` +
      `Read ONLY the provided inputs.`,
    guidelines: [
      "feature-spec.json is REQUIRED and must have a non-empty stories[].",
      "On every story after the first, story.json must include an independence determination.",
      "The self-check must pass before you return; log at least one spec-author event.",
    ],
  };

  return { workspaceDir, inputs, instructions };
}

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: Step + ClaudeStepAgent produce a conformant feature-spec.json", () => {
  it("drives the breakdown through the StepExecutor (7-phase Template Method) with Step + ClaudeStepAgent", async () => {
    const { workspaceDir, inputs, instructions } = setupLiveBreakdown();

    // The generic step from the shipped manifest + the real lever-built agent – no bespoke class.
    const agent = new ClaudeStepAgent({ role: "spec-author", model: "sonnet", effort: "low", session: "fresh" });
    const step = new Step(manifestForAction(BREAKDOWN)!, agent);

    // The orchestrator-owned seams the executor drives (phases 1/2/3-input/6). Here they
    // hand back the pre-provisioned workspace + input contents the setup produced.
    const validateBoundDeps: ValidateBoundDeps = {
      allowed: () => ({ kind: "design-complete" }) as WorkflowAction,
      reviseBudgetAvailable: () => true,
      recordRetry: () => ({ sanctioned: true }),
    };
    const ctx: StepCtx = {
      action: BREAKDOWN,
      cfg: { projectDir: workspaceDir, consortDir: join(workspaceDir, ".sftdd"), featureId: FEATURE } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps,
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => inputs,
      provisionWorkspace: () => ({ workspaceDir, outputPaths: { "feature-spec": SPEC_REL, "agent-log": LOG_REL } }),
      instructionsFor: () => instructions,
      onRecord: () => {},
    };

    // RUN the whole Template Method live. Phase 5 validates the produced artifact with the
    // output's OWN in-code checker; a clean produce yields the bounded design-complete route.
    const result = await execute(step, ctx, deps);

    expect(result.violations, `executor reported violations: ${result.violations.join("; ")}`).toEqual([]);
    const specPath = join(workspaceDir, SPEC_REL);
    expect(result.producedPaths).toContain(specPath);
    expect(result.bounded.action).toEqual({ kind: "design-complete" });

    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { stories?: string[] };
    expect(Array.isArray(spec.stories) && spec.stories.length >= 1).toBe(true);
  }, 300_000);
});
