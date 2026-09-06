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
import { reopenStoryForRedesign } from "../../consort/gates/reopen-story.js";
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

interface Args {
  feature?: string;
  story?: string;
  reason: string;
  projectDir: string;
  consortDir?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { reason: "reopened for redesign", projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--feature": out.feature = argv[++i]; break;
      case "--story": out.story = argv[++i]; break;
      case "--reason": out.reason = argv[++i]; break;
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-reopen-story – send a story back to the design lane for a genuine re-author (backed up).\n\n" +
            "  consort-reopen-story --feature <F> --story <S> [--reason \"<why>\"]\n\n" +
            "Clears acs/, test-list-per-story.json, reflect-verdict.json, plan.json and empties story.json acs[]\n" +
            "(so hasAcs=false and the Spec Author is re-dispatched), AND resets the pipeline entry to designing\n" +
            "(dropping the spec gate, experiment record, and acceptance), clears the feature deploy-evidence, and\n" +
            "clears the coarse phase – so a DONE + merged + ACCEPTED story reopens in one command. Backs everything\n" +
            "up first. It CANNOT clear a live git/Lakebase experiment branch – it prints that as the one step left.\n",
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
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const res = reopenStoryForRedesign(consortDir, args.feature, args.story);

  if (!res.cleared.length) {
    process.stdout.write(`consort-reopen-story: ${args.story} had no design artifacts to clear (already needs design).\n`);
    return 0;
  }
  process.stdout.write(`consort-reopen-story: reopened ${args.feature}/${args.story} for redesign.\n`);
  process.stdout.write(`  cleared (backed up to ${res.backupDir}):\n`);
  for (const c of res.cleared) process.stdout.write(`    - ${c}\n`);
  process.stderr.write(
    "\nThis reset the artifacts AND the pipeline entry (spec gate + experiment record + acceptance -> designing),\n" +
      "the feature deploy-evidence, and the coarse phase. Two things remain:\n" +
      "  1. Discard the story's actual git/Lakebase experiment BRANCH if one exists – this cannot clear a\n" +
      "     live branch, only the pipeline record of it. Do NOT leave it orphaned.\n" +
      "  2. Re-run the drive: hasAcs is now false and the entry is `designing`, so it re-dispatches the Spec\n" +
      "     Author -> Architect -> DBA -> Test Strategist -> reflect -> the spec gate (a genuine re-author),\n" +
      "     then cuts a FRESH experiment and re-runs the build + deploy gates.\n",
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`consort-reopen-story: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
