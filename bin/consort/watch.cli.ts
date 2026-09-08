#!/usr/bin/env node
// consort-watch: follow a backgrounded drive's live log and relay each phase/role/
// gate transition in plain language, STOPPING when control returns to the human (a
// gate, a pause, an escalation) or the run ends. This is the kit-owned replacement
// for a session hand-rolling `tail -f .consort/drive-live.log | while read; case …`
// (brittle: it re-guesses the drive's line formats). The scaffolded slash commands
// background the drive to `.consort/drive-live.log`; run this to watch it.
//
//   consort-watch [--log <path>] [--pid <n>] [--from-start] [--project-dir <p>] [--tdd-dir <p>]
//
// Exit: 0 = clean stop (gate / pause / done); 3 = escalation; 2 = log never appeared.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { classifyDriveLine, type WatchLineKind, type WatchClass } from "../../consort/orchestrator/drive/watch-classify.js";
import { openRoleArtifacts } from "../../consort/orchestrator/open/open-in-editor.js";
import { DESIGN_ROLES, resolveScope } from "../../consort/orchestrator/open/resolve-review-artifacts.js";
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

interface Args {
  log?: string;
  pid?: number;
  fromStart: boolean;
  projectDir: string;
  consortDir?: string;
  /** Open the reviewable artifacts in the editor when stopping at a gate/pause. */
  open: boolean;
  /** Bounded foreground wait (seconds): exit 0 ("still running") after this long
   *  WITHOUT a stop, so a foreground invocation stays under the harness's ~2min
   *  bash timeout (whose SIGTERM can otherwise kill a same-group drive). 0 = no
   *  bound (use when running consort-watch itself as a detached/background task). */
  timeout: number;
  /** POLL-ONCE mode: read new lines from this byte offset, relay them, print
   *  `[consort-watch] cursor=<N> status=<running|gate|pause|escalation|done|waiting>`,
   *  and EXIT immediately (no blocking). This is the harness-friendly relay: a
   *  long-blocking follow is NOT streamed to the human (they see only a spinner
   *  until it returns), so the caller LOOPS short `--since <cursor>` calls and
   *  narrates each batch. undefined = the (legacy) blocking follow mode. */
  since?: number;
  /** PERSISTENT MONITOR mode (for the Monitor tool, NOT a Bash call): follow the log
   *  indefinitely and stop ONLY at a terminal marker (gate/pause/escalation/done).
   *  Unlike a `--pid`-bound follow, it does NOT exit when a drive process dies – so ONE
   *  monitor spans the drive's mid-turn silences AND its turn-by-turn re-runs (each run
   *  truncates drive-live.log; the follow re-reads from 0). This is the kit-owned
   *  replacement for a hand-rolled `tail -F | while read; case …`. Implies no timeout
   *  bound. Use ONLY as a Monitor-tool command; a blocking Bash call shows only a
   *  spinner until it returns. */
  monitor: boolean;
}

/** Per-turn open + relay report: open exactly what the just-finished ROLE produced (roleArtifacts,
 *  scoped to the live feature/story) and return one line for the human – NEVER silent for a design
 *  role: it says what it opened, or WHY it could not (not inside the editor's terminal / no editor
 *  CLI / nothing authored yet), so a skip is diagnosable instead of looking like nothing happened.
 *  A build turn (driver – no reviewable design artifact) returns null: opening nothing is expected.
 *  This is the visibility the design lane needs – after each role's turn, see its artifacts. */
