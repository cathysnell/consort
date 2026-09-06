// manifest-runner: the bridge that takes a step MANIFEST and hands it to the orchestrator
// (the StepExecutor / Template Method). It builds the Step, assembles the
// orchestrator-owned seams (resolve inputs from the shared workspace, provision it, source
// instructions, reconcile routing), and runs the fixed 7 phases – so a caller drives a
// manifest without hand-wiring StepCtx/StepExecutorDeps every turn.
//
// runManifestStep runs ONE manifest. runManifestChain follows each turn's routing to the
// next manifest until the chain leaves the manifest set (a terminal / off-graph action),
// which is exactly the 2-turn stockflow demo: PO seed -> spec-author breakdown -> done.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runManifestStep, runManifestChain, type ManifestRunnerDeps } from "../../consort/orchestrator/runners/manifest-runner";
import { loadStepManifests } from "../../consort/orchestrator/steps/manifest";
import { makeMockReplayAgent } from "../../consort/orchestrator/agents/mock-replay-agent";
import { writeEscalation } from "../../consort/gates/escalation";
import type { StepAgent } from "../../consort/orchestrator/agents/agent-types";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

const KIT = process.cwd();
const CORPUS = join(KIT, "tests/integration");
// The route-scenario / 2-turn-orchestration manifest set lives in its own subdir now.
const MANIFEST_DIR = join(CORPUS, "manifests", "route-scenarios");
const INTAKE = join(CORPUS, "intake");

const PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };
const SPEC_AUTHOR: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "manifest-runner-ws-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** The PO mock (turn 1) + a mock spec-author (turn 2), keyed by the manifest's role. */
function agentFor(manifest: StepManifest): StepAgent {
  if (manifest.role === "product-owner") {
    return makeMockReplayAgent({
      corpusRoot: INTAKE,
      seeds: [
        { outputId: "product-overview", from: "product-overview.md", to: "product-overview.md" },
        { outputId: "nfrs", from: "nfrs.md", to: "nfrs.md" },
        { outputId: "design-guideline", from: "design-brief.md", to: "design-brief.md" },
      ],
    });
  }
  // Mock spec-author: reads the provided PO inputs, writes feature-spec + a log.
  return {
    async invoke(inv) {
      expect(Object.keys(inv.inputs).sort()).toEqual(["design-guideline", "nfrs", "product-overview"]);
      writeFileSync(
        join(inv.workspaceDir, "feature-spec.json"),
        JSON.stringify({ id: "F1-stock-visibility", name: "Stock Visibility", status: "draft", tdd_mode: "N>=2", stories: ["S1-record-stock"] }) + "\n",
      );
      writeFileSync(
        join(inv.workspaceDir, "agent-log.jsonl"),
        JSON.stringify({ timestamp: "2026-08-03T12:00:00Z", level: "info", role: "spec-author", event: "artifact.written", message: "wrote feature-spec.json" }) + "\n",
      );
    },
  };
}

function deps(): ManifestRunnerDeps {
  return {
    agentFor,
    workspaceDir: ws,
    cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-stock-visibility" } as ManifestRunnerDeps["cfg"],
  };
}

describe("runManifestStep: one manifest -> the orchestrator (StepExecutor)", () => {
  it("runs turn 1 (PO seed) – materializes the recorded files, routes to spec-author", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    const res = await runManifestStep(PO_SEED, manifests, deps());
    expect(res.violations).toEqual([]);
    expect(existsSync(join(ws, "product-overview.md"))).toBe(true);
    expect(existsSync(join(ws, "nfrs.md"))).toBe(true);
    expect(existsSync(join(ws, "design-brief.md"))).toBe(true);
    expect(res.bounded.action).toEqual(SPEC_AUTHOR);
  });

  it("resolves turn 2's inputs from the shared workspace + produces feature-spec.json", async () => {
    // Seed the workspace as turn 1 would have.
    for (const f of ["product-overview.md", "nfrs.md", "design-brief.md"]) {
      writeFileSync(join(ws, f), readFileSync(join(INTAKE, f), "utf8"));
    }
    const manifests = loadStepManifests(MANIFEST_DIR);
    const res = await runManifestStep(SPEC_AUTHOR, manifests, deps());
    expect(res.violations).toEqual([]);
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);
    // Honest next hop after breakdown for the uiTrack demo: the UX Designer (real nextDesignAction).
    expect(res.bounded.action).toEqual({ kind: "invoke-role", role: "ux-designer" });
  });

  it("THROWS when no manifest matches the action (the runner never silently no-ops)", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    await expect(runManifestStep({ kind: "planning-complete" } as WorkflowAction, manifests, deps())).rejects.toThrow(/no manifest|no step manifest/i);
  });
});

