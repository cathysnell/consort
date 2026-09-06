// LIVE, LEAN mock-PO -> live-spec-author chain (gated behind RUN_LIVE_STEP=1):
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/spec-author-breakdown-live.test.ts
//
// The 2-turn design chain driven entirely from manifests: turn 1 the PO Human Mock replays the
// recorded intake; turn 2 the REAL spec-author (claude) authors feature-spec.json from those
// inputs and emits an agent-report the orchestrator formats into a conformant agent-log.
//
// LEAN – NO cloud project. The live spec-author is tool-scoped (no Bash -> it never runs
// ./scripts/lk) and reports via the agent-report channel, so there is nothing a scaffolded
// Databricks/GitHub/Lakebase project would provide: the whole chain runs in a throwaway `.sftdd`
// workspace. (The earlier version scaffolded a real project; that was dead weight – removed.)
// Only ONE live agent here (spec-author); the PO is a deterministic replay.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layDownKitAgents } from "../../../consort/orchestrator/provisioning/bundle.js";
import { runManifestChain, type ManifestRunnerDeps } from "../../../consort/orchestrator/runners/manifest-runner.js";
import { loadStepManifests, type StepManifest } from "../../../consort/orchestrator/steps/manifest.js";
import type { WorkflowAction } from "../../../consort/orchestrator/drive/orchestrator-drive.js";
import type { DriveEffectsConfig } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import { resolveKitSingleSource } from "./kit-resolution.js";

const KIT = process.cwd();
const CORPUS = join(KIT, "tests/integration");
// The PO-seed + spec-author-breakdown pair this chain drives lives in the route-scenario set's
// own subdir (manifests/ now holds only per-purpose subdirs).
const MANIFEST_DIR = join(CORPUS, "manifests", "route-scenarios");
const INTAKE = join(CORPUS, "intake");
const FEATURE = "F1-stock-visibility";
const SPEC_REL = `.sftdd/features/${FEATURE}/feature-spec.json`;
const LOG_REL = ".sftdd/agent-log.jsonl";

const PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };

function instructionsFor(manifest: StepManifest): { prompt: string; guidelines: string[] } {
  if (manifest.role !== "spec-author") return { prompt: `Run ${manifest.role} step ${manifest.id}.`, guidelines: [] };
  return {
    prompt:
      `Break feature ${FEATURE} into its stories from the provided inputs (they are in this ` +
      `prompt – do NOT search the filesystem or read other projects). WRITE exactly these ` +
      `files, relative to your current working directory:\n` +
      `  - ${SPEC_REL}  (JSON: id, name, status "draft", tdd_mode, NON-EMPTY stories[])\n` +
      `  - a stub dir per story under .sftdd/features/${FEATURE}/stories/<S>/ (story.md + story.json)\n` +
      `Then STOP – do NOT run any shell command, do NOT run npx or ./scripts/lk, do NOT ` +
      `self-verify (the orchestrator validates your work). As the LAST thing in your reply, ` +
      `emit a fenced report block describing what you did:\n` +
      "```agent-report\n" +
      `[{ "level": "info", "event": "artifact.written", "message": "<one line: what you wrote>" }]\n` +
      "```\n" +
      `Add extra entries with level "warn" + event "open.question" for any ambiguity you surfaced.`,
    guidelines: [
      "feature-spec.json is REQUIRED and must have a non-empty stories[].",
      "End your reply with the ```agent-report block – the orchestrator formats it into the conformant agent log.",
      "Do NOT verify your own work or run any command; write the files, emit the report, stop.",
    ],
  };
}

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE (lean): mock PO -> live spec-author, no cloud scaffold", () => {
  it("drives the 2-turn chain from manifests in a throwaway workspace; the live spec-author authors a conformant feature-spec", async () => {
    const manifests = loadStepManifests(MANIFEST_DIR);
    // The agents are chosen by the MANIFESTS: PO replay, spec-author claude.
    expect(manifests.find((m) => m.role === "product-owner")?.agent?.kind).toBe("replay");
    expect(manifests.find((m) => m.role === "spec-author" && m.match.mode === "breakdown")?.agent?.kind).toBe("claude");

    // A throwaway workspace – NO scaffolded cloud project. The spec-author is tool-scoped out of
    // Bash + reports via the agent-report channel, so ./scripts/lk is never called.
    const workspaceDir = mkdtempSync(join(tmpdir(), "po-spec-author-"));
    mkdirSync(join(workspaceDir, ".sftdd"), { recursive: true });
    // Lay the kit's role agent defs into <workspaceDir>/.claude/agents/ so the live spec-author
    // resolves `--agent spec-author` – a plain file copy, no cloud project.
    layDownKitAgents(workspaceDir);

    const runnerDeps: ManifestRunnerDeps = {
      workspaceDir,
      cfg: { projectDir: workspaceDir, consortDir: join(workspaceDir, ".sftdd"), featureId: FEATURE } as DriveEffectsConfig,
      agentContext: { corpusRoot: INTAKE, kitDir: KIT },
      instructionsFor,
      // The spawned live agent authors an agent-report block; the orchestrator formats it into a
      // conformant agent-log.jsonl before validate-outputs (no lk subprocess needed).
      formatAgentReports: true,
      provisionWorkspace: (m) =>
        m.role === "spec-author"
          ? { workspaceDir, outputPaths: { "feature-spec": SPEC_REL, "agent-log": LOG_REL } }
          : { workspaceDir },
    };
    resolveKitSingleSource(KIT);

    try {
      // Cap at the 2 turns this test is about (PO seed -> live spec-author breakdown). The
      // route-scenarios/ dir also carries the downstream ux-designer manifest (a bare mock that
      // writes no design-guide, for the ROUTE suite), so an uncapped chain would flow into it and
      // block on its missing artifact. maxTurns:2 stops after the breakdown – the same cap the
      // hermetic manifest-runner 2-turn-chain test uses; the breakdown's honest next hop
      // (ux-designer) is still asserted below via specTurn.result.bounded.action.
      const turns = await runManifestChain(PO_SEED, manifests, runnerDeps, { maxTurns: 2 });

      // PO replayed, then the LIVE spec-author authored a conformant feature-spec.
      expect(turns.map((t) => t.manifestId)).toEqual(["po-seed", "spec-author"]);
      for (const t of turns) {
        expect(t.result.violations, `${t.manifestId}: ${t.result.violations.join("; ")}`).toEqual([]);
      }
      const specTurn = turns[turns.length - 1];
      expect(
        specTurn.result.producedPaths.some((p) => p.endsWith(SPEC_REL)),
        `spec-author produced: ${specTurn.result.producedPaths.join(", ")}`,
      ).toBe(true);
      // Honest next hop after breakdown for a uiTrack project: the UX Designer.
      expect(specTurn.result.bounded.action).toEqual({ kind: "invoke-role", role: "ux-designer" });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 900_000);
});
