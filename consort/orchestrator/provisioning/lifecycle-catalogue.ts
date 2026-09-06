// lifecycle-catalogue: the catalogue of RUN-SCOPED lifecycle ops a run-config's setup/teardown
// select by kind (mirrors the agent catalogue). A run-config declares
// `setup: { kind, config }` / `teardown: { kind, config }`; the runner's LifecycleDeps
// dispatches the kind through this catalogue.
//
// Kinds:
//   scaffold-project : create a REAL project via the kit createProject (Databricks + GitHub +
//                      Lakebase). Cloud-bound – needs creds; returns a handle (projectDir,
//                      lakebaseProjectId, repo url) teardown consumes.
//   remove-project   : delete what scaffold-project created (Lakebase project + local dir; the
//                      GitHub repo is left unless config.deleteRepo). Reads the setup handle.
//   inject-escalation: plant a REAL escalation into the workspace `.consort/escalations/` (via the
//                      shared writeEscalation), so a scenario can deterministically drive the
//                      revise/escalate route space – no flaky live navigator turn needed. The
//                      manifest runner's probeEscalation seam then derives it back off disk.
//
// resolveLifecycleKind throws loud on an unknown kind. The builders are pure (no cloud at
// import); the cloud calls happen only when a run actually invokes them (a gated live run).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createProject } from "../../lakebase/create-project.js";
import { writeEscalation } from "../../gates/escalation.js";
import { ARTIFACT_ROOT } from "../../config/consort-paths.js";
import type { LifecycleOp, LifecycleResult, LifecycleRunContext, LifecycleDeps } from "./lifecycle-types.js";

/** One catalogue entry: a description + the executor for that op kind. */
export interface LifecycleCatalogueEntry {
  description: string;
  configSummary: string;
  run(config: Record<string, unknown>, context: LifecycleRunContext): Promise<LifecycleResult>;
}

/** scaffold-project: real createProject into context.workspaceDir's parent, returning a
 *  teardown handle. Config carries the createProject inputs the caller must supply (project
 *  name, Databricks host, github owner, tiers, uiTrack, ...). Cloud-bound. */