describe("runManifestChain: follow the routing across turns", () => {
  it("drives the 2-turn stockflow demo from the PO seed to the UX-designer hand-off", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    // Cap at the 2 turns under test (PO seed -> spec-author breakdown). The manifest set now
    // ALSO carries a ux-designer manifest (for the route-scenario suite), so an uncapped chain
    // would continue into it; this test is about the PO->spec-author hand-off, so it stops at 2
    // and asserts the spec-author's produced route points at the UX Designer.
    const turns = await runManifestChain(PO_SEED, manifests, deps(), { maxTurns: 2 });

    // Two turns ran, in order, each clean.
    expect(turns.map((t) => t.manifestId)).toEqual(["po-seed", "spec-author"]);
    for (const t of turns) expect(t.result.violations).toEqual([]);

    // The chain produced BOTH turns' artifacts in the one shared workspace.
    expect(existsSync(join(ws, "product-overview.md"))).toBe(true);
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);

    // The spec-author's honest next hop is the UX Designer (real nextDesignAction for a uiTrack
    // project).
    expect(turns[turns.length - 1].result.bounded.action).toEqual({ kind: "invoke-role", role: "ux-designer" });
  });

  it("stops at a maxTurns guard rather than looping forever", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    const turns = await runManifestChain(PO_SEED, manifests, deps(), { maxTurns: 1 });
    expect(turns).toHaveLength(1);
    expect(turns[0].manifestId).toBe("po-seed");
  });
});

describe("runManifestStep: PREPARE-PRECONDITIONS appends the declared context-pack (phase 2.5)", () => {
  it("projects the LAYOUT from the workspace conventions.json + appends it to the agent's prompt", async () => {
    // Seed conventions.json in the workspace .sftdd (the context-pack LAYOUT source).
    mkdirSync(join(ws, ".sftdd", "architecture"), { recursive: true });
    writeFileSync(
      join(ws, ".sftdd", "architecture", "conventions.json"),
      JSON.stringify({ established_by: "F1", established_at: "2026-01-01T00:00:00.000Z", service_backed: true, layers: [{ role: "service", module: "app/services" }] }),
    );
    // A minimal manifest declaring a context-pack precondition, with a mock agent that captures
    // the prompt it receives (so we assert the phase appended the prepared block).
    let seenPrompt = "";
    const manifest: StepManifest = {
      id: "precond-probe", role: "driver",
      match: { kind: "invoke-role", role: "driver", story: "S1" },
      inputs: [],
      preconditions: [{ id: "context-pack", kind: "context-pack", description: "the pack", options: { skipTestLoop: true } }],
      outputs: [{ id: "marker", filename: "marker.txt", validator: "nonEmptyFile", description: "a produced marker" }],
      routing: { produced: { next: { kind: "design-complete" } } },
      agentOptions: { session: "fresh" },
    };
    const captureAgent: StepAgent = {
      async invoke(inv) {
        seenPrompt = inv.instructions.prompt;
        writeFileSync(join(inv.workspaceDir, "marker.txt"), "ok\n");
      },
    };
    const res = await runManifestStep(
      { kind: "invoke-role", role: "driver", story: "S1" } as WorkflowAction,
      [manifest],
      { ...deps(), agentFor: () => captureAgent, instructionsFor: () => ({ prompt: "GREEN story S1." }) },
    );
    expect(res.violations).toEqual([]);
    // The declared context-pack was PREPARED (LAYOUT from conventions) + APPENDED to the prompt.
    expect(seenPrompt).toMatch(/^GREEN story S1\./);
    expect(seenPrompt).toMatch(/LAYOUT \(place\/judge code/);
    expect(seenPrompt).toContain("service=app/services");
    // skipTestLoop honored (no TESTS line).
    expect(seenPrompt).not.toMatch(/TESTS ::/);
  });
});

describe("runManifestStep: probeEscalation reaches the revise/escalate route space", () => {
  const STORY = "S1-stock-list";
  function seedWorkspace() {
    for (const f of ["product-overview.md", "nfrs.md", "design-brief.md"]) {
      writeFileSync(join(ws, f), readFileSync(join(INTAKE, f), "utf8"));
    }
  }

  it("with NO escalation on disk, probeEscalation:true still routes produced -> ux-designer (byte-identical)", async () => {
    seedWorkspace();
    const manifests = loadStepManifests(MANIFEST_DIR);
    const res = await runManifestStep(SPEC_AUTHOR, manifests, { ...deps(), probeEscalation: true });
    expect(res.violations).toEqual([]);
    expect(res.bounded.action).toEqual({ kind: "invoke-role", role: "ux-designer" });
  });

  it("a ROUTABLE spec smell on disk routes the spec-author turn to a revise-route (Gate 1)", async () => {
    seedWorkspace();
    // Plant a real reflect-spec-defect escalation in the workspace .sftdd – the disk probe
    // classifies it routable (spec-author owns it, first revise allowed).
    writeEscalation(join(ws, ".sftdd"), {
      source: "smell:reflect-spec-defect",
      reason: "AC2 is untestable as written",
      feature_id: "F1-stock-visibility",
      story_id: STORY,
    });
    const manifests = loadStepManifests(MANIFEST_DIR);
    const res = await runManifestStep(SPEC_AUTHOR, manifests, { ...deps(), probeEscalation: true });
    expect(res.bounded.action).toMatchObject({ kind: "revise-route", role: "spec-author", gate: "spec", story: STORY });
  });

  it("a NON-routable (explicit) escalation routes the turn to raise-to-hil", async () => {
    seedWorkspace();
    writeEscalation(join(ws, ".sftdd"), {
      source: "honest-green",
      reason: "verify failed on main",
      feature_id: "F1-stock-visibility",
      story_id: STORY,
    });
    const manifests = loadStepManifests(MANIFEST_DIR);
    const res = await runManifestStep(SPEC_AUTHOR, manifests, { ...deps(), probeEscalation: true });
    expect(res.bounded.action).toMatchObject({ kind: "raise-to-hil", reason: "verify failed on main" });
  });
});
