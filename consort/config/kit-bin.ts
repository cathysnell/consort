// Resolve + run a kit CLI bin by name. Shared by the deterministic driver (which
// runs every kit CLI as a subprocess) and by any CLI that must route an operation
// through ANOTHER kit CLI (the single door that owns that operation's substrate)
// rather than calling the substrate in-process, e.g. `consort-pipeline
// accept` delegating the experiment git-merge to `consort-experiment merge`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// This module is BUNDLED into each importing bin (a non-entry lib), so at runtime
// __dirname is the importer's dir: <kitRoot>/dist/bin/consort. The kit root
// (which holds package.json + its bin map) is three directories up , the layout the
// SHIPPED dist has. LAKEBASE_KIT_DIR overrides it as the authoritative kit locator
// (the documented env other kit resolution honors): needed when the module runs from
// a non-dist layout (e.g. TS source under vitest, where the __dirname math would point
// at the wrong root). Resolved LAZILY (not at module load) so an env set after import ,
// as a test does before driving , is still honored; memoized on first use. When the env
// is set + valid it wins; otherwise the __dirname computation, so the shipped dist path
// is unchanged.
let kitRootCache: string | undefined;
function resolveKitRoot(): string {
  if (kitRootCache !== undefined) return kitRootCache;
  const env = process.env.LAKEBASE_KIT_DIR?.trim();
  kitRootCache = env && fs.existsSync(path.join(env, "package.json")) ? env : path.resolve(__dirname, "..", "..", "..");
  return kitRootCache;
}
const SUBSTRATE_PKG = "@databricks-solutions/lakebase-scm-utils";

/** The kit repo root (holds package.json + examples/replay/corpora/). Exposed so a
 *  bin that needs kit-relative assets (e.g. the recorded reference corpora the
 *  optimize semantic gate compares against) resolves them the same way, regardless
 *  of dev-clone vs installed-package layout. */
export function kitRoot(): string {
  return resolveKitRoot();
}
let kitBinMap: Record<string, string> | null = null;
let substrateRoot: string | null | undefined; // undefined = not yet resolved
let substrateBinMap: Record<string, string> | null = null;

/** Locate the installed scm-utils package root by walking node_modules up from
 *  the kit root (Node's own resolution order), so it resolves whether scm-utils is
 *  nested under the kit (a dev clone) or hoisted to a shared node_modules (a
 *  scaffolded project / the lk cache, where scm-utils is a sibling of the kit).
 *  Returns null when scm-utils is not installed. */
function resolveSubstrateRoot(): string | null {
  if (substrateRoot !== undefined) return substrateRoot;
  let dir = resolveKitRoot();
  for (;;) {
    const cand = path.join(dir, "node_modules", SUBSTRATE_PKG);
    if (fs.existsSync(path.join(cand, "package.json"))) {
      substrateRoot = cand;
      return cand;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  substrateRoot = null;
  return null;
}

/** The dist JS for a bin the driver emits, or null for a name that is neither a
 *  kit bin nor a substrate bin (an external tool resolved on PATH). Kit-owned bins
 *  resolve under the kit's dist; SUBSTRATE bins (e.g. lakebase-scm-merge) resolve
 *  under the installed scm-utils package's OWN dist via its bin map, so they run
 *  from the substrate regardless of hoisting , the kit no longer redeclares them.
 *  Resolving to the mapped file means the bin runs regardless of PATH. */
export function resolveKitBinJs(bin: string): string | null {
  if (kitBinMap === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(resolveKitRoot(), "package.json"), "utf8")) as {
        bin?: Record<string, string>;
      };
      kitBinMap = pkg.bin ?? {};
    } catch {
      kitBinMap = {};
    }
  }
  const rel = kitBinMap[bin];
  if (rel) return path.join(resolveKitRoot(), rel);

  // Not a kit bin: it may be a SUBSTRATE bin (scm-merge, scm-wait-ci, ...) the
  // driver emits. Resolve it from the installed scm-utils package's bin map.
  const subRoot = resolveSubstrateRoot();
  if (subRoot) {
    if (substrateBinMap === null) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(subRoot, "package.json"), "utf8")) as {
          bin?: Record<string, string>;
        };
        substrateBinMap = pkg.bin ?? {};
      } catch {
        substrateBinMap = {};
      }
    }
    const subRel = substrateBinMap[bin];
    if (subRel) return path.join(subRoot, subRel);
  }
  return null;
}

/** The kit's own version (package.json `version`), or "unknown" if unreadable.
 *  Used to stamp advisory surfaces (e.g. next.json's authoritative_playbook_version)
 *  so a consumer can tell which kit produced the snapshot. */
export function kitVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resolveKitRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Export this kit's version as `CONSORT_VERSION` so the substrate (lakebase-scm-utils)
 * labels the Postgres connections it opens under a Consort run as `consort/<version>`
 * rather than its own `scm-utils/<version>` (scm-utils reads this env in
 * `connectionApplicationName()`; anything that is NOT Consort , the VS Code extension, a
 * bare `lakebase-*` CLI , leaves it unset and keeps the scm-utils brand). Child processes
 * a Consort run spawns inherit it. Call once at a Consort entry point BEFORE any substrate
 * connection. Idempotent + non-destructive: it never overwrites an already-set value (so an
 * outer Consort process's version wins over a re-derive), and skips an unresolved version.
 * `version` is injectable for tests; it defaults to this kit's own `kitVersion()`. */
export function exportConsortVersionEnv(version: string = kitVersion()): void {
  if (process.env.CONSORT_VERSION) return;
  if (version && version !== "unknown") process.env.CONSORT_VERSION = version;
}

/** Run a kit bin as a synchronous subprocess (inheriting stdio), returning its
 *  exit code. A kit bin resolves to its dist JS run under `node`; a non-kit name
 *  falls back to the bare command on PATH. Throws only when the process cannot be
 *  spawned at all (res.error), so a non-zero exit is returned, not thrown. */
export function runKitBinSync(bin: string, args: string[], cwd: string): number {
  const js = resolveKitBinJs(bin);
  const res = js
    ? spawnSync("node", [js, ...args], { cwd, stdio: "inherit" })
    : spawnSync(bin, args, { cwd, stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status ?? 1;
}
