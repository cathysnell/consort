// test-env: the ONE place the live-test suites read their environment config from. Every value
// comes from an env var (set once in .env.local.test.config, the gitignored single home, sourced by
// scripts/run-all-live-tests.sh + run-live-tests.sh). There is NO hardcoded workspace/profile/owner
// fallback here on purpose – absent config resolves to `undefined` and each suite's gate skips
// cleanly, rather than a private host leaking into committed source or a misleading DNS failure.
//
// This replaces the ~4 divergent per-file resolvers (create-project.test.ts's resolveTestHost, the
// `DATABRICKS_CONFIG_PROFILE ?? "DEFAULT"` in gates/live-tools, the `${:-ecparr}` markers in the
// .run.json + smoke scripts). Point every live suite here.
//
// Env vars (documented in .env.template.test.config, valued in .env.local.test.config):
//   DATABRICKS_CONFIG_PROFILE  the CLI profile for the target workspace (host is resolved from it)
//   LAKEBASE_TEST_HOST         explicit host override (skips profile resolution; for CI/no-profile)
//   LAKEBASE_TEST_INSTANCE     an existing Lakebase project id to reuse (read-only + reuse suites)
//   LAKEBASE_TEST_GITHUB_OWNER GitHub owner for the PR/gates suites' throwaway repos
//   LAKEBASE_TEST_E2E=1        unlocks the destructive create/delete suites

// Host resolution lives in the provisioning family's credential seam (the ONE consort-side home for
// host/profile + auth); test-env reads it there rather than keeping a private copy.
import { resolveHostFromProfile } from "./credentials.js";
export { resolveHostFromProfile } from "./credentials.js";

/** The resolved test environment. Every field is optional – a missing one means "not configured",
 *  and the calling suite decides whether that makes it skip. */
export interface TestEnv {
  /** The workspace host (trailing slash stripped), from LAKEBASE_TEST_HOST or resolved from the
   *  profile. Undefined when neither is configured. */
  host?: string;
  /** The Databricks CLI profile (DATABRICKS_CONFIG_PROFILE). Undefined when unset – NO "DEFAULT"
   *  fallback (guessing DEFAULT is what sent runs at the wrong workspace). */
  profile?: string;
  /** An existing Lakebase project id to reuse (LAKEBASE_TEST_INSTANCE). */
  instance?: string;
  /** GitHub owner for the PR/gates suites (LAKEBASE_TEST_GITHUB_OWNER). */
  githubOwner?: string;
  /** LAKEBASE_TEST_E2E === "1" – the destructive-suite gate. */
  e2e: boolean;
}

/**
 * Resolve the test environment from env vars – the single entry point every live suite calls.
 * Host precedence: explicit LAKEBASE_TEST_HOST, else resolved from DATABRICKS_CONFIG_PROFILE, else
 * undefined. No hardcoded workspace/profile/owner – the values live in .env.local.test.config.
 */
export function resolveTestEnv(): TestEnv {
  const profile = process.env.DATABRICKS_CONFIG_PROFILE || undefined;
  const explicitHost = process.env.LAKEBASE_TEST_HOST?.replace(/\/+$/, "") || undefined;
  const host = explicitHost ?? (profile ? resolveHostFromProfile(profile) : undefined);
  return {
    ...(host ? { host } : {}),
    ...(profile ? { profile } : {}),
    ...(process.env.LAKEBASE_TEST_INSTANCE ? { instance: process.env.LAKEBASE_TEST_INSTANCE } : {}),
    ...(process.env.LAKEBASE_TEST_GITHUB_OWNER ? { githubOwner: process.env.LAKEBASE_TEST_GITHUB_OWNER } : {}),
    e2e: process.env.LAKEBASE_TEST_E2E === "1",
  };
}
