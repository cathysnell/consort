import { describe, it, expect } from "vitest";
import { orchestratorStatus, storyGateStatus } from "./OrchestratorLane";
import type { AgentLogEvent, Blocker, GateInfo } from "@/lib/types";

// A minimal event factory — only the fields orchestratorStatus reads (event, message, metadata).
const ev = (event: string, message: string, metadata?: Record<string, unknown>): AgentLogEvent => ({
  timestamp: "2026-01-01T00:00:00Z",
  level: "info",
  role: "orchestrator",
  event,
  message,
  metadata,
});

const gate = (name: string, status: string): GateInfo => ({ name, status });
const blocker = (source: string): Blocker => ({ source, reason: "", story: null, resolverRole: null, resolverHint: null });

describe("orchestratorStatus", () => {
  it("takes the current dispatch from the LATEST handoff message", () => {
    const s = orchestratorStatus(
      [
        ev("handoff", "dispatch spec-author for design", { to_role: "spec-author", phase: "design" }),
        ev("phase.start", "designing"),
        ev("handoff", "kick off the build for S3", { to_role: "driver", phase: "build" }),
      ],
      [],
      [],
    );
    expect(s.current).toBe("kick off the build for S3");
    expect(s.coord).toBe("dispatch to driver (build)");
  });

  it("synthesizes the dispatch line from to_role + phase when the handoff carried no message", () => {
    const s = orchestratorStatus([ev("handoff", "", { to_role: "architect", phase: "design" })], [], []);
    expect(s.current).toBe("dispatch architect for design");
    expect(s.coord).toBe("dispatch to architect (design)");
  });

  it("returns null current/coord when there is no handoff in the tail", () => {
    const s = orchestratorStatus([ev("phase.start", "designing")], [], []);
    expect(s.current).toBeNull();
    expect(s.coord).toBeNull();
  });

  it("builds recent gate rows from gate.surfaced / gate.approved, deduped and newest-last", () => {
    const s = orchestratorStatus(
      [
        ev("gate.surfaced", "", { gate: "acceptance", subject: "S3-sku-detail-view" }),
        ev("gate.approved", "", { gate: "acceptance", subject: "S3-sku-detail-view" }), // dup row, deduped
        ev("gate.surfaced", "", { gate: "spec", story: "S4-search" }),
      ],
      [],
      [],
    );
    expect(s.gateRows).toEqual(["acceptance: story S3-sku-detail-view", "spec: story S4-search"]);
  });

  it("caps gate rows at the six most recent", () => {
    const events = Array.from({ length: 9 }, (_, i) =>
      ev("gate.surfaced", "", { gate: "acceptance", subject: `S${i}` }),
    );
    const s = orchestratorStatus(events, [], []);
    expect(s.gateRows).toHaveLength(6);
    expect(s.gateRows[0]).toBe("acceptance: story S3");
    expect(s.gateRows.at(-1)).toBe("acceptance: story S8");
  });

  it("chips: open (non-approved) gates and blockers, approved gates dropped", () => {
    const s = orchestratorStatus([], [gate("spec", "open"), gate("plan", "approved")], [blocker("driver")]);
    expect(s.chips).toEqual([
      { kind: "gate", label: "spec" },
      { kind: "esc", label: "driver" },
    ]);
  });
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