async function scaffoldProject(config: Record<string, unknown>, context: LifecycleRunContext): Promise<LifecycleResult> {
  const c = config as {
    projectName?: string;
    parentDir?: string;
    databricksHost?: string;
    githubOwner?: string;
    createGithubRepo?: boolean;
    runnerType?: "self-hosted" | "github-hosted";
    tiers?: 1 | 2 | 3;
    uiTrack?: boolean;
    language?: "java" | "kotlin" | "python" | "nodejs";
  };
  if (!c.projectName) return { ok: false, error: "scaffold-project requires config.projectName" };
  if (!c.databricksHost) return { ok: false, error: "scaffold-project requires config.databricksHost" };
  const parentDir = c.parentDir ?? context.workspaceDir;
  try {
    const res = await createProject({
      projectName: c.projectName,
      parentDir,
      databricksHost: c.databricksHost,
      githubOwner: c.githubOwner,
      createGithubRepo: c.createGithubRepo,
      runnerType: c.runnerType,
      tiers: c.tiers,
      uiTrack: c.uiTrack,
      language: c.language,
    });
    // The full repo name teardown needs (gh repo delete + removeRunner both key off it). Prefer
    // deriving from the URL createProject returned; else owner/name.
    const repoFullName =
      (res.githubRepoUrl ? res.githubRepoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "") : undefined) ??
      (c.githubOwner && c.createGithubRepo !== false ? `${c.githubOwner}/${c.projectName}` : undefined);
    // createProject registers a SELF-HOSTED runner when it creates a repo (runnerType defaults
    // to self-hosted). Record whether teardown must de-register one.
    const runnerRegistered = !!repoFullName && (c.runnerType ?? "self-hosted") === "self-hosted";
    return {
      ok: true,
      handle: {
        projectDir: res.projectDir,
        projectName: c.projectName,
        lakebaseProjectId: res.lakebaseProjectId,
        lakebaseDefaultBranch: res.lakebaseDefaultBranch,
        githubRepoUrl: res.githubRepoUrl ?? null,
        githubRepoFullName: repoFullName ?? null,
        runnerRegistered,
        databricksHost: c.databricksHost,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The scaffold handle remove-project consumes. scaffold-project populates every field; a
 *  hand-built handle (tests) may omit the ones that don't apply. */
export interface ScaffoldHandle {
  projectDir?: string;
  projectName?: string;
  lakebaseProjectId?: string;
  /** The project's default Lakebase branch (the trunk features/experiments fork from). */
  lakebaseDefaultBranch?: string;
  databricksHost?: string;
  githubRepoUrl?: string | null;
  /** "<owner>/<name>" – what gh repo delete + removeRunner both key off. */
  githubRepoFullName?: string | null;
  /** True when scaffold registered a self-hosted runner that must be de-registered. */
  runnerRegistered?: boolean;
}

/** The cloud/side effects remove-project performs, injected so the teardown ORDER is pinned
 *  hermetically (tests pass fakes; production wires the real scm-utils + gh calls). This is the
 *  SAME never-leaking sequence create-project.test.ts uses: de-register the runner, delete the
 *  repo, delete the Lakebase project. */
export interface RemoveProjectEffects {
  stopRunner(projectName: string): void;
  removeRunner(args: { fullRepoName: string; projectName: string }): Promise<void>;
  deleteGithubRepo(fullRepoName: string): void;
  deleteLakebaseProject(args: { projectId: string; host: string }): Promise<void>;
}

/** The real effects – scm-utils runner/Lakebase ops + `gh repo delete`. Imported lazily so the
 *  hermetic tests + no-cloud paths never pull the cloud client at module load. */
async function realRemoveProjectEffects(): Promise<RemoveProjectEffects> {
  const scm = await import("@databricks-solutions/lakebase-scm-utils/lakebase");
  return {
    stopRunner: (name) => scm.stopRunner(name),
    removeRunner: (a) => scm.removeRunner(a as never),
    deleteGithubRepo: (repo) => {
      execFileSync("gh", ["repo", "delete", repo, "--yes"], { stdio: "ignore", timeout: 30_000 });
    },
    deleteLakebaseProject: (a) => scm.deleteLakebaseProject({ projectId: a.projectId, host: a.host } as never),
  };
}

/**
 * remove-project: tear down EVERYTHING scaffold-project created – the self-hosted runner, the
 * GitHub repo, the Lakebase project, and the local dir. This is the proven teardown ported from
 * create-project.test.ts + scm-utils; the earlier version only deleted Lakebase + dir, which
 * leaked the repo + runner on every run.
 *
 * ORDER matters: de-register the runner BEFORE deleting the repo (the GitHub API call needs the
 * repo to still exist), then delete the repo, then the Lakebase project, then the dir. Every
 * step is best-effort – a failure is collected, not thrown, and the remaining steps still run,
 * so one broken step never strands the rest (teardown must not mask a chain error). Reports
 * ok:false with the joined errors if anything failed.
 */
export async function removeProject(
  config: Record<string, unknown>,
  context: LifecycleRunContext,
  effectsOverride?: RemoveProjectEffects,
): Promise<LifecycleResult> {
  const handle = context.setupHandle as ScaffoldHandle | undefined;
  if (!handle) return { ok: false, error: "remove-project: no setup handle (nothing to tear down)" };
  void config;

  // Only build the (cloud) effects when there is real cloud work to do – a pure local-dir
  // teardown (tests, no-cloud runs) stays hermetic and never imports the cloud client.
  const needsCloud = !!(handle.runnerRegistered || handle.githubRepoFullName || (handle.lakebaseProjectId && handle.databricksHost));
  const fx = effectsOverride ?? (needsCloud ? await realRemoveProjectEffects() : undefined);
  const errors: string[] = [];

  // 1. De-register the self-hosted runner (before the repo is gone). Both scm-utils calls key
  //    off the repo/project name the scaffold recorded.
  if (fx && handle.runnerRegistered && handle.githubRepoFullName && handle.projectName) {
    try { fx.stopRunner(handle.projectName); } catch (e) { errors.push(`stopRunner: ${e instanceof Error ? e.message : String(e)}`); }
    try { await fx.removeRunner({ fullRepoName: handle.githubRepoFullName, projectName: handle.projectName }); }
    catch (e) { errors.push(`removeRunner: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // 2. Delete the GitHub repo.
  if (fx && handle.githubRepoFullName) {
    try { fx.deleteGithubRepo(handle.githubRepoFullName); }
    catch (e) { errors.push(`gh repo delete: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // 3. Delete the Lakebase project.
  let lakebaseDeleted = true; // vacuously true when there was no Lakebase project to delete
  if (fx && handle.lakebaseProjectId && handle.databricksHost) {
    lakebaseDeleted = false;
    try { await fx.deleteLakebaseProject({ projectId: handle.lakebaseProjectId, host: handle.databricksHost }); lakebaseDeleted = true; }
    catch (e) { errors.push(`Lakebase delete: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // 4. Remove the local project dir – but ONLY once the Lakebase project is actually gone. The local
  //    dir carries the scaffold markers (.env LAKEBASE_PROJECT_ID + .lakebase/) that the ORPHAN SWEEP
  //    keys off to reclaim a stranded project. Removing the dir after a FAILED Lakebase delete would
  //    strand the project with no local marker to recover it from – exactly the leak seen on the
  //    Stage-5 driver-green run (a transient delete failure + the dir gone => the sweep found nothing).
  //    So on a failed delete we KEEP the dir; the next orphan sweep (pre/post any live scaffold suite)
  //    re-reads its .env and retries the delete. This mirrors sweepOrphanProjects' own ordering.
  if (handle.projectDir) {
    if (lakebaseDeleted) {
      try { rmSync(handle.projectDir, { recursive: true, force: true }); }
      catch (e) { errors.push(`dir remove: ${e instanceof Error ? e.message : String(e)}`); }
    } else {
      errors.push(`dir KEPT (${handle.projectDir}) – Lakebase delete failed; left for the orphan sweep to retry`);
    }
  }

  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
}

/** inject-escalation: write a REAL escalation into the workspace `.consort/escalations/` so a
 *  scenario can deterministically exercise the revise/escalate route space. Reuses the shared
 *  writeEscalation (the same fn the live orchestrator uses), so the planted file is byte-shaped
 *  exactly like a real one and the disk probe classifies it identically. A `smell:<name>` source
 *  with a story_id is what makes a SPEC-level smell routable (-> revise-route); a plain source
 *  (or no story) stays terminal (-> raise-to-hil). Pure filesystem, no cloud. */
async function injectEscalation(config: Record<string, unknown>, context: LifecycleRunContext): Promise<LifecycleResult> {
  const c = config as { source?: string; reason?: string; story_id?: string; feature_id?: string };
  if (!c.source) return { ok: false, error: "inject-escalation requires config.source (e.g. \"smell:reflect-spec-defect\")" };
  if (!c.reason) return { ok: false, error: "inject-escalation requires config.reason" };
  try {
    const esc = writeEscalation(join(context.workspaceDir, ARTIFACT_ROOT), {
      source: c.source,
      reason: c.reason,
      ...(c.feature_id ? { feature_id: c.feature_id } : {}),
      ...(c.story_id ? { story_id: c.story_id } : {}),
    });
    return { ok: true, handle: { escalationId: esc.id } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The lifecycle catalogue: kind -> entry. */
export const LIFECYCLE_CATALOGUE: Record<string, LifecycleCatalogueEntry> = {
  "scaffold-project": {
    description: "Create a REAL project via the kit createProject (Databricks + GitHub + Lakebase). Cloud-bound; returns a teardown handle.",
    configSummary: "{ projectName (required), databricksHost (required), parentDir?, githubOwner?, createGithubRepo?, tiers?, uiTrack?, language? }",
    run: scaffoldProject,
  },
  "remove-project": {
    description: "Delete what scaffold-project created (Lakebase project + local dir), reading the setup handle. Best-effort.",
    configSummary: "{ } (consumes the scaffold-project handle from the run context)",
    run: removeProject,
  },
  "inject-escalation": {
    description: "Plant a REAL escalation into the workspace .consort/escalations/ (via writeEscalation) so a scenario deterministically drives the revise/escalate route space. Pure filesystem.",
    configSummary: "{ source (required, e.g. \"smell:reflect-spec-defect\"), reason (required), story_id?, feature_id? }",
    run: injectEscalation,
  },
};

/** Resolve a lifecycle kind to its catalogue entry. THROWS loud on an unknown kind. */
export function resolveLifecycleKind(kind: string): LifecycleCatalogueEntry {
  const entry = LIFECYCLE_CATALOGUE[kind];
  if (!entry) {
    const known = Object.keys(LIFECYCLE_CATALOGUE).sort().join(", ");
    throw new Error(`lifecycle-catalogue: unknown lifecycle kind "${kind}". Known: ${known}.`);
  }
  return entry;
}

/** The real LifecycleDeps that dispatch through the catalogue – pass this to runOrchestration
 *  for a live run (tests inject a mock instead). */
export const catalogueLifecycleDeps: LifecycleDeps = {
  run: (op: LifecycleOp, context: LifecycleRunContext) => resolveLifecycleKind(op.kind).run(op.config ?? {}, context),
};
