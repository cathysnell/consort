// Pin the scaffolded project's runtime kit ref to THIS kit's release version.
//
// Why: `scripts/lk` resolves the kit from a cache keyed by ref
// (`~/.cache/consort/<ref>`). When the ref is the mutable `main`, a new release
// moves main's tip but the cache key never changes, so a bin run keeps serving
// the stale install it first cached (the fast path deliberately never re-checks
// the remote – freshness is `--warm`'s job). The result: a project silently runs
// a months-old kit and newly-added bins go missing.
//
// The fix mirrors what the substrate already does for `.lakebase/scm-utils-ref`
// (pinned to `v${substrateVersion()}`): pin the kit to an IMMUTABLE version tag.
// A version tag never moves, so each release is a distinct cache key that installs
// fresh on first use – deterministic, no drift. The substrate's create-project
// Step 7e writes `.lakebase/kit-ref` straight from `LAKEBASE_KIT_REF`, so the
// consort create wrapper only has to DEFAULT that env var to its own version.
//
// An explicit `LAKEBASE_KIT_REF` (dev override, or a capture that pins a working
// ref) always wins – this only fills the unset default that used to fall through
// to `main`.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const CONSORT_PKG = "@databricks-solutions/consort";

/**
 * The kit ref to pin, or `undefined` to leave `LAKEBASE_KIT_REF` unset (lk then
 * defaults to `main`, preserving old behavior). An explicit env ref wins; a
 * missing/blank version yields `undefined` (never pin to a bare `v`).
 */
export function kitRefPin(env: NodeJS.ProcessEnv, version: string | undefined): string | undefined {
  if (env.LAKEBASE_KIT_REF && env.LAKEBASE_KIT_REF.trim()) return undefined;
  const v = (version ?? "").trim();
  return v ? `v${v}` : undefined;
}

/**
 * Read this kit's own version from the nearest ancestor `package.json` whose
 * name is `@databricks-solutions/consort`. Walks up from `fromDir` (robust to
 * the dist/bin/lakebase layout and to being invoked from a temp npx extract).
 * Returns `undefined` if it can't find a matching, versioned package.json.
 */
interface ConsortPkg {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

/** Walk up from `fromDir` to the nearest `@databricks-solutions/consort` package.json. */
function findConsortPkg(fromDir: string): ConsortPkg | undefined {
  let d = fromDir;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8")) as ConsortPkg;
      if (pkg.name === CONSORT_PKG && typeof pkg.version === "string" && pkg.version) {
        return pkg;
      }
    } catch {
      // no package.json here (or unreadable) – keep walking up
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

export function readConsortVersion(fromDir: string): string | undefined {
  const v = findConsortPkg(fromDir)?.version;
  return typeof v === "string" ? v : undefined;
}

/**
 * The substrate version THIS kit declares it depends on – the `vX.Y.Z` in
 * `dependencies["@databricks-solutions/lakebase-scm-utils"]`
 * (e.g. `github:databricks-solutions/lakebase-scm-utils#v0.2.3` -> `"0.2.3"`).
 * This is the version the scaffold SHOULD run against; compare it to the actually-
 * installed nested substrate to catch a stale-cache mismatch. Returns `undefined`
 * if the dep is absent or not version-pinned (e.g. a `main`/branch/dir spec).
 */
export function declaredSubstrateVersion(fromDir: string): string | undefined {
  const spec = findConsortPkg(fromDir)?.dependencies?.["@databricks-solutions/lakebase-scm-utils"];
  if (typeof spec !== "string") return undefined;
  const m = spec.match(/#v?(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : undefined;
}

/** Convenience: resolve the version from an ESM module URL (`import.meta.url`). */
export function consortVersionFromModule(metaUrl: string): string | undefined {
  try {
    return readConsortVersion(dirname(fileURLToPath(metaUrl)));
  } catch {
    return undefined;
  }
}

/** Convenience: resolve the declared substrate version from an ESM module URL. */
export function declaredSubstrateVersionFromModule(metaUrl: string): string | undefined {
  try {
    return declaredSubstrateVersion(dirname(fileURLToPath(metaUrl)));
  } catch {
    return undefined;
  }
}
