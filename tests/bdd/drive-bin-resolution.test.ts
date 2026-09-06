// Guard: the deterministic driver resolves the child-CLIs it emits through a
// package.json `bin` map (drive.cli's resolveKitBinJs), NOT a hand-maintained
// list. Every bin the effects layer can emit as a `cli` command MUST be declared
// in SOME resolvable bin map – the kit's own (for sftdd/tdd bins) or the installed
// substrate's (for scm-* bins, which the kit no longer redeclares after Track C
// Phase 4) – otherwise the driver falls back to a bare `spawn(<bin>)` which is not
// on PATH under lk and dies with ENOENT (this is exactly what happened when
// consort-log was emitted but missing from the old hardcoded map).
//
// This test reads the *_BIN constants the effects layer declares and asserts each
// resolves against the union of the kit + substrate bin maps, so a newly-emitted
// bin can't drift out of sync before a live run catches it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The kit bin names the effects layer emits (the `const X_BIN = "lakebase-..."`
 *  declarations in orchestrator-effects.ts). */
function emittedKitBins(): string[] {
  const src = readFileSync(new URL("../../consort/orchestrator/drive/orchestrator-effects.ts", import.meta.url), "utf8");
  const bins = new Set<string>();
  for (const m of src.matchAll(/_BIN\s*=\s*"((?:consort|lakebase)-[a-z0-9-]+)"/g)) bins.add(m[1]);
  return [...bins];
}

/** The union of the kit's own bin keys and the installed substrate's bin keys ,
 *  every name resolveKitBinJs can resolve to a dist JS. */
function resolvableBinKeys(): Set<string> {
  const kit = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { bin?: Record<string, string> };
  const keys = new Set(Object.keys(kit.bin ?? {}));
  try {
    const sub = JSON.parse(
      readFileSync(`${ROOT}/node_modules/@databricks-solutions/lakebase-scm-utils/package.json`, "utf8"),
    ) as { bin?: Record<string, string> };
    for (const k of Object.keys(sub.bin ?? {})) keys.add(k);
  } catch {
    /* substrate not installed (shouldn't happen in the kit's own suite) */
  }
  return keys;
}

describe("driver kit-bin resolution is backed by package.json bin (no hardcoded map)", () => {
  it("finds the emitted kit bins (sanity)", () => {
    expect(emittedKitBins().length).toBeGreaterThanOrEqual(4);
  });

  it("every bin the effects layer emits resolves against the kit or substrate bin map", () => {
    const declared = resolvableBinKeys();
    const missing = emittedKitBins().filter((b) => !declared.has(b));
    expect(missing, `these bins are emitted by the driver but resolve in neither the kit nor the substrate bin map (would ENOENT under lk)`).toEqual([]);
  });

  it("the drive runner no longer carries a hardcoded bin->js map (resolves via package.json)", () => {
    // execRunner (which resolves + spawns each cli bin via resolveKitBinJs) now lives
    // in claude-runner.ts, extracted from drive.cli.ts so the optimize harness imports
    // the spawn engine WITHOUT dragging drive.cli's main()/isCliEntry entry block into
    // its bundle (tsup splitting:false inlines modules; a bundled isCliEntry block
    // would fire the drive's main() as a phantom side effect).
    const src = readFileSync(new URL("../../consort/orchestrator/drive/claude-runner.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/KIT_CLI_JS/);
    expect(src).toMatch(/resolveKitBinJs/);
  });
});
