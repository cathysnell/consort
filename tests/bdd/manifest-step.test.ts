// Step: the GENERIC StepContract driven ENTIRELY by a manifest + the validator
// registry + an injected agent. It is the ONLY step implementation – the runner path builds
// `new Step(manifest, agent)` for every turn; there is no bespoke concrete StepContract
// class (the original SpecAuthorBreakdownStep was proven equivalent to this and then removed).
// This slice pins Step's inputs/outputs/conformanceValidators/route/run contract.
//
// It also pins the validator registry: the two breakdown validators are registered by name,
// resolveValidator returns the SAME deterministic fn, and an unknown name throws loud (a
// manifest typo is a hard failure, never a silent skip).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Step } from "../../consort/orchestrator/steps/step";
import { VALIDATOR_REGISTRY, resolveValidator } from "../../consort/orchestrator/validators/conformance/validator-registry";
import { manifestForAction } from "../../consort/orchestrator/steps/manifest";
import type { StepAgent, AgentInvocation } from "../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

let ws: string;

const BREAKDOWN: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

const PROVIDED_INPUTS: Record<string, string> = {
  "product-overview": "# Overview\nA stock app.\n",
  nfrs: "# NFRs\n## Required\n- R1: durability\n",
  "feature-request": "# Request\nRecord + view stock.\n",
};

function mockAgent(opts: { writes: boolean }): { agent: StepAgent; seen: AgentInvocation[] } {
  const seen: AgentInvocation[] = [];
  const agent: StepAgent = {
    async invoke(invocation) {
      seen.push(invocation);
      if (opts.writes) {
        writeFileSync(
          join(invocation.workspaceDir, "feature-spec.json"),
          JSON.stringify({ id: "F1-stock-visibility", name: "Stock", status: "draft", tdd_mode: "N>=2", stories: ["S1-record-stock"] }) + "\n",
        );
      }
    },
  };
  return { agent, seen };
}

/** The breakdown step, built purely from the shipped manifest + registry + agent. */
function breakdownStep(agent: StepAgent): Step {
  const manifest = manifestForAction(BREAKDOWN);
  if (!manifest) throw new Error("no breakdown manifest shipped");
  return new Step(manifest, agent);
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "manifest-step-ws-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("validator registry", () => {
  it("registers the two breakdown validators by name", () => {
    expect(Object.keys(VALIDATOR_REGISTRY)).toEqual(
      expect.arrayContaining(["featureSpecNonEmptyStories", "agentLogHasRoleEvent"]),
    );
  });

  it("resolveValidator returns the deterministic fn (rejects a storyless spec)", () => {
    const check = resolveValidator("featureSpecNonEmptyStories");
    const bad = join(ws, "storyless.json");
    writeFileSync(bad, JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: [] }));
    expect(check(bad).ok).toBe(false);
  });

  it("resolveValidator THROWS loud on an unknown name (a manifest typo is not a silent skip)", () => {
    expect(() => resolveValidator("noSuchChecker")).toThrow(/noSuchChecker|unknown|not registered/i);
  });
});

describe("Step: logical contract (≡ SpecAuthorBreakdownStep)", () => {
  it("declares logical inputs = the 3 PO artifacts (ids only)", () => {
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    expect(step.inputs(BREAKDOWN).map((s) => s.id)).toEqual(["product-overview", "nfrs", "feature-request"]);
  });

  it("declares its logical outputs = feature-spec AND a conformant log message", () => {
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    const byId = Object.fromEntries(step.outputs(BREAKDOWN).map((o) => [o.id, o]));
    expect(byId["feature-spec"].filename).toBe("feature-spec.json");
    expect(byId["agent-log"].filename).toBe("agent-log.jsonl");
  });
});

describe("Step: run() within the provided workspace", () => {
  it("FAILS naming a missing PROVIDED input (no agent invoked)", async () => {
    const { agent, seen } = mockAgent({ writes: true });
    const step = breakdownStep(agent);
    const { "feature-request": _omit, ...twoInputs } = PROVIDED_INPUTS;
    const r = await step.run({ action: BREAKDOWN, workspaceDir: ws, inputs: twoInputs, instructions: { prompt: "p" } });
    expect(r.produced).toBe(false);
    expect(r.missingInput).toBe("feature-request");
    expect(seen).toHaveLength(0);
  });

  it("invokes the injected agent contained to the workspace, then reports the produced path", async () => {
    const { agent, seen } = mockAgent({ writes: true });
    const step = breakdownStep(agent);
    const instructions = { prompt: "Break F1 into stories", guidelines: ["independence test"] };
    const r = await step.run({ action: BREAKDOWN, workspaceDir: ws, inputs: PROVIDED_INPUTS, instructions });
    expect(seen).toHaveLength(1);
    expect(seen[0].workspaceDir).toBe(ws);
    expect(seen[0].inputs).toEqual(PROVIDED_INPUTS);
    expect(seen[0].instructions).toEqual(instructions);
    expect(r.produced).toBe(true);
    expect(r.producedPaths).toEqual([join(ws, "feature-spec.json")]);
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);
  });

  it("reports produced:false when the agent writes nothing", async () => {
    const { agent } = mockAgent({ writes: false });
    const step = breakdownStep(agent);
    const r = await step.run({ action: BREAKDOWN, workspaceDir: ws, inputs: PROVIDED_INPUTS, instructions: { prompt: "p" } });
    expect(r.produced).toBe(false);
    expect(r.producedPaths).toBeUndefined();
  });
});

