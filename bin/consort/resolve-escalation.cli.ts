#!/usr/bin/env node
// consort-resolve-escalation: clear a HIL escalation once its root cause is fixed,
// so the driver retries the failed action fresh on the next run. This is the
// SUPPORTED alternative to `rm`-ing `.consort/escalations/<id>.json` by hand (which
// destroys the audit trail): it stamps `resolved_at` (+ an optional note) and KEEPS
// the record. `firstPendingEscalation` ignores anything resolved, so the drive stops
// pre-empting to raise-to-hil and re-attempts.
//
//   consort-resolve-escalation --list                 # show pending escalations
//   consort-resolve-escalation [--id <id>] [--all] [--feature <id>] [--story <id>] [--resolution "<why>"]
//
// With no scope and exactly one pending escalation, resolves it; with several,
// lists them and asks for --id or --all. Exit 0 resolved/listed, 2 needs a choice / none.

import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { readEscalations, resolveEscalations, escalationsFromSmells, type Escalation } from "../../consort/gates/escalation.js";
import { resolveOpenSmells } from "../../consort/smells/smells.js";

interface Args {
  projectDir: string;
  consortDir?: string;
  id?: string;
  feature?: string;
  story?: string;
  resolution?: string;
  all: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { projectDir: process.cwd(), all: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "--id": out.id = argv[++i]; break;
      case "--feature": out.feature = argv[++i]; break;
      case "--story": out.story = argv[++i]; break;
      case "--resolution": out.resolution = argv[++i]; break;
      case "--all": out.all = true; break;
      case "--list": out.list = true; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-resolve-escalation – clear a HIL escalation after fixing its root cause.\n\n" +
            "  consort-resolve-escalation --list\n" +
            "  consort-resolve-escalation [--id <id>] [--all] [--feature <id>] [--story <id>] [--resolution \"<why>\"]\n\n" +
            "Stamps resolved_at (keeps the record); the driver then retries the failed action. Do NOT rm the file.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

const describe = (e: Escalation): string =>
  `  ${e.id}\n      source: ${e.source}  reason: ${e.reason}` +
  `${e.feature_id ? `  feature: ${e.feature_id}` : ""}${e.story_id ? `  story: ${e.story_id}` : ""}`;

/** Does an escalation match the requested scope? */
function inScope(e: Escalation, args: Args): boolean {
  if (args.id) return e.id === args.id;
  if (args.feature && e.feature_id !== undefined && e.feature_id !== args.feature) return false;
  if (args.story && e.story_id !== args.story) return false;
  return true;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  // A HIL halt has TWO sources (the dual-source rule): explicit escalation FILES and
  // BLOCKING SMELLS in smells.json. "Clear the halt" must cover both – T27's blocker
  // is smell-derived, not a file. List + resolve both.
  const fileEscalations = readEscalations(consortDir).filter((e) => !e.resolved_at);
  const smellEscalations = escalationsFromSmells(consortDir, args.feature);
  const pending = [...fileEscalations, ...smellEscalations];

  if (args.list) {
    if (!pending.length) { process.stdout.write("consort-resolve-escalation: no pending escalations or blocking smells.\n"); return 0; }
    process.stdout.write(`consort-resolve-escalation: ${pending.length} pending blocker(s):\n${pending.map(describe).join("\n")}\n`);
    return 0;
  }

  if (!pending.length) {
    process.stdout.write("consort-resolve-escalation: nothing pending to resolve.\n");
    return 0;
  }

  // Explicit scope wins; otherwise auto-resolve iff exactly one blocker is pending.
  const scoped = Boolean(args.id || args.feature || args.story || args.all);
  if (!scoped && pending.length > 1) {
    process.stderr.write(
      `consort-resolve-escalation: ${pending.length} blockers are pending – specify which to clear with --id <id>, ` +
        `or --all to clear them all:\n${pending.map(describe).join("\n")}\n`,
    );
    return 2;
  }

  const resolved: string[] = [];
  // (1) File escalations – stamp resolved_at (keeps the record).
  resolved.push(
    ...resolveEscalations(consortDir, {
      ...(args.id ? { id: args.id } : {}),
      ...(args.feature ? { featureId: args.feature } : {}),
      ...(args.story ? { story: args.story } : {}),
      ...(args.resolution ? { resolution: args.resolution } : {}),
    }),
  );
  // (2) Blocking smells – mark the smell "cleared" (does NOT count toward the revise
  // budget), the smell-source half of the dual-source rule.
  for (const s of smellEscalations) {
    if (!args.all && !inScope(s, args)) continue;
    const smellName = s.source.startsWith("smell:") ? s.source.slice("smell:".length) : s.source;
    const n = resolveOpenSmells(consortDir, smellName, {
      ...(s.story_id ? { story_id: s.story_id } : {}),
      kind: "cleared",
      ...(args.resolution ? { note: args.resolution } : {}),
    });
    if (n > 0) resolved.push(s.id);
  }

  if (!resolved.length) {
    process.stderr.write("consort-resolve-escalation: nothing matched (check --id / --feature / --story against --list).\n");
    return 2;
  }
  process.stdout.write(
    `consort-resolve-escalation: resolved ${resolved.length} blocker(s): ${resolved.join(", ")}\n` +
      `  Re-run the driver – it will retry the failed action fresh (escalation records are kept, stamped resolved_at; ` +
      `smells are marked cleared).\n`,
  );
  return 0;
}

process.exit(main());
