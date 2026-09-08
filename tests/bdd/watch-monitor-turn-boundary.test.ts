// consort-watch --monitor must NOT false-alarm exit-3 on every turn boundary. The
// deterministic drive performs its action(s) and EXITS per turn (the driver re-runs it),
// so a dead pid is usually a benign turn boundary, not a crash. classifyPidGone tells them
// apart by the next-ACTION identity (advanced => benign; unchanged + no stop => stuck/crash),
// so the monitor alarms only at a real gate or a genuine stuck/crash – not on progress.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyPidGone, logIsFromDrive, type NextStop } from "../../bin/consort/watch.cli";
import type { WatchClass } from "../../consort/orchestrator/drive/watch-classify";

const ns = (o: Partial<NextStop>): NextStop => ({
  generated_at: "t",
  awaiting_human: false,
  done: false,
  escalated: false,
  summary: "",
  ...o,
});
const stopMarker: WatchClass = { kind: "gate", text: "GATE awaiting human approval", stop: true, outcome: "gate" };

describe("classifyPidGone (monitor: turn boundary vs stop vs crash)", () => {
  it("a real terminal (awaiting_human / done / escalated) => stop", () => {
    expect(classifyPidGone(ns({ awaiting_human: true, enact: "consort-next" }), "x", null)).toBe("stop");
    expect(classifyPidGone(ns({ done: true }), "x", null)).toBe("stop");
    expect(classifyPidGone(ns({ escalated: true }), "x", null)).toBe("stop");
  });

  it("a log stop marker => stop (even if next.json is not a stop)", () => {
    expect(classifyPidGone(ns({ enact: "a" }), "a", stopMarker)).toBe("stop");
  });

  it("advanced to a NEW next-action => benign turn boundary (re-run, don't alarm)", () => {
    expect(classifyPidGone(ns({ enact: "consort-drive --feature F4-outbound-pick" }), "consort-drive --plan-only", null)).toBe("turn-boundary");
    // enact absent -> summary is the identity
    expect(classifyPidGone(ns({ summary: "claiming F4 branch" }), "planning complete", null)).toBe("turn-boundary");
  });

  it("SAME pending action (stuck / crash-loop, e.g. F4 branch-claim substrate-failure) + no stop => crash", () => {
    expect(classifyPidGone(ns({ enact: "consort-drive --feature F4-outbound-pick" }), "consort-drive --feature F4-outbound-pick", null)).toBe("crash");
  });

  it("no next.json at all => crash", () => {
    expect(classifyPidGone(null, "x", null)).toBe("crash");
  });
});

describe("logIsFromDrive (monitor: is this a DRIVE log or a plain installer/scaffolder log?)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-drivelog-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a drive log (carries a [drive] step marker) => true", () => {
    const p = path.join(dir, "drive-live.log");
    fs.writeFileSync(p, "starting\n[drive] 000 dispatch spec-author for design\n");
    expect(logIsFromDrive(p)).toBe(true);
  });

  it("an installer/scaffolder log (no [drive] marker) => false — a gone pid there is NOT a crash", () => {
    const p = path.join(dir, "toolkit-install.log");
    fs.writeFileSync(p, "npm install\nadded 412 packages\n[Creating project portfolio-manager17]\ndone\n");
    expect(logIsFromDrive(p)).toBe(false);
  });

  it("a missing/empty log => false (default to the benign plain-process reading)", () => {
    expect(logIsFromDrive(path.join(dir, "nope.log"))).toBe(false);
    const empty = path.join(dir, "empty.log");
    fs.writeFileSync(empty, "");
    expect(logIsFromDrive(empty)).toBe(false);
  });
});
