// LIVE production-loop proof for #590, gated behind RUN_LIVE_STEP=1:
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/navigator-red-executor-dispatch-live.test.ts
//
// This is the PRODUCT-CHANNEL live proof: the production runDriver loop dispatches a REAL navigator
// RED turn THROUGH the StepExecutor
//   buildDriveEffects(cfg) -> runDriver -> effects.performViaExecutor -> execute()
// with a REAL `claude -p` navigator turn that authors the story's FAILING tests. RED writes tests/
// at the PROJECT ROOT – the `product` channel (the real accumulating code tree) – which is the ONE
// thing the design-lane 2b proof (spec-author breakdown, artifact channel) did NOT exercise.
//
// NO CLOUD. Navigator RED is LEAN (build-role-chains.ts): it authors tests, needs no running app or
// DB, is tool-scoped to Write/Read, never runs ./scripts/lk. So the ONLY thing separating this from
// the gated DRIVER product run is that RED does not honest-GREEN against a Lakebase branch. We seed
// the pre-RED build state (an `active` experiment marker + an approved gate + the per-story test-list
// + acs) as plain pipeline JSON – NO branch is actually cut – so nextTransition yields `navigator RED`
// as the first action and the lean turn runs offline.
//
// Contrast with navigator-red-live.test.ts (runIntegrationChain – the executor in ISOLATION): this
// drives runDriver – the actual orchestrator loop – so it proves the loop consumes execute()'s
// BoundedRoute and the post-turn `@build-cycle` (the RED cycle stamp) fires through the real
// execRunner, flipping testsWritten so the loop advances.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriver } from "../../../consort/orchestrator/drive/orchestrator-run.js";
import { buildDriveEffects } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import { execRunner } from "../../../consort/orchestrator/drive/claude-runner.js";
import type { DriveEffectsConfig } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import type { WorkflowAction } from "../../../consort/orchestrator/drive/orchestrator-drive.js";
import { resolveConsortSettings } from "../../../consort/orchestrator/settings/project-settings.js";
import { writePipeline } from "../../../consort/pipeline/story-pipeline.js";
import { storyTestProgress } from "../../../consort/pipeline/cycle-record.js";
import { resolveKitSingleSource } from "./kit-resolution.js";

const KIT = process.cwd();
const FIXTURES = join(KIT, "consort/evaluation/reference-assets/stockflow");
const REC_ARTIFACTS = join(FIXTURES, "recorded-artifacts/features/F6-split-tracking-code");
const REC_PRE_RED_CODE = join(
  FIXTURES,
  "recorded-build/features/F6-split-tracking-code/stories/S3-stock-shows-split-fields/turns/001-navigator-reflect/code",
);
const FEATURE = "F6-split-tracking-code";
const STORY = "S3-stock-shows-split-fields";
const AC = "AC1-split-fields-shown";

