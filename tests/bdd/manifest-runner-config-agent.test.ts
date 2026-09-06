// The runner resolves each turn's agent FROM the manifest's `agent: {kind, config}` via the
// agent catalogue – no injected agentFor, no per-script decision. The demo/caller supplies
// only the ENV (agentContext: corpusRoot/kitDir) + the shared workspace; WHICH agent each
// step uses is DATA in the manifest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runManifestStep, runManifestChain, type ManifestRunnerDeps } from "../../consort/orchestrator/runners/manifest-runner";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

let ws: string;
let corpus: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "cfg-agent-ws-"));
  corpus = mkdtempSync(join(tmpdir(), "cfg-agent-corpus-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(corpus, { recursive: true, force: true });
});

const PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };
const SPEC_AUTHOR: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

/** A PO-seed manifest whose agent is a `replay` kind – the agent choice is IN THE MANIFEST. */
function poSeedManifest(): StepManifest {
  return {
    id: "cfg-po-seed",
    role: "product-owner",
    match: { kind: "invoke-role", role: "product-owner", mode: "author-requests" },
    inputs: [],
    outputs: [
      { id: "product-overview", filename: "product-overview.md", validator: "nonEmptyFile" },
      { id: "agent-log", filename: "agent-log.jsonl", validator: "productOwnerLoggedAuthoring" },
    ],
    routing: { produced: { next: { kind: "invoke-role", role: "spec-author", mode: "breakdown" } } },
    agentOptions: { session: "fresh" },
    agent: {
      kind: "replay",
      config: { role: "product-owner", seeds: [{ outputId: "product-overview", from: "product-overview.md", to: "product-overview.md" }] },
    },
  } as StepManifest;
}

/** A spec-author manifest whose agent is a `mock` kind (stands in for claude in a hermetic
 *  test) – again, the agent choice is DATA in the manifest, not code. */
function specAuthorManifest(): StepManifest {
  const spec = JSON.stringify({ id: "F1-x", name: "Feature X", status: "draft", tdd_mode: "N=1", stories: ["S1-a"] }) + "\n";
  const log = JSON.stringify({ timestamp: "2026-08-03T12:00:00Z", level: "info", role: "spec-author", event: "artifact.written", message: "wrote feature-spec.json" }) + "\n";
  return {
    id: "cfg-spec-author",
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

function deps(): ManifestRunnerDeps {
  return {
    workspaceDir: ws,
    cfg: { projectDir: ws, consortDir: join(ws, ".sftdd"), featureId: "F1-x" } as ManifestRunnerDeps["cfg"],
    agentContext: { corpusRoot: corpus, kitDir: process.cwd() },
    // NOTE: no agentFor – the runner resolves the agent from manifest.agent.
  };
}

describe("runner: agent resolved FROM manifest.agent via the catalogue (config-driven)", () => {
  it("turn 1 uses the manifest's replay agent to emit the recorded seed", async () => {
    writeFileSync(join(corpus, "product-overview.md"), "# Overview\nrecorded.\n");
    const res = await runManifestStep(PO_SEED, [poSeedManifest()], deps());
    expect(res.violations).toEqual([]);
    expect(readFileSync(join(ws, "product-overview.md"), "utf8")).toBe("# Overview\nrecorded.\n");
    expect(res.bounded.action).toEqual(SPEC_AUTHOR);
  });

  it("turn 2 uses the manifest's (mock) agent to produce feature-spec.json", async () => {
    // Seed the input file turn 2 declares (as turn 1 would have), THEN run.
    writeFileSync(join(ws, "product-overview.md"), "# Overview\n");
    const res = await runManifestStep(SPEC_AUTHOR, [specAuthorManifest()], deps());
    expect(res.violations).toEqual([]);
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);
    expect(res.bounded.action).toEqual({ kind: "design-complete" });
  });

  it("drives the full 2-turn chain with agents resolved entirely from config", async () => {
    writeFileSync(join(corpus, "product-overview.md"), "# Overview\nrecorded.\n");
    const manifests = [poSeedManifest(), specAuthorManifest()];
    const turns = await runManifestChain(PO_SEED, manifests, deps());
    expect(turns.map((t) => t.manifestId)).toEqual(["cfg-po-seed", "cfg-spec-author"]);
    for (const t of turns) expect(t.result.violations).toEqual([]);
    expect(existsSync(join(ws, "feature-spec.json"))).toBe(true);
  });

  it("THROWS loud when a manifest declares neither agent nor an agentFor override", async () => {
    const m = poSeedManifest();
    delete (m as { agent?: unknown }).agent;
    await expect(runManifestStep(PO_SEED, [m], deps())).rejects.toThrow(/agent|no agent|kind/i);
  });
});
