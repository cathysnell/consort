// Release-artifact guard: every bin in package.json must be SHIPPED, i.e. its
// dist/ target must be git-tracked. dist/ is .gitignore'd but the kit ships a
// pre-built dist on every tag (force-added despite the ignore) because a consumer
// install (npm install github:...#ref) skips the build – see scripts/prepare.mjs.
//
// The defect this guards: when a new bin family landed (the sftdd/tdd CLIs), its
// built output was gitignored and never force-added, so the shipped dist omitted
// dist/scripts/sftdd/** entirely. `npm run build` produced the files locally, so
// nothing on disk looked wrong, but a real consumer install was missing 48 of 75
// bins – every /plan, /design, /build, /deploy backend. A disk-existence check
// would NOT have caught it (the dev clone builds them); only a git-tracked check
// does. So this test asks git, not the filesystem.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/** The set of dist/ files git actually tracks (what a tag ships). */
function trackedDistFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files", "dist"], { cwd: REPO_ROOT, encoding: "utf8" });
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

describe("shipped release artifact: every package.json bin is git-tracked in dist/", () => {
  it("no bin target is missing from the shipped (git-tracked) dist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    const tracked = trackedDistFiles();
    const bins = Object.entries(pkg.bin);
    expect(bins.length).toBeGreaterThan(0);

    // The kit now declares ONLY its own bins (all under ./dist/...). Substrate/SCM
    // bins live in @databricks-solutions/lakebase-scm-utils and are resolved by lk
    // (and the driver) from that package's own dist, so they are validated there,
    // never redeclared here. Normalize the bin path
    // ("./dist/bin/consort/intake.cli.js") to the repo-relative form git ls-files
    // emits ("dist/bin/consort/intake.cli.js").
    const missing = bins
      .map(([name, p]) => [name, p.replace(/^\.\//, "")] as const)
      .filter(([, p]) => !tracked.has(p));

    expect(
      missing,
      `these bins are declared in package.json but their dist target is NOT git-tracked, ` +
        `so a consumer install (which skips the build) ships them broken. Rebuild + ` +
        `\`git add -f\` the dist targets:\n` +
        missing.map(([n, p]) => `  ${n} -> ${p}`).join("\n"),
    ).toEqual([]);
  });
});

// The shipped step MANIFESTS are runtime DATA, but unlike the bins they are NOT
// standalone dist files: step-manifest.ts imports them as JSON modules, so the bundler
// INLINES them into the built dist/scripts/sftdd/*.cli.js. There is therefore no
// per-manifest dist twin to track – the guarantee that a consumer install can load them
// is that they are inlined into the shipped bundle. That is asserted where it belongs:
// step-manifest.test.ts loads SHIPPED_MANIFESTS + validates each against the schema.
// (A directory-scan guard here would be checking a path that no longer exists.)
