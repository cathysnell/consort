// L1 gate-span fidelity (option A): the DEFAULT telemetry now attributes duration to the
// role + phase of each invoke-role turn, instead of lumping every role turn under the coarse
// gate:"invoke-role". phaseForAction maps the action's buildMode/mode (or the role's base
// phase) to a CLOSED enum – this is the "where does the time go" key most installs will ship.

import { describe, it, expect } from "vitest";
import { phaseForAction } from "../../consort/telemetry/with-telemetry";
import { GATE_SPAN_FIELDS, PHASE_VALUES, isKnownPhase } from "../../consort/telemetry/allowlist";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary";

const A = (o: Record<string, unknown>): WorkflowAction => o as unknown as WorkflowAction;

describe("phaseForAction (L1 gate-span phase)", () => {
  it("splits the navigator lump by buildMode", () => {
    expect(phaseForAction(A({ kind: "invoke-role", role: "navigator", story: "S1", buildMode: "reflect" }))).toBe("reflect");
    expect(phaseForAction(A({ kind: "invoke-role", role: "navigator", story: "S1", buildMode: "review" }))).toBe("review");
    expect(phaseForAction(A({ kind: "invoke-role", role: "navigator", story: "S1", buildMode: "assess" }))).toBe("assess");
    expect(phaseForAction(A({ kind: "invoke-role", role: "navigator", story: "S1", buildMode: "assess-refactor" }))).toBe("assess-refactor");
  });

  it("splits the driver lump; base build turns fall back to red/green", () => {
    expect(phaseForAction(A({ kind: "invoke-role", role: "driver", story: "S1", buildMode: "refactor" }))).toBe("refactor");
    expect(phaseForAction(A({ kind: "invoke-role", role: "driver", story: "S1" }))).toBe("green"); // base = GREEN
    expect(phaseForAction(A({ kind: "invoke-role", role: "navigator", story: "S1" }))).toBe("red"); // base = RED
  });

  it("maps the design-lane roles to their base phase", () => {
    expect(phaseForAction(A({ kind: "invoke-role", role: "spec-author", mode: "breakdown" }))).toBe("breakdown");
    expect(phaseForAction(A({ kind: "invoke-role", role: "spec-author", story: "S1" }))).toBe("spec");
    expect(phaseForAction(A({ kind: "invoke-role", role: "architect-reviewer", story: "S1" }))).toBe("architecture");
    expect(phaseForAction(A({ kind: "invoke-role", role: "dba", story: "S1" }))).toBe("db-design");
    expect(phaseForAction(A({ kind: "invoke-role", role: "test-strategist", story: "S1" }))).toBe("test-strategy");
    expect(phaseForAction(A({ kind: "invoke-role", role: "ux-designer" }))).toBe("ux-design");
  });

  it("an unmapped buildMode is coerced to 'other' (never shipped as free text)", () => {
    const p = phaseForAction(A({ kind: "invoke-role", role: "driver", story: "S1", buildMode: "some-future-mode" }));
    expect(p).toBe("other");
    expect(isKnownPhase(p as string)).toBe(true);
  });

  it("is undefined for a non-invoke-role gate (only role turns carry a phase)", () => {
    expect(phaseForAction(A({ kind: "approve-gate", story: "S1" }))).toBeUndefined();
    expect(phaseForAction(A({ kind: "cut-experiment", story: "S1" }))).toBeUndefined();
  });

  it("role + phase are L1 gate-span fields (default level, not L2)", () => {
    expect(GATE_SPAN_FIELDS).toContain("role");
    expect(GATE_SPAN_FIELDS).toContain("phase");
    expect(PHASE_VALUES).toContain("other");
  });
});