export function reportRoleOpen(
  consortDir: string,
  role: string,
  env: NodeJS.ProcessEnv,
  spawn?: (cmd: string, files: string[]) => void,
): string | null {
  // LAKEBASE_CONSORT_OPEN=1/force lets a background monitor (whose process is NOT the editor's
  // integrated terminal, so isInsideEditor is false) still open – the human opted in, and the
  // editor CLI surfaces the file in the already-running instance regardless of the caller.
  // `spawn` is injectable so a test asserts the open WITHOUT launching the real editor (the
  // default resolves + spawns the real editor CLI, as production wants).
  const force = env.LAKEBASE_CONSORT_OPEN === "1" || env.LAKEBASE_CONSORT_OPEN === "force";
  const res = openRoleArtifacts(consortDir, role, { ...resolveScope(consortDir), env, force, ...(spawn ? { spawn } : {}) });
  if (res.opened) return `[consort-watch] opened ${res.files.length} artifact(s) produced by ${role} in ${res.editor}`;
  if (!DESIGN_ROLES.has(role)) return null; // build turn / no design output: expected, stay silent
  switch (res.reason) {
    case "not-in-editor":
      return `[consort-watch] ${role} turn done – ${res.files.length} artifact(s) to review, NOT opened – run the relay inside your Cursor/VS Code integrated terminal, OR set LAKEBASE_CONSORT_OPEN=1 to auto-open from a background monitor (else review via consort-open)`;
    case "no-editor":
      return `[consort-watch] ${role} turn done – no cursor/code CLI found to open its ${res.files.length} artifact(s) – install the editor's shell command (else review via consort-open)`;
    case "no-artifacts":
      return `[consort-watch] ${role} turn done – no reviewable artifact found yet for this scope`;
    default:
      return null;
  }
}

function parseArgs(argv: string[]): Args {
  const out: Args = { fromStart: false, projectDir: process.cwd(), open: true, timeout: 90, monitor: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--log": out.log = argv[++i]; break;
      case "--pid": out.pid = Number(argv[++i]); break;
      case "--timeout": out.timeout = Number(argv[++i]); break;
      case "--since": out.since = Number(argv[++i]); break;
      case "--from-start": out.fromStart = true; break;
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "--no-open": out.open = false; break;
      case "--monitor": out.monitor = true; out.timeout = 0; break; // persistent: no self-bound
      case "-h": case "--help":
        process.stdout.write(
          "consort-watch – follow a backgrounded drive's live log and relay transitions.\n\n" +
            "  consort-watch [--log <path>] [--pid <n>] [--from-start] [--project-dir <p>]\n" +
            "  consort-watch --since <cursor> [--pid <n>]   POLL-ONCE: new lines + status, exit at once (for a Bash-call relay loop)\n" +
            "  consort-watch --monitor                      PERSISTENT: follow the log across silences + drive re-runs, stop only at a marker (for the Monitor TOOL)\n\n" +
            "Defaults --log to <consort>/drive-live.log (the scaffolded `> … 2>&1 &` sink).\n" +
            "Stops at a gate / pause / escalation / run-end. Exit 0 clean, 3 escalation, 2 no log.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

const PREFIX: Record<WatchLineKind, string> = {
  dispatch: "  ->",
  "turn-done": "   ok",
  feature: " >>",
  skip: "  ~",
  gate: "GATE:",
  pause: "PAUSE:",
  escalation: "FAIL:",
  done: "DONE:",
  stalled: " !!",
  notice: "[consort]",
  info: "   .",
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the WHOLE log and return the LAST classified STOP line (gate/pause/escalation/
 *  done), or null if none. Used when the drive already reached a terminal marker before
 *  (or just as) we attached – a fast detached run that stopped before this follow
 *  started from EOF. Without it we'd miss the marker and falsely report an unclean exit.
 *  Works for ANY step (it matches whatever the classifier flags as a stop). */
export function scanLastStop(logPath: string): WatchClass | null {
  let last: WatchClass | null = null;
  try {
    for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
      const c = classifyDriveLine(line);
      if (c?.stop) last = c;
    }
  } catch {
    /* unreadable – treat as no stop found */
  }
  return last;
}

/** Emit the stop GUIDANCE for a terminal transition (point the human at consort-next at a
 *  gate/pause; consort-diagnose on escalation; else "run complete") and return the process
 *  exit code (3 for escalation, else 0). Artifacts are opened PER TURN as each role finishes
 *  (see the follow loop) – NOT batched here at the gate. The stop LINE itself is printed by
 *  the caller. Shared by the live follow AND the late-attach scan so both behave alike. */
function emitStop(c: WatchClass): number {
  if (c.outcome === "gate" || c.outcome === "pause") {
    process.stderr.write("consort-watch: control is back with you – run `consort-next` for the exact command, then re-run the drive.\n");
  } else if (c.outcome === "escalation") {
    process.stderr.write(`consort-watch: the run escalated – \`consort-diagnose\` bundles the forensics; after fixing the cause, \`consort-resolve-escalation\` clears it (do NOT rm the record), then re-run.\n`);
  } else {
    process.stderr.write("consort-watch: run complete.\n");
  }
  return c.outcome === "escalation" ? 3 : 0;
}

/** The AUTHORITATIVE stop signal: `.consort/next.json`, which the drive writes on EVERY
 *  stop (a gate, the planning backlog pause, accept/discard/revise, done, or an escalation)
 *  and NEVER while running. Read directly (no derive) so the persistent monitor can alert
 *  the INSTANT the drive stops, WITHOUT waiting on a `[drive]` marker the transient
 *  drive-live.log may never carry – the sit-at-gate bug. `generated_at` is stamped fresh on
 *  each stop, so a change since the monitor attached means a NEW stop (not the stale prior
 *  one). `awaiting_human` is the sole human-needed signal (mirrors consort-next). Returns
 *  null when next.json is absent/unreadable (the drive has not stopped yet). */
export interface NextStop {
  generated_at: string;
  awaiting_human: boolean;
  done: boolean;
  escalated: boolean;
  summary: string;
  hil?: string;
  enact?: string;
}
export function readNextStop(consortDir: string): NextStop | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(consortDir, "next.json"), "utf8")) as Record<string, unknown>;
    const primary = s.primary_action as { kind?: string } | undefined;
    const opts = Array.isArray(s.options) ? (s.options as Array<Record<string, unknown>>) : [];
    const opt = opts.find((o) => o?.id !== "resume" && o?.id !== "hold" && o?.kind !== "noop");
    const enactObj = opt?.enact as { bin?: string; args?: string[] } | undefined;
    const enact = enactObj?.bin ? `${enactObj.bin}${enactObj.args?.length ? " " + enactObj.args.join(" ") : ""}` : undefined;
    return {
      generated_at: String(s.generated_at ?? ""),
      awaiting_human: s.awaiting_human === true,
      done: primary?.kind === "done",
      escalated: primary?.kind === "raise-to-hil",
      summary: String(s.summary ?? ""),
      hil: typeof opt?.hil_prompt === "string" ? (opt.hil_prompt as string) : undefined,
      enact,
    };
  } catch {
    return null;
  }
}

