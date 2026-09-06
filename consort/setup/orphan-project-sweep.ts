// Orphan sweep: find + delete LEAKED scaffolded test projects. A live scaffold test
// (design-equivalence, driver-green, ...) creates a real project dir (e.g. de-live-<ts>/,
// dg-live-<ts>/) with a real Lakebase project, and normally tears it down in afterAll. But if the
// process is KILLED before teardown (e.g. the ~55min background-task cap), the Lakebase project is
// ORPHANED – it costs money and leaks until swept. This deterministic sweep finds such leftover
// project dirs under a parent, reads each one's Lakebase project id + host from the metadata the
// scaffold wrote (.env LAKEBASE_PROJECT_ID / DATABRICKS_HOST, cross-checked with
// .lakebase/workflow-state.json project_id), deletes the Lakebase project via an INJECTED seam
// (hermetic – the real caller wires scm-utils deleteLakebaseProject), then removes the local dir.
//
// Bounded + safe: it only matches dirs whose name matches a known test-project prefix (the run-config
// projectName templates: de-live-, dg-live-, and any caller-supplied prefix), and only touches a dir
// that carries BOTH the scaffold metadata markers (.lakebase/ + .env with a LAKEBASE_PROJECT_ID), so
// it can never delete an unrelated directory. Run it before/after any live scaffold suite so a killed
// run self-heals; it is a no-op when nothing is orphaned.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The default scaffolded-test-project dir name prefixes (the run-config projectName templates):
 *  design-equivalence (de-live-), driver-green (dg-live-). Callers can pass extra prefixes. */
export const DEFAULT_TEST_PROJECT_PREFIXES = ["de-live-", "dg-live-"] as const;

/** A leaked project the sweep found: its dir + the Lakebase identifiers read from its metadata. */
export interface OrphanProject {
  dir: string;
  projectId: string;
  host: string;
}

/** The Lakebase-project delete seam, injected so the sweep is hermetic. The real caller wires
 *  scm-utils deleteLakebaseProject({ projectId, host }); a test passes a spy. */
export type DeleteLakebaseProjectFn = (args: { projectId: string; host: string }) => Promise<void>;

/** Parse a KEY=VALUE .env line's value for one key (first match; trims quotes/whitespace). */
function readEnvValue(envText: string, key: string): string | undefined {
  for (const line of envText.split("\n")) {
    const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

/** Read a scaffolded project dir's Lakebase identifiers from the metadata the scaffold wrote:
 *  .env (LAKEBASE_PROJECT_ID + DATABRICKS_HOST) is the primary source; .lakebase/workflow-state.json
 *  (project_id) cross-checks the id. Returns null when the dir lacks the scaffold markers (so a
 *  non-scaffold dir is never swept). Exported for the sweep + tests. */
export function readScaffoldProjectMeta(dir: string): { projectId: string; host: string } | null {
  const envPath = join(dir, ".env");
  const lakebaseDir = join(dir, ".lakebase");
  // Require BOTH markers so we never touch a dir that isn't a scaffolded project.
  if (!existsSync(envPath) || !existsSync(lakebaseDir)) return null;

  const envText = readFileSync(envPath, "utf8");
  const projectId = readEnvValue(envText, "LAKEBASE_PROJECT_ID");
  const host = readEnvValue(envText, "DATABRICKS_HOST");
  if (!projectId || !host) return null;

  // Cross-check the id against .lakebase/workflow-state.json when present (belt-and-suspenders;
  // the .env id is authoritative, but a mismatch means the dir is not what we think it is).
  const wsPath = join(lakebaseDir, "workflow-state.json");
  if (existsSync(wsPath)) {
    try {
      const ws = JSON.parse(readFileSync(wsPath, "utf8")) as { project_id?: unknown };
      if (typeof ws.project_id === "string" && ws.project_id && ws.project_id !== projectId) return null;
    } catch {
      /* unparseable state – fall back to the .env id */
    }
  }
  return { projectId, host };
}

/** Find leaked scaffolded test-project dirs directly under `parentDir` whose name matches a known
 *  test-project prefix AND that carry the scaffold metadata markers. Pure (no deletion). */
export function findOrphanProjects(parentDir: string, prefixes: readonly string[] = DEFAULT_TEST_PROJECT_PREFIXES): OrphanProject[] {
  if (!existsSync(parentDir)) return [];
  const out: OrphanProject[] = [];
  for (const name of readdirSync(parentDir)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(parentDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const meta = readScaffoldProjectMeta(dir);
    if (meta) out.push({ dir, ...meta });
  }
  return out;
}

/** What a sweep did, per orphan. */
export interface SweptOrphan extends OrphanProject {
  /** The Lakebase project was deleted (false + error when the delete threw). */
  deleted: boolean;
  /** The local dir was removed. */
  dirRemoved: boolean;
  error?: string;
}

/**
 * Sweep leaked scaffolded test projects under `parentDir`: for each, delete its Lakebase project via
 * the injected `deleteLakebaseProject`, then remove the local dir. Best-effort per orphan (one failure
 * does not stop the rest); a delete failure leaves the dir so a later sweep retries. Returns a report.
 * A no-op (empty report) when nothing is orphaned. Run before/after any live scaffold suite.
 */
export async function sweepOrphanProjects(args: {
  parentDir: string;
  deleteLakebaseProject: DeleteLakebaseProjectFn;
  prefixes?: readonly string[];
}): Promise<SweptOrphan[]> {
  const orphans = findOrphanProjects(args.parentDir, args.prefixes);
  const report: SweptOrphan[] = [];
  for (const o of orphans) {
    let deleted = false;
    let dirRemoved = false;
    let error: string | undefined;
    try {
      await args.deleteLakebaseProject({ projectId: o.projectId, host: o.host });
      deleted = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Only remove the local dir once the Lakebase project is gone – otherwise a later sweep can
    // still read the metadata and retry the delete (removing the dir first would strand the project).
    if (deleted) {
      try {
        rmSync(o.dir, { recursive: true, force: true });
        dirRemoved = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    report.push({ ...o, deleted, dirRemoved, ...(error ? { error } : {}) });
  }
  return report;
}
