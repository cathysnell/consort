// An orchestration RUN-CONFIG bundles a full run: an optional `setup` lifecycle op, the
// ordered `steps` (references into a manifest set), and an optional `teardown` op. The runner
// runs setup ONCE before the chain and teardown ONCE after – even if the chain throws – so a
// headless demo is self-contained: scaffold a project, drive the steps, tear it down.
//
// Lifecycle ops are catalogued by kind (like agents): `scaffold-project` (real createProject,
// cloud-bound) + `remove-project` (delete repo + Lakebase + dir). Here we drive the runner
// with a MOCK lifecycle catalogue so the run-config wiring is hermetic; the real cloud ops
// are exercised only in a gated live run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runOrchestration, type OrchestrationRunConfig, type LifecycleDeps } from "../../consort/orchestrator/runners/orchestration-runner";
import type { ManifestRunnerDeps } from "../../consort/orchestrator/runners/manifest-runner";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

let ws: string;
let corpus: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "orch-run-ws-"));
  corpus = mkdtempSync(join(tmpdir(), "orch-run-corpus-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(corpus, { recursive: true, force: true });
});

const PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };
const SPEC_AUTHOR: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

function poSeedManifest(): StepManifest {
  return {
    id: "run-po-seed",
    role: "product-owner",
    match: { kind: "invoke-role", role: "product-owner", mode: "author-requests" },
    inputs: [],
    outputs: [{ id: "product-overview", filename: "product-overview.md", validator: "nonEmptyFile" }],
    routing: { produced: { next: SPEC_AUTHOR } },
    agentOptions: { session: "fresh" },
    agent: { kind: "replay", config: { role: "product-owner", seeds: [{ outputId: "product-overview", from: "product-overview.md", to: "product-overview.md" }] } },
  } as StepManifest;
}
function specAuthorManifest(): StepManifest {
  const spec = JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: ["S1-a"] }) + "\n";
  const log = JSON.stringify({ timestamp: "2026-08-03T12:00:00Z", level: "info", role: "spec-author", event: "artifact.written", message: "wrote it" }) + "\n";
  return {
    id: "run-spec-author",
    role: "spec-author",
    match: { kind: "invoke-role", role: "spec-author", mode: "breakdown" },
    inputs: [{ id: "product-overview", source: "feature:product-overview.md" }],
    outputs: [
      { id: "feature-spec", filename: "feature-spec.json", validator: "featureSpecNonEmptyStories" },
      { id: "agent-log", filename: "agent-log.jsonl", validator: "agentLogHasRoleEvent" },
    ],
    routing: { produced: { next: { kind: "design-complete" } } },
    agentOptions: { session: "fresh" },
    agent: { kind: "mock", config: { role: "spec-author", outputs: { "feature-spec.json": spec, "agent-log.jsonl": log } } },
  } as StepManifest;
}

function runnerDeps(): ManifestRunnerDeps {
  return {
    workspaceDir: ws,
    cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-x" } as ManifestRunnerDeps["cfg"],
    agentContext: { corpusRoot: corpus, kitDir: process.cwd() },
  };
}

describe("orchestration run-config: runner runs setup -> chain -> teardown", () => {
  it("runs setup ONCE before the chain and teardown ONCE after, in order", async () => {
    writeFileSync(join(corpus, "product-overview.md"), "# Overview\nrecorded.\n");
    const order: string[] = [];
    const lifecycle: LifecycleDeps = {
      run: async (op) => {
        order.push(`${op.kind}`);
        return { ok: true };
      },
    };
    const config: OrchestrationRunConfig = {
      id: "demo-run",
      setup: { kind: "scaffold-project", config: { projectName: "demo" } },
      start: PO_SEED,
      teardown: { kind: "remove-project", config: {} },
    };

    const result = await runOrchestration(config, [poSeedManifest(), specAuthorManifest()], runnerDeps(), lifecycle);

    // setup ran first, both turns ran, teardown ran last.
    expect(order).toEqual(["scaffold-project", "remove-project"]);
    expect(result.turns.map((t) => t.manifestId)).toEqual(["run-po-seed", "run-spec-author"]);
    for (const t of result.turns) expect(t.result.violations).toEqual([]);
    expect(result.setup?.ok).toBe(true);
    expect(result.teardown?.ok).toBe(true);
  });

  it("runs teardown EVEN IF the chain throws (finally semantics)", async () => {
    // No corpus seed => the replay agent throws (recorded file missing) mid-chain.
    const ran: string[] = [];
    const lifecycle: LifecycleDeps = {
      run: async (op) => {
        ran.push(op.kind);
        return { ok: true };
      },
    };
    const config: OrchestrationRunConfig = {
      id: "demo-run",
      setup: { kind: "scaffold-project", config: {} },
      start: PO_SEED,
      teardown: { kind: "remove-project", config: {} },
    };

    await expect(runOrchestration(config, [poSeedManifest(), specAuthorManifest()], runnerDeps(), lifecycle)).rejects.toThrow();
    // setup + teardown both ran despite the chain failure.
    expect(ran).toEqual(["scaffold-project", "remove-project"]);
  });

  it("a run-config with no setup/teardown just runs the chain (both optional)", async () => {
    writeFileSync(join(corpus, "product-overview.md"), "# Overview\nrecorded.\n");
    const lifecycle: LifecycleDeps = { run: async () => ({ ok: true }) };
    const config: OrchestrationRunConfig = { id: "bare", start: PO_SEED };
    const result = await runOrchestration(config, [poSeedManifest(), specAuthorManifest()], runnerDeps(), lifecycle);
    expect(result.turns).toHaveLength(2);
    expect(result.setup).toBeUndefined();
    expect(result.teardown).toBeUndefined();
  });

  it("aborts before the chain if setup fails (no turns run), and still tears down", async () => {
    const ran: string[] = [];
    const lifecycle: LifecycleDeps = {
      run: async (op) => {
        ran.push(op.kind);
        if (op.kind === "scaffold-project") return { ok: false, error: "scaffold failed" };
        return { ok: true };
      },
    };
    const config: OrchestrationRunConfig = {
      id: "demo",
      setup: { kind: "scaffold-project", config: {} },
      start: PO_SEED,
      teardown: { kind: "remove-project", config: {} },
    };
    const result = await runOrchestration(config, [poSeedManifest(), specAuthorManifest()], runnerDeps(), lifecycle);
    expect(result.setup?.ok).toBe(false);
    expect(result.turns).toEqual([]); // chain never started
    expect(ran).toEqual(["scaffold-project", "remove-project"]); // teardown still ran
  });
});