/** True when next.json describes a real STOP the monitor must surface (a human decision,
 *  a terminal done, or an escalation) – as opposed to a mid-run snapshot. */
function isNextStop(ns: NextStop | null): ns is NextStop {
  return !!ns && (ns.awaiting_human || ns.done || ns.escalated);
}

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
export type PidGoneKind = "stop" | "turn-boundary" | "crash";
export function classifyPidGone(
  ns: NextStop | null,
  actionBaseline: string,
  lastStop: WatchClass | null,
): PidGoneKind {
  // Read the action identity BEFORE the isNextStop guard: isNextStop is a type predicate, so
  // after it TS narrows `ns` to null and would reject ns.enact/summary.
  const action = ns ? (ns.enact ?? ns.summary ?? "") : "";
  if (isNextStop(ns) || lastStop) return "stop";
  if (action && action !== actionBaseline) return "turn-boundary";
  return "crash";
}

/** Emit the stop from next.json (the authoritative surface) and return the exit code.
 *  Used by the persistent monitor so a drive-stop is surfaced the moment next.json changes,
 *  never contingent on a log marker. Escalation => 3; gate/done => 0. */
function emitNextStop(ns: NextStop): number {
  process.stdout.write(`[consort-watch] DRIVE STOPPED – ${ns.summary || (ns.done ? "run complete" : ns.escalated ? "escalation" : "awaiting a decision")}\n`);
  if (ns.escalated) {
    process.stderr.write("consort-watch: the run escalated – `consort-diagnose` bundles the forensics; after fixing the cause, `consort-resolve-escalation` clears it (do NOT rm the record), then re-run.\n");
    return 3;
  }
  if (ns.done) {
    process.stderr.write("consort-watch: run complete.\n");
    return 0;
  }
  // awaiting_human at a gate / backlog / accept-discard-revise: surface the prompt + the
  // exact enact command. (Artifacts are opened per turn as roles finish, not here.)
  if (ns.hil) process.stdout.write(`[consort-watch] HUMAN NEEDED: ${ns.hil}${ns.enact ? ` – run: ${ns.enact}` : ""}\n`);
  process.stderr.write("consort-watch: control is back with you – run `consort-next` for the exact command, then re-run the drive.\n");
  return 0;
}

