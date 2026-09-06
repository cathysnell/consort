// The consent predicate truth table. Emit IFF ALL hold:
//   telemetry_enabled === true && !CI && CONSORT_TELEMETRY!=="0".
// Env overrides only ever DISABLE, and they always win.
//
// TELEMETRY IS CAPTURED WHENEVER CONSORT IS USED – the launch method is
// irrelevant. The predicate does NOT gate on stdout.isTTY (an interactive
// terminal): an agent-driven run (Claude Code spawning consort-drive) is non-TTY
// yet fully human-driven, and it MUST emit. The old isTTY gate silently
// suppressed telemetry for that (dominant) usage; it is gone.

import { describe, it, expect } from "vitest";
import { shouldEmitTelemetry } from "../../consort/telemetry/consent";

const base = { telemetryEnabled: true, env: {} as NodeJS.ProcessEnv };

describe("telemetry consent predicate", () => {
  it("emits when all conditions hold (enabled + no CI/kill)", () => {
    expect(shouldEmitTelemetry(base)).toBe(true);
  });

  it("emits regardless of launch method – there is NO TTY gate", () => {
    // The predicate has no isTTY input; a non-TTY (agent-driven / shell) run emits
    // exactly like an interactive one. This is the requirement: captured whenever used.
    expect(shouldEmitTelemetry({ telemetryEnabled: true, env: {} })).toBe(true);
  });

  it("does NOT emit when persisted telemetry is disabled", () => {
    expect(shouldEmitTelemetry({ ...base, telemetryEnabled: false })).toBe(false);
  });

  it.each(["1", "true", "TRUE"])("does NOT emit in CI (CI=%s)", (v) => {
    expect(shouldEmitTelemetry({ ...base, env: { CI: v } })).toBe(false);
  });

  it("does NOT emit when CONSORT_TELEMETRY=0 (explicit kill)", () => {
    expect(shouldEmitTelemetry({ ...base, env: { CONSORT_TELEMETRY: "0" } })).toBe(false);
  });

  it("CONSORT_TELEMETRY=1 is NOT a force-enable (cannot re-enable a disabled/CI run)", () => {
    // A truthy value never overrides a disabling condition.
    expect(shouldEmitTelemetry({ telemetryEnabled: false, env: { CONSORT_TELEMETRY: "1" } })).toBe(false);
    expect(shouldEmitTelemetry({ telemetryEnabled: true, env: { CI: "1", CONSORT_TELEMETRY: "1" } })).toBe(false);
  });

  it("CI=false / CI=0 / CI unset are treated as NOT in CI", () => {
    expect(shouldEmitTelemetry({ ...base, env: { CI: "false" } })).toBe(true);
    expect(shouldEmitTelemetry({ ...base, env: { CI: "0" } })).toBe(true);
    expect(shouldEmitTelemetry({ ...base, env: { CI: "" } })).toBe(true);
  });

  it("a disabling env wins even when everything else says emit", () => {
    expect(shouldEmitTelemetry({ telemetryEnabled: true, env: { CONSORT_TELEMETRY: "0" } })).toBe(false);
  });
});
