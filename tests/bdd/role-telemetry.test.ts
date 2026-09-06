// role-telemetry: the per-role turn instrumentation that SURVIVES an isolated role run (the
// point of the manifest/chain isolation substrate – each role's turn can be measured + lever-
// swept on its own). Captures what the optimize harness measured per trial (durationMs, cost,
// tokens, the agent-reported num_turns) PLUS the transcript + which levers were in effect, then
// persists it to a durable dir + formats a one-line summary. Pure + deterministic here; the live
// per-role tests feed it real turns.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRoleTelemetry, writeRoleTelemetry, type RoleTelemetry } from "../../consort/optimize/role-telemetry";

const REC: RoleTelemetry = {
  role: "test-strategist",
  chain: "test-strategist-chain",
  model: "sonnet",
  levers: { effort: "default", session: "fresh", allowedTools: ["Write", "Read"], disallowedTools: ["Bash"] },
  outerDurationMs: 856092,
  agent: { numTurns: 41, durationMs: 851000, costUsd: 1.87, inputTokens: 20000, outputTokens: 6000, cacheReadTokens: 15000 },
  outcome: "produced",
  producedFile: "features/F1-stock-visibility/test-list.json",
  transcript: { prompt: "You are the Test Strategist...", finalText: "Wrote test-list.json with 12 tests.", tools: ["Read x", "Write y"] },
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "role-telemetry-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("formatRoleTelemetry: a one-line, human-scannable summary", () => {
  it("leads with role + outcome + the agent turn count + both durations + cost", () => {
    const line = formatRoleTelemetry(REC);
    expect(line).toContain("test-strategist");
    expect(line).toContain("produced");
    // The agent-reported turn count – the signal that distinguishes a one-shot turn from a
    // retry/loop-heavy one (why a role was slow).
    expect(line).toMatch(/turns[=: ]*41/i);
    // Wall-clock in seconds (outer step timer), so a 14-min outlier is obvious at a glance.
    expect(line).toContain("856");
    expect(line).toMatch(/\$?1\.87/);
    expect(line).toContain("sonnet");
  });

  it("degrades gracefully when the agent reported no usage (numbers simply omitted)", () => {
    const line = formatRoleTelemetry({ ...REC, agent: undefined });
    expect(line).toContain("test-strategist");
    expect(line).toContain("produced");
    // No crash, no NaN.
    expect(line).not.toMatch(/NaN|undefined/);
  });
});

describe("writeRoleTelemetry: persists a durable per-role record", () => {
  it("writes <dir>/<chain>.telemetry.json with the full record + returns its path", () => {
    const p = writeRoleTelemetry(dir, REC);
    expect(existsSync(p)).toBe(true);
    expect(p.endsWith("test-strategist-chain.telemetry.json")).toBe(true);
    const back = JSON.parse(readFileSync(p, "utf8")) as RoleTelemetry;
    expect(back.role).toBe("test-strategist");
    expect(back.agent?.numTurns).toBe(41);
    expect(back.levers.allowedTools).toEqual(["Write", "Read"]);
    expect(back.transcript?.finalText).toContain("test-list.json");
  });

  it("survives to disk independent of the (rm'd) workspace – the durable dir is the caller's", () => {
    writeRoleTelemetry(dir, REC);
    // A second role's record coexists (one file per chain).
    writeRoleTelemetry(dir, { ...REC, role: "dba", chain: "dba-chain" });
    expect(readdirSync(dir).sort()).toEqual(["dba-chain.telemetry.json", "test-strategist-chain.telemetry.json"]);
  });
});
