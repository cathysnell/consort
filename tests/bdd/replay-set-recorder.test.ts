// The per-agent-turn REPLAY SET is what lets an optimization experiment replay ONE manifest step in
// isolation: the pre-state (full project code tree BEFORE the turn) + the resolved inputs / assembled
// prompt / guidelines / levers the turn ran with, PLUS the full pre-turn `.consort` STATE tree
// (pre-consort/) a replay lays verbatim instead of reconstructing the cycle state. These guards pin that
// wrapWithRecorder writes the complete bundle into the turn dir BEFORE the agent mutates the tree, that
// pre-consort/ captures the `.consort` STATE (minus append-only streams + runtime ephemera), and that the
// code pre-project tree still excludes `.consort`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapWithRecorder } from "../../consort/orchestrator/agents/replay-recorder-wrapper";
import type { StepAgent, AgentInvocation } from "../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary";

let root: string;
let projectDir: string;
let consortDir: string;
let recordDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "replay-set-"));
  projectDir = join(root, "proj");
  consortDir = join(projectDir, ".consort");
  recordDir = join(root, "corpus");
  // A scaffolded project tree: code (app/, tests/) + a .consort artifact. This is the PRE-state.
  mkdirSync(join(projectDir, "app"), { recursive: true });
  mkdirSync(join(projectDir, "tests"), { recursive: true });
  mkdirSync(consortDir, { recursive: true });
  writeFileSync(join(projectDir, "app", "models.py"), "class Stock: pass\n");
  writeFileSync(join(projectDir, "tests", "test_stock.py"), "def test(): assert True\n");
  writeFileSync(join(consortDir, "product-overview.md"), "the product\n");
  // .consort STATE (kept by pre-consort): a top-level file, a nested state tree.
  writeFileSync(join(consortDir, "smells.json"), "[]\n");
  mkdirSync(join(consortDir, "features", "F1"), { recursive: true });
  writeFileSync(join(consortDir, "features", "F1", "workflow-state.json"), '{"phase":"build"}\n');
  // append-only STREAMS + runtime ephemera (EXCLUDED from pre-consort).
  writeFileSync(join(consortDir, "agent-log.jsonl"), '{"e":"turn"}\n');
  writeFileSync(join(consortDir, "correspondence.jsonl"), '{"c":"kickoff"}\n');
  writeFileSync(join(consortDir, "agent-live.log"), "live reasoning...\n");
  writeFileSync(join(consortDir, "deploy.pid"), "12345\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" } as WorkflowAction;

/** A fake inner agent that, when invoked, writes a NEW file (so we can prove the pre-state snapshot
 *  was taken BEFORE this mutation – the snapshot must NOT contain this file). */
function fakeAgent(): StepAgent {
  return {
    async invoke(inv: AgentInvocation) {
      writeFileSync(join(inv.workspaceDir, "app", "produced-after.py"), "# written by the turn\n");
    },
  };
}

/** A transcript stub – a complete agent turn records transcript.md (the per-turn audit requires it).
 *  Returns the outcome once, mirroring takeLastAgentTranscript's take-once contract. */
function transcriptStub(): () => { prompt: string; role?: string; model?: string; finalText: string; tools: string[] } | undefined {
  let taken = false;
  return () => (taken ? undefined : ((taken = true), { prompt: "p", role: "spec-author", model: "haiku", finalText: "did the thing", tools: ["Write"] }));
}

function invocation(): AgentInvocation {
  return {
    action,
    workspaceDir: projectDir,
    inputs: {
      "product-overview": "the product\n",
      "feature-request": "please build stock tracking\n",
    },
    instructions: { prompt: "Break the feature into stories.\n[context-pack]\nservice=app/services", guidelines: ["be terse"] },
  };
}

