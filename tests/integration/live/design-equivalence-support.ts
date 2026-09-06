// Shared support for the GATED design-equivalence LIVE check – the UNCONSTRAINED-channel sibling of
// the lean design-equivalence attempt. The lean version (tool-scoped Write/Read, throwaway .consort)
// could NOT run faithfully: the production roleTaskBody ends each design turn with a `./scripts/lk`
// self-check the agent must pass before returning, and `lk` runs ONLY from the unconstrained channel
// (Bash + the workspace scripts/lk shim on a scaffolded tree). Lean omits that self-correction step,
// so it measured production-turn-MINUS-self-check (a strictly lesser turn). This harness runs the
// design roles the way production does:
//
//   scaffold-project ONCE (beforeAll) -> for each design step: cut a fresh git WORKTREE off the
//   scaffold's committed HEAD -> seed the faithful recorded upstream into the worktree's .consort ->
//   run the PRODUCTION-body turn UNCONSTRAINED (Bash allowed, so ./scripts/lk self-check runs) ->
//   judge the output vs the pin -> remove the worktree -> next step -> remove-project.
//
// WHY WORKTREE-PER-STEP (not scaffold-once-and-reset): the scaffold commits a PRISTINE .consort/
// bootstrap (+ .claude/agents, scripts/lk, .lakebase config) into the initial commit – the artifact
// root is NOT gitignored (only the two per-run files agent-log.jsonl/run-config.json are). So
// `git worktree add <dir> -b <branch>` off HEAD gives each step a fresh, production-shaped, fully
// ISOLATED tree with a clean .consort – no snapshot, no rm+restore reset, and steps can run in
// PARALLEL (each worktree is independent). This mirrors production (a real branch per unit of work,
// the #589 design) far better than mutating one shared tree.
//
// CONFIG-DRIVEN + on the EXISTING orchestration machinery (no bespoke create/teardown): the workspace
// host comes from the ONE config home (resolveTestEnv -> .env.local.test.config), scaffold + teardown
// are the catalogued lifecycle ops (scaffold-project / remove-project), same as driver-green. A real
// Lakebase project IS created (for consistency) even though design roles never touch the DB.
//
// RESET CONTRACT (tiered + DB-aware): design roles only Write/Read design docs into .consort – they
// never run alembic or insert rows – so a fresh worktree off HEAD is a COMPLETE reset for the design
// tier (filesystem-only, by construction). When this pattern extends to CODE/build turns (driver GREEN
// runs `alembic upgrade` + inserts test rows), the worktree gives filesystem isolation but the SHARED
// Lakebase project does NOT reset itself: the build tier MUST additionally cut a Lakebase BRANCH per
// worktree (cutExperiment, #589) so the DB state is isolated + torn down with the branch. The design
// harness leaves that DB isolation unimplemented BY DESIGN (nothing to undo) but names it here.
//
// ORPHAN SWEEP: scaffold projects land under KIT (de-live-<ts>/). If a run is KILLED before afterAll
// (the ~55min background-task cap), the Lakebase project ORPHANS. beforeAll pre-sweeps + afterAll
// post-sweeps leaked de-live-* dirs via the deterministic orphan-project-sweep (real scm-utils delete),
// so a killed run self-heals on the next run.

