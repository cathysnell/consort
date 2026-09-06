// The diagnostic-bundle source resolver (consort-diagnose). Given a project's
// .consort/, it must enumerate the LOCAL forensic artifacts that troubleshoot a
// failure – every escalation, every cycle's green-failure.json, plus the run-context
// logs/state – and mark which exist. Only existing sources are collected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectDiagnosticSources } from "../../consort/orchestrator/diagnose/collect-bundle";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "diag-"));
});
afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

function write(rel: string, body = "{}"): void {
  const p = join(tdd, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

describe("collectDiagnosticSources", () => {
  it("enumerates every escalation and every cycle's green-failure.json", () => {
    write("escalations/e1.json");
    write("escalations/e2.json");
    write("cycles/F1/S1/AC1/green-failure.json");
    write("cycles/F1/S2/AC3/green-failure.json");
    const sources = collectDiagnosticSources(tdd);
    const esc = sources.filter((s) => s.kind === "escalation" && s.exists);
    const gf = sources.filter((s) => s.kind === "green-failure" && s.exists);
    expect(esc).toHaveLength(2);
    expect(gf).toHaveLength(2);
    // green-failures are discovered no matter how deep the cycle path is.
    expect(gf.map((s) => s.path).some((p) => p.includes(join("F1", "S2", "AC3")))).toBe(true);
  });

  it("marks fixed run-context sources present/absent and tails the big logs", () => {
    write("workflow-state.json");
    write("agent-log.jsonl", "line1\nline2\n");
    // drive-live.log intentionally absent
    const sources = collectDiagnosticSources(tdd);
    const byKind = (k: string) => sources.find((s) => s.kind === k);
    expect(byKind("workflow-state")?.exists).toBe(true);
    expect(byKind("agent-log")?.exists).toBe(true);
    expect(byKind("agent-log")?.tailLines).toBeGreaterThan(0); // tailed, not whole-copied
    expect(byKind("drive-live")?.exists).toBe(false); // absent, so it won't be collected
  });

  it("returns no escalation/green-failure sources for a clean project (bin then reports nothing to diagnose)", () => {
    write("workflow-state.json");
    const sources = collectDiagnosticSources(tdd);
    expect(sources.some((s) => (s.kind === "escalation" || s.kind === "green-failure") && s.exists)).toBe(false);
  });
});