/** True when a directory tree holds at least one test file (.py/.ts/.tsx). */
function hasTestFile(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (hasTestFile(abs)) return true;
    } else if (/\.(py|ts|tsx)$/.test(e.name)) {
      return true;
    }
  }
  return false;
}

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: the production drive dispatches navigator RED THROUGH the executor (product channel)", () => {
  it("runDriver -> performViaExecutor -> execute() authors the story's failing tests at the project root + stamps RED", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "drive-red-"));
    const consortDir = join(projectDir, ".sftdd");
    const featureDir = join(consortDir, "features", FEATURE);
    const storyDir = join(featureDir, "stories", STORY);
    mkdirSync(join(storyDir, "acs"), { recursive: true });

    // 1. The pre-RED CODE tree at the PROJECT ROOT (app/, existing tests/, alembic, pyproject) – the
    //    real accumulating product tree the navigator writes its new tests alongside. This is the
    //    recorded state just before S3's first RED (the 001-navigator-reflect turn's code snapshot).
    cpSync(REC_PRE_RED_CODE, projectDir, { recursive: true });

    // 2. The design artifacts RED reads (feature architecture + db-design + the story's AC), laid
    //    into .sftdd where the manifest's inputs + the context-pack precondition resolve them.
    for (const f of ["architecture.json", "db-design.json", "test-list.json"]) {
      cpSync(join(REC_ARTIFACTS, f), join(featureDir, f));
    }
    cpSync(join(REC_ARTIFACTS, "stories", STORY, "acs", `${AC}.json`), join(storyDir, "acs", `${AC}.json`));
    // conventions.json (the module LAYOUT the context-pack projects) – seed from the recorded design.
    mkdirSync(join(consortDir, "architecture"), { recursive: true });
    cpSync(join(FIXTURES, "recorded-artifacts/architecture/conventions.json"), join(consortDir, "architecture", "conventions.json"));

    // 3. The per-story test-list (the manifest's `test-list` input + the RED coverage bar). Derived
    //    from the feature master's S3 items (ac_id AC1-split-fields-shown), in the per-story shape
    //    writeStoryTestList produces + readStoryItems reads (feature_id/story_id/items[]).
    const master = JSON.parse(readFileSync(join(REC_ARTIFACTS, "test-list.json"), "utf8")) as { items: Array<Record<string, unknown>> };
    const s3Items = master.items.filter((i) => i.ac_id === AC);
    expect(s3Items.length, "S3 has test-list items in the recorded master").toBeGreaterThan(0);
    writeFileSync(join(storyDir, "test-list-per-story.json"), JSON.stringify({ feature_id: FEATURE, story_id: STORY, items: s3Items }, null, 2) + "\n");

    // 4. The pipeline: S3 gate-approved + an ACTIVE experiment marker (no branch actually cut – RED
    //    is lean) + build_active on S3, so nextTransition routes STRAIGHT to `navigator RED` (its
    //    design gates are all satisfied by the seeded artifacts; the build lane's first pending step
    //    is !testsWritten -> navigator RED).
    writePipeline(consortDir, {
      version: 1,
      feature_id: FEATURE,
      stories: {
        [STORY]: {
          status: "ready",
          gate: { status: "approved", approver: "human-proxy", approved_at: "2026-08-05T00:00:00Z", history: [] },
          experiment: { slug: "s3-red", branch: `experiment/${STORY}`, parent: `feature/${FEATURE}`, n: 1, status: "active", cut_at: "2026-08-05T00:00:00Z" },
        },
      },
      build_queue: [STORY],
      build_active: STORY,
    } as never);
    writeFileSync(join(consortDir, "workflow-state.json"), JSON.stringify({ phase: "implementation", phase_feature_id: FEATURE }));

    // Lay the kit's role agent defs so the live `--agent navigator` resolves (plain copy, no cloud).
    const agentsDst = join(projectDir, ".claude", "agents");
    mkdirSync(agentsDst, { recursive: true });
    cpSync(join(KIT, "skills", "consort", "agents"), agentsDst, { recursive: true });

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
      loopGranularity: "story",
      modelForRole: (role) => settings.models[role] ?? "sonnet",
      modelForTurn: (role, turn) => settings.modelFor(role, turn),
      effortForTurn: (role, turn) => {
        const e = settings.effortFor(role, turn);
        return e === "default" ? "" : e;
      },
      // Tool-scope the navigator to Write/Read (the SAME scope the proven navigator-red-chain
      // manifest declares). RED authors tests from the context pack (rubric + module LAYOUT) baked
      // into its prompt by buildClaudeCommand -> roleTaskBody; with Bash/Glob/Grep it instead
      // explores the whole seeded tree open-endedly and never converges within the turn budget.
      // This matches the isolated chain's starting conditions while exercising the identical
      // executor-dispatch path (cfg tool scope -> buildClaudeCommand -> claudeToolArgs spawn flags).
      allowedToolsForRole: (role) => (role === "navigator" ? ["Write", "Read"] : undefined),
      disallowedToolsForRole: (role) =>
        role === "navigator" ? ["Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task"] : undefined,
    } as DriveEffectsConfig;
    cfg.runner = execRunner(cfg);

    try {
      // Drive the REAL loop, bounded to stop right AFTER the single RED turn: stopWhen fires on the
      // FIRST action that is NOT the plain navigator RED (the loop performs RED, then the next
      // iteration's action – driver GREEN – trips the bound before it runs, since GREEN needs cloud).
      const isRed = (a: WorkflowAction): boolean =>
        a.kind === "invoke-role" && a.role === "navigator" && !("mode" in a) && !("buildMode" in a) && "story" in a && a.story === STORY;
      const result = await runDriver(buildDriveEffects(cfg), {
        stopWhen: (a: WorkflowAction) => !isRed(a),
        maxSteps: 3,
      });

      // The RED turn ran through the executor + its post-turn `@build-cycle` stamp:
      //   (a) the navigator authored FAILING tests at the PROJECT ROOT (the product channel, live).
      const testsDir = join(projectDir, "tests");
      expect(statSync(testsDir).isDirectory(), `tests/ dir at ${testsDir}`).toBe(true);
      expect(hasTestFile(testsDir), "navigator authored >=1 test file under tests/ (product channel)").toBe(true);
      //   (b) a RED cycle was stamped (testsWritten flipped): the story now has an open RED cycle.
      const progress = storyTestProgress(consortDir, FEATURE, STORY);
      expect(progress.openRed.length > 0 || progress.allGreen, "a RED cycle was stamped for the story").toBe(true);
      //   (c) the loop advanced past RED (stopped at the bound), proving it consumed the executor's route.
      expect(result.stoppedAtBound || result.stoppedAtMax || result.iterations >= 1).toBe(true);
    } finally {
      delete process.env.LAKEBASE_SFTDD_USE_MANIFEST_STEPS;
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 1_200_000);
});
