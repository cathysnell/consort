#!/usr/bin/env node
// consort-reopen-story: send a story back to the design lane for genuine RE-AUTHORING.
// withdraw-gate reverts the gate and revise resets build state, but both LEAVE the story's
// ACs/test-list/reflect-verdict on disk, so the drive just re-approves the same spec. This
// clears those design artifacts (with a backup) so hasAcs=false and the drive re-dispatches
// the Spec Author – the missing recovery primitive the stockflow run had to improvise.
//
//   consort-reopen-story --feature <F> --story <S> [--reason "<why>"] [--project-dir <p>]
//
// It ALSO resets the story's pipeline entry to `designing` – dropping the spec gate, the
// experiment record, AND the acceptance in one write, clearing the feature deploy-evidence,
// and clearing the coarse phase – so reopening a DONE + merged + ACCEPTED story works in one
// command (the case the stockflow run had to hand-surger across four primitives). The one
// thing it CANNOT clear is the actual git/Lakebase experiment BRANCH (a real external
// resource); it prints that as the remaining manual step so it is never silently stranded.

import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { reopenStoryForRedesign, reopenStoryFromRole, DESIGN_LANE_ORDER, type DesignLaneRole } from "../../consort/gates/reopen-story.js";
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

interface Args {
  feature?: string;
  story?: string;
  reason: string;
  projectDir: string;
  consortDir?: string;
  /** Scope the reopen to a design role: revert that role's output + downstream only, keep upstream. */
  from?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { reason: "reopened for redesign", projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--feature": out.feature = argv[++i]; break;
      case "--story": out.story = argv[++i]; break;
      case "--from": out.from = argv[++i]; break;
      case "--reason": out.reason = argv[++i]; break;
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-reopen-story – send a story back to the design lane for a genuine re-author (backed up).\n\n" +
            "  consort-reopen-story --feature <F> --story <S> [--from <role>] [--reason \"<why>\"]\n\n" +
            "Default (full reopen): clears acs/, test-list, reflect-verdict, plan and empties story.json acs[]\n" +
            "(hasAcs=false -> the Spec Author is re-dispatched). --from <role> is a PROPORTIONATE scoped reopen:\n" +
            "it reverts only that role's output + everything downstream, keeps the upstream design, and the drive\n" +
            "resumes AT that role. Roles: " + DESIGN_LANE_ORDER.join(" -> ") + ".\n" +
            "  e.g. --from test-strategist  (re-author the test-list only; keeps ACs/architecture/schema)\n" +
            "test-strategist/navigator are STORY-local; architect-reviewer/dba/ux-designer revert FEATURE-shared\n" +
            "artifacts (a sibling story not yet gated re-derives too). Either way it resets the pipeline -> designing\n" +
            "(drops the spec gate + experiment + acceptance so the gate is re-surfaced with fresh integrity), clears\n" +
            "the feature deploy-evidence + coarse phase, and backs everything up. It CANNOT clear a live git/Lakebase\n" +
            "experiment branch – it prints that as the one step left.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.feature || !args.story) {
    process.stderr.write("consort-reopen-story: --feature and --story are required.\n");
    return 2;
  }
  // --from scopes the reopen to a design role. Validate against the lane order before touching disk.
  if (args.from !== undefined && !DESIGN_LANE_ORDER.includes(args.from as DesignLaneRole)) {
    process.stderr.write(`consort-reopen-story: --from must be one of ${DESIGN_LANE_ORDER.join(", ")} (got "${args.from}").\n`);
    return 2;
  }
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const from = args.from as DesignLaneRole | undefined;
  const res = from ? reopenStoryFromRole(consortDir, args.feature, args.story, from) : reopenStoryForRedesign(consortDir, args.feature, args.story);

  if (!res.cleared.length) {
    process.stdout.write(`consort-reopen-story: ${args.story} had no design artifacts to clear${from ? ` from ${from}` : ""} (nothing to revert).\n`);
    return 0;
  }
  const scope = from ? `from ${from}` : "for redesign (full)";
  process.stdout.write(`consort-reopen-story: reopened ${args.feature}/${args.story} ${scope}.\n`);
  process.stdout.write(`  cleared (backed up to ${res.backupDir}):\n`);
  for (const c of res.cleared) process.stdout.write(`    - ${c}\n`);
  // The resume role is `from` (scoped) or the Spec Author (full); the drive re-derives it from the
  // artifacts left on disk, then re-runs the design tail -> spec gate (fresh integrity) -> rebuild.
  const resume = from ? from.replace("navigator", "navigator (reflect)") : "Spec Author";
  process.stderr.write(
    `\nThis reset the design tail AND the pipeline entry (spec gate + experiment + acceptance -> designing),\n` +
      "the feature deploy-evidence, and the coarse phase. Two things remain:\n" +
      "  1. Discard the story's actual git/Lakebase experiment BRANCH if one exists – this cannot clear a\n" +
      "     live branch, only the pipeline record of it. Do NOT leave it orphaned.\n" +
      `  2. Re-run the drive: it re-derives the resume point at the ${resume} and re-runs the design tail ->\n` +
      "     the spec gate (re-surfaced + re-approved, fresh integrity), then cuts a FRESH experiment and rebuilds.\n",
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`consort-reopen-story: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
