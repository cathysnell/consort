// The intake gate: the HITL checkpoint after the PO drafts the intake, before the Spec Author
// proposes. approveIntakeGate writes the approval marker + logs gate.approved("intake"); consort-next
// surfaces the gate as a human decision. Hermetic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approveIntakeGate } from "../../consort/gates/intake-gate";
import { intakeApprovedOnDisk, intakeApprovedMarker } from "../../consort/config/consort-paths";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "intake-gate-"));
});
afterEach(() => rmSync(tdd, { recursive: true, force: true }));

describe("approveIntakeGate", () => {
  it("writes the approval marker and logs gate.approved(intake)", () => {
    expect(intakeApprovedOnDisk(tdd)).toBe(false);
    approveIntakeGate(tdd, "kev");
    expect(intakeApprovedOnDisk(tdd)).toBe(true);
    expect(existsSync(intakeApprovedMarker(tdd))).toBe(true);

    const log = join(tdd, "agent-log.jsonl");
    expect(existsSync(log)).toBe(true);
    const events = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const approved = events.filter((e) => e.event === "gate.approved" && e.metadata?.gate === "intake");
    expect(approved).toHaveLength(1);
    expect(approved[0].metadata.approver).toBe("kev");
  });

  it("is idempotent (re-approving keeps the gate approved)", () => {
    approveIntakeGate(tdd, "kev");
    approveIntakeGate(tdd, "kev");
    expect(intakeApprovedOnDisk(tdd)).toBe(true);
  });
});
