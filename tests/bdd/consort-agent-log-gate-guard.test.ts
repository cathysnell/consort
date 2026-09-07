// The gate lifecycle is owned by the deterministic drive: the orchestrator code-emits
// gate.surfaced (lane-correct gate name) and the Human Proxy / approve-gate CLI records
// the decision, ALL in-process. A role agent shelling out `consort-log --event gate.*`
// from inside its own turn double-logs the gate under the wrong role AND at the wrong
// lane position (the architect-reviewer re-surfacing gate=plan mid-design re-lit the
// already-approved planning gate). The `consort-log` CLI — the agent's only door to the
// log — REJECTS the gate lifecycle (exit 3); the in-process lib (emitAgentLogEvent) still
// allows it, because that is the drive's door.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentLogCli } from "../../bin/consort/agent-log.cli";
import { emitAgentLogEvent, readAgentLog } from "../../consort/logging/agent-log";

let tdd: string;
let stderrText = "";
let restoreStderr: () => void;

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "agent-log-gate-guard-"));
  stderrText = "";
  // Silence the rejection message the CLI writes to stderr, capturing it to assert on.
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as never);
  restoreStderr = () => spy.mockRestore();
});
afterEach(() => {
  restoreStderr();
  rmSync(tdd, { recursive: true, force: true });
});

const GATE_EVENTS = ["gate.surfaced", "gate.approved", "gate.rejected", "gate.modified"] as const;

describe("consort-log CLI rejects a role-emitted gate lifecycle event (single emit)", () => {
  it.each(GATE_EVENTS)("rejects --event %s with exit 3 and writes nothing", (event) => {
    const code = runAgentLogCli([
      "--role", "architect-reviewer",
      "--level", "info",
      "--event", event,
      "--slot", "gate=plan",
      "--slot", "subject=x",
      "--tdd-dir", tdd,
    ]);
    expect(code).toBe(3);
    expect(existsSync(join(tdd, "agent-log.jsonl"))).toBe(false); // nothing appended
    expect(stderrText).toMatch(/gate lifecycle .* owned by the deterministic drive/i);
  });

  it("still allows a judgment event (reasoning) — exit 0, one line written", () => {
    const code = runAgentLogCli([
      "--role", "architect-reviewer",
      "--level", "info",
      "--event", "reasoning",
      "--slot", "note=weighing enum placement",
      "--tdd-dir", tdd,
    ]);
    expect(code).toBe(0);
    expect(readAgentLog({ consortDir: tdd })).toHaveLength(1);
  });
});

describe("consort-log CLI rejects a gate lifecycle event inside a --events batch (nothing written)", () => {
  it("fails the whole batch (exit 3) when any item is a gate event", () => {
    const code = runAgentLogCli([
      "--events",
      JSON.stringify([
        { role: "architect-reviewer", level: "info", event: "reasoning", slots: { note: "ok" } },
        { role: "architect-reviewer", level: "info", event: "gate.surfaced", slots: { gate: "plan", subject: "x" } },
      ]),
      "--tdd-dir", tdd,
    ]);
    expect(code).toBe(3);
    // Atomic: the valid reasoning item is NOT written when a sibling is a gate event.
    expect(readAgentLog({ consortDir: tdd })).toEqual([]);
  });
});

describe("the drive's door stays open: the in-process lib still emits gate.* (not the CLI)", () => {
  it("emitAgentLogEvent(gate.surfaced) writes the canonical drive event", () => {
    const ev = emitAgentLogEvent(
      { role: "orchestrator", level: "info", event: "gate.surfaced", slots: { gate: "spec", subject: "story S1" } },
      { consortDir: tdd },
    );
    expect(ev.event).toBe("gate.surfaced");
    expect(readAgentLog({ consortDir: tdd })).toHaveLength(1);
  });
});
