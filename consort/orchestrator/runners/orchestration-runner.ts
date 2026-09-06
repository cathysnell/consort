// orchestration-runner: drives a full RUN from a run-config – an optional `setup` lifecycle
// op, the step chain, and an optional `teardown` op. The runner runs setup ONCE before the
// chain and teardown ONCE after (finally semantics: teardown runs even if the chain throws),
// so a headless demo is self-contained – scaffold a project, drive the steps, tear it down.
//
// Setup/teardown are RUN-SCOPED (not per-step manifests): a multi-step run scaffolds once and
// tears down once. Lifecycle ops are catalogued by kind (like agents), and INJECTED as
// LifecycleDeps so the run-config wiring is unit-tested with a mock; the real cloud ops
// (scaffold-project -> createProject; remove-project -> delete repo + Lakebase + dir) live in
// the lifecycle catalogue and run only in a gated live run.

import { runManifestChain, type ManifestRunnerDeps, type ManifestTurn } from "./manifest-runner.js";
import type { StepManifest } from "../steps/manifest.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
// The lifecycle-op contract (op / result / deps / run-context) lives in the provisioning family – the
// shared home between the ops' producer (the lifecycle catalogue) and this consumer (the run bracket).
import type {
  LifecycleOp,
  LifecycleResult,
  LifecycleDeps,
  LifecycleRunContext,
} from "../provisioning/lifecycle-types.js";
// Re-export so existing importers of these types from orchestration-runner keep working unchanged.
export type { LifecycleOp, LifecycleResult, LifecycleDeps, LifecycleRunContext } from "../provisioning/lifecycle-types.js";

/** A full orchestration run: lifecycle brackets + the step chain's start action. */
export interface OrchestrationRunConfig {
  id: string;
  /** Optional setup op run ONCE before the chain (e.g. scaffold a project). */
  setup?: LifecycleOp;
  /** The action the step chain starts from. */
  start: WorkflowAction;
  /** Optional teardown op run ONCE after the chain (finally; e.g. remove the project). */
  teardown?: LifecycleOp;
}

/** What a full run returns: the lifecycle results + every chain turn. */
export interface OrchestrationResult {
  turns: ManifestTurn[];
  setup?: LifecycleResult;
  teardown?: LifecycleResult;
}

/**
 * Run a full orchestration: setup (once) -> step chain -> teardown (once, finally).
 *  - setup runs first; if it FAILS (ok:false) the chain is SKIPPED but teardown still runs
 *    (so a half-scaffolded project is still cleaned up).
 *  - the chain runs via runManifestChain (agents resolved from each manifest.agent).
 *  - teardown runs in a `finally`, so it happens even if the chain throws; the original
 *    error is re-thrown after teardown.
 *  - the setup handle is threaded into teardown's context (so teardown knows what to remove).
 */
export async function runOrchestration(
  config: OrchestrationRunConfig,
  manifests: StepManifest[],
  runnerDeps: ManifestRunnerDeps,
  lifecycle: LifecycleDeps,
): Promise<OrchestrationResult> {
  const result: OrchestrationResult = { turns: [] };
  const ctx: LifecycleRunContext = { workspaceDir: runnerDeps.workspaceDir };

  // Setup – once, before anything.
  if (config.setup) {
    result.setup = await lifecycle.run(config.setup, ctx);
    if (result.setup.handle) ctx.setupHandle = result.setup.handle;
  }

  try {
    // Skip the chain when setup explicitly failed (still tears down in finally).
    if (!config.setup || result.setup?.ok) {
      result.turns = await runManifestChain(config.start, manifests, runnerDeps);
    }
  } finally {
    if (config.teardown) {
      result.teardown = await lifecycle.run(config.teardown, ctx);
    }
  }

  return result;
}
