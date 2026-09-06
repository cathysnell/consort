// Regression for the live-run bug: a spec-author manifest whose agent-log is MATERIALIZED by
// the orchestrator (from the agent's report) rather than written by the agent. Two faults the
// three live runs exposed:
//   1. validate-outputs looked only at the AGENT's producedPaths, so the orchestrator-
//      materialized agent-log.jsonl was flagged "not produced" -> a false violation ->
//      blocked -> re-spawn. Fix: validate-outputs checks the declared path ON DISK.
//   2. the runner's recordRetry was unbounded ({sanctioned:true} always), so that blocked
//      loop re-spawned FOREVER (9x to timeout live). Fix: a chain-shared retry budget that
//      THROWS past MAX_STEP_RETRIES.
// These run hermetically with a mock agent that reports via its final text – no cloud, no
// spawn – and would have caught the live failure.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { runManifestStep, runManifestChain, type ManifestRunnerDeps } from "../../consort/orchestrator/runners/manifest-runner";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { StepAgent } from "../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "runner-mat-")); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const SPEC_AUTHOR: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };
const GOOD_SPEC = JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: ["S1-a"] }) + "\n";

/** A mock agent whose lastResult.finalText carries a fenced agent-report block – exactly the
 *  live claude path. It writes ONLY feature-spec.json; the agent-log is the orchestrator's to
 *  materialize from the report (the agent never writes agent-log.jsonl). */
function reportingAgent(reportBlock: string, opts: { writeSpec?: boolean } = {}): StepAgent & { lastResult?: { finalText?: string } } {
  const agent: StepAgent & { lastResult?: { finalText?: string } } = {
    async invoke(inv) {
      if (opts.writeSpec !== false) writeFileSync(join(inv.workspaceDir, "feature-spec.json"), GOOD_SPEC);
      agent.lastResult = { finalText: reportBlock };
    },
  };
  return agent;
}

/** spec-author manifest: feature-spec (agent) + agent-log (orchestrator-materialized). */
function specAuthorManifest(): StepManifest {
  return {
    id: "mat-spec-author",
    role: "spec-author",
    match: { kind: "invoke-role", role: "spec-author", mode: "breakdown" },
    inputs: [],
    outputs: [
      { id: "feature-spec", filename: "feature-spec.json", validator: "featureSpecNonEmptyStories" },
      { id: "agent-log", filename: "agent-log.jsonl", validator: "agentLogHasRoleEvent" },
    ],
    routing: { produced: { next: { kind: "design-complete" } } },
    agentOptions: { session: "fresh" },
    agent: { kind: "mock", config: {} }, // replaced by agentFor override below
  } as StepManifest;
}

function deps(agent: StepAgent): ManifestRunnerDeps {
  return {
    workspaceDir: ws,
    cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-x" } as ManifestRunnerDeps["cfg"],
    agentFor: () => agent, // inject the reporting agent directly
    formatAgentReports: true, // orchestrator formats the report into agent-log.jsonl
  };
}

describe("runner: orchestrator-materialized agent-log counts as produced (no false blocked loop)", () => {
  const goodReport = "```agent-report\n" + JSON.stringify([{ level: "info", event: "artifact.written", message: "wrote feature-spec.json + 1 story" }]) + "\n```";

  it("a clean turn produces feature-spec + a materialized agent-log – NO violation, routes to design-complete", async () => {
    const res = await runManifestStep(SPEC_AUTHOR, [specAuthorManifest()], deps(reportingAgent(goodReport)));
    expect(res.violations, `unexpected violations: ${res.violations.join("; ")}`).toEqual([]);
    // the agent wrote the spec; the ORCHESTRATOR materialized the log from the report.
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);
    expect(existsSync(join(ws, "agent-log.jsonl"))).toBe(true);
    const log = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
    expect(log.role).toBe("spec-author");
    // routes forward (NOT a blocked re-issue).
    expect(res.bounded.action).toEqual({ kind: "design-complete" });
  });

  it("runManifestChain does not re-spawn a clean turn (single turn, not a loop)", async () => {
    let invocations = 0;
    const agent = reportingAgent(goodReport);
    const counting: StepAgent & { lastResult?: { finalText?: string } } = {
      async invoke(inv) { invocations++; await agent.invoke(inv); counting.lastResult = agent.lastResult; },
    };
    const turns = await runManifestChain(SPEC_AUTHOR, [specAuthorManifest()], deps(counting));
    expect(invocations).toBe(1);           // exactly one spawn – the live bug spawned 9
    expect(turns).toHaveLength(1);
    expect(turns[0].result.violations).toEqual([]);
  });

  it("materializes the agent-log at the DECLARED nested path (outputPaths remap), not the workspace root", async () => {
    // The exact live-run bug: provisionWorkspace remaps agent-log -> .sftdd/agent-log.jsonl
    // (a real spec-author turn nests its outputs). The formatter must write THERE, not at the
    // workspace root, or validate-outputs looks under .sftdd/ – misses it – and wrongly blocks.
    const SPEC_REL = ".sftdd/features/F1-x/feature-spec.json";
    const LOG_REL = ".sftdd/agent-log.jsonl";
    const nestedAgent = reportingAgent(goodReport, { writeSpec: false });
    // write the spec at the nested declared path (mirrors the live agent's cwd-relative write).
    const wrappingAgent: StepAgent & { lastResult?: { finalText?: string } } = {
      async invoke(inv) {
        const p = join(inv.workspaceDir, SPEC_REL);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, GOOD_SPEC);
        await nestedAgent.invoke(inv);
        wrappingAgent.lastResult = nestedAgent.lastResult;
      },
    };
    const manifest = specAuthorManifest();
    const d: ManifestRunnerDeps = {
      ...deps(wrappingAgent),
      provisionWorkspace: () => ({ workspaceDir: ws, outputPaths: { "feature-spec": SPEC_REL, "agent-log": LOG_REL } }),
    };
    const res = await runManifestStep(SPEC_AUTHOR, [manifest], d);
    expect(res.violations, `unexpected violations: ${res.violations.join("; ")}`).toEqual([]);
    // the log landed at the declared nested path (the formatter mkdir'd .sftdd/), NOT the root.
    expect(existsSync(join(ws, LOG_REL))).toBe(true);
    expect(existsSync(join(ws, "agent-log.jsonl"))).toBe(false);
    expect(res.bounded.action).toEqual({ kind: "design-complete" });
  });

  it("a PERSISTENTLY failing step aborts after the retry budget – does NOT re-spawn forever", async () => {
    // Agent reports nothing usable (no agent-report block) => agent-log never materializes =>
    // validation fails => blocked. The chain must THROW after the bounded retry, not loop.
    let invocations = 0;
    const badAgent: StepAgent & { lastResult?: { finalText?: string } } = {
      async invoke(inv) { invocations++; writeFileSync(join(inv.workspaceDir, "feature-spec.json"), GOOD_SPEC); badAgent.lastResult = { finalText: "no report block here" }; },
    };
    await expect(runManifestChain(SPEC_AUTHOR, [specAuthorManifest()], deps(badAgent))).rejects.toThrow(/retry budget|blocked/i);
    // bounded: the initial turn + one sanctioned retry, then abort – NOT unbounded.
    expect(invocations).toBeLessThanOrEqual(2);
  });
});