import { expect } from "vitest";
import { mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cutWorktree, forceRemoveWorktree } from "./shared-scaffold-support.js";
import { loadRunConfig } from "../../../consort/orchestrator/runners/run-config-loader.js";
import { resolveTestEnv } from "../../../consort/orchestrator/provisioning/test-env.js";
import { layDownKitAgents } from "../../../consort/orchestrator/provisioning/bundle.js";
import { catalogueLifecycleDeps } from "../../../consort/orchestrator/provisioning/lifecycle-catalogue.js";
import type { ScaffoldHandle } from "../../../consort/orchestrator/provisioning/lifecycle-catalogue.js";
import type { LifecycleRunContext } from "../../../consort/orchestrator/provisioning/lifecycle-types.js";
import { buildDriveEffects, type DriveEffectsConfig } from "../../../consort/orchestrator/drive/orchestrator-effects.js";
import { execRunner } from "../../../consort/orchestrator/drive/claude-runner.js";
import { resolveConsortSettings } from "../../../consort/orchestrator/settings/project-settings.js";
import { loadConsortConfig, defaultConsortConfig, writeConsortConfig } from "../../../consort/config/consort-config-file.js";
import { sweepOrphanProjects } from "../../../consort/setup/orphan-project-sweep.js";
import type { WorkflowAction, DriveState } from "../../../consort/orchestrator/drive/orchestrator-drive.js";
import type { ValidateBoundDeps } from "../../../consort/orchestrator/steps/step-contract.js";
import { evaluateSemanticGate, makeOpusJudge, SEMANTIC_THRESHOLD } from "../../../consort/evaluation/semantic-gate.js";
import type { TurnKey } from "../../../consort/orchestrator/settings/project-settings.js";
import { designSpec, DESIGN_LIVE_STEPS, FEATURE, type DesignLiveSpec } from "./executor-dispatch-live-support.js";
import { resolveKitSingleSource, assertKitSingleSource, clearKitSingleSource } from "./kit-resolution.js";

export const KIT = process.cwd();
const SETUP_DIR = join(KIT, "tests/integration/live/design-equivalence-setup");
const RUN_CONFIG_PATH = join(SETUP_DIR, "design-equivalence.run.json");
/** The pin's recorded-artifacts – the faithful recorded upstream each equivalence seed copies from. */
const PIN_ARTIFACTS = join(KIT, "consort/evaluation/reference-assets/stockflow/recorded-artifacts");

export { DESIGN_LIVE_STEPS, FEATURE };

const routerDeps: ValidateBoundDeps = {
  allowed: () => ({ kind: "state-derived" }) as unknown as WorkflowAction,
  reviseBudgetAvailable: () => true,
  recordRetry: () => ({ sanctioned: true }),
};

/** Resolve the scaffold config from this check's run-config, exporting the config-home host as
 *  DATABRICKS_HOST so the run-config's required ${DATABRICKS_HOST} marker resolves (mirrors driver-
 *  green). Returns "" host when the config home is unset => the caller's gate skips. */
export function resolveDesignEquivRunConfig(): { host: string; scaffoldConfig: Record<string, unknown> } {
  const host = resolveTestEnv().host ?? "";
  if (host && !process.env.DATABRICKS_HOST) process.env.DATABRICKS_HOST = host;
  if (!host) return { host: "", scaffoldConfig: {} };
  const cfg = loadRunConfig(RUN_CONFIG_PATH);
  const scaffoldConfig = (cfg.setup?.config ?? {}) as Record<string, unknown>;
  return { host: String(scaffoldConfig.databricksHost ?? host), scaffoldConfig };
}

/** True when a directory tree holds at least one file (the acs/ dir-primary check). */
function nonEmptyDir(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
}

/** Pre-clean/post-clean leaked de-live-* scaffold dirs under KIT (a run killed before teardown orphans
 *  its Lakebase project). Best-effort + no-op when nothing is orphaned or the cloud env is unset. Wires
 *  the REAL scm-utils delete; the orphan sweep reads each dir's projectId/host from its own metadata. */
