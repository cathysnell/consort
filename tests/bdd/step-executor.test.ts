// StepExecutor: the ONE standard step-execution process (Template Method). It runs a FIXED,
// no-exception 7-phase sequence for EVERY step:
//   1 resolve-inputs (fail loud, before any spawn)  2 provision-workspace
//   3 dispatch-agent (wait + monitor)  4 capture-outputs  5 validate-outputs (in-code
//   checkers)  6 record/log  7 route (validateAndBound)
// The phase ORDER + the fail-loud input gate + containment + validateAndBound authority are
// the orchestrator-owned invariant; the StepContract/manifest/registry fill the hooks. This
// slice drives it hermetically with a MOCK agent (via Step) + mock deps: assert the
// order, the fail-loud missing input (no spawn), a checker reject -> violations, and
// route -> BoundedRoute. The monitor is unit-tested separately (turn-monitor.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execute } from "../../consort/orchestrator/turns/step-executor";
import type { StepExecutorDeps, StepCtx } from "../../consort/orchestrator/turns/step-executor";
import { Step } from "../../consort/orchestrator/steps/step";
import { manifestForAction } from "../../consort/orchestrator/steps/manifest";
import type { StepAgent, AgentInvocation } from "../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction, DriveState } from "../../consort/orchestrator/drive/orchestrator-drive";
import type { ValidateBoundDeps } from "../../consort/orchestrator/steps/step-contract";

let root: string;
const BREAKDOWN: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

const GOOD_SPEC = JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: ["S1-a"] }) + "\n";
const GOOD_LOG = JSON.stringify({
  timestamp: "2026-08-03T12:00:00Z", level: "info", role: "spec-author",
  event: "artifact.written", message: "wrote feature-spec.json",
}) + "\n";

/** Records the phase-visible calls in order so the test can assert the Template Method. */
function harness(opts: { writeSpec?: boolean; writeLog?: boolean; badSpec?: boolean } = {}) {
  const order: string[] = [];
  const seen: AgentInvocation[] = [];

  const agent: StepAgent = {
    async invoke(invocation) {
      order.push("dispatch-agent");
      seen.push(invocation);
      if (opts.writeSpec !== false) {
        writeFileSync(join(invocation.workspaceDir, "feature-spec.json"), opts.badSpec
          ? JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: [] })
          : GOOD_SPEC);
      }
      if (opts.writeLog !== false) {
        writeFileSync(join(invocation.workspaceDir, "agent-log.jsonl"), GOOD_LOG);
      }
    },
  };

  const step = new Step(manifestForAction(BREAKDOWN)!, agent);

  const validateBoundDeps: ValidateBoundDeps = {
    allowed: () => ({ kind: "design-complete" }) as WorkflowAction,
    reviseBudgetAvailable: () => true,
    recordRetry: () => ({ sanctioned: true }),
  };

  const ctx: StepCtx = {
    action: BREAKDOWN,
    cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
    state: { phase: "feature" } as unknown as DriveState,
    validateBoundDeps,
  };

  const deps: StepExecutorDeps = {
    resolveInputs: vi.fn(() => {
      order.push("resolve-inputs");
      return {
        "product-overview": "# Overview\n",
        nfrs: "# NFRs\n",
        "feature-request": "# Request\n",
      };
    }),
    provisionWorkspace: vi.fn((_action) => {
      order.push("provision-workspace");
      return { workspaceDir: root, outputPaths: {} };
    }),
    instructionsFor: () => ({ prompt: "Break F1 into stories" }),
    onRecord: vi.fn(() => {
      order.push("record/log");
    }),
  };

  return { step, ctx, deps, order, seen };
}

