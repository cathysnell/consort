// Shared scaffold+worktree primitives for the GATED live harnesses (design-equivalence + driver-green).
// The #589 model: scaffold a project ONCE, then give each unit of work (a design step, a driver-green
// candidate) its OWN git WORKTREE off the scaffold's committed HEAD – a clean, production-shaped tree with
// a pristine .consort bootstrap – so units run in PARALLEL with zero shared mutable state. The design tier
// needs only filesystem isolation (a fresh worktree IS a complete reset, since design roles never touch the
// DB); the build/driver tier ALSO cuts a Lakebase BRANCH per worktree (cutExperiment, #589) for DB
// isolation. These helpers are the worktree half, factored out of design-equivalence-support.ts so both
// harnesses share ONE implementation rather than each rolling its own.

import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree } from "@databricks-solutions/lakebase-scm-utils/git";
import { layDownKitAgents } from "../../../consort/orchestrator/provisioning/bundle.js";
import { ARTIFACT_ROOT } from "../../../consort/config/consort-paths.js";

/** Force-remove a per-unit worktree. scm-utils removeWorktree has no --force, but a unit leaves a dirty
 *  tree (it wrote artifacts / ran the app into the worktree), so a plain `git worktree remove` would
 *  refuse. Force-remove; if git balks (locked), rm the dir + prune the metadata so the scaffold's .git is
 *  clean for the next cut. Best-effort – the whole scaffold is deleted in teardown anyway. */
export function forceRemoveWorktree(projectDir: string, wtDir: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: projectDir, stdio: "ignore", timeout: 30_000 });
    return;
  } catch {
    /* fall through to rm + prune */
  }
  try { rmSync(wtDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { execFileSync("git", ["worktree", "prune"], { cwd: projectDir, stdio: "ignore", timeout: 30_000 }); } catch { /* ignore */ }
}

let worktreeSeq = 0;

/** Cut a fresh git worktree off a scaffold's committed HEAD for ONE unit of work: a clean,
 *  production-shaped tree (pristine .consort bootstrap + .claude/agents + scripts/lk + .lakebase from
 *  HEAD). Copies the gitignored `.env` (Databricks host/profile – not in HEAD) so the tree mirrors the
 *  scaffold exactly, and re-lays the freshest kit agents. Returns the worktree dir + its .consort. Retries
 *  a transient `git worktree add` collision (parallel units share the scaffold's .git metadata).
 *
 *  Generic: `label` names the unit (a design step, a candidate id); `branchPrefix` namespaces the throwaway
 *  worktree branch (e.g. "de-eq" / "dg"). The design + driver harnesses wrap this with their own extras. */
export async function cutWorktree(args: {
  projectDir: string;
  worktreesRoot: string;
  label: string;
  branchPrefix: string;
  kitDir: string;
}): Promise<{ wtDir: string; consortDir: string }> {
  const { projectDir, worktreesRoot, label, branchPrefix, kitDir } = args;
  const unique = `${label}-${Date.now().toString(36)}-${worktreeSeq++}`;
  const wtDir = join(worktreesRoot, unique); // MUST NOT exist – git creates it
  const branch = `${branchPrefix}/${unique}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await createWorktree({ cwd: projectDir, path: wtDir, branch });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  if (lastErr) throw new Error(`git worktree add for ${label} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);

  // Mirror the scaffold's gitignored .env into the worktree (host/profile for fidelity), best-effort.
  const baseEnv = join(projectDir, ".env");
  if (existsSync(baseEnv)) cpSync(baseEnv, join(wtDir, ".env"));
  // Freshest kit agents (overwrite; HEAD already carries a copy).
  layDownKitAgents(wtDir, kitDir);

  return { wtDir, consortDir: join(wtDir, ARTIFACT_ROOT) };
}
