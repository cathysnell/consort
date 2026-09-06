// route-scenario: an isolated scenario that proves ONE route pathway out of a design step end
// to end, LEAN – no cloud project. Each scenario is DATA (the manifests that drive it + an
// optional escalation inject + the expected bounded route), and one shared driver runs it
// against a throwaway `.consort` workspace on disk.
//
// "Live, not hermetic" here means the scenario exercises the REAL stack – the real manifest
// runner, the real StepExecutor, a real escalation planted on disk, and the real disk probe
// deriving it back – NOT a mocked route decision. It just does not need a scaffolded cloud
// project: the route pathways depend on `.consort` state, not on Databricks/GitHub. (The
// live-claude authoring path, which DOES need a scaffolded project so ./scripts/lk resolves, is
// covered separately by stockflow-demo-config-live.test.ts.)
//
// Shape: make a temp workspace + `.consort` -> run the seed turns (reach the pre-condition) ->
// optionally inject a real escalation -> run the STEP UNDER TEST with probeEscalation on ->
// assert its bounded route -> remove the workspace (finally).

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManifestStep, type ManifestRunnerDeps } from "../runners/manifest-runner.js";
import { loadStepManifests, type StepManifest } from "../steps/manifest.js";
import { ARTIFACT_ROOT } from "../../config/consort-paths.js";
import { catalogueLifecycleDeps } from "../provisioning/lifecycle-catalogue.js";
import type { LifecycleOp } from "../provisioning/lifecycle-types.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
import type { DriveEffectsConfig } from "../drive/orchestrator-effects.js";

/** One route scenario – DATA. Lean: no cloud scaffold, just a `.consort` workspace. */
export interface RouteScenario {
  /** Stable id (also the assertion label). */
  id: string;
  /** One-line human description of the pathway under test. */
  description: string;
  /** The feature id the scenario designs. */
  feature: string;
  /** Directory holding the step manifests that drive this scenario. */
  manifestDir: string;
  /** Directory holding the recorded intake seeds the replay/PO turns copy in. */
  intakeDir: string;
  /** The seed actions to run (in order) to reach the pre-condition (e.g. PO seed). Each must
   *  have a matching manifest in manifestDir. */
  seedActions: WorkflowAction[];
  /** Optional escalation to inject into the workspace `.consort` AFTER the seeds and BEFORE the
   *  step under test – this is what makes a revise/escalate scenario deterministic. A
   *  filesystem-only inject-escalation lifecycle op. */
  injectEscalation?: LifecycleOp;
  /** The single action whose ROUTE is under test (run last, with probeEscalation on). */
  stepUnderTest: WorkflowAction;
  /** The bounded action the step under test MUST route to (subset match via routeMatches). */
  expectedRoute: WorkflowAction | Partial<WorkflowAction>;
  /** Optional: the step under test's agent should produce a NONCONFORMANT primary output (or
   *  none), so validate-outputs fails and the step is BLOCKED (a bounded retry of the same
   *  action). The suite's agent factory reads this to drive the `blocked` outcome without
   *  hardcoding scenario ids. Default false (a conformant produced turn). */
  nonconformantPrimary?: boolean;
}

/** What one scenario run reports. */
export interface RouteScenarioResult {
  id: string;
  /** The bounded action the step under test actually routed to. */
  actualRoute: WorkflowAction;
}

/** How the suite builds the runner deps (agents per manifest role) for a scenario + workspace.
 *  Kept as a hook so the driver stays agnostic to agent wiring (PO replay + a deterministic
 *  spec-author, for a route scenario). probeEscalation is forced by the driver per phase. */
export interface RouteScenarioHooks {
  runnerDeps(scenario: RouteScenario, workspaceDir: string, cfg: DriveEffectsConfig): ManifestRunnerDeps;
}

/**
 * Run ONE route scenario end to end, LEAN:
 *   1. make a throwaway workspace + `.consort`.
 *   2. run each seed action through the manifest runner (probeEscalation OFF).
 *   3. if injectEscalation is set, plant a real escalation into the workspace `.consort`.
 *   4. run the step under test with probeEscalation ON – its bounded route is the assertion.
 *   5. remove the workspace (finally).
 * No cloud: scaffold/teardown are a temp dir. Teardown ALWAYS runs (finally).
 */
export async function runRouteScenario(
  scenario: RouteScenario,
  hooks: RouteScenarioHooks,
): Promise<RouteScenarioResult> {
  const manifests = loadStepManifests(scenario.manifestDir);
  const workspaceDir = mkdtempSync(join(tmpdir(), `route-scn-${scenario.id}-`));
  mkdirSync(join(workspaceDir, ARTIFACT_ROOT), { recursive: true });
  const cfg = {
    projectDir: workspaceDir,
    consortDir: join(workspaceDir, ARTIFACT_ROOT),
    featureId: scenario.feature,
  } as DriveEffectsConfig;

  try {
    const baseDeps = hooks.runnerDeps(scenario, workspaceDir, cfg);

    // 2. seeds – reach the pre-condition (probeEscalation OFF).
    for (const action of scenario.seedActions) {
      await runManifestStep(action, manifests, { ...baseDeps, probeEscalation: false });
    }

    // 3. inject a real escalation (revise/escalate scenarios only) – filesystem, no cloud.
    if (scenario.injectEscalation) {
      const inj = await catalogueLifecycleDeps.run(scenario.injectEscalation, { workspaceDir });
      if (!inj.ok) throw new Error(`inject-escalation failed: ${inj.error}`);
    }

    // 4. the step under test – probeEscalation ON so the disk escalation drives the route.
    const res = await runManifestStep(scenario.stepUnderTest, manifests, { ...baseDeps, probeEscalation: true });
    return { id: scenario.id, actualRoute: res.bounded.action };
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

/** A subset match: every key in `expected` must deep-equal the same key in `actual`. Lets a
 *  scenario assert the route SHAPE (kind + role + gate) without pinning volatile fields. */
export function routeMatches(actual: WorkflowAction, expected: WorkflowAction | Partial<WorkflowAction>): boolean {
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return Object.keys(e).every((k) => JSON.stringify(a[k]) === JSON.stringify(e[k]));
}
