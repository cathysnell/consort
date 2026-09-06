// P3-prep: positionToBuildHandoff. From the design-complete boundary, the build
// lane's next actions are SUBSTRATE (dispatch, then cut-experiment – which forks
// the paired branch), NOT role turns. To sweep the first build turn the CLI must
// auto-PERFORM those substrate actions (the fork is the pre-turn state the snapshot
// captures) and land ON the first invoke-role build turn (navigator RED). This is
// that positioning loop, with plan + perform injected so it is unit-tested with no
// cloud. It stops on the first build role turn, errors if the lane is left (target
// unreachable), and refuses to loop forever.

import { describe, expect, it } from "vitest";

import { positionToBuildHandoff } from "../../consort/optimize/optimize-live";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

/** A scripted plan sequence: each call returns the next (action, commands). */
function scriptedPlan(seq: Array<{ action: WorkflowAction; commands: string[] }>): {
  planNext: () => Promise<{ action: WorkflowAction; commands: string[] }>;
  performed: string[][];
} {
  let i = 0;
  const performed: string[][] = [];
  return {
    performed,
    planNext: async () => seq[Math.min(i++, seq.length - 1)],
  };
}

describe("positionToBuildHandoff", () => {
  it("performs dispatch + cut-experiment, then lands on the navigator RED turn", async () => {
    const { planNext, performed } = scriptedPlan([
      { action: { kind: "dispatch", story: "S1" }, commands: ["dispatch-cmd"] },
      { action: { kind: "cut-experiment", story: "S1" }, commands: ["cut-cmd"] },
      { action: { kind: "invoke-role", role: "navigator", story: "S1" }, commands: ["navigator-cmd"] },
    ]);
    const plan = await positionToBuildHandoff({
      planNext,
      perform: async (cmds) => {
        performed.push(cmds as string[]);
      },
    });
    expect(plan).toMatchObject({ id: "S1-navigator-red", role: "navigator", story: "S1", buildMode: "red" });
    // it performed the two substrate steps (fork happened) but NOT the navigator turn
    expect(performed).toEqual([["dispatch-cmd"], ["cut-cmd"]]);
  });

  it("lands immediately when already positioned on a build role turn", async () => {
    const { planNext, performed } = scriptedPlan([
      { action: { kind: "invoke-role", role: "driver", story: "S1" }, commands: ["driver-cmd"] },
    ]);
    const plan = await positionToBuildHandoff({ planNext, perform: async (c) => void performed.push(c as string[]) });
    expect(plan).toMatchObject({ id: "S1-driver-green", role: "driver", story: "S1", buildMode: "green" });
    expect(performed).toEqual([]);
  });

  it("returns null when the next action is NOT in the build lane (design not complete / gate)", async () => {
    const { planNext } = scriptedPlan([
      { action: { kind: "approve-gate", story: "S1" }, commands: [] },
    ]);
    const plan = await positionToBuildHandoff({ planNext, perform: async () => {} });
    expect(plan).toBeNull();
  });

  it("refuses to loop forever (a substrate step that never advances throws)", async () => {
    // dispatch that keeps returning dispatch (a stuck substrate) must not spin.
    const planNext = async () => ({ action: { kind: "dispatch", story: "S1" } as WorkflowAction, commands: ["x"] });
    await expect(
      positionToBuildHandoff({ planNext, perform: async () => {}, maxSteps: 5 }),
    ).rejects.toThrow(/could not position/i);
  });
});
