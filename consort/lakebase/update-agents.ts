// In-place refresh for a scaffolded project's `.claude/agents/` against the
// kit's current role-agent definitions (skills/consort/agents/*.md). Sibling to
// updateCommands.
//
// WHY THIS EXISTS: create-project seeds .claude/agents/ once (copyMissingMd,
// which SKIPS any file already present). So a kit bugfix to a role prompt (e.g.
// the DBA realizes_invariants prose fix) never reaches an already-scaffolded
// project – the driver keeps spawning the stale agent. updateAgents is the
// fixer: it force-refreshes the agent defs from the running kit, so
// `./scripts/lk lakebase-update-agents` (or a version-aware auto-resync) closes
// the gap. Agent defs are kit-owned; unlike commands there are no placeholders
// to substitute and no project-owned hook files to preserve.

import * as fs from "node:fs";
import * as path from "node:path";

export type AgentUpdateOutcome = "added" | "updated" | "unchanged" | "preserved";

export interface AgentFileUpdate {
  /** File name (e.g. "dba.md"). */
  name: string;
  outcome: AgentUpdateOutcome;
}

export interface UpdateAgentsArgs {
  /** Project directory containing `.claude/agents/`. */
  projectDir: string;
  /**
   * Kit directory containing `skills/consort/agents/`. Default: walk up from
   * this module looking for the agents-source marker.
   */
  kitDir?: string;
  /** Report what WOULD change without writing. Default: false. */
  dryRun?: boolean;
  /**
   * When false, a project agent file whose body has drifted from the kit is
   * LEFT untouched (reported "preserved") instead of overwritten. Default: true
   * – the whole point is to propagate kit bugfixes, so the default overwrites.
   */
  force?: boolean;
}

export interface UpdateAgentsResult {
  files: AgentFileUpdate[];
  /** True iff anything actually changed on disk (or would, in dryRun). */
  changed: boolean;
}

function findKitAgentsDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "skills", "consort", "agents");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate skills/consort/agents/ relative to ${start}. Pass explicit kitDir.`,
  );
}

/**
 * Refresh a scaffolded project's `.claude/agents/*.md` in place from the kit's
 * current role-agent definitions.
 *
 * Defaults:
 *   - WRITES the kit's current agent def over the project's copy.
 *   - force:true (default) overwrites a drifted project agent (the propagation
 *     path). force:false leaves a drifted file untouched, reported "preserved"
 *     (so a caller can confirm per-file).
 *   - CREATES `.claude/agents/` if missing; ADDS any agent the project lacks.
 *   - dryRun:true reports the same outcomes without touching disk.
 *
 * Outcomes: "added" (project lacked it), "updated" (content differed, written),
 * "unchanged" (byte-identical), "preserved" (drifted + force:false, left alone).
 */
export function updateAgents(args: UpdateAgentsArgs): UpdateAgentsResult {
  const projectAgentsDir = path.join(args.projectDir, ".claude", "agents");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const kitAgentsDir = args.kitDir
    ? path.join(args.kitDir, "skills", "consort", "agents")
    : findKitAgentsDir(here);

  const dryRun = args.dryRun === true;
  const force = args.force !== false;

  const sourceFiles = fs.existsSync(kitAgentsDir)
    ? fs.readdirSync(kitAgentsDir).filter((f) => f.endsWith(".md"))
    : [];

  if (!dryRun && sourceFiles.length > 0 && !fs.existsSync(projectAgentsDir)) {
    fs.mkdirSync(projectAgentsDir, { recursive: true });
  }

  const files: AgentFileUpdate[] = [];
  let changed = false;

  for (const name of sourceFiles) {
    const projectPath = path.join(projectAgentsDir, name);
    const desired = fs.readFileSync(path.join(kitAgentsDir, name), "utf-8");

    if (!fs.existsSync(projectPath)) {
      files.push({ name, outcome: "added" });
      changed = true;
      if (!dryRun) fs.writeFileSync(projectPath, desired);
      continue;
    }
    const current = fs.readFileSync(projectPath, "utf-8");
    if (current === desired) {
      files.push({ name, outcome: "unchanged" });
      continue;
    }
    // Drifted from the kit.
    if (!force) {
      files.push({ name, outcome: "preserved" });
      continue;
    }
    files.push({ name, outcome: "updated" });
    changed = true;
    if (!dryRun) fs.writeFileSync(projectPath, desired);
  }

  return { files, changed };
}
