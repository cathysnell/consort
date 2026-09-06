// observability: each role agent emits structured log events; a centralized
// logger appends them to .tdd/agent-log.jsonl (JSON Lines) so the whole
// relay-of-agents run is reconstructable. The `event` is a CLOSED vocabulary
// (agent-log-events.ts); the message is RENDERED from that event's template +
// the supplied slots. emit THROWS on an off-vocabulary event or a missing
// required slot (nothing dropped), and on schema violation; then appends atomically.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emitAgentLogEvent, emitAgentLogEvents, readAgentLog } from "../../consort/logging/agent-log";

let tdd: string;
const clock = () => new Date("2026-06-05T10:00:00.000Z");

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "agent-log-"));
});
afterEach(() => rmSync(tdd, { recursive: true, force: true }));

describe("emitAgentLogEvent", () => {
  it("renders the message from the event template + slots, stamps ts, appends a JSON line", () => {
    const ev = emitAgentLogEvent(
      {
        role: "spec-author",
        level: "info",
        event: "artifact.written",
        feature_id: "F1-initial-domain",
        slots: { artifact: "feature-spec.json", summary: "drafted", path: "feature-spec.json" },
      },
      { consortDir: tdd, now: clock },
    );
    expect(ev.timestamp).toBe("2026-06-05T10:00:00.000Z");
    // message is rendered from "{{role}} wrote {{artifact}} – {{summary}}".
    expect(ev.message).toBe("spec-author wrote feature-spec.json – drafted");

    const file = join(tdd, "agent-log.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.role).toBe("spec-author");
    expect(parsed.event).toBe("artifact.written");
    expect(parsed.metadata.path).toBe("feature-spec.json"); // slots folded into metadata
  });

  it("appends (does not overwrite) across multiple emits + roles", () => {
    emitAgentLogEvent({ role: "spec-author", level: "info", event: "phase.end", slots: { phase: "design", outcome: "complete" } }, { consortDir: tdd, now: clock });
    emitAgentLogEvent({ role: "architect-reviewer", level: "debug", event: "reasoning", slots: { note: "weighing enum placement" } }, { consortDir: tdd, now: clock });
    const events = readAgentLog({ consortDir: tdd });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.role)).toEqual(["spec-author", "architect-reviewer"]);
  });

  it("rejects an off-vocabulary event (closed enum, nothing dropped)", () => {
    expect(() =>
      emitAgentLogEvent({ role: "driver", level: "info", event: "made.up.event" as never, slots: {} }, { consortDir: tdd, now: clock }),
    ).toThrow(/unknown agent-log event/i);
  });

  it("rejects an emit missing a required template slot (throws, not dropped)", () => {
    // phase.end's template "{{role}} END {{phase}} ({{outcome}})" requires phase + outcome.
    expect(() =>
      emitAgentLogEvent({ role: "driver", level: "info", event: "phase.end", slots: { phase: "story" } }, { consortDir: tdd, now: clock }),
    ).toThrow(/missing required slot "outcome"/i);
  });

  it("rejects an invalid role (schema enum)", () => {
    expect(() =>
      emitAgentLogEvent({ role: "wizard" as never, level: "info", event: "reasoning", slots: { note: "y" } }, { consortDir: tdd, now: clock }),
    ).toThrow(/role/i);
  });
});

