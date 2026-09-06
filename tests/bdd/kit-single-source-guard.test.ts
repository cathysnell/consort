// Guard: EXACTLY ONE way to resolve "the kit". The split-brain trap (exporting LAKEBASE_KIT_DIR,
// which redirects only the orchestrator and leaves the env-less claude -p agents on the ref cache)
// must never creep back into a launcher or a live test. Every capture/replay/smoke launcher resolves
// through the shared shell resolver (resolve_kit_single_source in examples/replay/lib/pin-local-kit.sh);
// every live test resolves through the TS twin (resolveKitSingleSource in tests/integration/live/
// kit-resolution.ts). This guard reads the files (no execution) and pins that invariant.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

// The launchers that scaffold + drive a run – they must resolve via the shared function.
const LAUNCHERS = [
  "examples/replay/_replay-smoke.sh",
  "examples/replay/run-smoke.sh",
  "examples/replay/capture-scenario.sh",
];

// The live tests that spawn a real `claude -p` agent – they must resolve via the TS twin.
const LIVE_TS = [
  "tests/integration/live/spec-author-breakdown-live.test.ts",
  "tests/integration/live/navigator-red-executor-dispatch-live.test.ts",
  "tests/integration/live/drive-executor-dispatch-live.test.ts",
  "tests/integration/live/executor-dispatch-live-support.ts",
  "tests/integration/live/driver-build-support.ts",
  "tests/integration/live/design-equivalence-support.ts",
  "tests/live/spec-author-step-live.test.ts",
];

describe("kit single-source guard: launchers resolve via the ONE shared shell resolver", () => {
  for (const rel of LAUNCHERS) {
    it(`${path.basename(rel)} sources pin-local-kit.sh + calls resolve_kit_single_source, never exports LAKEBASE_KIT_DIR`, () => {
      const body = read(rel);
      expect(body, `${rel}: sources the shared resolver lib`).toMatch(/pin-local-kit\.sh/);
      expect(body, `${rel}: calls the ONE resolver`).toMatch(/resolve_kit_single_source\b/);
      // The split-brain door: never EXPORT LAKEBASE_KIT_DIR (a printed hint in an echo/log is fine).
      expect(body, `${rel}: no 'export LAKEBASE_KIT_DIR'`).not.toMatch(/export\s+LAKEBASE_KIT_DIR/);
    });
  }
});

describe("kit single-source guard: live tests resolve via the ONE TS twin", () => {
  for (const rel of LIVE_TS) {
    it(`${path.basename(rel)} imports resolveKitSingleSource, never sets process.env.LAKEBASE_KIT_DIR`, () => {
      const body = read(rel);
      expect(body, `${rel}: imports from kit-resolution`).toMatch(/from ["'](\.\.\/)*.*kit-resolution\.js["']/);
      expect(body, `${rel}: calls the TS resolver`).toMatch(/resolveKitSingleSource\b/);
      // Never assign LAKEBASE_KIT_DIR (the env the spawned agent does not inherit = split-brain).
      expect(body, `${rel}: no 'LAKEBASE_KIT_DIR =' assignment`).not.toMatch(/LAKEBASE_KIT_DIR\s*=/);
    });
  }
});

describe("kit single-source guard: exactly ONE resolver declaration of each (no second policy)", () => {
  it("resolve_kit_single_source is declared exactly once (in pin-local-kit.sh)", () => {
    const shellFiles = walk(path.join(REPO, "examples"), (p) => p.endsWith(".sh"));
    const decls = shellFiles.filter((p) => /resolve_kit_single_source\s*\(\)/.test(fs.readFileSync(p, "utf8")));
    expect(decls.map((p) => path.relative(REPO, p))).toEqual(["examples/replay/lib/pin-local-kit.sh"]);
  });

  it("resolveKitSingleSource is exported from exactly one module (kit-resolution.ts)", () => {
    const tsFiles = walk(path.join(REPO, "tests"), (p) => p.endsWith(".ts"))
      // Exclude THIS guard file – it names the symbol as a string, not a declaration.
      .filter((p) => path.relative(REPO, p) !== "tests/bdd/kit-single-source-guard.test.ts");
    const decls = tsFiles.filter((p) => /export function resolveKitSingleSource\b/.test(fs.readFileSync(p, "utf8")));
    expect(decls.map((p) => path.relative(REPO, p))).toEqual(["tests/integration/live/kit-resolution.ts"]);
  });
});

/** Recursively list files under dir matching a predicate; skips node_modules/dist/.git. */
function walk(dir: string, match: (p: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (match(full)) out.push(full);
    }
  }
  return out.sort();
}