export type PollStatus = "running" | "gate" | "pause" | "escalation" | "done" | "waiting";
export interface PollResult {
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
export function pollOnce(
  logPath: string,
  since: number,
  pid?: number,
  isAlive: (p: number) => boolean = alive,
  nowMs: number = Date.now(),
): PollResult {
  const pidAlive = pid === undefined ? null : isAlive(pid);
  if (!fs.existsSync(logPath)) return { relayed: [], turnsDone: [], cursor: 0, status: "waiting", silentMs: 0, pidAlive };
  const st = fs.statSync(logPath);
  const size = st.size;
  const silentMs = Math.max(0, nowMs - st.mtimeMs); // measured: since the last log write
  const from = since < 0 || since > size ? 0 : since; // clamp; truncation => re-read
  const relayed: string[] = [];
  const turnsDone: string[] = [];
  let status: PollStatus = "running";
  if (size > from) {
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    let inNotice = false;
    for (const line of buf.toString("utf8").split("\n")) {
      if (inNotice) {
        if (/^\s+\S/.test(line)) { relayed.push(line.replace(/\s+$/, "")); continue; }
        inNotice = false;
      }
      const c = classifyDriveLine(line);
      if (!c) continue;
      relayed.push(`${PREFIX[c.kind]} ${c.text}`);
      if (c.kind === "notice") { inNotice = true; continue; }
      // A finished role turn: record the role so the caller can open what it produced.
      if (c.kind === "turn-done") {
        const role = c.text.match(/^(\S+) turn/)?.[1];
        if (role) turnsDone.push(role);
      }
      if (c.stop && c.outcome) status = c.outcome; // last stop in this batch wins
    }
  }
  // Process gone + nothing new PAST our cursor => scan the whole log for the real
  // terminal marker (a stop at any step the caller's cursor started after).
  if (status === "running" && pidAlive === false && size <= from) {
    status = scanLastStop(logPath)?.outcome ?? "done";
  }
  return { relayed, turnsDone, cursor: size, status, silentMs, pidAlive };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const logPath = args.log ?? path.join(consortDir, "drive-live.log");

  // POLL-ONCE (--since <offset>): read new lines from the offset, relay them, print a
  // machine-readable `[consort-watch] cursor=<N> status=<…> silent_for_s=<N> pid_alive=<…>`
  // trailer, and EXIT at once. This is the harness-friendly relay – a blocking follow is not
  // streamed to the human (they see only a spinner until it returns), so the caller LOOPS
  // short --since calls and narrates each batch. `silent_for_s` + `pid_alive` are MEASURED
  // (log mtime + pid probe): relay them as-is and do NOT infer a "hung" / "stuck N min"
  // verdict from a long silence – one model call is silent until it returns, so only the
  // drive's own `stalled` line is an authoritative stall. Returns fast whether or not there
  // is new content.
  if (args.since !== undefined) {
    const r = pollOnce(logPath, args.since, args.pid);
    for (const line of r.relayed) process.stdout.write(`${line}\n`);
    // PER-TURN artifact open – THE path the design lane actually runs. For each role whose
    // turn finished this batch, reveal what it produced (a no-op unless inside the editor;
    // openRoleArtifacts' own guard) and relay the result, so the human sees each role's output
    // turn by turn. (The old open lived only in the blocking-tail/--monitor loop below, which
    // the mandatory poll-once relay never enters – so it never fired during a normal run.)
    if (args.open) {
      for (const role of r.turnsDone) {
        const rep = reportRoleOpen(consortDir, role, process.env);
        if (rep) process.stdout.write(`${rep}\n`);
      }
    }
    process.stdout.write(
      `[consort-watch] cursor=${r.cursor} status=${r.status} silent_for_s=${Math.round(r.silentMs / 1000)} pid_alive=${r.pidAlive === null ? "unknown" : r.pidAlive}\n`,
    );
    return 0;
  }

  // Wait (bounded) for the log to appear – the drive may be backgrounding just now.
  const APPEAR_MS = 30_000;
  const t0 = Date.now();
  while (!fs.existsSync(logPath)) {
    if (args.pid && !alive(args.pid)) {
      process.stderr.write(`consort-watch: drive pid ${args.pid} exited before ${logPath} appeared.\n`);
      return 2;
    }
    if (Date.now() - t0 > APPEAR_MS) {
      process.stderr.write(`consort-watch: no ${logPath} after ${APPEAR_MS / 1000}s.\n`);
      return 2;
    }
    await sleep(300);
  }

  // Follow from the current end (like `tail -n 0 -f`) unless --from-start.
  let offset = args.fromStart ? 0 : fs.statSync(logPath).size;
  let carry = "";
  // A `[consort]` disclosure is multi-line: the first line classifies as `notice`;
  // the following indented lines (the opt-out + Level-2 offer) carry no prefix, so we
  // surface them verbatim while inside the block. Persists across chunk reads.
  let inNotice = false;
  const watchStart = Date.now();
  process.stderr.write(`consort-watch: following ${logPath}${args.pid ? ` (pid ${args.pid})` : ""}\n`);

  // Monitor late-attach: if the drive ALREADY wrote a terminal marker before this monitor
  // started following from EOF, report it now. Monitor mode skips the pid-gone exit (to
  // span re-runs), so without this it would follow an already-finished log forever. (In
  // the normal case – armed while the drive runs, no marker yet – scanLastStop is null and
  // we follow forward. A re-run truncates the log, so no stale marker survives.)
  if (args.monitor) {
    const last = scanLastStop(logPath);
    if (last) {
      process.stdout.write(`${PREFIX[last.kind]} ${last.text}\n`);
      return emitStop(last);
    }
  }

  // Persistent-monitor stop detection – the fix for "sits at a gate for hours". The drive
  // writes next.json on EVERY stop, so the monitor alerts the INSTANT it stops instead of
  // waiting on a [drive] log marker the transient log may never carry. `nextBaseline` is the
  // snapshot present at attach (the drive is running now, so this is the prior/handled stop);
  // the no-pid fallback fires only on a CHANGE. With --pid (recommended), a dead pid IS the
  // stop – unambiguous, no staleness. Either way the authoritative STATE comes from next.json.
  const nextBaseline = readNextStop(consortDir)?.generated_at ?? "";
  // The pending next-ACTION at attach (enact, else summary) – the progress signal for the
  // pid-gone check: a CHANGE means the drive advanced a turn (benign boundary); UNCHANGED +
  // no stop means it is stuck/crashed on the same action.
  const baselineForAction = readNextStop(consortDir);
  const actionBaseline = baselineForAction ? (baselineForAction.enact ?? baselineForAction.summary ?? "") : "";
  const monitorStopCheck = (): number | null => {
    const pidGone = args.pid !== undefined && !alive(args.pid);
    const ns = readNextStop(consortDir);
    if (pidGone) {
      const last = scanLastStop(logPath);
      const kind = classifyPidGone(ns, actionBaseline, last);
      if (kind === "stop") {
        if (isNextStop(ns)) return emitNextStop(ns);
        process.stdout.write(`${PREFIX[last!.kind]} ${last!.text}\n`);
        return emitStop(last!);
      }
      if (kind === "turn-boundary") {
        // Benign: the drive advanced a turn and exited for a re-run (NOT a crash). Exit 0
        // with a re-run hint instead of the exit-3 crash alarm, so a per-turn drive does not
        // trip a false "check for a crash" every single turn boundary.
        process.stdout.write(`[consort-watch] turn boundary – the drive advanced (${ns?.summary || ns?.enact || "next action ready"}) and exited; re-run the drive to continue.\n`);
        return 0;
      }
      if (baselineForAction === null && ns === null) {
        // Plain detached-process watch (scaffolder / installer), not a drive: there is no
        // next.json to record a stop, so a gone pid is normal completion, not a crash. Exit 0
        // (the watch did its job); the caller reads the log for the process's own result. Without
        // this the Monitor tool reports a SUCCESSFUL scaffold/install as "script failed (exit 3)".
        process.stdout.write(`[consort-watch] process (pid ${args.pid}) finished — see the log for its result.\n`);
        return 0;
      }
      process.stderr.write(`consort-watch: drive pid ${args.pid} is no longer running with no progress + no stop recorded – run consort-next to check for a crash.\n`);
      return 3;
    }
    // No --pid: a FRESH next.json stop (generated_at changed since attach) means the drive
    // stopped even though we cannot probe its pid.
    if (args.pid === undefined && isNextStop(ns) && ns.generated_at !== nextBaseline) {
      return emitNextStop(ns);
    }
    return null;
  };

  for (;;) {
    const size = fs.statSync(logPath).size;
    if (size < offset) offset = 0; // truncated / rotated – restart
    if (size > offset) {
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      carry += buf.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? ""; // keep the partial last line for next read
      for (const line of lines) {
        // Inside a `[consort]` disclosure block, surface the indented continuation
        // lines (opt-out + Level-2 offer) verbatim; a blank / non-indented line ends it.
        if (inNotice) {
          if (/^\s+\S/.test(line)) { process.stdout.write(`${line.replace(/\s+$/, "")}\n`); continue; }
          inNotice = false;
        }
        const c = classifyDriveLine(line);
        if (!c) continue;
        process.stdout.write(`${PREFIX[c.kind]} ${c.text}\n`);
        if (c.kind === "notice") { inNotice = true; continue; }
        // PER-TURN artifact open: when a role's turn finishes, reveal exactly what THAT role
        // produced – visibility only, a no-op unless inside an editor, and never silent for a
        // design role (reportRoleOpen says opened / why-not). Same path as the poll-once relay.
        if (c.kind === "turn-done" && args.open) {
          const role = c.text.match(/^(\S+) turn/)?.[1];
          if (role) {
            const rep = reportRoleOpen(consortDir, role, process.env);
            if (rep) process.stdout.write(`${rep}\n`);
          }
        }
        // The exact next command lives in the authoritative read-only surface, not in
        // this line's indented follow-up (which the classifier skips) – emitStop points there.
        if (c.stop) return emitStop(c);
      }
    }
    // Drive process gone + nothing more to read PAST our offset. This is the common
    // late-attach case: a fast detached drive wrote its terminal marker (a PAUSE at any
    // step, a gate, done) and exited BEFORE we started following from EOF. Scan the whole
    // log for the last stop and report the REAL outcome – NOT a false "unclean exit".
    // Only when there is genuinely no stop marker anywhere is it a crash/kill.
    // Persistent monitor: alert the moment the drive STOPS – keyed on the authoritative
    // next.json (written on every stop) + the drive pid, NEVER on a [drive] log marker that
    // the transient log may never carry. This is the fix for the monitor sitting silently at
    // a gate for hours: previously --monitor skipped the pid-gone check to "span re-runs" and
    // waited only for a marker, so a marker-less drive-exit (a plan gate that wrote next.json
    // but no [drive] stop line) left it polling forever.
    if (args.monitor) {
      const code = monitorStopCheck();
      if (code !== null) return code;
    } else if (args.pid && !alive(args.pid) && fs.statSync(logPath).size <= offset) {
      // Non-monitor follow: the drive is gone + nothing more to read. Report the last
      // stop marker, else a genuine crash (no terminal line seen).
      const last = scanLastStop(logPath);
      if (last) {
        process.stdout.write(`${PREFIX[last.kind]} ${last.text}\n`);
        return emitStop(last);
      }
      process.stderr.write(`consort-watch: drive pid ${args.pid} is no longer running (no terminal line seen).\n`);
      return 3;
    }
    // Bounded foreground wait: exit cleanly BEFORE the harness's ~2min bash timeout
    // fires a SIGTERM (which, if the drive shares this process group, would kill the
    // drive too). The drive keeps running detached; re-run consort-watch to resume.
    if (args.timeout > 0 && (Date.now() - watchStart) / 1000 >= args.timeout) {
      process.stderr.write(
        `consort-watch: still running after ${args.timeout}s and no gate yet – the drive continues in the background. ` +
          `Re-run \`consort-watch\` to keep relaying (or pass --timeout 0 when running consort-watch itself detached).\n`,
      );
      return 0;
    }
    await sleep(400);
  }
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`consort-watch: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
