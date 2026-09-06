#!/usr/bin/env node
// CLI: finalize a recorded capture so its prompts/transcripts are PORTABLE + BROWSABLE.
//
// Runs POST-recording, once the final `.consort` state exists:
//   1. buildConsortMirror  – create <recordDir>/.consort/ = recorded-artifacts (produced, wins) UNION
//      intake (seed, fills gaps), so every `.consort/<x>` a recorded prompt references is a REAL file.
//   2. sweepRecordedPaths   – rewrite <PROJECT_ROOT>/.consort/<x> (and any residual absolute project
//      path via --live-root) in every prompt.txt + transcript.md + correspondence.jsonl to the
//      record-relative `./.consort/<x>` – which now opens in a file browser.
//
// Idempotent; operates only on recorded text/dirs. Safe to re-run on an existing corpus.
//
//   consort-finalize-corpus <recordDir> [--live-root <absProjectRootFromAnOlderRun>]
//
// Exit codes: 0 ok; 2 bad args; 3 finalize failure.

import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";
import { finalizeCorpus } from "../../consort/logging/finalize-corpus.js";

export function runFinalizeCorpusCli(argv: string[]): number {
  const args = [...argv];
  let recordDir: string | undefined;
  let liveRoot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--live-root") liveRoot = args[++i];
    else if (!a.startsWith("--") && !recordDir) recordDir = a;
    else if (a === "-h" || a === "--help") { printUsage(); return 0; }
  }
  if (!recordDir) { printUsage(); return 2; }

  try {
    const { mirror, sweep } = finalizeCorpus(recordDir, liveRoot);
    process.stderr.write(
      `[finalize-corpus] .consort mirror: ${mirror.fromProduced} produced + ${mirror.fromIntake} intake` +
        `${mirror.collisions.length ? `, ${mirror.collisions.length} COLLISION(S) skipped: ${mirror.collisions.join(", ")}` : ""}\n` +
        `[finalize-corpus] path sweep: ${sweep.rewrittenToConsort} -> ./.consort (browsable), ` +
        `${sweep.leftAsToken} left as <PROJECT_ROOT> (no mirror file), ${sweep.filesScanned} files scanned\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`[finalize-corpus] FAILED: ${(e as Error).message}\n`);
    return 3;
  }
}

function printUsage(): void {
  process.stderr.write(
    "usage: consort-finalize-corpus <recordDir> [--live-root <absProjectRoot>]\n" +
      "  Builds <recordDir>/.consort mirror + rewrites recorded paths to ./.consort/... (browsable).\n",
  );
}

if (isCliEntry(import.meta.url)) {
  process.exit(runFinalizeCorpusCli(process.argv.slice(2)));
}
