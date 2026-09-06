// PERMANENT anti-recurrence guard for the scripts/sftdd foliation + the CLI move to bin/: the flat
// scripts/sftdd/ pile was foliated into first-class consort/<domain>/ families (config, logging,
// gates, experiment, pipeline, smells, architecture, intake, deploy, optimize, evaluation, session,
// reports, test-list, setup, lakebase) plus the orchestrator/ families, and every CLI moved to bin/. The
// dependency graph is now ONE-WAY:
//
//   consort/<family>/ libraries  ->  each other, DOWNWARD by layer  ->  bin/**/*.cli entrypoints
//
// The bins COMPOSE the families (that is what an entrypoint does); a family library must NEVER reach
// back UP into a bin. scripts/sftdd/ now holds ONLY schemas + docs (no source), and bin/ holds ONLY
// .cli entrypoints – no library a family could depend on lives in either.
//
// Three invariants:
//   1. scripts/sftdd/ contains NO source module (the pile is fully foliated; only schemas + docs).
//   2. No consort/ library imports a VALUE from a bin/ CLI (bins compose families, never the reverse)
//      – the graph is fully one-way, no exceptions.
//   3. bin/ holds ONLY *.cli.ts entrypoints – no library code leaked into the executables home.
//
// This retires the temporary Stage-0 guard (scripts-orchestrator-acyclic-guard) – the graph is now
// enforced from the consort/ side, which is where domain code lives.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** git ls-files under a dir (tracked paths). */
function tracked(dir: string): string[] {
  return execFileSync("git", ["ls-files", dir], { encoding: "utf-8", cwd: process.cwd() })
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Recursively list files under a dir ON DISK (catches an untracked new file too, so the guard
 *  bites before the file is even staged). Repo-relative paths. */
function onDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...onDisk(p));
    else out.push(p);
  }
  return out;
}

describe("consort foliation + bin/ move: scripts holds no source, bin holds only CLIs, graph is one-way", () => {
  it("scripts/sftdd/ contains NO source module (fully foliated; only schemas + docs)", () => {
    const src = onDisk("scripts/sftdd").filter(
      (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("/schemas/"),
    );
    expect(
      src,
      `scripts/sftdd/ should hold only schemas + docs after foliation + the bin/ move; these source ` +
        `files resurfaced – put domain code in a consort/<family>/ and CLIs in bin/:\n  ${src.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no consort/ library imports a VALUE from a bin/ CLI (bins compose families, never the reverse)", () => {
    const offenders: string[] = [];
    for (const file of tracked("consort/")) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (file.includes("/reference-assets/stockflow/")) continue; // recorded corpus, not kit source
      const src = readFileSync(file, "utf-8");
      for (const line of src.split("\n")) {
        const m = line.match(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/);
        if (!m) continue;
        const [, typeOnly, spec] = m;
        if (typeOnly) continue; // erased at build, no runtime edge
        // A CLI bin is bin/**/<name>.cli(.js); a library importing one is an UP edge.
        if (/(^|\/)bin\/.*\.cli(\.js)?$/.test(spec)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `a consort/ family library imports a VALUE from a bin/ CLI (a re-introduced UP edge into the ` +
        `bin layer). Move the shared code DOWN into a consort/<family>/ lib both the bin and the ` +
        `library import, or make the import type-only:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("bin/ holds ONLY *.cli.ts entrypoints (no library code in the executables home)", () => {
    const nonCli = onDisk("bin").filter((p) => p.endsWith(".ts") && !p.endsWith(".cli.ts"));
    expect(
      nonCli,
      `bin/ should hold only *.cli.ts entrypoints; these non-CLI files leaked into the executables ` +
        `home – move library code to a consort/<family>/:\n  ${nonCli.join("\n  ")}`,
    ).toEqual([]);
  });
});
