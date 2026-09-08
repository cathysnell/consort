#!/usr/bin/env node
/** Overridable inputs, so tests isolate the config to a temp dir. */
interface HomeConfigDeps {
    env?: NodeJS.ProcessEnv;
    /** Home dir override (defaults to os.homedir()); used only when $XDG_CONFIG_HOME is unset. */
    homedir?: string;
}

interface TelemetryCliDeps extends HomeConfigDeps {
    out?: (s: string) => void;
    err?: (s: string) => void;
    isTTY?: boolean;
}
/** The status snapshot (also the --json shape). */
interface TelemetryStatus {
    telemetry_enabled: boolean;
    install_id: string;
    will_emit_now: boolean;
    is_tty: boolean;
    in_ci: boolean;
    killed: boolean;
    endpoint_armed: boolean;
    config_file: string;
    schema: string;
    level: number;
    /** True once the human has been briefed + decided. FALSE means `/consort:start`
     *  should present the L1 opt-out + L2 opt-in briefing (a config that merely exists
     *  is NOT acknowledgment). This is the gate for the briefing. */
    acknowledged: boolean;
}
/** Run the CLI. Returns the process exit code. Never throws. */
declare function runTelemetryCli(argv: string[], deps?: TelemetryCliDeps): number;
/** `consort-telemetry beacon` – send the one-time install beacon (a random id + version + date).
 *  Async (a network POST), so it is a separate entry from the sync runTelemetryCli. ALWAYS exits
 *  0: the beacon is best-effort and must never fail the caller (the `/consort:start` briefing runs
 *  it right after disclosing it). Idempotent + fires regardless of the opt-out (see install-beacon). */
declare function runTelemetryBeacon(deps?: TelemetryCliDeps): Promise<number>;

export { type TelemetryCliDeps, type TelemetryStatus, runTelemetryBeacon, runTelemetryCli };
