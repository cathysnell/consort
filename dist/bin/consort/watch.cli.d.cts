#!/usr/bin/env node
type WatchLineKind = "dispatch" | "turn-done" | "feature" | "skip" | "gate" | "pause" | "escalation" | "done" | "stalled" | "notice" | "info";
interface WatchClass {
    kind: WatchLineKind;
    /** The line to show the human, with the `[drive] NNN ` bookkeeping trimmed. */
    text: string;
    /** STOP tailing after emitting this line (control has returned to the human). */
    stop: boolean;
    /** Terminal disposition, set when `stop` — drives the watcher's exit code. */
    outcome?: "gate" | "pause" | "done" | "escalation";
}

/** Per-turn open + relay report: open exactly what the just-finished ROLE produced (roleArtifacts,
 *  scoped to the live feature/story) and return one line for the human – NEVER silent for a design
 *  role: it says what it opened, or WHY it could not (not inside the editor's terminal / no editor
 *  CLI / nothing authored yet), so a skip is diagnosable instead of looking like nothing happened.
 *  A build turn (driver – no reviewable design artifact) returns null: opening nothing is expected.
 *  This is the visibility the design lane needs – after each role's turn, see its artifacts. */
declare function reportRoleOpen(consortDir: string, role: string, env: NodeJS.ProcessEnv, spawn?: (cmd: string, files: string[]) => void): string | null;
/** Read the WHOLE log and return the LAST classified STOP line (gate/pause/escalation/
 *  done), or null if none. Used when the drive already reached a terminal marker before
 *  (or just as) we attached – a fast detached run that stopped before this follow
 *  started from EOF. Without it we'd miss the marker and falsely report an unclean exit.
 *  Works for ANY step (it matches whatever the classifier flags as a stop). */
declare function scanLastStop(logPath: string): WatchClass | null;
/** The AUTHORITATIVE stop signal: `.consort/next.json`, which the drive writes on EVERY
 *  stop (a gate, the planning backlog pause, accept/discard/revise, done, or an escalation)
 *  and NEVER while running. Read directly (no derive) so the persistent monitor can alert
 *  the INSTANT the drive stops, WITHOUT waiting on a `[drive]` marker the transient
 *  drive-live.log may never carry – the sit-at-gate bug. `generated_at` is stamped fresh on
 *  each stop, so a change since the monitor attached means a NEW stop (not the stale prior
 *  one). `awaiting_human` is the sole human-needed signal (mirrors consort-next). Returns
 *  null when next.json is absent/unreadable (the drive has not stopped yet). */
interface NextStop {
    generated_at: string;
    awaiting_human: boolean;
    done: boolean;
    escalated: boolean;
    summary: string;
    hil?: string;
    enact?: string;
}
declare function readNextStop(consortDir: string): NextStop | null;
/** When the monitored drive's PID is gone, classify WHY it exited – so the persistent
 *  --monitor does not false-alarm on every turn. The deterministic drive performs its
 *  action(s) and EXITS at a boundary (the driver re-runs it per turn), so a dead pid is
 *  usually NOT a crash.
 *  - `stop`  : a real terminal – a gate/pause/done/escalation (next.json awaiting_human/
 *              done/escalated, or a log stop marker).
 *  - `turn-boundary` : the drive ADVANCED to a new next-action and exited cleanly for a
 *              re-run (its action identity – `enact`, else `summary` – CHANGED since we
 *              attached). Benign; the driver just re-runs. NOT a crash.
 *  - `crash` : pid gone with NO progress (same pending action) AND no stop marker – genuinely
 *              stuck or died (e.g. a substrate-failure the re-run keeps hitting).
 *  The ACTION IDENTITY, not `generated_at`, is the progress signal: a crash that re-derives +
 *  re-writes the SAME action each retry keeps the same identity (generated_at still advances),
 *  so it is correctly caught as `crash` rather than hidden as false progress. */
type PidGoneKind = "stop" | "turn-boundary" | "crash";
declare function classifyPidGone(ns: NextStop | null, actionBaseline: string, lastStop: WatchClass | null): PidGoneKind;
/** True when a monitored log is a DRIVE's log — it carries `[drive]` step markers. A plain
 *  detached process (installer / scaffolder) writes no such markers (npm fetch, `[Creating…]`),
 *  so a gone pid there is normal completion, not a crash. Missing/empty log => not a drive log. */
declare function logIsFromDrive(logPath: string): boolean;
type PollStatus = "running" | "gate" | "pause" | "escalation" | "done" | "waiting";
interface PollResult {
    /** The lines a human sees this poll, already PREFIX-formatted (role/gate/etc.). */
    relayed: string[];
    /** Roles whose turn FINISHED in this batch (one per `[drive] <role> turn Ns` line), in
     *  order – the caller opens each role's produced artifacts for the human to review before
     *  the next turn. Empty when no turn completed this poll. */
    turnsDone: string[];
    /** New byte offset – pass as the next `--since`. */
    cursor: number;
    /** running until a stop is seen (this batch OR, when the pid is gone, anywhere in the log). */
    status: PollStatus;
    /** MEASURED liveness, never inferred: ms since the log's last write (now - mtime). A long
     *  silent stretch is a slow OR a hung turn – the log ALONE CANNOT tell which (one model
     *  call writes nothing until it returns), so the caller RELAYS this number and must NOT
     *  invent a "hung" / "stuck N min" verdict from it. The only authoritative stall signal is
     *  the drive's own `[drive] turn stalled:` line (emitted by the in-process inactivity
     *  monitor after real silence), which classifies as kind `stalled`. */
    silentMs: number;
    /** MEASURED: is the drive pid alive? `null` when no pid was supplied (unknown, never guessed). */
    pidAlive: boolean | null;
}
/** POLL-ONCE, pure + testable (no stdout): read new lines from `since` to EOF, format
 *  each meaningful transition for relay, and resolve the status. This is the ONE relay
 *  the guidance mandates – the caller loops it (narrating `relayed` each time) until
 *  `status` is a stop. `isAlive` is injectable so a test can drive the pid-gone path;
 *  `nowMs` is injectable so a test can drive the measured-silence path deterministically.
 *  Also returns MEASURED liveness (`silentMs`, `pidAlive`) so the caller relays real
 *  numbers and never has to guess how long a quiet turn has been running. */
declare function pollOnce(logPath: string, since: number, pid?: number, isAlive?: (p: number) => boolean, nowMs?: number): PollResult;

export { type NextStop, type PidGoneKind, type PollResult, type PollStatus, classifyPidGone, logIsFromDrive, pollOnce, readNextStop, reportRoleOpen, scanLastStop };
