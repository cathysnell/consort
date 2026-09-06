// turn-monitor: the wait/liveness capability for a step's dispatch-agent phase.
//
// Today the agent spawn is a blocking await with no heartbeat, no hard timeout, and no
// structured progress signal – a hung turn looks identical to a slow one. This adds an
// OPTIONAL monitor: fed the agent stream's per-line events, it emits progress (liveness),
// fires a heartbeat after a stretch of silence, and fires a hard timeout the caller maps to
// a TRANSIENT failure so the EXISTING transient-retry envelope handles the re-run – no new
// retry logic, no second stream channel.
//
// The controller is a small, pure state machine over an INJECTED clock so it is unit-tested
// with no real spawn/timers. Default (no monitor) is a total no-op: byte-identical to today.

/** One liveness event. `tool`/`text` mirror the agent stream; heartbeat/start/end are ours. */
export interface TurnProgress {
  kind: "tool" | "text" | "heartbeat" | "start" | "end";
  tool?: string;
  /** Clock time (ms) the event was emitted. */
  atMs: number;
}

/**
 * The monitor a caller supplies to observe + bound one agent turn. All fields optional:
 *  - onProgress: called once per stream line (liveness) + on start/end/heartbeat.
 *  - heartbeatMs: emit a "heartbeat" if no progress for this long (detects a stalled turn);
 *    re-arms after each beat + resets on any real progress.
 *  - inactivityTimeoutMs: SILENCE deadline; fires the caller's onTimeout after this long with
 *    NO progress, and RE-ARMS on every real event (so a turn that keeps streaming never trips,
 *    however long it runs – the wedge signature is silence, not duration). This is the primary
 *    guard against a stalled API stream (child alive, socket open, but no bytes ever arriving,
 *    so `close` never fires and the await hangs forever). Fires at most once.
 *  - timeoutMs: HARD deadline from start; fires onTimeout when reached regardless of activity.
 *    A backstop for a turn that streams forever without finishing. Fires at most once.
 *    When both are set, whichever elapses first wins (both routed to the same onTimeout).
 */
export interface TurnMonitor {
  /** Called with a fully-stamped event (the controller always supplies atMs). */
  onProgress?(p: TurnProgress): void;
  heartbeatMs?: number;
  inactivityTimeoutMs?: number;
  timeoutMs?: number;
}

/** The clock + timer seam – injected so the controller is tested with a fake clock. */
export interface MonitorClock {
  now(): number;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(t: ReturnType<typeof setTimeout>): void;
}

/** The default real clock (wall time + Node timers). */
export const realClock: MonitorClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

/** The live controller a caller drives across one turn. */
export interface MonitorController {
  /** Begin the turn: emit "start", arm the heartbeat + timeout. */
  start(): void;
  /** Record a stream event: emit it, reset the heartbeat. */
  progress(p: { kind: TurnProgress["kind"]; tool?: string }): void;
  /** End the turn: emit "end", clear all timers (safe to call after a timeout). */
  stop(): void;
}

/**
 * Build a monitor controller. `monitor` undefined => a no-op controller (byte-identical
 * default). `onTimeout` is the caller's hard-timeout handler (kill + transient reject); it
 * fires at most once and only when timeoutMs is set. `clock` defaults to the real clock.
 */
export function createMonitorController(
  monitor: TurnMonitor | undefined,
  onTimeout: () => void,
  clock: MonitorClock = realClock,
): MonitorController {
  if (!monitor) {
    return { start() {}, progress() {}, stop() {} };
  }

  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let stopped = false;

  const emit = (kind: TurnProgress["kind"], tool?: string) => {
    monitor.onProgress?.({ kind, tool, atMs: clock.now() });
  };

  const fireTimeout = () => {
    if (stopped || timedOut) return;
    timedOut = true;
    clearAll();
    onTimeout();
  };

  const armHeartbeat = () => {
    if (monitor.heartbeatMs === undefined) return;
    if (heartbeatTimer !== undefined) clock.clearTimer(heartbeatTimer);
    heartbeatTimer = clock.setTimer(() => {
      if (stopped || timedOut) return;
      emit("heartbeat");
      armHeartbeat(); // re-arm so silence keeps beating
    }, monitor.heartbeatMs);
  };

  // The inactivity (silence) deadline re-arms on every real event, exactly like the
  // heartbeat, but its firing is the hard onTimeout (kill + transient reject) rather than
  // a mere beat. This is what a stalled stream trips: no line for inactivityTimeoutMs.
  const armInactivity = () => {
    if (monitor.inactivityTimeoutMs === undefined) return;
    if (inactivityTimer !== undefined) clock.clearTimer(inactivityTimer);
    inactivityTimer = clock.setTimer(fireTimeout, monitor.inactivityTimeoutMs);
  };

  const clearAll = () => {
    if (heartbeatTimer !== undefined) clock.clearTimer(heartbeatTimer);
    if (inactivityTimer !== undefined) clock.clearTimer(inactivityTimer);
    if (timeoutTimer !== undefined) clock.clearTimer(timeoutTimer);
    heartbeatTimer = undefined;
    inactivityTimer = undefined;
    timeoutTimer = undefined;
  };

  return {
    start() {
      emit("start");
      armHeartbeat();
      armInactivity();
      // Hard deadline from start: fires regardless of activity (a turn that streams
      // forever without finishing). Armed once, never re-armed by progress.
      if (monitor.timeoutMs !== undefined) {
        timeoutTimer = clock.setTimer(fireTimeout, monitor.timeoutMs);
      }
    },
    progress(p) {
      if (stopped || timedOut) return;
      emit(p.kind, p.tool);
      armHeartbeat(); // real activity resets the silence clock
      armInactivity(); // ...and the inactivity (kill) deadline
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearAll();
      emit("end");
    },
  };
}