/** A step whose contract declares preconditions, for the PREPARE-PRECONDITIONS phase. */
function preconditionStep(pre: import("../../consort/orchestrator/steps/step-contract").StepPrecondition[]) {
  return {
    inputs: () => [],
    preconditions: () => pre,
    postTurn: () => [],
    agentOptions: () => ({ session: "fresh" as const }),
    raises: () => [],
    requiresEvents: () => [],
    outputs: () => [],
    route: () => ({ outcome: "produced" as const, proposedNext: { kind: "design-complete" } as WorkflowAction }),
    async run() {
      return { produced: true, producedPaths: [] };
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "step-exec-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("StepExecutor: the fixed 7-phase Template Method", () => {
  it("runs the phases in the fixed order and returns a BoundedRoute on a clean produce", async () => {
    const { step, ctx, deps, order, seen } = harness();
    const result = await execute(step, ctx, deps);

    // Phase order is the invariant.
    expect(order).toEqual([
      "resolve-inputs",
      "provision-workspace",
      "dispatch-agent",
      "record/log",
    ]);
    // Contained dispatch: the agent got exactly the resolved inputs + workspace.
    expect(seen).toHaveLength(1);
    expect(seen[0].workspaceDir).toBe(root);
    expect(seen[0].inputs["product-overview"]).toBe("# Overview\n");

    // capture + validate passed => no violations, produced paths recorded, route bounded.
    expect(result.violations).toEqual([]);
    expect(result.producedPaths).toEqual([join(root, "feature-spec.json"), join(root, "agent-log.jsonl")]);
    expect(result.bounded.action).toEqual({ kind: "design-complete" });
  });

  it("FAILS LOUD in phase 1 when an input is missing – NO agent spawn, NO workspace provisioned", async () => {
    const { step, ctx, deps, order, seen } = harness();
    (deps.resolveInputs as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("resolve-inputs");
      return { missing: "feature-request" };
    });

    await expect(execute(step, ctx, deps)).rejects.toThrow(/feature-request|missing input/i);
    // The gate is BEFORE provision + dispatch.
    expect(order).toEqual(["resolve-inputs"]);
    expect(seen).toHaveLength(0);
    expect(deps.provisionWorkspace).not.toHaveBeenCalled();
  });

  it("phase 5 (validate-outputs) HARD-REJECTS a nonconformant output with named violations, no agent follow-up", async () => {
    const { step, ctx, deps } = harness({ badSpec: true });
    const result = await execute(step, ctx, deps);
    expect(result.violations.join(" ")).toMatch(/stories/i);
    // A rejected output routes blocked (retry) – not a clean produce.
    expect(result.bounded.action).toEqual(BREAKDOWN); // blocked => re-issue the same step
    expect(result.bounded.sanctionedRetry).toBe(true);
  });

  it("phase 4/5: a missing produced artifact is a produce failure that routes blocked", async () => {
    const { step, ctx, deps } = harness({ writeSpec: false });
    const result = await execute(step, ctx, deps);
    expect(result.violations.join(" ")).toMatch(/feature-spec|not produced|missing/i);
    expect(result.bounded.action).toEqual(BREAKDOWN);
  });
});

