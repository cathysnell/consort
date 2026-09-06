// Detached telemetry sender: POST an NDJSON payload file to the endpoint, then exit.
//
// Spawned DETACHED (setsid, stdio ignored, unref'd) by detachedHttpSink so telemetry
// delivery SURVIVES the parent drive's process.exit WITHOUT the parent ever awaiting
// or blocking on the network. Before this, the emitter POSTed in-process fire-and-forget
// and `consort-drive` called process.exit() immediately after finish() – tearing down
// the in-flight socket before it landed. Result: every run's telemetry was silently
// dropped (an empty telemetry.runs despite heavy use). The parent now hands the batch to
// THIS process and exits at once; this process owns the POST with a generous, cold-start-
// tolerant timeout.
//
// Node BUILTINS ONLY (no kit imports) so the bundle stays tiny and spawning is cheap,
// and so a bundled entry never drags a heavier module. All errors are swallowed – a
// telemetry send must never surface anything.

import { readFileSync, unlinkSync } from "node:fs";

async function main(): Promise<void> {
  const [, , file, url, token] = process.argv;
  if (!file || !url) return;
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    return; // nothing to send
  }
  const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  try {
    // 10s covers a Flex scale-from-zero cold start (~2.5s) with headroom. This process
    // is detached, so the wait never affects the drive.
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(10_000)
        : undefined;
    await fetch(url, { method: "POST", headers, body, ...(signal ? { signal } : {}) });
  } catch {
    /* best-effort: a failed/timed-out send is dropped, never retried, never surfaced */
  } finally {
    try {
      unlinkSync(file); // clean up the handoff spool file
    } catch {
      /* ignore */
    }
  }
}

void main().finally(() => process.exit(0));
