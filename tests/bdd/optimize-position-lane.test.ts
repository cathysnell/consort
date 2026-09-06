// P3-prep (#502): positionToNextHandoff generalizes positionToBuildHandoff to
// either lane. It performs the lane's non-role SUBSTRATE/gate actions
// (design: project-architect-notes / surface-gate / approve-gate; build: dispatch /
// cut-experiment) to advance, and returns the next ROLE turn in that lane, or null
// at the lane boundary (design-complete / left the lane). The reflect critic turn
// is a role turn but not swept – the caller (defaultLaneCandidates) returns
// baseline-only for it, so it is still "positioned on" and passes through as a
// (trivial) sweep. Plan + perform injected -> hermetic.

import { describe, expect, it } from "vitest";

import { positionToNextHandoff } from "../../consort/optimize/optimize-live";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

function scripted(seq: Array<{ action: WorkflowAction; commands: string[] }>) {
  let i = 0;
  const performed: string[][] = [];
  return {
    performed,
    planNext: async () => seq[Math.min(i++, seq.length - 1)],
  };
}

describe("positionToNextHandoff: design lane", () => {
  it("performs a gate action, then lands on the next design role turn", async () => {
    const { planNext, performed } = scripted([
      { action: { kind: "surface-gate", story: "S1" }, commands: ["surface-cmd"] },
      { action: { kind: "invoke-role", role: "architect-reviewer", story: "S1" }, commands: ["arch-cmd"] },
    ]);
    const plan = await positionToNextHandoff({ lane: "design", planNext, perform: async (c) => void performed.push(c as string[]) });
    expect(plan).toMatchObject({ id: "S1-architect-reviewer", role: "architect-reviewer", story: "S1" });
    expect(performed).toEqual([["surface-cmd"]]); // gate performed, role turn NOT
  });

  it("returns null at the design boundary (design-complete)", async () => {
    const { planNext } = scripted([{ action: { kind: "design-complete" }, commands: [] }]);
    const plan = await positionToNextHandoff({ lane: "design", planNext, perform: async () => {} });
    expect(plan).toBeNull();
  });

  it("returns null when the lane has left design (a build action appears)", async () => {
    const { planNext } = scripted([{ action: { kind: "dispatch", story: "S1" }, commands: [] }]);
    const plan = await positionToNextHandoff({ lane: "design", planNext, perform: async () => {} });
    expect(plan).toBeNull();
  });

  it("lands on a design role turn immediately when already positioned", async () => {
    const { planNext, performed } = scripted([{ action: { kind: "invoke-role", role: "dba", story: "S1" }, commands: ["dba-cmd"] }]);
    const plan = await positionToNextHandoff({ lane: "design", planNext, perform: async (c) => void performed.push(c as string[]) });
    expect(plan).toMatchObject({ id: "S1-dba", role: "dba", story: "S1" });
    expect(performed).toEqual([]);
  });
});

describe("positionToNextHandoff: build lane (unchanged behavior)", () => {
  it("performs dispatch + cut, lands on the navigator RED turn", async () => {
    const { planNext, performed } = scripted([
      { action: { kind: "dispatch", story: "S1" }, commands: ["dispatch"] },
      { action: { kind: "cut-experiment", story: "S1" }, commands: ["cut"] },
      { action: { kind: "invoke-role", role: "navigator", story: "S1" }, commands: ["nav"] },
    ]);
    const plan = await positionToNextHandoff({ lane: "build", planNext, perform: async (c) => void performed.push(c as string[]) });
    expect(plan).toMatchObject({ id: "S1-navigator-red", role: "navigator", story: "S1", buildMode: "red" });
    expect(performed).toEqual([["dispatch"], ["cut"]]);
  });
});