describe("wrapWithRecorder: the per-agent-turn replay set", () => {
  it("captures pre-project code + inputs + prompt + guidelines + levers into replay-set/", async () => {
    const wrapped = wrapWithRecorder(fakeAgent(), {
      recordDir,
      projectDir,
      consortDir,
      featureId: "F1",
      takeTranscript: transcriptStub(),
      resolveLevers: () => ({ model: "haiku", effort: "low", session: "fresh" }),
    });
    await wrapped.invoke(invocation());

    const setDir = join(recordDir, "turns", "0000-spec-author-breakdown", "replay-set");
    expect(existsSync(setDir), "replay-set/ dir exists in the turn dir").toBe(true);

    // pre-project/ – the code tree BEFORE the turn (models.py + test_stock.py), NOT the produced file.
    expect(readFileSync(join(setDir, "pre-project", "app", "models.py"), "utf8")).toContain("class Stock");
    expect(readFileSync(join(setDir, "pre-project", "tests", "test_stock.py"), "utf8")).toContain("def test()");
    expect(existsSync(join(setDir, "pre-project", "app", "produced-after.py")), "pre-state must NOT contain the file the turn produced").toBe(false);
    // .consort is NOT snapshotted into the pre-project CODE tree (that is code-only).
    expect(existsSync(join(setDir, "pre-project", ".consort")), ".consort excluded from pre-project").toBe(false);

    // pre-consort/ – the full pre-turn .consort STATE tree, laid verbatim by a replay.
    expect(readFileSync(join(setDir, "pre-consort", "product-overview.md"), "utf8")).toBe("the product\n");
    expect(readFileSync(join(setDir, "pre-consort", "smells.json"), "utf8")).toBe("[]\n");
    expect(readFileSync(join(setDir, "pre-consort", "features", "F1", "workflow-state.json"), "utf8")).toContain('"phase":"build"'); // nested state kept
    // append-only STREAMS + runtime ephemera are EXCLUDED (not pre-turn routing state; O(turns^2) / transient).
    expect(existsSync(join(setDir, "pre-consort", "agent-log.jsonl")), "agent-log stream excluded").toBe(false);
    expect(existsSync(join(setDir, "pre-consort", "correspondence.jsonl")), "correspondence stream excluded").toBe(false);
    expect(existsSync(join(setDir, "pre-consort", "agent-live.log")), "liveness sidecar excluded").toBe(false);
    expect(existsSync(join(setDir, "pre-consort", "deploy.pid")), "pid ephemera excluded").toBe(false);

    // inputs/<id> – the resolved contents handed to the step.
    expect(readFileSync(join(setDir, "inputs", "product-overview"), "utf8")).toBe("the product\n");
    expect(readFileSync(join(setDir, "inputs", "feature-request"), "utf8")).toContain("stock tracking");

    // prompt.txt + guidelines.json + levers.json – the invocation conditions.
    expect(readFileSync(join(setDir, "prompt.txt"), "utf8")).toContain("Break the feature into stories");
    expect(readFileSync(join(setDir, "prompt.txt"), "utf8")).toContain("context-pack"); // preconditions inlined
    expect(JSON.parse(readFileSync(join(setDir, "guidelines.json"), "utf8"))).toEqual(["be terse"]);
    expect(JSON.parse(readFileSync(join(setDir, "levers.json"), "utf8"))).toEqual({ model: "haiku", effort: "low", session: "fresh" });
  });

  it("levers.json is {} when no resolveLevers is supplied (test double / no wiring)", async () => {
    const wrapped = wrapWithRecorder(fakeAgent(), { recordDir, projectDir, consortDir, featureId: "F1", takeTranscript: transcriptStub() });
    await wrapped.invoke(invocation());
    const levers = readFileSync(join(recordDir, "turns", "0000-spec-author-breakdown", "replay-set", "levers.json"), "utf8");
    expect(JSON.parse(levers)).toEqual({});
  });

  it("the replay set lands in the SAME turn dir recordTurn fills (turnDirFor agreement)", async () => {
    const wrapped = wrapWithRecorder(fakeAgent(), { recordDir, projectDir, consortDir, featureId: "F1", takeTranscript: transcriptStub() });
    await wrapped.invoke(invocation());
    const turnDir = join(recordDir, "turns", "0000-spec-author-breakdown");
    // Both the replay set (pre-state) AND the turn output (turn.json) share the one dir.
    expect(existsSync(join(turnDir, "replay-set"))).toBe(true);
    expect(existsSync(join(turnDir, "turn.json"))).toBe(true);
  });
});
