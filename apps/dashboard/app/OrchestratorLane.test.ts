import { describe, it, expect } from "vitest";
import { storyGateStatus } from "./OrchestratorLane";
import type { AgentLogEvent } from "@/lib/types";

// A minimal event factory — only the fields storyGateStatus reads (event, message, metadata).
const ev = (event: string, message: string, metadata?: Record<string, unknown>): AgentLogEvent => ({
  timestamp: "2026-01-01T00:00:00Z",
  level: "info",
  role: "orchestrator",
  event,
  message,
  metadata,
});

describe("storyGateStatus", () => {
  it("infers earlier gates as approved once a later one is reached, and stays at the current gate", () => {
    // The kit rarely logs gate.approved, so we infer: reaching acceptance means plan+spec passed.
    const events = [
      ev("gate.surfaced", "", { gate: "plan" }),
      ev("gate.surfaced", "", { gate: "spec", story: "S3" }),
      ev("gate.surfaced", "", { gate: "acceptance", story: "S3" }),
    ];
    const s = storyGateStatus(events, "S3");
    expect(s.plan).toBe("approved"); // a later gate was reached → passed
    expect(s.spec).toBe("approved"); // acceptance reached → spec passed (the missing gate.approved)
    expect(s.acceptance).toBe("pending"); // the run is parked here
    expect(s.deploy).toBeUndefined(); // not reached → upcoming
    expect(s.promote).toBeUndefined();
  });

  it("resets per story: another story's gate events don't leak in", () => {
    // S1 reached acceptance, but for S3 only spec has surfaced — S1's events must not mark S3 further.
    const events = [
      ev("gate.surfaced", "", { gate: "spec", story: "S1" }),
      ev("gate.surfaced", "", { gate: "acceptance", story: "S1" }),
      ev("gate.surfaced", "", { gate: "spec", story: "S3" }),
    ];
    const s = storyGateStatus(events, "S3");
    expect(s.spec).toBe("pending"); // S3's spec is the latest reached → pending (not approved by S1)
    expect(s.acceptance).toBeUndefined(); // S3 has not reached acceptance
  });
});
