// The build-trial classifier: a build candidate is scored on whether it SELF-HEALS to
// terminal-good through runDriver's raises/retries/route-backs. This is the load-bearing
// unattended decision – self-heal = valid measurement, non-self-heal = DQ (not fatal),
// infra = systemic halt – so it is exhaustively unit-tested.

import { describe, expect, it } from "vitest";
import { classifyBuildTrial, isViableBuildTrial } from "../../consort/optimize/optimize-build-trial";

describe("classifyBuildTrial", () => {
  it("self-healed: the loop returned, did not escalate, honest-GREEN passed", () => {
    const v = classifyBuildTrial({ result: { escalated: false }, honestGreen: { passed: true } });
    expect(v.outcome).toBe("self-healed");
    expect(isViableBuildTrial(v)).toBe(true);
  });

  it("self-healed: a clean bounded stop with no escalation counts (story reached its bound good)", () => {
    const v = classifyBuildTrial({ result: { stoppedAtBound: true, escalated: false } });
    expect(v.outcome).toBe("self-healed");
  });

  it("not-viable: raised-to-HIL after retries (did NOT self-heal) – DQ, not systemic", () => {
    const v = classifyBuildTrial({ result: { escalated: true, escalation: { reason: "green failed 3x", source: "driver" } } });
    expect(v.outcome).toBe("not-viable");
    expect(isViableBuildTrial(v)).toBe(false);
    if (v.outcome === "not-viable") {
      expect(v.reason).toMatch(/raised-to-HIL/);
      expect(v.reason).toMatch(/green failed 3x/);
      expect(v.reason).toMatch(/driver/);
    }
  });

  it("not-viable: DriverStalledError (route-back could not converge) – DQ", () => {
    const v = classifyBuildTrial({ error: { name: "DriverStalledError", message: "action repeated without advancing" } });
    expect(v.outcome).toBe("not-viable");
    if (v.outcome === "not-viable") expect(v.reason).toMatch(/did not converge/);
  });

  it("not-viable: ProtocolViolationError (a handoff contract went unmet after its retry)", () => {
    const v = classifyBuildTrial({ error: { name: "ProtocolViolationError", message: "navigator did not return test-list" } });
    expect(v.outcome).toBe("not-viable");
  });

  it("not-viable: loop returned clean but honest-GREEN has an unresolved escalation (belt-and-suspenders)", () => {
    const v = classifyBuildTrial({ result: { escalated: false }, honestGreen: { passed: false, reason: "1 unresolved escalation for S1" } });
    expect(v.outcome).toBe("not-viable");
    if (v.outcome === "not-viable") expect(v.reason).toMatch(/unresolved escalation/);
  });

  it("systemic: an infra error (auth expiry) – HALTS, not a candidate DQ", () => {
    const v = classifyBuildTrial({ error: { name: "Error", message: "OAuth token expired minting Lakebase credentials" } });
    expect(v.outcome).toBe("systemic");
    expect(isViableBuildTrial(v)).toBe(false);
    if (v.outcome === "systemic") expect(v.reason).toMatch(/infra fault/);
  });

  it("systemic: a Lakebase fork collision is infra, not the candidate's fault", () => {
    const v = classifyBuildTrial({ error: { name: "Error", message: "branch already exists: could not cut experiment" } });
    expect(v.outcome).toBe("systemic");
  });

  it("systemic: neither a result nor an error is an unknown state (halt, do not guess viable)", () => {
    const v = classifyBuildTrial({});
    expect(v.outcome).toBe("systemic");
  });

  it("a thrown error takes precedence over a stale result", () => {
    // If the loop both produced a partial result AND threw, the throw classifies it.
    const v = classifyBuildTrial({ result: { escalated: false }, error: { name: "DriverStalledError", message: "x" } });
    expect(v.outcome).toBe("not-viable");
  });
});
