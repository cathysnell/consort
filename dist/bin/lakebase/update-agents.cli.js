#!/usr/bin/env node

// consort/lakebase/update-agents.ts
import * as fs from "fs";
import * as path from "path";
function findKitAgentsDir(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "skills", "consort", "agents");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate skills/consort/agents/ relative to ${start}. Pass explicit kitDir.`
  );
}
function updateAgents(args) {
  const projectAgentsDir = path.join(args.projectDir, ".claude", "agents");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const kitAgentsDir = args.kitDir ? path.join(args.kitDir, "skills", "consort", "agents") : findKitAgentsDir(here);
  const dryRun = args.dryRun === true;
  const force = args.force !== false;
  const sourceFiles = fs.existsSync(kitAgentsDir) ? fs.readdirSync(kitAgentsDir).filter((f) => f.endsWith(".md")) : [];
  if (!dryRun && sourceFiles.length > 0 && !fs.existsSync(projectAgentsDir)) {
    fs.mkdirSync(projectAgentsDir, { recursive: true });
  }
  const files = [];
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

// bin/lakebase/update-agents.cli.ts
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project-dir":
      case "-C":
        out.projectDir = argv[++i];
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--keep-local":
        out.keepLocal = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (!a.startsWith("-") && !out.projectDir) out.projectDir = a;
        break;
    }
  }
  return out;
}
var HELP = `lakebase-update-agents \u2013 refresh .claude/agents/ from the current kit

Refreshes a scaffolded project's role-agent definitions (dba.md,
architect-reviewer.md, ...) against the kit's current defs. Use it after
updating the kit (./scripts/lk --warm, or a plugin update) so an agent-prompt
bugfix actually reaches the project , create-project only SEEDS agents, it does
not refresh ones already on disk.

Usage:
  lakebase-update-agents [path]               overwrite drifted agents (default)
  lakebase-update-agents [path] --dry-run     preview without writing
  lakebase-update-agents [path] --keep-local  keep project-edited agents (report "preserved")

Flags:
  --project-dir <path>, -C <path>   Project root (defaults to current directory)
  --dry-run                         Report what would change; write nothing
  --keep-local                      Do NOT overwrite a drifted (locally-edited) agent
  --json                            Emit a JSON report on stdout instead of human text
  --help, -h                        Show this help

Output: a human-readable summary on stdout (or JSON with --json).
        Exit 0 on success (whether or not changes were applied); 1 on failure.
`;
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const projectDir = args.projectDir ?? process.cwd();
  const result = updateAgents({
    projectDir,
    dryRun: args.dryRun === true,
    force: args.keepLocal !== true
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  for (const f of result.files) {
    if (f.outcome === "unchanged") continue;
    process.stdout.write(`  ${f.outcome.padEnd(10)} ${f.name}
`);
  }
  if (args.dryRun) {
    process.stdout.write("\n(dry-run: no files were written)\n");
  } else if (!result.changed) {
    process.stdout.write("Agents are in sync with the kit. Nothing to do.\n");
  } else {
    process.stdout.write("\nDone.\n");
  }
  return 0;
}
try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
