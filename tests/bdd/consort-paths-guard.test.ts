// Guard: the knowledge of WHERE .consort artifacts live is defined in ONE place
// (consort/config/consort-paths.ts), not spread across the codebase. This is the
// enforcement behind the single-source-of-truth refactor: the
// deterministic driver kept stalling because a producer and its consumer built
// the same path/format knowledge in different spots and silently drifted.
//
// Two invariants, checked across every consort/*.ts AND bin/*.ts (incl. adapters/),
// excluding consort-paths.ts itself + test files:
//   1. No hand-built `"features"` path segment. Everything routes through the
//      consort-paths builders (featuresDir / featureDir / storiesDir / ...), so the
//      `.consort/features/...` layout has exactly one definition.
//   2. No local findFeatureDir / findStoryDir definition. Feature/story dir
//      resolution is the one rule in consort-paths (findFeatureDir / findStoryDir);
//      the 6 divergent copies that variously threw / picked-first / returned
//      undefined are gone. (Adapter-specific by-id resolvers are named
//      *ById to make clear they are a different operation, not a copy.)

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

// consort-paths.ts lives in the low consort/config/ family (foliation); the modules that could
// hand-build a layout path are the consort/ families + the bin/ CLIs. Scan the consort/ tree
// AND bin/ so the single-source rule covers everywhere a layout path could be re-hand-built.
const SCAN_DIRS = [
  fileURLToPath(new URL("../../consort", import.meta.url)),
  fileURLToPath(new URL("../../bin", import.meta.url)),
];
const SINGLE_SOURCE = "consort-paths.ts";

// The optimize family is the champion-walk HARNESS + its recorded corpus, not runtime .consort
// layout code. It legitimately names the top-level artifact roots as a snapshot allow-list
// (SNAPSHOT_ROOTS = ["features","planning","design"]), which is not a hand-built layout PATH.
// It was never in this guard's original scripts/sftdd scope, so exclude it (+ its fixtures).
const SKIP_DIRS = ["optimize", "evaluation"];

/** Every .ts source file under the scanned dirs (recursive), minus tests + the one
 *  module that is allowed to know the layout + the optimize harness/corpus. */
function tddSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.includes(entry)) continue;
      out.push(...tddSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (entry === SINGLE_SOURCE) continue;
    out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap(tddSourceFiles);

describe("consort-paths is the single source of truth for .consort layout", () => {
  it("finds source files to check (sanity)", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('no module hand-builds the "features" path segment (route through consort-paths)', () => {
    const offenders = FILES.filter((f) => /"features"/.test(readFileSync(f, "utf8"))).map((f) =>
      basename(f),
    );
    expect(offenders, `these files hand-build a "features" path; use a consort-paths builder instead`).toEqual([]);
  });

  it("no module defines its own findFeatureDir / findStoryDir (resolution lives once in consort-paths)", () => {
    const re = /\b(?:function|const)\s+(?:findFeatureDir|findStoryDir)\b/;
    const offenders = FILES.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => basename(f));
    expect(offenders, `these files define a local feature/story-dir resolver; import it from consort-paths`).toEqual([]);
  });

  // The artifact-root NAME (.consort + the legacy .sftdd/.tdd) is defined once in
  // consort-paths.ts (ARTIFACT_ROOT / LEGACY_ARTIFACT_ROOTS / ALL_ARTIFACT_ROOTS).
  // No other module may hardcode one of those directory-name string literals – it
  // must import the constant, so a future root rename touches one file, not a
  // scattered pile (the whole point of Rename C's single source of truth).
  it("no module hardcodes an artifact-root literal (import ARTIFACT_ROOT / ALL_ARTIFACT_ROOTS instead)", () => {
    // The two legitimate definition/migration homes name the literals by design.
    const ALLOWED = new Set(["consort-paths.ts", "migrate-artifact-dir.ts"]);
    // A bare quoted dir-name literal ("consort" / ".sftdd" / ".tdd") in CODE (a
    // comment naming the legacy chain is fine; this matches the string token).
    const re = /["'](?:\.consort|\.sftdd|\.tdd)["']/;
    const offenders = FILES.filter((f) => !ALLOWED.has(basename(f)))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        // Check line-by-line, skipping pure-comment lines, so prose mentioning a
        // legacy root does not false-positive; only a code-line literal counts.
        return src.split("\n").some((line) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*")) return false;
          return re.test(line);
        });
      })
      .map((f) => basename(f));
    expect(
      offenders,
      `these files hardcode an artifact-root literal (".consort"/".sftdd"/".tdd"); import ARTIFACT_ROOT / ALL_ARTIFACT_ROOTS from consort-paths instead`,
    ).toEqual([]);
  });
});