export async function sweepDesignEquivOrphans(): Promise<void> {
  try {
    const scm = await import("@databricks-solutions/lakebase-scm-utils/lakebase");
    const report = await sweepOrphanProjects({
      parentDir: KIT,
      deleteLakebaseProject: (a) => scm.deleteLakebaseProject({ projectId: a.projectId, host: a.host } as never),
    });
    if (report.length) {
      // eslint-disable-next-line no-console
      console.log(`[design-equivalence] orphan sweep: ${report.map((r) => `${r.projectId}=${r.deleted ? "deleted" : `LEFT (${r.error ?? "?"})`}`).join(", ")}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[design-equivalence] orphan sweep skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The scaffolded project a design-equivalence run drives – held for the lifetime of the suite so all
 *  design steps share ONE scaffold (amortized). Each step cuts its OWN worktree off the committed HEAD
 *  (no shared mutable .consort), so there is nothing to reset between steps. */
export interface DesignEquivProject {
  projectDir: string;
  handle: ScaffoldHandle;
  teardownCtx: LifecycleRunContext;
  /** A temp dir the per-step worktrees are cut under (each step gets `<worktreesRoot>/<step>-<n>`). */
  worktreesRoot: string;
}

/** SCAFFOLD ONCE: a real project (Databricks + Lakebase + optional GitHub) via the catalogued
 *  scaffold-project op, reading databricksHost from the run-config. The scaffold commits a PRISTINE
 *  .consort/ bootstrap (+ .claude/agents, scripts/lk, .lakebase config) into its initial commit, so
 *  every per-step worktree checks out a clean, production-shaped tree. Pre-sweeps orphans first. */
export async function scaffoldDesignEquivProject(): Promise<DesignEquivProject> {
  await sweepDesignEquivOrphans();
  const { scaffoldConfig } = resolveDesignEquivRunConfig();
  const setupCtx: LifecycleRunContext = { workspaceDir: KIT };
  const setup = await catalogueLifecycleDeps.run({ kind: "scaffold-project", config: scaffoldConfig }, setupCtx);
  if (!setup.ok || !setup.handle) throw new Error(`scaffold-project failed: ${setup.error ?? "no handle"}`);
  const handle = setup.handle as ScaffoldHandle;
  const projectDir = handle.projectDir!;
  // Ensure the FRESHEST kit role agents on the base tree (the scaffold committed a copy; overwrite so
  // a kit change since scaffold is reflected). Worktrees inherit .claude/agents from HEAD, and each is
  // re-laid at cut time for the same freshness guarantee.
  layDownKitAgents(projectDir, KIT);

  const worktreesRoot = mkdtempSync(join(tmpdir(), "de-worktrees-"));
  // Suite-scoped env, set ONCE (constant for every step) so PARALLEL steps never race a per-step
  // set/delete: the manifest-step path + the kit dir the `lk` shim resolves. Cleared in teardown.
  process.env.LAKEBASE_SFTDD_USE_MANIFEST_STEPS = "1";
  // ONE kit resolution (split-brain-safe): pin the local ref's cache slot to THIS checkout + write the
  // ref hint into the project so the env-less claude -p design agents resolve the SAME bits. Per-step
  // worktrees are cut off this scaffold's HEAD and share the same kit root + pinned ref (never
  // LAKEBASE_KIT_DIR, which the agent process does not inherit).
  resolveKitSingleSource(KIT);
  assertKitSingleSource(projectDir, KIT);
  return { projectDir, handle, teardownCtx: { workspaceDir: KIT, setupHandle: setup.handle }, worktreesRoot };
}

/** TEARDOWN: remove everything scaffold-project created (never-leaking catalogue remove-project) +
 *  drop the worktrees-root temp dir, then post-sweep any orphan a killed sibling run left. */
export async function teardownDesignEquivProject(project: DesignEquivProject): Promise<void> {
  try {
    await catalogueLifecycleDeps.run({ kind: "remove-project", config: {} }, project.teardownCtx);
  } finally {
    delete process.env.LAKEBASE_SFTDD_USE_MANIFEST_STEPS;
    clearKitSingleSource();
    rmSync(project.worktreesRoot, { recursive: true, force: true });
    await sweepDesignEquivOrphans();
  }
}

/** Cut a fresh git worktree off the scaffold's committed HEAD for one design step. Delegates the generic
 *  worktree mechanics (add + retry + .env mirror + agent re-lay) to the shared `cutWorktree`, then applies
 *  the design-only extra: writing uiTrack through to the worktree's on-disk config when the knob is set. */
async function cutStepWorktree(project: DesignEquivProject, step: TurnKey): Promise<{ wtDir: string; consortDir: string }> {
  const { wtDir, consortDir } = await cutWorktree({
    projectDir: project.projectDir,
    worktreesRoot: project.worktreesRoot,
    label: String(step),
    branchPrefix: "de-eq",
    kitDir: KIT,
  });

  // DESIGN_EQUIV_UITRACK=1 must reach DISK, not just cfg. The test-analyst-roster preparer resolves
  // project.uiTrack from the worktree's `.lakebase/consort-config.json` (resolveProjectSettings), so
  // the client analyst is enabled ONLY when the on-disk config says uiTrack:true. Setting cfg.uiTrack
  // alone (equivCfg) drives readDriveStateFromDisk but NOT the roster gate. Write it through here so
  // the knob is real end-to-end and disk stays the single source of truth for uiTrack.
  if (process.env.DESIGN_EQUIV_UITRACK === "1") {
    const config = loadConsortConfig(wtDir) ?? defaultConsortConfig();
    config.project = { ...(config.project ?? {}), uiTrack: true };
    writeConsortConfig(wtDir, config, { force: true });
  }

  return { wtDir, consortDir };
}

/** The DriveEffectsConfig for a design-equivalence turn: UNCONSTRAINED (Bash allowed) so the role's
 *  ./scripts/lk self-check runs exactly as production does. NO taskSuffix – the production buildTaskBody
 *  is the whole prompt (the equivalence proof measures the REAL production turn). PINS the model to
 *  `corpusModel` – the model the corpus recorded this turn on – so the comparison is LIKE-FOR-LIKE:
 *  the judge scores the current output against a SAME-MODEL reference, isolating agent/prompt quality
 *  from model-default drift (e.g. test-strategist's shipped default is now sonnet but the corpus is opus;
 *  judging sonnet-vs-opus conflates the two). effort still follows the shipped per-role config. */
function equivCfg(projectDir: string, consortDir: string, corpusModel: string): DriveEffectsConfig {
  const settings = resolveConsortSettings({ projectDir });
  const cfg: DriveEffectsConfig = {
    projectDir,
    consortDir,
    featureId: FEATURE,
    runner: { async run() {} },
    useManifestSteps: true,
    // uiTrack defaults FALSE (the API-only design tier). DESIGN_EQUIV_UITRACK=1 flips it ON so a
    // UI-bearing turn (e.g. test-list, whose corpus reference has client-render tests because
    // stockflow has a frontend) is judged like-for-like against a frontend-aware reference.
    uiTrack: process.env.DESIGN_EQUIV_UITRACK === "1",
    approver: "human-proxy",
    deployTarget: "local",
    loopGranularity: "story",
    // PIN the model to the corpus's recorded model for a fair, same-model comparison.
    modelForRole: () => corpusModel,
    modelForTurn: () => corpusModel,
    effortForTurn: (role, turn) => {
      const e = settings.effortFor(role, turn);
      return e === "default" ? "" : e;
    },
    // UNCONSTRAINED: the design role gets the full production tool set (Bash for ./scripts/lk). NO
    // taskSuffix set => performViaExecutor uses the pure production buildTaskBody.
  } as DriveEffectsConfig;
  cfg.runner = execRunner(cfg);
  return cfg;
}

/** Seed a spec's faithful recorded upstream (equivalenceSeed) into the worktree's .consort. */
function seedUpstream(consortDir: string, spec: DesignLiveSpec): void {
  const seed = spec.equivalenceSeed ?? spec.seed;
  for (const s of seed) {
    const dest = join(consortDir, s.rel);
    mkdirSync(dirname(dest), { recursive: true });
    const withAbs = s as { rel: string; from?: string; fromAbs?: string; content?: string };
    if (withAbs.fromAbs) cpSync(withAbs.fromAbs, dest, { recursive: true });
    else if (s.from) cpSync(join(KIT, "tests/integration/intake", s.from), dest);
    else writeFileSync(dest, s.content ?? "seed\n");
  }
}

/**
 * Run ONE design step's PRODUCTION-body turn in its OWN worktree, judge it vs the pin, and remove the
 * worktree. Cuts a fresh worktree off the scaffold HEAD (clean .consort by construction), seeds the
 * faithful recorded upstream, dispatches through the shipped performViaExecutor path with the pure
 * production prompt (unconstrained, so ./scripts/lk self-check runs), asserts the artifact landed, then
 * judges semantic equivalence to the pin at spec.step (per-story slice for the story-scoped roles).
 * Always removes the worktree afterward (finally). No shared state, so steps are safe to run in parallel.
 */
export async function runDesignEquivStep(project: DesignEquivProject, step: TurnKey): Promise<void> {
  const spec = designSpec(step);
  const { wtDir, consortDir } = await cutStepWorktree(project, step);

  // LAKEBASE_SFTDD_USE_MANIFEST_STEPS + LAKEBASE_KIT_DIR are set ONCE in scaffoldDesignEquivProject
  // (constant for the whole suite) so parallel steps never race a per-step set/delete.
  try {
    seedUpstream(consortDir, spec);
    const cfg = equivCfg(wtDir, consortDir, spec.corpusModel);
    const state = { phase: "feature" } as unknown as DriveState;
    const effects = buildDriveEffects(cfg);
    const bounded = await effects.performViaExecutor!(spec.action, state, routerDeps);
    expect(bounded, `${spec.name} should be executor-dispatched`).toBeDefined();

    // The artifact landed under .consort at its feature/story-scoped path (the artifact channel).
    const artifactAbs = join(consortDir, spec.artifactRel);
    if (spec.artifactIsDir) {
      expect(nonEmptyDir(artifactAbs), `${spec.name} produced a non-empty ${spec.artifactRel}/`).toBe(true);
    } else {
      expect(existsSync(artifactAbs), `${spec.name} produced ${spec.artifactRel}`).toBe(true);
    }

    // Judge semantic equivalence to the pin – the SHARED judge, per-story slice where the role is
    // story-scoped (its feature artifact is accreted across stories in the real drive).
    const referencePaths = spec.equivalenceReferencePaths?.(KIT);
    const outcome = await evaluateSemanticGate({
      kitRoot: KIT,
      consortDir,
      featureId: FEATURE,
      step: spec.step,
      judge: makeOpusJudge({ cwd: KIT }),
      ...(spec.equivalenceStoryId ? { storyId: spec.equivalenceStoryId } : {}),
      ...(referencePaths?.length ? { referencePaths } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[design-equivalence] ${step} (model=${spec.corpusModel}, corpus-pinned): ${outcome.skipped ? "SKIPPED (no pinned reference)" : outcome.passed ? `PASSED (score ${outcome.score?.toFixed(2)} >= ${SEMANTIC_THRESHOLD})` : `FAILED – ${outcome.reason}`}`,
    );
    expect(
      outcome.passed,
      `${step}: produced artifact not semantically equivalent to the pin – ${outcome.reason ?? "below threshold"}`,
    ).toBe(true);
  } finally {
    // Remove the worktree (fresh one per step => nothing to reset; the whole scaffold is torn down in
    // afterAll). For the build tier, ALSO drop this step's Lakebase branch here (see the header note).
    forceRemoveWorktree(project.projectDir, wtDir);
  }
}

/** One step's outcome in a parallel run: passed, or the assertion/dispatch error message. */
export interface DesignEquivStepResult {
  step: TurnKey;
  passed: boolean;
  error?: string;
}

/**
 * Run every design step in PARALLEL on the ONE scaffold, bounded to `concurrency` at a time (each in
 * its OWN worktree => no shared state to race). Collects each step's outcome instead of throwing, so
 * one failing step never aborts the rest (the caller asserts on the collected results). This is the
 * cap-safe shape: 8 sequential ~15min turns would blow the ~55min background-task lifetime, but
 * ~3-4-wide fan-out finishes the wall-clock in well under the cap. Concurrency is bounded (not
 * all-at-once) so N `claude -p` spawns don't thrash the host.
 */
export async function runDesignEquivStepsParallel(
  project: DesignEquivProject,
  steps: readonly TurnKey[],
  concurrency = 4,
): Promise<DesignEquivStepResult[]> {
  const queue = [...steps];
  const results: DesignEquivStepResult[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const step = queue.shift();
      if (!step) return;
      try {
        await runDesignEquivStep(project, step);
        results.push({ step, passed: true });
      } catch (e) {
        results.push({ step, passed: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, steps.length)) }, worker));
  // Stable order (queue draining is nondeterministic under concurrency) for a readable report.
  const order = new Map(steps.map((s, i) => [s, i]));
  results.sort((a, b) => (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0));
  return results;
}
