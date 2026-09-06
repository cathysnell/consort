// A 2-turn REPLAY orchestration, expressed entirely as step manifests + driven by the
// Template Method (StepExecutor), hermetically:
//   Turn 1 – PO Human Mock: replays the human PO's RECORDED authoring (product-overview.md,
//     nfrs.md, design-brief.md) from the stockflow corpus into the workspace, logs it, and
//     ROUTES to the spec-author breakdown (its manifest's produced.next).
//   Turn 2 – Spec Author: takes those three PO files as INPUTS and produces feature-spec.json
//     (a mock agent stands in for the model; the PO mock is the piece under demonstration).
//
// The demo manifests live in the integration corpus (tests/integration/manifests/) – NOT the
// shipped step-manifests/ – because turn 2 shares its `match` with the production
// spec-author-breakdown manifest; keeping them integration-local avoids an ambiguous overlap in
// the shipped set while still exercising the exact loader/Step/StepExecutor path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadStepManifests, manifestForAction, validateStepManifest } from "../../../consort/orchestrator/steps/manifest";
import { Step } from "../../../consort/orchestrator/steps/step";
import { execute, type StepExecutorDeps, type StepCtx } from "../../../consort/orchestrator/turns/step-executor";
import { makeMockReplayAgent } from "../../../consort/orchestrator/agents/mock-replay-agent";
import type { StepAgent } from "../../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction, DriveState } from "../../../consort/orchestrator/drive/orchestrator-drive";
import type { ValidateBoundDeps } from "../../../consort/orchestrator/steps/step-contract";

const KIT = process.cwd();
const CORPUS = join(KIT, "tests/integration");
// The route-scenario + 2-turn-orchestration manifest set lives in its OWN subdir (no longer flat
// in manifests/, which now holds only per-purpose subdirs). loadStepManifests is non-recursive,
// so this loads exactly the route-scenario set (the per-role live chains are separate subdirs).
const MANIFEST_DIR = join(CORPUS, "manifests", "route-scenarios");
const INTAKE = join(CORPUS, "intake"); // where the recorded human PO authoring lives

const PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };
const SPEC_AUTHOR: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "stockflow-demo-ws-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** validateBound deps whose pure transition IS the demo's 2-turn chain. validateAndBound
 *  honors a produced proposal only when it EQUALS the pure allowed transition (a step never
 *  drives the machine off-graph), so `allowed` must return the same next the manifest routing
 *  proposes: after the PO seed -> spec-author breakdown; after that -> design-complete. */
function chainBoundDeps(allowedNext: WorkflowAction): ValidateBoundDeps {
  return {
    allowed: (_s) => allowedNext,
    reviseBudgetAvailable: () => true,
    recordRetry: () => ({ sanctioned: true }),
  };
}

describe("stockflow-demo manifests: shape + loader", () => {
  it("all demo manifests conform to the step-manifest schema", () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    // The 2-turn replay pair (po-seed + spec-author breakdown) PLUS the per-story + propose
    // spec-author manifests AND the ux-designer manifest the route-scenario suite drives (every
    // spec-author + ux-designer invocation the orchestrator can emit). Each maps to exactly one
    // action (no ambiguous overlap).
    expect(manifests.map((m) => m.id).sort()).toEqual([
      "architect-reviewer",
      "po-seed",
      "spec-author",
      "spec-author-propose",
      "spec-author-story",
      "test-strategist",
      "ux-designer",
    ]);
    for (const m of manifests) expect(validateStepManifest(m)).toEqual({ ok: true, violations: [] });
  });

  it("turn 1 routes to the spec-author breakdown (the 2-turn chain)", () => {
    const poSeed = manifestForAction(PO_SEED, loadStepManifests(MANIFEST_DIR))!;
    expect(poSeed.routing.produced.next).toEqual({ kind: "invoke-role", role: "spec-author", mode: "breakdown" });
  });
});