describe("Step: in-code output conformance validators (resolved from the registry by name)", () => {
  function outputCheck(id: string) {
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    return step.outputs(BREAKDOWN).find((o) => o.id === id)!.validate;
  }

  it("feature-spec validator ACCEPTS a conformant spec and REJECTS a storyless one", () => {
    const check = outputCheck("feature-spec");
    const good = join(ws, "good-spec.json");
    writeFileSync(good, JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: ["S1-a"] }));
    expect(check(good)).toEqual({ ok: true, violations: [] });
    const storyless = join(ws, "bad-spec.json");
    writeFileSync(storyless, JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: [] }));
    const r = check(storyless);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/stories/i);
  });

  it("agent-log validator ACCEPTS a conformant line and REJECTS an empty log", () => {
    const check = outputCheck("agent-log");
    const good = join(ws, "good-log.jsonl");
    writeFileSync(good, JSON.stringify({
      timestamp: "2026-08-03T12:00:00Z", level: "info", role: "spec-author",
      event: "artifact.written", message: "wrote feature-spec.json + 1 story stub",
    }) + "\n");
    expect(check(good)).toEqual({ ok: true, violations: [] });
    const empty = join(ws, "empty-log.jsonl");
    writeFileSync(empty, "");
    expect(check(empty).ok).toBe(false);
  });
});

describe("Step: conformanceValidators() (exposed to the agent)", () => {
  it("exposes one validator per output, each with a docstring + the same in-code fn", () => {
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    const byId = Object.fromEntries(step.conformanceValidators(BREAKDOWN).map((p) => [p.outputId, p]));
    expect(byId["feature-spec"].docstring.length).toBeGreaterThan(0);
    expect(byId["agent-log"].docstring.length).toBeGreaterThan(0);
    const bad = join(ws, "storyless.json");
    writeFileSync(bad, JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: [] }));
    expect(byId["feature-spec"].fn(bad).ok).toBe(false);
  });
});

describe("Step: route()", () => {
  const cleanState = { phase: "feature", escalation: null } as never;

  it("emits a produced proposal from the manifest routing map (shipped breakdown = state-derived)", () => {
    // The shipped breakdown manifest defers its next hop to the pure transition (the real next
    // hop after breakdown depends on uiTrack/story state), so route() emits the state-derived
    // marker validateAndBound resolves to the allowed transition.
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    const proposal = step.route(BREAKDOWN, { state: cleanState, feature: "F1-stock-visibility" });
    expect(proposal.outcome).toBe("produced");
    expect(proposal.proposedNext).toEqual({ kind: "state-derived" });
  });

  it("emits a REVISE proposal when the state carries a ROUTABLE spec smell (escalationPreempt)", () => {
    // A routable spec-level smell (revise budget left) routes the verdict back to the owning
    // author – the same authority nextTransition uses (escalationPreempt), not re-derived.
    const state = {
      phase: "feature",
      escalation: {
        id: "smell-1",
        source: "navigator/reflect",
        reason: "AC2 is untestable as written",
        routable: { story: "S1-stock-list", owning_role: "spec-author", gate: "spec" },
      },
    } as never;
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    const proposal = step.route(BREAKDOWN, { state, feature: "F1-stock-visibility" });
    expect(proposal.outcome).toBe("revise");
    expect(proposal.proposedNext).toMatchObject({ kind: "revise-route", role: "spec-author", gate: "spec", story: "S1-stock-list" });
    expect(proposal.reason).toBe("AC2 is untestable as written");
  });

  it("emits an ESCALATE proposal for a NON-routable blocking escalation (-> raise-to-hil)", () => {
    const state = {
      phase: "feature",
      escalation: { id: "halt-1", source: "honest-green", reason: "verify failed on main", story_id: "S1-stock-list" },
    } as never;
    const step = breakdownStep(mockAgent({ writes: true }).agent);
    const proposal = step.route(BREAKDOWN, { state, feature: "F1-stock-visibility" });
    expect(proposal.outcome).toBe("escalate");
    expect(proposal.proposedNext).toMatchObject({ kind: "raise-to-hil", reason: "verify failed on main" });
  });
});
