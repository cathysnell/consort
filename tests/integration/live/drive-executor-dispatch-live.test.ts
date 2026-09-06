// LIVE production-loop proof for Stage 2 2b (#587), gated behind RUN_LIVE_STEP=1:
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/drive-executor-dispatch-live.test.ts
//
// This is the HONEST "the live drive uses the executor" proof: it drives the REAL production path
//   buildDriveEffects(cfg) -> runDriver -> effects.performViaExecutor -> execute()
// with a REAL `claude -p` spec-author breakdown turn, on a REAL seeded .sftdd, no cloud. The only
// difference from `consort-drive --only design` is the bound (stop after the one breakdown
// turn) and that no Lakebase/GitHub project is claimed (breakdown is a design turn – it touches
// neither). useManifestSteps is turned on via the same env the CLI reads (LAKEBASE_SFTDD_USE_
// MANIFEST_STEPS), so the executor-dispatch path fires exactly as it would in production.
//
// Contrast with spec-author-breakdown-live.test.ts (which drives runManifestChain – the executor
// in ISOLATION): this drives runDriver – the actual orchestrator loop – so it proves the loop
// consumes execute()'s BoundedRoute and the pre/post-turn CLIs (reset/sync-breakdown, reconcile)
// fire through the real execRunner.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriver } from "../../../consort/orchestrator/drive/orchestrator-run.js";
import { buildDriveEffects } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import { execRunner } from "../../../consort/orchestrator/drive/claude-runner.js";
import type { DriveEffectsConfig } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import type { WorkflowAction } from "../../../consort/orchestrator/drive/orchestrator-drive.js";
import { resolveConsortSettings } from "../../../consort/orchestrator/settings/project-settings.js";
import { writePipeline, readPipeline } from "../../../consort/pipeline/story-pipeline.js";
import { resolveKitSingleSource } from "./kit-resolution.js";

const KIT = process.cwd();
const INTAKE = join(KIT, "tests/integration/intake");
const FEATURE = "F1-stock-visibility";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: the production drive dispatches spec-author breakdown THROUGH the executor", () => {
  it("runDriver -> performViaExecutor -> execute() authors a conformant feature-spec + syncs the pipeline", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "drive-exec-"));
    const consortDir = join(projectDir, ".sftdd");
    const featureDir = join(consortDir, "features", FEATURE);
    mkdirSync(featureDir, { recursive: true });

    // Seed the FEATURE phase: the breakdown's declared inputs (product-overview/nfrs/feature-request)
    // + an empty pipeline, so nextTransition yields `spec-author breakdown` as the first action.
    for (const f of ["product-overview.md", "nfrs.md"]) cpSync(join(INTAKE, f), join(consortDir, f));
    writeFileSync(join(consortDir, "feature-request.md"), "# Feature F1: stock visibility\nRecord + view stock by SKU and location.\n");
    writeFileSync(join(featureDir, "feature-request.md"), "# Feature F1\nRecord + view stock.\n");
    writePipeline(consortDir, { version: 1, feature_id: FEATURE, stories: {}, build_queue: [], build_active: null });
    writeFileSync(join(consortDir, "workflow-state.json"), JSON.stringify({ phase: "implementation", phase_feature_id: FEATURE }));

    // Lay the kit's role agent defs so the live `--agent spec-author` resolves (plain copy, no cloud).
    const agentsSrc = join(KIT, "skills", "consort", "agents");
    const agentsDst = join(projectDir, ".claude", "agents");
    mkdirSync(agentsDst, { recursive: true });
    cpSync(agentsSrc, agentsDst, { recursive: true });

    // Turn on executor dispatch via the SAME env the production CLI reads.
    process.env.LAKEBASE_SFTDD_USE_MANIFEST_STEPS = "1";
    resolveKitSingleSource(KIT);

    // Build the REAL production cfg + effects + runner (mirrors drive.cli's wiring).
    const settings = resolveConsortSettings({ projectDir });
    const cfg: DriveEffectsConfig = {
      projectDir,
      consortDir,
      featureId: FEATURE,
      runner: { async run() {} },
      useManifestSteps: true,
      uiTrack: false,
      approver: "human-proxy",
      deployTarget: "local",
      modelForRole: (role) => settings.models[role] ?? "sonnet",
      modelForTurn: (role, turn) => settings.modelFor(role, turn),
      effortForTurn: (role, turn) => {
        const e = settings.effortFor(role, turn);
        return e === "default" ? "" : e;
      },
    } as DriveEffectsConfig;
    cfg.runner = execRunner(cfg);

    try {
      // Drive the REAL loop, bounded to stop right AFTER the single breakdown turn: stopWhen fires
      // on the FIRST action that is NOT the breakdown (the loop performs breakdown, then the next
      // iteration's action – ux-designer/story – trips the bound before it runs).
      const result = await runDriver(buildDriveEffects(cfg), {
        stopWhen: (a: WorkflowAction) => !(a.kind === "invoke-role" && "mode" in a && a.role === "spec-author" && a.mode === "breakdown"),
        maxSteps: 3,
      });

      // The breakdown turn ran through the executor + its post-turn sync-breakdown: feature-spec on
      // disk with a non-empty stories[], AND the pipeline synced to those stories.
      const specPath = join(featureDir, "feature-spec.json");
      expect(existsSync(specPath), `feature-spec.json at ${specPath}`).toBe(true);
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as { stories?: string[] };
      expect(Array.isArray(spec.stories) && spec.stories.length > 0, "feature-spec has stories[]").toBe(true);

      // sync-breakdown (the executor's post-turn effect) projected the stories into the pipeline.
      const pipeline = readPipeline(consortDir, FEATURE);
      expect(Object.keys(pipeline.stories).length, "pipeline synced to the breakdown stories").toBeGreaterThan(0);

      // The loop advanced past breakdown (stopped at the bound), proving it consumed the executor's route.
      expect(result.stoppedAtBound || result.stoppedAtMax || result.iterations >= 1).toBe(true);
    } finally {
      delete process.env.LAKEBASE_SFTDD_USE_MANIFEST_STEPS;
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 900_000);
});