describe("stockflow-demo: 2-turn replay orchestration through the StepExecutor", () => {
  it("turn 1 (PO Human Mock) materializes the 3 recorded PO files + routes to spec-author", async () => {
    const manifest = manifestForAction(PO_SEED, loadStepManifests(MANIFEST_DIR))!;
    // The PO Human Mock: replays the RECORDED human authoring from the corpus intake dir.
    const agent = makeMockReplayAgent({
      corpusRoot: INTAKE,
      seeds: [
        { outputId: "product-overview", from: "product-overview.md", to: "product-overview.md" },
        { outputId: "nfrs", from: "nfrs.md", to: "nfrs.md" },
        { outputId: "design-guideline", from: "design-brief.md", to: "design-brief.md" },
      ],
    });
    const step = new Step(manifest, agent);

    const ctx: StepCtx = {
      action: PO_SEED,
      cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-stock-visibility" } as StepCtx["cfg"],
      state: { phase: "planning" } as unknown as DriveState,
      validateBoundDeps: chainBoundDeps(SPEC_AUTHOR), // after the PO seed, the chain goes to spec-author
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({}), // turn 1 has NO inputs (the PO authors from scratch)
      provisionWorkspace: () => ({ workspaceDir: ws }),
      instructionsFor: () => ({ prompt: "Author the PO seed for StockFlow." }),
      onRecord: () => {},
    };

    const result = await execute(step, ctx, deps);

    // The recorded files landed + each passed its in-code validator (violations empty).
    expect(result.violations).toEqual([]);
    expect(existsSync(join(ws, "product-overview.md"))).toBe(true);
    expect(existsSync(join(ws, "nfrs.md"))).toBe(true);
    expect(existsSync(join(ws, "design-brief.md"))).toBe(true);
    expect(readFileSync(join(ws, "product-overview.md"), "utf8").length).toBeGreaterThan(0);
    // And it ROUTED to the spec-author breakdown – the next turn.
    expect(result.bounded.action).toEqual(SPEC_AUTHOR);
  });

  it("turn 2 (Spec Author) consumes the 3 PO files as inputs and produces feature-spec.json", async () => {
    // Turn 1's outputs are already on disk (materialized here for an isolated turn-2 test).
    for (const f of ["product-overview.md", "nfrs.md", "design-brief.md"]) {
      writeFileSync(join(ws, f), readFileSync(join(INTAKE, f), "utf8"));
    }

    const manifest = manifestForAction(SPEC_AUTHOR, loadStepManifests(MANIFEST_DIR))!;
    // Turn 2 takes the 3 PO files by their manifest input ids – the orchestrator resolves
    // them from where turn 1 wrote them.
    expect(manifest.inputs.map((i) => i.id)).toEqual(["product-overview", "nfrs", "design-guideline"]);

    // A mock spec-author agent (the piece under demonstration is the PO mock; the spec author
    // stands in). It reads the provided inputs + writes the feature-spec into the workspace.
    const specAgent: StepAgent = {
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
    const step = new Step(manifest, specAgent);

    const ctx: StepCtx = {
      action: SPEC_AUTHOR,
      cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-stock-visibility" } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: chainBoundDeps({ kind: "design-complete" } as WorkflowAction), // after spec-author, design is complete
    };
    const deps: StepExecutorDeps = {
      // The orchestrator resolves turn 2's inputs from turn 1's outputs on disk.
      resolveInputs: () => ({
        "product-overview": readFileSync(join(ws, "product-overview.md"), "utf8"),
        nfrs: readFileSync(join(ws, "nfrs.md"), "utf8"),
        "design-guideline": readFileSync(join(ws, "design-brief.md"), "utf8"),
      }),
      provisionWorkspace: () => ({ workspaceDir: ws }),
      instructionsFor: () => ({ prompt: "Break F1 into stories from the PO seed." }),
      onRecord: () => {},
    };

    const result = await execute(step, ctx, deps);

    expect(result.violations).toEqual([]);
    expect(result.producedPaths).toContain(join(ws, "feature-spec.json"));
    const spec = JSON.parse(readFileSync(join(ws, "feature-spec.json"), "utf8")) as { stories: string[] };
    expect(spec.stories.length).toBeGreaterThanOrEqual(1);
    expect(result.bounded.action).toEqual({ kind: "design-complete" });
  });

  it("end-to-end: turn 1 output files satisfy turn 2's declared inputs (the chain holds)", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    const poSeed = manifestForAction(PO_SEED, manifests)!;
    const specAuthor = manifestForAction(SPEC_AUTHOR, manifests)!;
    // Every input turn 2 declares (by its `feature:<file>` source) is a file turn 1 produces.
    const producedFiles = new Set(poSeed.outputs.map((o) => o.filename));
    for (const input of specAuthor.inputs) {
      const file = input.source.replace(/^feature:/, "");
      expect(producedFiles.has(file), `turn 2 input "${input.id}" (${file}) is not produced by turn 1`).toBe(true);
    }
  });
});