describe("phase 2.5 PREPARE-PRECONDITIONS: declared preconditions are prepared + appended before dispatch", () => {
  function ctxFor(): StepCtx {
    const validateBoundDeps: ValidateBoundDeps = {
      allowed: () => ({ kind: "design-complete" }) as WorkflowAction,
      reviseBudgetAvailable: () => true,
      recordRetry: () => ({ sanctioned: true }),
    };
    return {
      action: BREAKDOWN,
      cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps,
    };
  }

  it("runs BETWEEN provision-workspace and dispatch-agent, and appends each prepared block to the prompt", async () => {
    const order: string[] = [];
    let dispatched = "";
    const step = {
      ...preconditionStep([{ id: "context-pack", kind: "context-pack", description: "the pack" }]),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        order.push("dispatch-agent");
        dispatched = provided.instructions.prompt;
        return { produced: true, producedPaths: [] };
      },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => { order.push("resolve-inputs"); return {}; },
      provisionWorkspace: () => { order.push("provision-workspace"); return { workspaceDir: root }; },
      instructionsFor: () => ({ prompt: "REVIEW story S1." }),
      prepare: (kind) => { order.push(`prepare:${kind}`); return " LAYOUT (place/judge code) :: service=app/services."; },
    };
    await execute(step, ctxFor(), deps);
    expect(order).toEqual(["resolve-inputs", "provision-workspace", "prepare:context-pack", "dispatch-agent"]);
    // The prepared block is appended to the instruction prompt the agent receives.
    expect(dispatched).toBe("REVIEW story S1. LAYOUT (place/judge code) :: service=app/services.");
  });

  it("WARNS (never fails) when a declared preparer yields empty – the 'always something' anomaly", async () => {
    const warnings: string[] = [];
    const step = preconditionStep([{ id: "context-pack", kind: "context-pack", description: "the pack" }]);
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "GREEN story S1." }),
      prepare: () => "", // preparer degraded to empty (e.g. conventions.json absent)
      onWarn: (w) => warnings.push(w),
    };
    const result = await execute(step, ctxFor(), deps);
    // The turn still runs (empty is a degrade, never a hard fail) but the anomaly is surfaced.
    expect(result.violations).toEqual([]);
    expect(warnings.some((w) => /context-pack/.test(w) && /empty/i.test(w))).toBe(true);
  });

  it("a step with NO declared preconditions never calls prepare + never warns (affirmative nothing)", async () => {
    let prepareCalls = 0;
    const warnings: string[] = [];
    const step = preconditionStep([]);
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "plain" }),
      prepare: () => { prepareCalls++; return "x"; },
      onWarn: (w) => warnings.push(w),
    };
    await execute(step, ctxFor(), deps);
    expect(prepareCalls).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("is byte-identical when the executor has NO prepare dep (default track): preconditions ignored", async () => {
    // A declared precondition with no prepare dep wired is a no-op (the default executor
    // path, used by tests + the current manifest runner, stays unchanged).
    let dispatched = "";
    const step = {
      ...preconditionStep([{ id: "context-pack", kind: "context-pack", description: "x" }]),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        dispatched = provided.instructions.prompt;
        return { produced: true, producedPaths: [] };
      },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "unchanged" }),
    };
    await execute(step, ctxFor(), deps);
    expect(dispatched).toBe("unchanged");
  });

  // POSITION-AWARE injection (A-full Stage F): a precondition rides BEFORE ("prepend") or AFTER
  // ("append", the default) the base prompt – so the executor-assembled prompt is byte-identical to
  // the legacy inline positioning (context-pack appended; green-failure advisory prepended).
  it("a PREPEND precondition rides BEFORE the base prompt (the assess-advisory position)", async () => {
    let dispatched = "";
    const step = {
      ...preconditionStep([{ id: "green-failure-advisory", kind: "green-failure-advisory", description: "adv", position: "prepend" as const }]),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        dispatched = provided.instructions.prompt; return { produced: true, producedPaths: [] };
      },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "ASSESS the failed GREEN." }),
      prepare: () => "ADVISORY (start here). ",
    };
    await execute(step, ctxFor(), deps);
    expect(dispatched).toBe("ADVISORY (start here). ASSESS the failed GREEN.");
  });

  it("PREPEND + APPEND compose in position (prepend before, append after, base in the middle)", async () => {
    let dispatched = "";
    const step = {
      ...preconditionStep([
        { id: "green-failure-advisory", kind: "green-failure-advisory", description: "adv", position: "prepend" as const },
        { id: "context-pack", kind: "context-pack", description: "pack", position: "append" as const },
      ]),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        dispatched = provided.instructions.prompt; return { produced: true, producedPaths: [] };
      },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "DO THE THING." }),
      prepare: (kind) => (kind === "green-failure-advisory" ? "ADV. " : " PACK."),
    };
    await execute(step, ctxFor(), deps);
    expect(dispatched).toBe("ADV. DO THE THING. PACK.");
  });
});