describe("readAgentLog filtering", () => {
  beforeEach(() => {
    emitAgentLogEvent({ role: "spec-author", level: "info", event: "phase.end", slots: { phase: "design", outcome: "complete" }, feature_id: "F1" }, { consortDir: tdd, now: clock });
    emitAgentLogEvent({ role: "driver", level: "debug", event: "reasoning", slots: { note: "b" }, feature_id: "F1" }, { consortDir: tdd, now: clock });
    emitAgentLogEvent({ role: "driver", level: "error", event: "gate.rejected", slots: { gate: "spec", reason: "c" }, feature_id: "F2" }, { consortDir: tdd, now: clock });
  });

  it("filters by role", () => {
    expect(readAgentLog({ consortDir: tdd, role: "driver" })).toHaveLength(2);
  });
  it("filters by feature", () => {
    expect(readAgentLog({ consortDir: tdd, featureId: "F1" })).toHaveLength(2);
  });
  it("filters by minimum severity (info hides debug)", () => {
    const infoPlus = readAgentLog({ consortDir: tdd, minLevel: "info" });
    expect(infoPlus.map((e) => e.level).sort()).toEqual(["error", "info"]);
  });
  it("returns [] when no log file exists yet", () => {
    const empty = mkdtempSync(join(tmpdir(), "agent-log-empty-"));
    expect(readAgentLog({ consortDir: empty })).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("emitAgentLogEvents (batch: one process, one append)", () => {
  it("writes every event in the batch in order", () => {
    const written = emitAgentLogEvents(
      [
        { role: "navigator", level: "debug", event: "reasoning", feature_id: "F1", slots: { note: "the test forces a seam" } },
        { role: "navigator", level: "warn", event: "smell.flagged", feature_id: "F1", slots: { smell: "fragility-ratio", severity: "advisory", detail: "x" } },
      ],
      { consortDir: tdd, now: clock },
    );
    expect(written).toHaveLength(2);
    const events = readAgentLog({ consortDir: tdd });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(["reasoning", "smell.flagged"]);
  });

  it("validates ALL events before writing: one invalid event fails the batch, nothing is written", () => {
    expect(() =>
      emitAgentLogEvents(
        [
          { role: "navigator", level: "debug", event: "reasoning", slots: { note: "ok" } },
          { role: "driver", level: "info", event: "phase.end", slots: { phase: "story" } }, // missing required outcome
        ],
        { consortDir: tdd, now: clock },
      ),
    ).toThrow(/missing required slot "outcome"/i);
    expect(readAgentLog({ consortDir: tdd })).toEqual([]); // atomic: no partial batch
  });

  it("an empty batch is a no-op", () => {
    expect(emitAgentLogEvents([], { consortDir: tdd, now: clock })).toEqual([]);
    expect(readAgentLog({ consortDir: tdd })).toEqual([]);
  });
});

describe("emit mirrors into the corpus (LAKEBASE_CONSORT_RECORD_DIR) – live-write, like correspondence.jsonl", () => {
  let recordDir: string;
  let priorEnv: string | undefined;
  beforeEach(() => {
    recordDir = mkdtempSync(join(tmpdir(), "agent-log-rec-"));
    priorEnv = process.env.LAKEBASE_CONSORT_RECORD_DIR;
  });
  afterEach(() => {
    rmSync(recordDir, { recursive: true, force: true });
    if (priorEnv === undefined) delete process.env.LAKEBASE_CONSORT_RECORD_DIR;
    else process.env.LAKEBASE_CONSORT_RECORD_DIR = priorEnv;
  });

  it("appends the SAME line to <recordDir>/agent-log.jsonl when recording, byte-identical to the project log", () => {
    process.env.LAKEBASE_CONSORT_RECORD_DIR = recordDir;
    emitAgentLogEvent(
      { role: "spec-author", level: "info", event: "phase.end", slots: { phase: "design", outcome: "complete" } },
      { consortDir: tdd, now: clock },
    );
    const projectLog = readFileSync(join(tdd, "agent-log.jsonl"), "utf8");
    const corpusLog = join(recordDir, "agent-log.jsonl");
    expect(existsSync(corpusLog)).toBe(true);
    expect(readFileSync(corpusLog, "utf8")).toBe(projectLog); // corpus copy == project log
  });

  it("does NOT write a corpus copy when RECORD_DIR is unset (a plain, non-recording run)", () => {
    delete process.env.LAKEBASE_CONSORT_RECORD_DIR;
    emitAgentLogEvent({ role: "spec-author", level: "info", event: "reasoning", slots: { note: "x" } }, { consortDir: tdd, now: clock });
    expect(existsSync(join(recordDir, "agent-log.jsonl"))).toBe(false);
  });

  it("mirrors a BATCH emit too (one joined append), matching the project log", () => {
    process.env.LAKEBASE_CONSORT_RECORD_DIR = recordDir;
    emitAgentLogEvents(
      [
        { role: "navigator", level: "debug", event: "reasoning", slots: { note: "a" } },
        { role: "navigator", level: "debug", event: "reasoning", slots: { note: "b" } },
      ],
      { consortDir: tdd, now: clock },
    );
    const projectLog = readFileSync(join(tdd, "agent-log.jsonl"), "utf8");
    expect(readFileSync(join(recordDir, "agent-log.jsonl"), "utf8")).toBe(projectLog);
    expect(projectLog.trim().split("\n")).toHaveLength(2);
  });
})
