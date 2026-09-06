// analyzeFailure – the deterministic diagnosis half of consort-diagnose. It reads
// the escalation(s) + cycle green-failures, classifies the failure, and suggests a
// remediation the driving session attempts (troubleshoot) before offering to share.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeFailure } from "../../consort/orchestrator/diagnose/analyze-failure";
import { writeEscalation } from "../../consort/gates/escalation";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "analyze-"));
});
afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

function greenFailure(rel: string, summary: string, failureOutput?: string): void {
  const p = join(tdd, "cycles", rel, "green-failure.json");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ assessed: false, summary, ...(failureOutput ? { failureOutput } : {}) }));
}

describe("analyzeFailure", () => {
  it("no artifacts => hasFailure false", () => {
    expect(analyzeFailure(tdd).hasFailure).toBe(false);
  });

  it("deploy-verify escalation => class deploy-verify + migrate-aware remediation", () => {
    writeEscalation(tdd, { source: "deploy-verify", reason: "/stock 500 relation does not exist", feature_id: "F1", story_id: "S1" });
    greenFailure("F1/S1/AC1", "verify failed", "E   relation \"stock_levels\" does not exist");
    const a = analyzeFailure(tdd);
    expect(a.hasFailure).toBe(true);
    expect(a.class).toBe("deploy-verify");
    expect(a.escalations).toHaveLength(1);
    expect(a.greenFailures[0].failureOutput).toContain("does not exist");
    expect(a.suggestedRemediation).toMatch(/migrate/i);
    expect(a.location).toBe("F1/S1");
  });

  it("driver-green escalation => class driver-green", () => {
    writeEscalation(tdd, { source: "driver-green", reason: "AC2 still red", feature_id: "F1", story_id: "S2" });
    expect(analyzeFailure(tdd).class).toBe("driver-green");
  });

  it("smell escalation => class smell + names the smell in the remediation", () => {
    writeEscalation(tdd, { source: "smell:layering-violation", reason: "boundary imports session", feature_id: "F1", story_id: "S1" });
    const a = analyzeFailure(tdd);
    expect(a.class).toBe("smell");
    expect(a.suggestedRemediation).toMatch(/layering-violation/);
  });

  it("green-failure with no escalation => still a failure, classed driver-green", () => {
    greenFailure("F1/S1/AC1", "pytest failed", "FAILED tests/features/x.py::test_y");
    const a = analyzeFailure(tdd);
    expect(a.hasFailure).toBe(true);
    expect(a.class).toBe("driver-green");
  });
});