// OPTIONAL OUTPUTS (A-full Stage F): a self-heal turn legitimately may produce NO artifact (it
// escalates). An optional output ABSENT is a clean pass; PRESENT-but-nonconformant is a hard reject;
// a REQUIRED output absent still blocks. This is the ONE contract gap that kept the assess/self-heal
// turns off the executor.
describe("optional outputs: absent-optional passes, present-nonconformant fails, required-absent blocks", () => {
  const okValidate = () => ({ ok: true as const, violations: [] as string[] });
  const rejectValidate = () => ({ ok: false as const, violations: ["marker malformed"] as string[] });
  const action: WorkflowAction = { kind: "invoke-role", role: "navigator", story: "S1-x", buildMode: "assess" } as WorkflowAction;

  function ctxFor(): StepCtx {
    return {
      action,
      cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: {
        allowed: () => ({ kind: "state-derived" }) as unknown as WorkflowAction,
        reviseBudgetAvailable: () => true,
        recordRetry: () => ({ sanctioned: true }),
      },
    };
  }

  /** A step whose SOLE declared output is an optional marker; run() writes it only when `writeMarker`. */
  function assessLikeStep(writeMarker: boolean, validate: import("../../consort/orchestrator/steps/step-contract").OutputValidator = okValidate) {
    return {
      inputs: () => [],
      preconditions: () => [],
      postTurn: () => [],
      agentOptions: () => ({ session: "fresh" as const }),
      raises: () => [],
      requiresEvents: () => [],
      outputs: () => [{ id: "assess-marker", description: "the marker", filename: "marker.json", channel: "meta" as const, optional: true, validate }],
      route: () => ({ outcome: "produced" as const, proposedNext: { kind: "state-derived" } as unknown as WorkflowAction }),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        if (writeMarker) writeFileSync(join(provided.workspaceDir, "marker.json"), JSON.stringify({ superseded: [] }) + "\n");
        // The turn "produced" its work either way (escalation is a legitimate produce with no file).
        return { produced: true, producedPaths: writeMarker ? [join(provided.workspaceDir, "marker.json")] : [] };
      },
    };
  }

  const deps = (): StepExecutorDeps => ({
    resolveInputs: () => ({}),
    provisionWorkspace: () => ({ workspaceDir: root }),
    instructionsFor: () => ({ prompt: "assess" }),
  });

  it("an ABSENT optional output is a clean PASS (the escalate-with-no-marker route)", async () => {
    const result = await execute(assessLikeStep(false), ctxFor(), deps());
    expect(result.violations).toEqual([]);
    // Clean produce => it routes forward (not blocked), so the escalation path is preserved.
    expect(result.bounded.action).not.toEqual(action);
  });

  it("a PRESENT optional output still runs its validator – a malformed marker is a hard reject", async () => {
    const result = await execute(assessLikeStep(true, rejectValidate), ctxFor(), deps());
    expect(result.violations.join(" ")).toMatch(/marker malformed/);
  });

  it("a PRESENT + conformant optional output passes", async () => {
    const result = await execute(assessLikeStep(true), ctxFor(), deps());
    expect(result.violations).toEqual([]);
  });

  it("a REQUIRED output (optional absent) that never appears STILL blocks – the design-lane default", async () => {
    const step = {
      ...assessLikeStep(false),
      outputs: () => [{ id: "spec", description: "required", filename: "missing.json", channel: "meta" as const, validate: okValidate }],
    };
    const result = await execute(step, ctxFor(), deps());
    // No `optional` => a required output; run() wrote nothing => the primary is absent => blocked.
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.bounded.action).toEqual(action); // blocked => re-issue the same step
  });

  // Regression guard for the SYSTEMIC navigator-review PROTOCOL VIOLATION (live occurrences #1/#2/#3):
  // navigator-review declares ZERO outputs – its result is the `review-verdict` EVENT (raised + handled
  // by the postTurn cycle CLI), NOT a workspace artifact. A clean "looks good" review writes no file, so
  // run() reports produced:false. The old guard only spared an OPTIONAL primary (needs outputs.length>0),
  // so a zero-output turn fell through to a FALSE "primary output not produced" violation -> blocked ->
  // its verdict-writing postTurn is gated behind the block -> retry -> identical -> abort. This asserts a
  // zero-output turn with produced:false is a CLEAN PASS that routes FORWARD, never blocked.
  it("a ZERO-OUTPUT turn with produced:false is a clean PASS, NOT blocked (the review looks-good route)", async () => {
    const reviewLikeStep = {
      ...assessLikeStep(false),
      outputs: () => [], // the review turn declares no workspace output; its result is the review-verdict EVENT
      async run() {
        // A "looks good" review writes no file – exactly the case that dead-locked the sprint.
        return { produced: false as const, producedPaths: [] as string[] };
      },
    };
    const result = await execute(reviewLikeStep, ctxFor(), deps());
    expect(result.violations).toEqual([]); // no false "primary output not produced" violation
    expect(result.bounded.action).not.toEqual(action); // routes FORWARD, not a blocked re-issue
  });

  // The TRUE root cause of the systemic navigator-review PROTOCOL VIOLATION (occurrences #1-#4): the
  // review manifest declares a REQUIRED input (acs) + an OPTIONAL input (code, the project tree).
  // resolveInputs correctly SKIPS the optional-absent `code` on the live lane, so it is NOT in the
  // inputs map. ManifestStep.run's own presence re-check must ALSO honor `optional` – otherwise it
  // returns {produced:false, missingInput:"code"} BEFORE the agent spawns (confirmed live: no TURN
  // START), phase 5 flags `missing input "code"`, and the turn blocks->retries->aborts. This asserts
  // that a ManifestStep whose optional input is absent from the resolved map runs the agent + passes.
  it("ManifestStep.run does NOT fail on an OPTIONAL input absent from the resolved map (review's `code`)", async () => {
    const { Step } = await import("../../consort/orchestrator/steps/step");
    let spawned = false;
    const agent = { invoke: async () => { spawned = true; } };
    const manifest = {
      id: "navigator-review-like",
      role: "navigator",
      match: { kind: "invoke-role" as const, role: "navigator", buildMode: "review" },
      inputs: [
        { id: "code", source: "story:code", optional: true, description: "project tree (optional)" },
        { id: "acs", source: "story:acs", description: "required ACs" },
      ],
      outputs: [],
      routing: { produced: { next: "state-derived" as const } },
      agent: { kind: "claude" as const, config: { role: "navigator" } },
    };
    const step = new Step(manifest as never, agent as never, () => true);
    // resolveInputs on the live lane skips optional-absent `code`, so ONLY `acs` is in the map.
    const res = await step.run({
      action: manifest.match as unknown as WorkflowAction,
      workspaceDir: root,
      inputs: { acs: "" }, // `code` deliberately ABSENT (the optional-skip case)
      instructions: { prompt: "REVIEW" },
    } as never);
    expect(spawned, "the agent MUST spawn – the optional-absent `code` must not short-circuit run()").toBe(true);
    expect((res as { produced: boolean }).produced, "zero-output review PRODUCES by completing").toBe(true);
    expect((res as { missingInput?: string }).missingInput, "no missingInput on an optional-absent input").toBeUndefined();
  });
});

