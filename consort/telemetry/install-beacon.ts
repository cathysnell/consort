// The one-time INSTALL BEACON: a minimal, DISCLOSED transmission that records only that Consort
// was installed somewhere – a random install id + the kit version + a timestamp, nothing else.
//
// It is DELIBERATELY not consent-gated by the briefing opt-out: it fires ONCE per install
// (idempotent via the `beacon_sent` flag), regardless of the ongoing-telemetry opt-out choice, so
// the maintainers can count installs even when a user opts out of run/gate/turn telemetry. This is
// honest ONLY because the `/consort:start` briefing DISCLOSES it ("a random id + version + date")
// before it fires. The one hard suppressor is CONSORT_TELEMETRY=0 (a total opt-out) – that sends
// nothing at all, not even the beacon. `beacon_sent` is set ONLY on a successful (2xx) send, so an
// offline first run retries until the marker lands exactly once.

import { DEFAULT_ENDPOINT } from "./emitter.js";
import { ensureInstallId, readStoredConfig, markBeaconSent, telemetryDebug, type HomeConfigDeps } from "./home-config.js";

export interface BeaconResult {
  sent: boolean;
  /** When sent=false: why. */
  reason?: "already-sent" | "hard-disabled" | "post-failed";
}

export interface BeaconOpts {
  /** The kit version to stamp (the CLI passes kitVersion()). */
  version: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  deps?: HomeConfigDeps;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  nowIso?: string;
}

/** Send the one-time install beacon. Idempotent, best-effort, NEVER throws. Fires regardless of
 *  the briefing opt-out (disclosed); suppressed only by CONSORT_TELEMETRY=0 or an already-sent
 *  marker. Marks `beacon_sent` only on a 2xx so an offline run retries. */
export async function sendInstallBeacon(opts: BeaconOpts): Promise<BeaconResult> {
  const env = opts.env ?? process.env;
  // A TOTAL opt-out (env kill) sends nothing – not even the beacon. The briefing opt-out does not
  // suppress it (the beacon is disclosed and records only that an install exists).
  if (env.CONSORT_TELEMETRY === "0") return { sent: false, reason: "hard-disabled" };
  const deps = opts.deps ?? {};
  if (readStoredConfig(deps)?.beacon_sent === true) return { sent: false, reason: "already-sent" };
  const install_id = ensureInstallId(deps);
  const endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const body = JSON.stringify({ name: "consort.install", install_id, version: opts.version, ts: opts.nowIso ?? new Date().toISOString() }) + "\n";
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let ok = false;
    try {
      const res = await doFetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body,
        signal: ctrl.signal,
      });
      ok = res.ok;
    } finally {
      clearTimeout(timer);
    }
    if (ok) {
      markBeaconSent(deps);
      return { sent: true };
    }
    return { sent: false, reason: "post-failed" };
  } catch (err) {
    telemetryDebug("install beacon POST failed (will retry next run)", err);
    return { sent: false, reason: "post-failed" };
  }
}
