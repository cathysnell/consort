// credentials: the consort-side credential seam for a run's Databricks session – host resolution +
// the drive-startup auth preflight. The ACTUAL token minting + `--profile`-threading CLI wrapper live
// in external scm-utils (@databricks-solutions/lakebase-scm-utils/lakebase); this module is the thin
// consort-owned boundary that both tests and the interactive drive defer to for "which workspace /
// is the session live". It lives in the provisioning family because auth is a prep concern – part of
// setting up the environment a run targets.

import { execFileSync } from "node:child_process";
import { checkDatabricksAuth, databricksAuthPrereqMessage } from "@databricks-solutions/lakebase-scm-utils/lakebase";

/** Resolve a workspace host from a CLI profile via `databricks auth describe -o json` (the same
 *  degradation-tolerant call run-all-live-tests.sh uses – it reports the host from ~/.databrickscfg
 *  even when the token cache is stale, unlike the deprecated `auth env`). Tolerates a non-JSON
 *  preamble by trimming to the first `{`. Returns undefined on any failure. */
export function resolveHostFromProfile(profile: string, timeoutMs = 15_000): string | undefined {
  try {
    const raw = execFileSync("databricks", ["auth", "describe", "--profile", profile, "-o", "json"], {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    const start = raw.indexOf("{");
    if (start < 0) return undefined;
    const parsed = JSON.parse(raw.slice(start)) as { details?: { host?: string } };
    const host = parsed.details?.host;
    return typeof host === "string" && host ? host.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

// ── Drive-startup auth preflight (fail-fast on an expired Databricks session) ──────────────────────
//
// The drive spawns expensive LLM turns + does DB-backed verifies. If the Databricks OAuth refresh
// token is expired, credential minting fails DEEP inside a test's DB connection – where it degrades
// into a hang, and the drive spins for hours (assess -> repair loops on a failure that can never
// clear). This runs ONCE at drive startup and exercises the REFRESH token via scm-utils's
// checkDatabricksAuth (`databricks auth token --force-refresh`), so a dead session halts the run
// immediately with the `databricks auth login` remediation – BEFORE any agent spawn. It is the single
// cheap gate that turns that latent multi-hour spin into a second-zero, actionable failure.

export interface DriveAuthPreflightResult {
  ok: boolean;
  /** The actionable remediation, present only when ok is false. */
  message?: string;
}

/** The auth probe seam (scm-utils checkDatabricksAuth). Injectable for tests. */
export type AuthCheck = (host?: string) => Promise<{ ok: boolean; reason?: string }>;

/**
 * Fail-fast auth preflight for the drive. Returns ok:true when the Databricks session is live
 * (refresh token valid), else ok:false with the reauth message. `check` defaults to scm-utils's
 * refresh-exercising checkDatabricksAuth; tests inject a stub. `host` is threaded through for the
 * remediation hint.
 */
export async function driveAuthPreflight(
  host?: string,
  check: AuthCheck = checkDatabricksAuth,
): Promise<DriveAuthPreflightResult> {
  const res = await check(host);
  if (res.ok) return { ok: true };
  return { ok: false, message: databricksAuthPrereqMessage(host, res.reason) };
}