describe("phases 2.7/6.5 PRE/POST-TURN EFFECTS: the Template Method's expanded deterministic-CLI phases", () => {
  function ctxFor(): StepCtx {
    return {
      action: BREAKDOWN,
      cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: {
        allowed: () => ({ kind: "design-complete" }) as WorkflowAction,
        reviseBudgetAvailable: () => true,
        recordRetry: () => ({ sanctioned: true }),
      },
    };
  }

  it("runs pre-turn-effects BEFORE dispatch and post-turn-effects AFTER record, on a clean produce", async () => {
    const order: string[] = [];
    const step = {
      inputs: () => [],
      preconditions: () => [],
      postTurn: () => [],
      agentOptions: () => ({ session: "fresh" as const }),
      raises: () => [],
      requiresEvents: () => [],
      outputs: () => [],
      route: () => ({ outcome: "produced" as const, proposedNext: { kind: "design-complete" } as WorkflowAction }),
      async run() { order.push("dispatch"); return { produced: true, producedPaths: [] }; },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "breakdown" }),
      preTurnEffects: async () => { order.push("pre-turn"); },
      onRecord: () => { order.push("record"); },
      postTurnEffects: async () => { order.push("post-turn"); },
    };
    await execute(step, ctxFor(), deps);
    // pre-turn before the agent; post-turn after the record (mirrors legacy before/after CLIs).
    expect(order).toEqual(["pre-turn", "dispatch", "record", "post-turn"]);
  });

  it("SKIPS post-turn-effects when validation failed (no downstream projection off a bad artifact)", async () => {
    let postRan = false;
    let preRan = false;
    // A step whose declared output never appears => a violation (blocked), so post-turn must NOT fire.
    const step = {
      inputs: () => [],
      preconditions: () => [],
      postTurn: () => [],
      agentOptions: () => ({ session: "fresh" as const }),
      raises: () => [],
      requiresEvents: () => [],
      outputs: () => [{ id: "spec", description: "x", filename: "missing.json", validate: () => ({ ok: true as const, violations: [] as string[] }) }],
      route: () => ({ outcome: "produced" as const, proposedNext: { kind: "design-complete" } as WorkflowAction }),
      async run() { return { produced: true, producedPaths: [] }; }, // claims produced but writes nothing
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "breakdown" }),
      preTurnEffects: async () => { preRan = true; },
      postTurnEffects: async () => { postRan = true; },
    };
    const result = await execute(step, ctxFor(), deps);
    expect(result.violations.length).toBeGreaterThan(0); // the missing declared output blocked it
    expect(preRan).toBe(true);   // pre-turn always runs (it precedes the agent)
    expect(postRan).toBe(false); // post-turn gated on clean validation
  });

  it("byte-identical when NO effect deps are wired (the default 7-phase path)", async () => {
    let dispatched = false;
    const step = {
      inputs: () => [],
      preconditions: () => [],
      postTurn: () => [],
      agentOptions: () => ({ session: "fresh" as const }),
      raises: () => [],
      requiresEvents: () => [],
      outputs: () => [],
      route: () => ({ outcome: "produced" as const, proposedNext: { kind: "design-complete" } as WorkflowAction }),
      async run() { dispatched = true; return { produced: true, producedPaths: [] }; },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt: "plain" }),
    };
    const result = await execute(step, ctxFor(), deps);
    expect(dispatched).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("three-channel outputs: product->workspace, artifact->artifactDir, meta->metaDir", () => {
  const okValidate = () => ({ ok: true as const, violations: [] as string[] });
  const action: WorkflowAction = { kind: "invoke-role", role: "driver", story: "S1-x" } as WorkflowAction;

  function ctxFor(): StepCtx {
    return {
      action,
      cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: {
        allowed: () => ({ kind: "state-derived" }) as unknown as WorkflowAction,
        reviseBudgetAvailable: () => true,
        recordRetry: () => ({ sanctioned: true }),
      },
    };
  }

  /** A step declaring one output per channel; run() writes each into the root the provided run
   *  resolves for its channel (product->workspaceDir, artifact->artifactDir??ws, meta->metaDir??ws). */
  function channelStep() {
    const outputs = [
      { id: "code", description: "product artifact", filename: "code.txt", channel: "product" as const, validate: okValidate },
      { id: "spec", description: "design doc", filename: "feature-spec.json", channel: "artifact" as const, validate: okValidate },
      { id: "marker", description: "meta artifact", filename: "marker.json", channel: "meta" as const, validate: okValidate },
    ];
    return {
      inputs: () => [],
      preconditions: () => [],
      postTurn: () => [],
      agentOptions: () => ({ session: "fresh" as const }),
      raises: () => [],
      requiresEvents: () => [],
      outputs: () => outputs,
      route: () => ({ outcome: "produced" as const, proposedNext: { kind: "state-derived" } as unknown as WorkflowAction }),
      async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
        const productRoot = provided.workspaceDir;
        const artifactRoot = provided.artifactDir ?? provided.workspaceDir;
        const metaRoot = provided.metaDir ?? provided.workspaceDir;
        writeFileSync(join(productRoot, "code.txt"), "print('hi')\n");
        writeFileSync(join(artifactRoot, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }) + "\n");
        writeFileSync(join(metaRoot, "marker.json"), JSON.stringify({ superseded: [] }) + "\n");
        return { produced: true, producedPaths: [join(productRoot, "code.txt"), join(artifactRoot, "feature-spec.json"), join(metaRoot, "marker.json")] };
      },
    };
  }

  it("validates each output under its OWN channel root (product/artifact/meta land in 3 dirs)", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "step-exec-art-"));
    const metaDir = mkdtempSync(join(tmpdir(), "step-exec-meta-"));
    try {
      const deps: StepExecutorDeps = {
        resolveInputs: () => ({}),
        provisionWorkspace: () => ({ workspaceDir: root, artifactDir, metaDir }),
        instructionsFor: () => ({ prompt: "build S1" }),
      };
      const result = await execute(channelStep(), ctxFor(), deps);
      expect(result.violations).toEqual([]);
      // Each artifact landed in ITS root – and NOT leaked into the product workspace.
      expect(existsSync(join(root, "code.txt"))).toBe(true);
      expect(existsSync(join(artifactDir, "feature-spec.json"))).toBe(true);
      expect(existsSync(join(metaDir, "marker.json"))).toBe(true);
      expect(existsSync(join(root, "feature-spec.json"))).toBe(false);
      expect(existsSync(join(root, "marker.json"))).toBe(false);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      rmSync(metaDir, { recursive: true, force: true });
    }
  });

  it("back-compat: with NO artifactDir/metaDir provisioned, every channel falls back to workspaceDir", async () => {
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}),
      provisionWorkspace: () => ({ workspaceDir: root }), // single root
      instructionsFor: () => ({ prompt: "build S1" }),
    };
    const result = await execute(channelStep(), ctxFor(), deps);
    // All three outputs resolved under the workspace – byte-identical to the pre-channel behavior.
    expect(result.violations).toEqual([]);
    expect(existsSync(join(root, "code.txt"))).toBe(true);
    expect(existsSync(join(root, "feature-spec.json"))).toBe(true);
    expect(existsSync(join(root, "marker.json"))).toBe(true);
  });

  it("flags a MISSING meta output at its metaDir location (channel is enforced, not cosmetic)", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "step-exec-art-"));
    const metaDir = mkdtempSync(join(tmpdir(), "step-exec-meta-"));
    try {
      // A step that writes product + artifact but never the meta marker.
      const step = {
        ...channelStep(),
        async run(provided: import("../../consort/orchestrator/steps/step-run-types").ProvidedStepRun) {
          writeFileSync(join(provided.workspaceDir, "code.txt"), "print('hi')\n");
          writeFileSync(join(provided.artifactDir ?? provided.workspaceDir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }) + "\n");
          return { produced: true, producedPaths: [join(provided.workspaceDir, "code.txt")] };
        },
      };
      const deps: StepExecutorDeps = {
        resolveInputs: () => ({}),
        provisionWorkspace: () => ({ workspaceDir: root, artifactDir, metaDir }),
        instructionsFor: () => ({ prompt: "build S1" }),
      };
      const result = await execute(step, ctxFor(), deps);
      // The meta output was declared but never appeared under metaDir => a named violation.
      expect(result.violations.join(" ")).toMatch(/marker/i);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      rmSync(metaDir, { recursive: true, force: true });
    }
  });
});

