// The telemetry consent predicate. Pure: no I/O, no clock, no globals – the
// caller supplies the persisted flag and the env.
//
// Emit IFF ALL of these hold:
//   1. telemetry_enabled === true      (the persisted opt-out flag)
//   2. CI is unset / falsey            (a project's CI pipeline is not a user of Consort)
//   3. CONSORT_TELEMETRY !== "0"       (the kit's explicit per-invocation kill)
//
// TELEMETRY IS CAPTURED WHENEVER CONSORT IS USED – the launch method is
// irrelevant (shell launcher, interactive, or agent-driven). It was originally
// ALSO gated on `stdout.isTTY === true`, using an interactive terminal as a proxy
// for "a human is present". But the primary way Consort runs – an agent (Claude
// Code) spawning `consort-drive` as a subprocess – is NON-TTY yet fully
// human-driven, so that proxy silently suppressed telemetry for essentially all
// real usage. The TTY gate is GONE: capture never depends on a terminal.
// Disclosure is delivered independently of the TTY (the first-run notice fires
// whenever consent holds; see with-telemetry.ts), so the opt-out model is
// preserved without conflating "no terminal" with "no human".
//
// Environment overrides ALWAYS win – and they only ever DISABLE. There is no
// force-enable env: an operator can always silence telemetry (CI,
// CONSORT_TELEMETRY=0). This is a conjunction: any single failing condition => no
// emit (a silent no-op upstream).

export interface ConsentInputs {
  /** The persisted `telemetry_enabled` flag (from ~/.config/consort). */
  telemetryEnabled: boolean;
  /** The process environment (read for CI / CONSORT_TELEMETRY). */
  env: NodeJS.ProcessEnv;
}

/** CI is "truthy" for anything set + non-empty that is not explicitly 0/false ,
 *  err toward NOT emitting (privacy-safe) when a CI provider sets an odd value. */
const inCi = (env: NodeJS.ProcessEnv): boolean => {
  const v = (env.CI ?? "").trim();
  if (v === "") return false;
  return !/^(0|false)$/i.test(v);
};

/** The kit's explicit per-invocation kill: CONSORT_TELEMETRY="0" disables. */
const killed = (env: NodeJS.ProcessEnv): boolean => (env.CONSORT_TELEMETRY ?? "").trim() === "0";

/**
 * Whether telemetry may be emitted for this invocation. See the module header
 * for the condition conjunction. Env overrides (kill, CI) are checked first so
 * they always win.
 */
export function shouldEmitTelemetry(inp: ConsentInputs): boolean {
  if (killed(inp.env)) return false;
  if (inCi(inp.env)) return false;
  if (!inp.telemetryEnabled) return false;
  return true;
}
