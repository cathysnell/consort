// Classify one line of a backgrounded drive's live log (`.consort/drive-live.log`,
// the scaffolded `> … 2>&1 &` sink). The drive emits human-readable `[drive]` /
// `[sprint]` narration to stderr; a session tailing that log wants to (a) relay
// each phase/role/gate transition and (b) STOP at the points where control returns
// to the human (a gate, a pause, an escalation) or the run ends.
//
// This is the ONE owner of those line formats (they are produced by
// claude-runner.ts + drive.cli.ts), so a consumer never re-guesses them with a
// brittle shell `case`. Pure + line-oriented => unit-testable against the exact
// strings the drive writes.

export type WatchLineKind =
  | "dispatch" // a role/action started (the `[drive] NNN …` per-action line)
  | "turn-done" // a role turn finished
  | "feature" // a sprint feature is being claimed/driven
  | "skip" // a backlog feature was skipped (already shipped)
  | "gate" // awaiting human approval  (STOP)
  | "pause" // awaiting human input     (STOP)
  | "escalation" // raised to HIL          (STOP, failure)
  | "done" // run / sprint complete   (STOP)
  | "stalled" // a turn stalled + is retrying (warn, continue)
  | "notice" // a `[consort]` disclosure (telemetry L1/L2 briefing) – surfaced verbatim
  | "info"; // another `[drive]`/`[sprint]` line worth showing

export interface WatchClass {
  kind: WatchLineKind;
  /** The line to show the human, with the `[drive] NNN ` bookkeeping trimmed. */
  text: string;
  /** STOP tailing after emitting this line (control has returned to the human). */
  stop: boolean;
  /** Terminal disposition, set when `stop` — drives the watcher's exit code. */
  outcome?: "gate" | "pause" | "done" | "escalation";
}

/** Classify a single log line. Returns null for lines that are not drive/sprint
 *  narration (raw tool output, blank lines, agent chatter) – the watcher skips them. */
export function classifyDriveLine(raw: string): WatchClass | null {
  const line = raw.replace(/\s+$/, "");

  // Escalation is checked FIRST, before the [drive]/[sprint] prefix guard: drive.cli
  // writes "[drive] <err>\n        recorded under <dir>/escalations/ …", so the
  // load-bearing marker is on the INDENTED continuation line (no prefix). The
  // preceding "[drive] <err>" line falls through to `info` and shows the error text.
  if (/recorded under .*escalations\//.test(line)) {
    return { kind: "escalation", text: line.trim(), stop: true, outcome: "escalation" };
  }

  // `[consort]` disclosures (the one-time telemetry L1/L2 briefing, written to the
  // drive's stderr by onNotice) are NOT tooling noise – the orchestrator contract
  // requires surfacing them. They land in drive-live.log like everything else, so the
  // narrator MUST relay them; without this they were dropped by the guard below and
  // the human was never briefed. The notice is multi-line – this classifies its FIRST
  // line; the watcher surfaces the indented continuation lines that follow (they carry
  // the opt-out + the Level-2 offer).
  if (line.startsWith("[consort]")) {
    return { kind: "notice", text: line.replace(/^\[consort\] /, ""), stop: false };
  }

  // `lk:` install narration (a backgrounded `--refresh` – the kit download + heartbeat).
  // The same relay follows create / refresh / drive, so surface these verbatim.
  if (/^lk: /.test(line)) {
    return { kind: "info", text: line.replace(/^lk: /, ""), stop: false };
  }

  const isDrive = line.startsWith("[drive]");
  const isSprint = line.startsWith("[sprint]");
  // `lakebase-create-project` narrates provisioning as bracketed stage lines – e.g.
  // "[Creating GitHub repository...]", "[Scaffolding project files...]", "[doctor] …",
  // "[Project created successfully!]". Relay ANY bracketed line, not just [drive]/[sprint],
  // so create's Part-1 stages surface through the same watcher. Non-bracketed noise
  // (raw npm/pytest lines) is still skipped.
  const isBracketed = /^\[[^\]]+\]/.test(line);
  if (!isDrive && !isSprint && !isBracketed) return null;

  // ── STOP points (control returns to the human) ───────────────────────────
  // The escalation headline itself ("[drive]/[sprint] RAISED TO HIL …"), so the
  // watcher stops ON it rather than one line later at "recorded under escalations/".
  if (/\bRAISED TO HIL\b/.test(line)) {
    return { kind: "escalation", text: line.replace(/^\[(drive|sprint)\] /, ""), stop: true, outcome: "escalation" };
  }
  // An unexpected crash the drive could not classify (drive.cli's last-resort catch).
  // A terminal failure – STOP so the watcher / a Monitor surfaces it instead of the
  // run looking still-in-flight (a bare error line would classify as `null` + be skipped).
  if (/^\[drive\] ABORTED\b/.test(line)) {
    return { kind: "escalation", text: line.replace(/^\[drive\] /, ""), stop: true, outcome: "escalation" };
  }
  if (/^\[drive\] GATE awaiting human approval:/.test(line)) {
    return { kind: "gate", text: line, stop: true, outcome: "gate" };
  }
  if (/^\[drive\] PAUSED\b/.test(line) || /^\[sprint\] paused on\b/.test(line)) {
    return { kind: "pause", text: line, stop: true, outcome: "pause" };
  }
  if (/^\[drive\] holding\b/.test(line)) {
    return { kind: "pause", text: line, stop: true, outcome: "pause" };
  }
  if (/^\[sprint\] .*\bcomplete:/.test(line) || /^\[drive\] done in \d+ actions\b/.test(line)) {
    return { kind: "done", text: line, stop: true, outcome: "done" };
  }
  if (/^\[drive\] stopped at --max-steps\b/.test(line)) {
    return { kind: "done", text: line, stop: true, outcome: "done" };
  }

  // ── Progress (relay, keep tailing) ───────────────────────────────────────
  // The per-action line: "[drive] 000 dispatch spec-author for design". Trim the
  // "[drive] NNN " bookkeeping so the relay reads as the transition itself.
  const perAction = line.match(/^\[drive\] \d{3} (.*)$/);
  if (perAction) return { kind: "dispatch", text: perAction[1], stop: false };
  if (/^\[drive\] \S+ turn [\d.]+s\b/.test(line)) {
    return { kind: "turn-done", text: line.replace(/^\[drive\] /, ""), stop: false };
  }
  if (/^\[sprint\] feature \d+:.*already shipped, skipping/.test(line)) {
    return { kind: "skip", text: line.replace(/^\[sprint\] /, ""), stop: false };
  }
  if (/^\[sprint\] feature \d+:/.test(line)) {
    return { kind: "feature", text: line.replace(/^\[sprint\] /, ""), stop: false };
  }
  if (/^\[drive\] turn stalled:/.test(line)) {
    return { kind: "stalled", text: line.replace(/^\[drive\] /, ""), stop: false };
  }

  // Any other drive/sprint line worth surfacing (resuming, auto-continue, kit-moved…).
  return { kind: "info", text: line.replace(/^\[(drive|sprint)\] /, ""), stop: false };
}
