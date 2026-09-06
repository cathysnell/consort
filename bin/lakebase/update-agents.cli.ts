#!/usr/bin/env node
// CLI wrapper around updateAgents. Refresh a scaffolded project's
// `.claude/agents/*.md` against the kit's current role-agent definitions, so a
// kit bugfix to a role prompt reaches an already-scaffolded project (create's
// copyMissingMd only seeds missing files, it never refreshes an existing one).
//
// Overwrites drifted agent defs by default (the propagation is the point);
// --dry-run previews, --keep-local preserves a project-edited agent.

import { updateAgents } from "../../consort/lakebase/update-agents.js";

interface ParsedArgs {
  projectDir?: string;
  dryRun?: boolean;
  keepLocal?: boolean;
  json?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
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

const HELP = `lakebase-update-agents – refresh .claude/agents/ from the current kit

Refreshes a scaffolded project's role-agent definitions (dba.md,
architect-reviewer.md, ...) against the kit's current defs. Use it after
updating the kit (./scripts/lk --warm, or a plugin update) so an agent-prompt
bugfix actually reaches the project – create-project only SEEDS agents, it does
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

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const projectDir = args.projectDir ?? process.cwd();
  const result = updateAgents({
    projectDir,
    dryRun: args.dryRun === true,
    force: args.keepLocal !== true,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  for (const f of result.files) {
    if (f.outcome === "unchanged") continue;
    process.stdout.write(`  ${f.outcome.padEnd(10)} ${f.name}\n`);
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
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