// The LIVE drive provisions artifactDir === metaDir === <workspace>/.consort (a NESTED subdir of
// the product workspace, not a sibling temp dir) – see executor-dispatch.ts provisionWorkspace.
// This shape is where a leading ".consort/" on a filename double-encodes the root
// (=> <workspace>/.consort/.consort/...), the bug fixed when the channel model went live. These
// two tests pin the live shape + make that regression BITE hermetically (no live run needed).
describe("channel placement under the LIVE .consort shape (artifactDir === metaDir === <ws>/.consort)", () => {
  // Uses the REAL Step + the REAL spec-author-breakdown manifest (feature-spec -> artifact,
  // agent-log -> meta, both BARE filenames), so this exercises Step.run()'s actual channel
  // placement (step.ts) + producedPaths computation, not an inline stand-in.
  const breakdownAction: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

  function breakdownCtx(): StepCtx {
    return {
      action: breakdownAction,
      cfg: { projectDir: root, consortDir: join(root, ".consort"), featureId: "F1-x" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: {
        allowed: () => ({ kind: "design-complete" }) as WorkflowAction,
        reviseBudgetAvailable: () => true,
        recordRetry: () => ({ sanctioned: true }),
      },
    };
  }

  it("a BARE (channel-relative) filename lands directly under .consort – NOT double-encoded", async () => {
    const consort = join(root, ".consort");
    mkdirSync(consort, { recursive: true });
    // A conformant agent that writes each channel's BARE filename into the root the invocation
    // hands it (the orchestrator's placement, resolved by the channel model).
    const agent: StepAgent = {
      async invoke(inv) {
        writeFileSync(join(inv.workspaceDir, "feature-spec.json"), GOOD_SPEC);
        writeFileSync(join(inv.workspaceDir, "agent-log.jsonl"), GOOD_LOG);
      },
    };
    const step = new Step(manifestForAction(breakdownAction)!, agent);
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({ "product-overview": "x", nfrs: "x", "feature-request": "x" }),
      // The LIVE shape: both contained roots ARE the workspace's .consort subdir. But the agent
      // writes at workspaceDir (its cwd), so provision the ROOT as .consort so the agent's writes
      // and the channel resolution coincide – exactly the executor-dispatch live wiring, where the
      // agent runs in the project and artifact/meta resolve to <project>/.consort.
      provisionWorkspace: () => ({ workspaceDir: consort, artifactDir: consort, metaDir: consort }),
      instructionsFor: () => ({ prompt: "break down F1" }),
    };
    const result = await execute(step, breakdownCtx(), deps);
    expect(result.violations).toEqual([]);
    // Each file lands exactly one level deep under .consort – the correct placement.
    expect(existsSync(join(consort, "feature-spec.json"))).toBe(true);
    expect(existsSync(join(consort, "agent-log.jsonl"))).toBe(true);
    // And is NEVER double-nested – the regression this guard exists for.
    expect(existsSync(join(consort, ".consort", "feature-spec.json"))).toBe(false);
    expect(existsSync(join(consort, ".consort", "agent-log.jsonl"))).toBe(false);
    // Step.run() reports the single-level .consort paths as produced.
    expect(result.producedPaths).toEqual([join(consort, "feature-spec.json"), join(consort, "agent-log.jsonl")]);
  });

  it("DECOY: an outputPath override ILLEGALLY prefixed with .consort/ double-encodes (proves the guard bites)", async () => {
    const consort = join(root, ".consort");
    mkdirSync(consort, { recursive: true });
    // The exact authoring mistake the channel model forbids: an outputPaths override that re-encodes
    // the channel root (".consort/feature-spec.json"). The orchestrator prepends the channel root
    // (artifactDir === consort), so the executor looks for the primary output at
    // <consort>/.consort/feature-spec.json – which the (correct, bare-writing) agent never creates,
    // so the primary is absent => a produce failure. If someone re-introduces the prefix on a
    // shipped manifest/override, its live turn breaks exactly here.
    const agent: StepAgent = {
      async invoke(inv) {
        // The agent writes the BARE (correct) filename; the double-encoded expectation misses it.
        writeFileSync(join(inv.workspaceDir, "feature-spec.json"), GOOD_SPEC);
        writeFileSync(join(inv.workspaceDir, "agent-log.jsonl"), GOOD_LOG);
      },
    };
    const step = new Step(manifestForAction(breakdownAction)!, agent);
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({ "product-overview": "x", nfrs: "x", "feature-request": "x" }),
      provisionWorkspace: () => ({
        workspaceDir: consort,
        artifactDir: consort,
        metaDir: consort,
        // The illegal re-encoding override on the PRIMARY output.
        outputPaths: { "feature-spec": ".consort/feature-spec.json" },
      }),
      instructionsFor: () => ({ prompt: "break down F1" }),
    };
    const result = await execute(step, breakdownCtx(), deps);
    // The primary output was expected at the DOUBLE-ENCODED path and never found => blocked.
    expect(result.violations.length).toBeGreaterThan(0);
    expect(existsSync(join(consort, ".consort", "feature-spec.json"))).toBe(false); // never created there
    expect(existsSync(join(consort, "feature-spec.json"))).toBe(true); // correct place, but the override's expectation missed it
  });
});
