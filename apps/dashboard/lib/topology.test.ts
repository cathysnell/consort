import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKFLOW,
  LANE_IDS,
  PHASE_TO_NODE,
  matchesStep,
  laneStepForEvent,
  laneProgress,
  passedNodes,
  nodeForPhase,
  nodeById,
  gateForNode,
  edgeDone,
  type LaneId,
  type LaneStep,
  type StepMatch,
} from "./topology";
import { ROLES } from "./types";
import type { AgentLogEvent } from "./types";

function ev(
  event: string,
  role: string,
  metadata: Record<string, unknown> = {},
): AgentLogEvent {
  return { timestamp: "2026-08-05T12:00:00.000Z", level: "info", role, event, message: "", metadata };
}

// ---------------------------------------------------------------------------
// Graph shape: every id referenced by an edge must exist, and nothing dangles.

describe("topology — graph integrity", () => {
  it("has unique node ids", () => {
    const ids = WORKFLOW.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every lifecycle edge connects declared nodes", () => {
    const ids = new Set(WORKFLOW.nodes.map((n) => n.id));
    for (const [a, b] of WORKFLOW.edges) {
      expect(ids, `edge from ${a}`).toContain(a);
      expect(ids, `edge to ${b}`).toContain(b);
    }
  });

  it("the spine is reachable from intake and ends at shipped", () => {
    const out = new Map<string, string[]>();
    for (const [a, b] of WORKFLOW.edges) out.set(a, [...(out.get(a) ?? []), b]);
    const seen = new Set<string>();
    const stack = ["intake"];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    expect(seen.size).toBe(WORKFLOW.nodes.length);
    expect(seen).toContain("shipped");
  });

  it("every declared role is a known Role", () => {
    for (const n of WORKFLOW.nodes) {
      for (const r of n.roles) expect(ROLES).toContain(r);
    }
    for (const lane of LANE_IDS) {
      for (const s of WORKFLOW.lanes[lane].steps) {
        if (s.role) expect(ROLES).toContain(s.role);
        if (s.match?.role) expect(ROLES).toContain(s.match.role);
      }
    }
  });

  it("gate nodes carry no roles and phase nodes are the only tallied ones", () => {
    for (const n of WORKFLOW.nodes) {
      if (n.type === "gate") expect(n.roles).toEqual([]);
    }
  });

  it("every gate node maps to a gate name", () => {
    for (const n of WORKFLOW.nodes) {
      if (n.type === "gate") expect(gateForNode(n.id), n.id).not.toBeNull();
    }
    expect(gateForNode("plan")).toBeNull();
  });

  it("every phaseToNode target is a real node", () => {
    const ids = new Set(WORKFLOW.nodes.map((n) => n.id));
    for (const [phase, node] of Object.entries(PHASE_TO_NODE)) {
      expect(ids, `${phase} -> ${node}`).toContain(node);
    }
  });

  it("nodeById resolves declared nodes and rejects others", () => {
    expect(nodeById("build")?.label).toBe("Build lane");
    expect(nodeById("nope")).toBeNull();
  });
});

describe("topology — lane integrity", () => {
  it("lane step ids are unique within a lane and across lanes", () => {
    const all: string[] = [];
    for (const lane of LANE_IDS) {
      const ids = WORKFLOW.lanes[lane].steps.map((s) => s.id);
      expect(new Set(ids).size, lane).toBe(ids.length);
      all.push(...ids);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("lane edges and backEdges reference steps in that lane", () => {
    for (const lane of LANE_IDS) {
      const l = WORKFLOW.lanes[lane];
      const ids = new Set(l.steps.map((s) => s.id));
      for (const [a, b] of l.edges) {
        expect(ids, `${lane} edge from ${a}`).toContain(a);
        expect(ids, `${lane} edge to ${b}`).toContain(b);
      }
      for (const [a, b] of l.backEdges) {
        expect(ids, `${lane} back-edge from ${a}`).toContain(a);
        expect(ids, `${lane} back-edge to ${b}`).toContain(b);
      }
    }
  });

  it("only gates + raise-to-HIL terminals may have a null match (nothing else is unlightable)", () => {
    for (const lane of LANE_IDS) {
      for (const s of WORKFLOW.lanes[lane].steps) {
        // Human gates and the per-lane raise-to-HIL escalation terminals are the only steps that
        // never light from an event (match:null) , their state comes from the human / an escalation.
        if (s.match === null) expect(s.gate === true || s.escalation === true, s.id).toBe(true);
      }
    }
  });

  it("keeps the honest-GREEN branch structure: assess fans out to repair / permissive / HIL", () => {
    const back = WORKFLOW.lanes.build.backEdges.map(([a, b]) => `${a}->${b}`);
    expect(back).toContain("b-verify->b-assess"); // verify fails
    expect(back).toContain("b-assess->b-repair"); // regression
    expect(back).toContain("b-assess->b-perm"); // supersession
    expect(back).toContain("b-assess->b-hil"); // genuine → escalate
    // The repair/perm → GREEN re-verify lines are intentionally NOT drawn (removed from the graph);
    // the recovery paths' re-verify is left implicit rather than cluttering the lane with risers.
    expect(back).not.toContain("b-repair->b-green");
    expect(back).not.toContain("b-perm->b-green");
  });

  it("marks the fail/side paths as branches, not happy path", () => {
    const byId = new Map(WORKFLOW.lanes.build.steps.map((s) => [s.id, s]));
    for (const id of ["b-assess", "b-repair", "b-perm"]) expect(byId.get(id)?.branch, id).toBe(true);
    for (const id of ["b-red", "b-green", "b-review"]) expect(byId.get(id)?.branch, id).toBeUndefined();
  });

  it("design lane reflect loops back to the spec author (and can escalate to HIL)", () => {
    expect(WORKFLOW.lanes.design.backEdges).toEqual([
      ["d-nav", "d-spec", "revise on findings"],
      ["d-nav", "d-hil", "escalate"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase mapping, incl. the two deliberate corrections to Kevin's table.

describe("nodeForPhase", () => {
  it("maps the lifecycle phases", () => {
    expect(nodeForPhase("propose")).toBe("plan");
    expect(nodeForPhase("design")).toBe("design");
    expect(nodeForPhase("green")).toBe("build");
    expect(nodeForPhase("deploy")).toBe("deploy");
    expect(nodeForPhase("promote")).toBe("promote");
  });

  it("puts assess and assess-refactor in the BUILD lane, not plan", () => {
    // The correction: assess* is the honest-GREEN "regression or supersession?"
    // decision. Kevin's table sent `assess` to "plan" and omitted `assess-refactor`,
    // which made the top-level graph jump back to Plan mid-build.
    expect(nodeForPhase("assess")).toBe("build");
    expect(nodeForPhase("assess-refactor")).toBe("build");
  });

  it("normalizes whitespace and casing instead of enumerating misspellings", () => {
    expect(nodeForPhase("estimate ")).toBe("plan");
    expect(nodeForPhase(" red ")).toBe("build");
    expect(nodeForPhase("RED")).toBe("build");
  });

  it("returns null for absent or unknown phases", () => {
    expect(nodeForPhase(null)).toBeNull();
    expect(nodeForPhase(undefined)).toBeNull();
    expect(nodeForPhase("")).toBeNull();
    expect(nodeForPhase("   ")).toBeNull();
    expect(nodeForPhase("not-a-phase")).toBeNull();
  });

  it("does not inherit from Object.prototype", () => {
    // Phase names come from log metadata, so a bare table[key] would resolve these to
    // functions — which are truthy, so they'd slip past a `!nodeForPhase(p)` guard and
    // land in the Set<string> that passedNodes builds.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(nodeForPhase(key), key).toBeNull();
      expect(gateForNode(key), key).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Predicate semantics — the subtle part of the port.

describe("matchesStep", () => {
  it("never matches a null predicate", () => {
    expect(matchesStep(null, ev("phase.start", "driver"))).toBe(false);
  });

  it("eventPrefix decides alone, ignoring role and phase", () => {
    const m: StepMatch = { eventPrefix: "verify" };
    expect(matchesStep(m, ev("verify.passed", "driver"))).toBe(true);
    expect(matchesStep(m, ev("verify.failed", "orchestrator", { phase: "red" }))).toBe(true);
    expect(matchesStep(m, ev("cycle.green", "driver"))).toBe(false);
  });

  it("event decides alone on EXACT equality, distinct from a prefix", () => {
    const m: StepMatch = { event: "deploy.verified" };
    expect(matchesStep(m, ev("deploy.verified", "release-engineer", { phase: "deploy" }))).toBe(true);
    // exact, not a prefix: a longer name that merely starts the same must not match
    expect(matchesStep(m, ev("deploy.verified.extra", "release-engineer"))).toBe(false);
    expect(matchesStep(m, ev("deploy.start", "release-engineer"))).toBe(false);
    // role/phase are not consulted
    expect(matchesStep(m, ev("deploy.verified", "orchestrator"))).toBe(true);
  });

  it("requires role equality", () => {
    const m: StepMatch = { role: "dba" };
    expect(matchesStep(m, ev("phase.start", "dba"))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "driver"))).toBe(false);
  });

  it("phaseAny requires membership", () => {
    const m: StepMatch = { role: "architect-reviewer", phaseAny: ["estimate", "estimate-committed"] };
    expect(matchesStep(m, ev("phase.start", "architect-reviewer", { phase: "estimate" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "architect-reviewer", { phase: "estimate-committed" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "architect-reviewer", { phase: "design" }))).toBe(false);
    // a missing phase cannot be a member
    expect(matchesStep(m, ev("phase.start", "architect-reviewer"))).toBe(false);
  });

  it("phaseNot excludes listed phases but a MISSING phase does not exclude", () => {
    const m: StepMatch = { role: "spec-author", phaseNot: ["propose", "estimate"] };
    expect(matchesStep(m, ev("phase.start", "spec-author", { phase: "design" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "spec-author", { phase: "propose" }))).toBe(false);
    // this is what lets a role's non-phase events (e.g. artifact.written) still light it
    expect(matchesStep(m, ev("artifact.written", "spec-author"))).toBe(true);
  });

  it("buildModeNot excludes listed modes but a MISSING buildMode does not", () => {
    const m: StepMatch = { role: "driver", buildModeNot: ["refactor", "repair"] };
    expect(matchesStep(m, ev("phase.start", "driver", { buildMode: "repair" }))).toBe(false);
    expect(matchesStep(m, ev("phase.start", "driver", { phase: "green" }))).toBe(true);
  });

  it("buildModeAny accepts the phase as a fallback when buildMode is absent", () => {
    // reflect is logged with phase=reflect and sometimes no buildMode on phase.start
    const m: StepMatch = { role: "navigator", buildMode: "reflect", phase: "reflect" };
    expect(matchesStep(m, ev("phase.start", "navigator", { buildMode: "reflect" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "navigator", { phase: "reflect" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "navigator", { phase: "red" }))).toBe(false);
    expect(matchesStep(m, ev("phase.start", "navigator"))).toBe(false);
  });

  it("phase is a hard requirement only when no buildMode constraint is present", () => {
    const m: StepMatch = { role: "spec-author", phase: "propose" };
    expect(matchesStep(m, ev("phase.start", "spec-author", { phase: "propose" }))).toBe(true);
    expect(matchesStep(m, ev("phase.start", "spec-author", { phase: "design" }))).toBe(false);
    expect(matchesStep(m, ev("phase.start", "spec-author"))).toBe(false);
  });

  it("ignores non-string metadata rather than coercing it", () => {
    expect(matchesStep({ role: "driver", phase: "green" }, ev("x", "driver", { phase: 7 }))).toBe(false);
    // a numeric buildMode is treated as absent, so phaseNot/buildModeNot don't exclude
    expect(matchesStep({ role: "driver", buildModeNot: ["repair"] }, ev("x", "driver", { buildMode: 1 }))).toBe(true);
  });

  it("tolerates a missing metadata object entirely", () => {
    const e: AgentLogEvent = { timestamp: "t", level: "info", role: "dba", event: "x", message: "" };
    expect(matchesStep({ role: "dba" }, e)).toBe(true);
    expect(matchesStep({ role: "dba", phase: "design" }, e)).toBe(false);
  });
});

describe("laneStepForEvent", () => {
  it("routes representative events to the expected lane and step", () => {
    expect(laneStepForEvent(ev("phase.start", "spec-author", { phase: "propose" }))).toEqual({
      lane: "plan",
      step: "p-propose",
    });
    expect(laneStepForEvent(ev("phase.start", "dba", { phase: "design" }))).toEqual({
      lane: "design",
      step: "d-dba",
    });
    expect(laneStepForEvent(ev("phase.start", "navigator", { phase: "red" }))).toEqual({
      lane: "build",
      step: "b-red",
    });
    expect(laneStepForEvent(ev("phase.start", "driver", { phase: "green" }))).toEqual({
      lane: "build",
      step: "b-green",
    });
    expect(laneStepForEvent(ev("verify.passed", "orchestrator"))).toEqual({
      lane: "build",
      step: "b-verify",
    });
    expect(
      laneStepForEvent(ev("phase.start", "navigator", { phase: "assess", buildMode: "assess" })),
    ).toEqual({ lane: "build", step: "b-assess" });
    expect(
      laneStepForEvent(ev("phase.start", "driver", { phase: "repair", buildMode: "repair" })),
    ).toEqual({ lane: "build", step: "b-repair" });
  });

  it("returns null for events that light nothing", () => {
    expect(laneStepForEvent(null)).toBeNull();
    expect(laneStepForEvent(undefined)).toBeNull();
    // orchestrator owns no sub-step
    expect(laneStepForEvent(ev("handoff", "orchestrator", { phase: "design" }))).toBeNull();
  });

  it("first match wins across lanes in plan→design→build order", () => {
    // spec-author in `propose` matches p-propose; d-spec excludes propose, so no ambiguity
    const hit = laneStepForEvent(ev("phase.start", "spec-author", { phase: "propose" }));
    expect(hit?.lane).toBe("plan");
  });
});

describe("laneProgress / passedNodes", () => {
  const events = [
    ev("intake.supplied", "orchestrator"),
    ev("phase.start", "spec-author", { phase: "propose" }),
    ev("phase.start", "architect-reviewer", { phase: "estimate" }),
    ev("phase.start", "dba", { phase: "design" }),
    ev("phase.start", "navigator", { phase: "red" }),
    ev("phase.start", "driver", { phase: "green" }),
  ];

  it("accumulates reached steps and tracks the playhead step", () => {
    const p = laneProgress(events);
    expect([...p.done.plan]).toEqual(["p-intake", "p-propose", "p-size"]);
    expect([...p.done.design]).toEqual(["d-dba"]);
    expect([...p.done.build]).toEqual(["b-red", "b-green"]);
    expect(p.last.plan).toBe("p-size");
    expect(p.current).toEqual({ lane: "build", step: "b-green" });
  });

  it("current follows the event AT the playhead, not the last match", () => {
    // fold through the unmatched orchestrator handoff: nothing is current
    const withTrailingNoise = [...events, ev("handoff", "orchestrator", { phase: "design" })];
    const p = laneProgress(withTrailingNoise);
    expect(p.current).toBeNull();
    // but the reached set is unchanged
    expect([...p.done.build]).toEqual(["b-red", "b-green"]);
  });

  // --- feature scoping ------------------------------------------------------
  // Lane progress described the whole RUN, not the current feature. On a multi-feature run
  // that is wrong in a user-visible way: in the stockflow-rerecord corpus, at event 230 the
  // second sprint has barely started designing, yet every build sub-step and every lifecycle
  // node through `promote` read as reached — inherited from sprint 1. A lane graph drawn from
  // that shows a completed build lane for a feature that has not written a line of code.
  describe("feature scoping", () => {
    const twoFeatures = [
      ev("phase.start", "spec-author", { phase: "propose", feature_id: "F1" }),
      ev("phase.start", "dba", { phase: "design", feature_id: "F1" }),
      ev("phase.start", "navigator", { phase: "red", feature_id: "F1" }),
      ev("phase.start", "driver", { phase: "green", feature_id: "F1" }),
      ev("phase.start", "release-engineer", { phase: "deploy", feature_id: "F1" }),
      // sprint 2 opens: nothing built for it yet
      ev("phase.start", "spec-author", { phase: "propose", feature_id: "F2" }),
      ev("phase.start", "dba", { phase: "design", feature_id: "F2" }),
    ];

    it("laneProgress scoped to a feature ignores other features' steps", () => {
      const all = laneProgress(twoFeatures);
      expect([...all.done.build]).toEqual(["b-red", "b-green"]); // unscoped: F1's build work

      const f2 = laneProgress(twoFeatures, undefined, "F2");
      expect([...f2.done.build]).toEqual([]); // F2 has built nothing
      expect([...f2.done.design]).toEqual(["d-dba"]);
      expect([...f2.done.plan]).toEqual(["p-propose"]);

      const f1 = laneProgress(twoFeatures, undefined, "F1");
      expect([...f1.done.build]).toEqual(["b-red", "b-green"]);
    });

    it("passedNodes scoped to a feature does not inherit an earlier feature's spine", () => {
      expect([...passedNodes(twoFeatures)]).toContain("deploy"); // unscoped
      const f2 = passedNodes(twoFeatures, undefined, "F2");
      expect([...f2].sort()).toEqual(["design", "plan"]);
      expect(f2.has("deploy")).toBe(false);
      expect(f2.has("build")).toBe(false);
    });

    it("scoping composes with upTo", () => {
      const p = laneProgress(twoFeatures, 6, "F2");
      expect([...p.done.plan]).toEqual(["p-propose"]);
      expect(p.done.design.size).toBe(0); // F2's design is event 6, excluded by upTo=6
    });

    it("omitting the feature preserves today's whole-run behavior exactly", () => {
      // The scoping argument is additive: every existing caller must be unaffected.
      expect(laneProgress(twoFeatures, undefined, undefined)).toEqual(laneProgress(twoFeatures));
      expect([...passedNodes(twoFeatures, undefined, undefined)]).toEqual([...passedNodes(twoFeatures)]);
    });

    it("ignores an unreliable feature_id on reasoning events", () => {
      // Same hazard PR #12 handled: `reasoning` events carry a story id or truncated feature
      // in feature_id. They must not attribute lane progress to a bogus feature.
      const withReasoning = [
        ev("phase.start", "navigator", { phase: "red", feature_id: "F1" }),
        ev("reasoning", "driver", { phase: "green", feature_id: "S3-some-story" }),
      ];
      // The reasoning event's phase still counts for the feature in force (F1), not "S3-...".
      expect(laneProgress(withReasoning, undefined, "S3-some-story").done.build.size).toBe(0);
    });

    it("attributes events with no feature_id to the feature in force", () => {
      // Not every event stamps a feature; carry the last one forward, as storiesFromLog does.
      const carried = [
        ev("phase.start", "spec-author", { phase: "propose", feature_id: "F1" }),
        ev("phase.start", "navigator", { phase: "red" }), // no feature_id — still F1
      ];
      expect([...laneProgress(carried, undefined, "F1").done.build]).toEqual(["b-red"]);
      expect([...laneProgress(carried, undefined, "F2").done.build]).toEqual([]);
    });
  });

  it("is a prefix fold: upTo windows the log", () => {
    const p = laneProgress(events, 3);
    expect([...p.done.plan]).toEqual(["p-intake", "p-propose", "p-size"]);
    expect(p.done.design.size).toBe(0);
    expect(p.done.build.size).toBe(0);
    expect(p.current).toEqual({ lane: "plan", step: "p-size" });
  });

  it("clamps out-of-range and negative upTo", () => {
    expect(laneProgress(events, 999).done.build.size).toBe(2);
    const empty = laneProgress(events, 0);
    expect(empty.current).toBeNull();
    expect(empty.done.plan.size).toBe(0);
    expect(laneProgress(events, -5).done.plan.size).toBe(0);
  });

  it("handles an empty log", () => {
    const p = laneProgress([]);
    expect(p.current).toBeNull();
    expect(p.last).toEqual({ plan: null, design: null, build: null, deploy: null });
    expect(passedNodes([]).size).toBe(0);
  });

  it("passedNodes keeps its Set to real node ids on hostile phase names", () => {
    const hostile = passedNodes([ev("phase.start", "driver", { phase: "constructor" })]);
    expect(hostile.size).toBe(0);
    // and the set never holds a non-string, which would break JSON round-tripping
    for (const v of passedNodes(events)) expect(typeof v).toBe("string");
  });

  it("passedNodes derives intake from the event name and the rest from phases", () => {
    const seen = passedNodes(events);
    expect(seen).toContain("intake");
    expect(seen).toContain("plan");
    expect(seen).toContain("design");
    expect(seen).toContain("build");
    expect(seen).not.toContain("deploy");
  });

  it("passedNodes windows on upTo and never shrinks as upTo grows", () => {
    let prev = 0;
    for (let i = 0; i <= events.length; i++) {
      const n = passedNodes(events, i).size;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("does not mutate the events it folds", () => {
    const before = JSON.stringify(events);
    laneProgress(events);
    passedNodes(events);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("edgeDone requires both endpoints reached", () => {
    const p = laneProgress(events);
    expect(edgeDone("build", ["b-red", "b-green"], p)).toBe(true);
    expect(edgeDone("build", ["b-green", "b-verify"], p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Data-fidelity test vs. the ORIGINAL Python WORKFLOW.
//
// The differential test below shares this module's WORKFLOW object between both
// evaluators, so it proves the predicate LOGIC was ported faithfully but is blind to the
// ported DATA: a mis-transcribed match predicate or step id would make both
// implementations agree and stay green. This block closes that gap by asserting the TS
// data against a committed extraction of the canonical Python WORKFLOW literal
// (lib/__fixtures__/consort-workflow.json, regenerated by scripts/extract-kevin-workflow.py).
//
// Every difference must be declared below, with the evidence for it. That makes the
// deviations self-documenting and forces a deliberate edit here to add a new one.

interface PyStep {
  id: string;
  role: string | null;
  label: string;
  sub: string;
  gate?: boolean;
  branch?: boolean;
  match: Record<string, unknown> | null;
}
interface PyLane {
  title: string;
  steps: PyStep[];
  edges: [string, string][];
  backEdges: [string, string, string][];
}
interface PyWorkflow {
  _source: { line: number; literal_sha256: string; kit_describe: string };
  nodes: { id: string; label: string; roles: string[]; type: string }[];
  edges: [string, string][];
  phaseToNode: Record<string, string>;
  lanes: Record<string, PyLane>;
}

const PY: PyWorkflow = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "consort-workflow.json"), "utf8"),
);

// The deliberate corrections to Kevin's phaseToNode. Anything not listed here must match
// his table exactly. See lib/topology.ts for the reasoning; both were verified against
// the 380-event live log and the 421-event corpus log.
const INTENTIONAL_DEVIATIONS: Record<string, { py: string | undefined; ts: string | undefined; why: string }> = {
  intake: {
    py: undefined,
    ts: "intake",
    why: "dashboard-native: the metered Product Owner intake turn emits phase=intake; map it to the Intake lifecycle node so the current-sprint graph lights the Intake box while the PO drafts. Kevin's Python had no intake phase (intake was event-driven via intake.supplied, which lights the same node).",
  },
  assess: {
    py: "plan",
    ts: "build",
    why: "every assess* event carries buildMode: assess* and is the honest-GREEN decision; his own b-assess step already matched it in the build lane",
  },
  "assess-refactor": {
    py: undefined,
    ts: "build",
    why: "absent from his table entirely, so it fell off the graph; same honest-GREEN decision as assess",
  },
  "estimate ": {
    py: "plan",
    ts: undefined,
    why: "trailing-space misspelling key dropped; nodeForPhase trims instead",
  },
  RED: {
    py: "build",
    ts: undefined,
    why: "casing misspelling key dropped; nodeForPhase lowercases instead",
  },
};

// The lanes ported verbatim from Kevin's Python WORKFLOW; the fixture guards exactly these.
// "deploy" is a dashboard-native lane (release-engineer's deploy + promote phases, which are
// deterministic CLI effects with no LLM-agent sub-workflow in the Python) — it has no fixture
// counterpart and is tested on its own terms below, not against the extraction.
const PORTED_LANE_IDS = ["plan", "design", "build"] as const;

// Declared dashboard-side departures from Kevin's Python at the STEP level. The fixture is a
// verbatim extraction of the Python, so a value the dashboard intentionally changes would fail the
// verbatim comparison; each such change is declared here (mirroring INTENTIONAL_DEVIATIONS for
// phaseToNode), applied to the fixture side of the comparison, and separately asserted to still
// describe reality so it can't rot.
const STEP_DEVIATIONS: {
  lane: (typeof PORTED_LANE_IDS)[number];
  step: string;
  field: "role" | "sub";
  py: string | null;
  ts: string | null;
  why: string;
}[] = [
  {
    lane: "build",
    step: "b-verify",
    field: "role",
    py: null,
    ts: "release-engineer",
    why: "the dashboard attributes VERIFY (build-cycle and deploy) to the release-engineer for lane colouring; Kevin's Python left it ownerless. It keeps its verify-prefix match, so it still lights from events and is not a human gate.",
  },
  {
    lane: "plan",
    step: "p-req",
    field: "sub",
    py: "author requests",
    ts: "choose features",
    why: "author-requests is where the PO picks the sized candidates that fit the sprint (a feature-request.md per committed feature) — a selection, not prose authoring; 'choose features' describes what actually happens.",
  },
];

// Whole STEPS the dashboard ADDS to a ported lane that Kevin's Python omits — a declared departure
// like STEP_DEVIATIONS, but for a sub-step rather than one of its fields. Each must correspond to a
// phase the Python phaseToNode already routes to this lane yet gave no sub-step, so the lane could
// light while no step did. Added steps are filtered off the topology side of the verbatim
// comparison (so every OTHER step still matches the fixture byte-for-byte) and separately asserted
// to exist, sit right after their declared predecessor, and carry a reason.
const ADDED_STEPS: {
  lane: (typeof PORTED_LANE_IDS)[number];
  step: string;
  after: string; // the existing step this one is inserted directly after
  why: string;
}[] = [
  {
    lane: "plan",
    step: "p-intake-gate",
    after: "p-intake",
    why: "the intake gate — the HITL checkpoint AFTER the PO drafts the intake and BEFORE the Spec Author proposes (human reviews/edits/approves). A dashboard-native gate step Kevin's Python lacked; it closes the INTAKE side of the split plan lane and lights from the run's intake gate state.",
  },
  {
    lane: "plan",
    step: "p-breakdown",
    after: "p-req",
    why: "breakdown (spec-author) breaks the committed features into stories — a real plan-lane phase (PHASE_TO_NODE.breakdown === 'plan') that Kevin's Python routed to the Plan node but gave no sub-step; adding it lets the plan lane AND a step light while the backlog is broken down.",
  },
];

describe("topology — data fidelity vs Kevin's Python WORKFLOW", () => {
  it("the fixture is the literal we think it is", () => {
    expect(PY._source.line).toBe(384);
    expect(PY._source.kit_describe).toBe("v0.3.6");
    expect(PY._source.literal_sha256).toHaveLength(64);
  });

  it("ports the lifecycle nodes verbatim, in order", () => {
    expect(WORKFLOW.nodes.map((n) => ({ id: n.id, label: n.label, roles: n.roles, type: n.type }))).toEqual(
      PY.nodes.map((n) => ({ id: n.id, label: n.label, roles: n.roles, type: n.type })),
    );
  });

  it("ports the lifecycle edges verbatim, in order", () => {
    expect(WORKFLOW.edges.map((e) => [...e])).toEqual(PY.edges);
  });

  it("ports phaseToNode verbatim except for the declared deviations", () => {
    const keys = new Set([...Object.keys(PY.phaseToNode), ...Object.keys(PHASE_TO_NODE)]);
    const undeclared: string[] = [];
    for (const k of keys) {
      const py = PY.phaseToNode[k];
      const ts = Object.hasOwn(PHASE_TO_NODE, k) ? PHASE_TO_NODE[k] : undefined;
      if (py === ts) continue;
      const d = INTENTIONAL_DEVIATIONS[k];
      if (!d) {
        undeclared.push(`${JSON.stringify(k)}: py=${py} ts=${ts}`);
        continue;
      }
      // a declared deviation must still describe reality, so it can't rot
      expect(py, `${k} py side`).toBe(d.py);
      expect(ts, `${k} ts side`).toBe(d.ts);
      expect(d.why.length, `${k} needs a reason`).toBeGreaterThan(20);
    }
    expect(undeclared).toEqual([]);
  });

  it("declares no deviations that aren't real differences", () => {
    // Keeps the list from accumulating stale entries after a re-sync.
    const notActuallyDifferent = Object.keys(INTENTIONAL_DEVIATIONS).filter((k) => {
      const ts = Object.hasOwn(PHASE_TO_NODE, k) ? PHASE_TO_NODE[k] : undefined;
      return PY.phaseToNode[k] === ts;
    });
    expect(notActuallyDifferent).toEqual([]);
  });

  for (const lane of PORTED_LANE_IDS) {
    it(`ports the ${lane} lane verbatim: title, steps, predicates, edges`, () => {
      const py = PY.lanes[lane];
      const ts = WORKFLOW.lanes[lane];
      expect(py, `fixture has no ${lane} lane`).toBeDefined();

      expect(ts.title).toBe(py.title);
      expect(ts.backEdges.map((e) => [...e])).toEqual(py.backEdges);

      // Dashboard-native added steps are declared departures; filter them off the topology side so
      // the rest of the lane is compared to the fixture verbatim. Their own shape is proven below.
      const added = new Set(ADDED_STEPS.filter((a) => a.lane === lane).map((a) => a.step));
      const tsSteps = ts.steps.filter((s) => !added.has(s.id));
      // Edges collapse through the added steps back to the fixture chain. The ported lanes are LINEAR
      // (each edge joins consecutive steps), so with the added steps removed the fixture edges are
      // exactly the consecutive pairs of the remaining steps , IN ORDER (robust to multiple added
      // steps, unlike a filter-then-append which loses order). With no added steps this equals ts.edges.
      const tsEdges = added.size
        ? tsSteps.slice(0, -1).map((s, i) => [s.id, tsSteps[i + 1].id])
        : ts.edges.map((e) => [...e]);
      expect(tsEdges).toEqual(py.edges);

      // Step order matters: it is the order the lane renders in.
      expect(tsSteps.map((s) => s.id)).toEqual(py.steps.map((s) => s.id));

      // Apply the declared step deviations to the FIXTURE side, so the verbatim comparison reflects
      // "Kevin's Python + the dashboard's declared departures". The deviations are separately proven
      // to describe reality by the test below, so this can't hide an undeclared drift.
      const devs = STEP_DEVIATIONS.filter((d) => d.lane === lane);
      const withDev = (s: PyStep): PyStep => {
        const d = devs.find((x) => x.step === s.id);
        return d ? { ...s, [d.field]: d.ts } : s;
      };

      // Normalize absent-vs-false and key order so only real differences surface.
      const norm = (s: PyStep | LaneStep) => ({
        id: s.id,
        role: s.role ?? null,
        label: s.label,
        sub: s.sub,
        gate: s.gate ?? false,
        branch: s.branch ?? false,
        match: s.match
          ? Object.fromEntries(Object.entries(s.match).sort(([a], [b]) => a.localeCompare(b)))
          : null,
      });
      expect(tsSteps.map(norm)).toEqual(py.steps.map((s) => norm(withDev(s))));
    });
  }

  it("the fixture declares exactly the ported lanes, all present in LANE_IDS", () => {
    // The extraction covers the Python lanes and nothing else; each is a real dashboard lane.
    expect(Object.keys(PY.lanes).sort()).toEqual([...PORTED_LANE_IDS].sort());
    for (const l of PORTED_LANE_IDS) expect(LANE_IDS).toContain(l);
  });

  it("declares every step deviation truthfully (fixture keeps the old value, topology the new)", () => {
    // Keeps STEP_DEVIATIONS honest: each must correspond to a real fixture-vs-topology difference,
    // so a resolved or mis-stated one is caught rather than silently masking a comparison.
    for (const d of STEP_DEVIATIONS) {
      const py = PY.lanes[d.lane].steps.find((s) => s.id === d.step);
      const ts = WORKFLOW.lanes[d.lane].steps.find((s) => s.id === d.step);
      expect(py, `${d.step} in fixture`).toBeDefined();
      expect(ts, `${d.step} in topology`).toBeDefined();
      expect((py![d.field] ?? null) as string | null, `${d.step} fixture ${d.field}`).toBe(d.py);
      expect((ts![d.field] ?? null) as string | null, `${d.step} topology ${d.field}`).toBe(d.ts);
      expect(d.py, `${d.step} is a real difference`).not.toBe(d.ts);
      expect(d.why.length, `${d.step} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("declares every added step truthfully (absent from the fixture, present in topology, in order)", () => {
    // Keeps ADDED_STEPS honest: each must be a genuine dashboard addition — not in Kevin's Python,
    // present in the topology, sitting right after its declared predecessor, on a lane whose
    // phaseToNode routes the step's phase here — with a reason. A step that's actually in the
    // fixture (or mis-placed) is caught instead of silently masking a comparison.
    for (const a of ADDED_STEPS) {
      const py = PY.lanes[a.lane].steps.find((s) => s.id === a.step);
      const steps = WORKFLOW.lanes[a.lane].steps;
      const idx = steps.findIndex((s) => s.id === a.step);
      const afterIdx = steps.findIndex((s) => s.id === a.after);
      expect(py, `${a.step} must be absent from the fixture`).toBeUndefined();
      expect(idx, `${a.step} must exist in topology`).toBeGreaterThanOrEqual(0);
      expect(afterIdx, `${a.after} (predecessor of ${a.step}) must exist`).toBeGreaterThanOrEqual(0);
      expect(idx, `${a.step} must sit directly after ${a.after}`).toBe(afterIdx + 1);
      const step = steps[idx];
      if (step.gate) {
        // A GATE step (null match) lights from gate state, not an event phase , so it has no phase to
        // route. It must be a real gate (gate:true + match:null), consistent with the ported gates.
        expect(step.match, `${a.step} is a gate , match must be null`).toBeNull();
      } else {
        // An event-lit added step's phase must route to its own lane in phaseToNode (a real lane phase).
        const phases = [step.match?.phase, ...(step.match?.phaseAny ?? [])].filter(Boolean) as string[];
        expect(phases.length, `${a.step} needs a matching phase`).toBeGreaterThan(0);
        for (const p of phases) expect(nodeForPhase(p), `${p} routes to lane ${a.lane}`).toBe(a.lane);
      }
      expect(a.why.length, `${a.step} needs a reason`).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The deploy lane is dashboard-native (no Python counterpart), so it is asserted directly here
// rather than against the fixture. It combines the deploy + promote phases, attributes every
// deterministic step to the release-engineer, and keeps its two human gates unlightable.

describe("topology — the deploy lane (dashboard-native)", () => {
  const deploy = WORKFLOW.lanes.deploy;

  it("exists and sits immediately after build in LANE_IDS", () => {
    expect(deploy).toBeDefined();
    expect(LANE_IDS.indexOf("deploy")).toBe(LANE_IDS.indexOf("build") + 1);
  });

  it("lays out the deploy + promote phases plus the self-heal arm, in order", () => {
    expect(deploy.steps.map((s) => s.id)).toEqual([
      "dp-deploy", "dp-verify", "dp-gate",
      "dp-pr", "dp-ci", "dp-promgate", "dp-merge",
      "dp-assess", "dp-refactor", "dp-hil", "dp-promote-hil",
    ]);
  });

  it("attributes every deterministic step to the release-engineer, leaving gates ownerless", () => {
    const byId = new Map(deploy.steps.map((s) => [s.id, s]));
    for (const id of ["dp-deploy", "dp-verify", "dp-pr", "dp-ci", "dp-merge"]) {
      expect(byId.get(id)?.role, id).toBe("release-engineer");
    }
    for (const id of ["dp-gate", "dp-promgate", "dp-hil", "dp-promote-hil"]) expect(byId.get(id)?.role, id).toBeNull();
  });

  it("keeps the two human gates unlightable (→ purple) and both escalation terminals", () => {
    const byId = new Map(deploy.steps.map((s) => [s.id, s]));
    for (const id of ["dp-gate", "dp-promgate"]) {
      expect(byId.get(id)?.gate, id).toBe(true);
      expect(byId.get(id)?.match, id).toBeNull(); // match:null → isHumanGate → purple
    }
    for (const id of ["dp-hil", "dp-promote-hil"]) {
      expect(byId.get(id)?.escalation, id).toBe(true);
      expect(byId.get(id)?.match, id).toBeNull();
    }
  });

  it("lights deploy/verify from deploy.* events and the promote steps from the promote phase", () => {
    expect(laneStepForEvent(ev("deploy.start", "release-engineer"))).toEqual({ lane: "deploy", step: "dp-deploy" });
    expect(laneStepForEvent(ev("deploy.verified", "release-engineer"))).toEqual({ lane: "deploy", step: "dp-verify" });
    // The promote sub-steps emit no per-step events, so the promote phase.start lights the first
    // of them (dp-pr) — the section is structural, faithful to what the kit actually logs.
    expect(laneStepForEvent(ev("phase.start", "release-engineer", { phase: "promote" }))).toEqual({
      lane: "deploy",
      step: "dp-pr",
    });
  });

  it("documents the assess-deploy overlap: build's b-assess claims it, dp-assess never lights", () => {
    // dp-assess and b-assess both match buildMode assess-deploy; build precedes deploy in
    // LANE_IDS, so the build lane wins. dp-assess renders (the recovery arm is drawn) but is never
    // the lit step — a deliberate, documented overlap, not a bug.
    expect(
      laneStepForEvent(ev("phase.start", "navigator", { phase: "assess", buildMode: "assess-deploy" })),
    ).toEqual({ lane: "build", step: "b-assess" });
    // refactor-deploy, by contrast, has no build-lane claimant, so dp-refactor does light.
    expect(
      laneStepForEvent(ev("phase.start", "driver", { phase: "refactor", buildMode: "refactor-deploy" })),
    ).toEqual({ lane: "deploy", step: "dp-refactor" });
  });

  it("wires the happy-path spine and the self-heal back-edges", () => {
    expect(deploy.edges.map(([a, b]) => `${a}->${b}`)).toEqual([
      "dp-deploy->dp-verify", "dp-verify->dp-gate", "dp-gate->dp-pr",
      "dp-pr->dp-ci", "dp-ci->dp-promgate", "dp-promgate->dp-merge",
    ]);
    const back = deploy.backEdges.map(([a, b]) => `${a}->${b}`);
    expect(back).toContain("dp-verify->dp-assess"); // verify fails
    expect(back).toContain("dp-refactor->dp-deploy"); // re-deploy after scoping
    expect(back).toContain("dp-assess->dp-hil"); // genuine failure → escalate
    // The promote SCM steps have no self-heal — a non-zero exit escalates straight to the HIL.
    expect(back).toContain("dp-pr->dp-promote-hil"); // prepare-pr fails
    expect(back).toContain("dp-ci->dp-promote-hil"); // CI red
    expect(back).toContain("dp-merge->dp-promote-hil"); // merge conflict
  });
});

// ---------------------------------------------------------------------------
// Differential test vs. the ORIGINAL Python/JS evaluator.
//
// The port's real risk is not a crash, it is silently disagreeing with Kevin's
// evaluator on which sub-step an event lights — which would mis-light the lane graphs
// with no error. So: transcribe his template's laneStepForEvent
// (_dashboard_template.html:539-563) verbatim, run both over every event of the real
// logs, and require agreement event-for-event.

// Verbatim transcription. Deliberately keeps his control flow, including the no-op `if`
// on line 548 and the redundant trailing phase check. Do not "clean this up" — its value
// is being the original.
function originalLaneStepForEvent(e: AgentLogEvent): { lane: string | null; step: string | null } {
  const md = (e.metadata || {}) as Record<string, unknown>;
  const role = e.role;
  const phase = md.phase as string | undefined;
  const bm = md.buildMode as string | undefined;
  const evName = e.event;
  // Iterate the same lane set laneStepForEvent does (LANE_IDS), so the two agree on the
  // dashboard-native deploy lane too, not only the ported three.
  for (const laneId of LANE_IDS) {
    for (const s of WORKFLOW.lanes[laneId].steps) {
      const m = s.match;
      if (!m) continue;
      if (m.eventPrefix) {
        if (evName && evName.startsWith(m.eventPrefix)) return { lane: laneId, step: s.id };
        else continue;
      }
      if (m.event) {
        if (evName === m.event) return { lane: laneId, step: s.id };
        else continue;
      }
      if (m.role && role !== m.role) continue;
      if (m.phaseAny) {
        if (!phase || !m.phaseAny.includes(phase)) continue;
        return { lane: laneId, step: s.id };
      }
      if (m.phase && phase !== m.phase && !(m.buildMode && bm === m.buildMode)) {
        /* allow phase OR buildMode match below */
      }
      if (m.phaseNot && phase && m.phaseNot.includes(phase)) continue;
      if (m.buildModeNot && bm && m.buildModeNot.includes(bm)) continue;
      if (m.buildMode || m.buildModeAny) {
        const set = m.buildModeAny || [m.buildMode];
        if (!bm || !set.includes(bm)) {
          if (!(m.phase && phase === m.phase)) continue;
        }
      }
      if (m.phase && !m.buildMode && !m.buildModeAny) {
        if (phase !== m.phase) continue;
      }
      return { lane: laneId, step: s.id };
    }
  }
  return { lane: null, step: null };
}

const HOME = process.env.HOME || "";

interface LogFixture {
  name: string;
  path: string;
  // Sub-steps this particular run legitimately never reaches, with the reason. Declared
  // per fixture rather than inferred from the name, so renaming a fixture can't silently
  // change how strict its assertions are.
  neverLit: Record<string, string>;
}

// The live run in this lab (380 events) and the shipped replay corpus (421 events).
// Between them, every non-gate sub-step lights except the one noted below — including
// b-verify (release-engineer emits verify.passed) and b-perm (driver, buildMode refactor).
const LOGS: LogFixture[] = [
  {
    name: "live stockflow",
    // v0.3.7 renames .sftdd → .consort (auto-migrated on next run); resolve current then legacy.
    path:
      [".consort", ".sftdd", ".tdd"]
        .map((r) => join(HOME, "Code/consort-lab/stockflow", r, "agent-log.jsonl"))
        .find((p) => existsSync(p)) ?? join(HOME, "Code/consort-lab/stockflow/.consort/agent-log.jsonl"),
    neverLit: {
      // The corpus log DOES light p-req, which is what shows the predicate is right.
      "plan/p-req": "live: product-owner emits only gate.approved, never the author-requests phase",
    },
  },
  {
    name: "replay stockflow-rerecord",
    // v0.3.7 relocated the corpus to examples/replay/corpora/; prefer it, fall back to legacy.
    path:
      [
        join(HOME, ".claude/plugins/marketplaces/databricks-solutions/examples/replay/corpora/stockflow-rerecord/agent-log.jsonl"),
        join(HOME, ".claude/plugins/marketplaces/databricks-solutions/examples/sftdd-scenarios/stockflow-rerecord/agent-log.jsonl"),
      ].find((p) => existsSync(p)) ??
      join(HOME, ".claude/plugins/marketplaces/databricks-solutions/examples/replay/corpora/stockflow-rerecord/agent-log.jsonl"),
    neverLit: {},
  },
];

function readLog(p: string): AgentLogEvent[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AgentLogEvent];
      } catch {
        return [];
      }
    });
}

for (const { name, path, neverLit } of LOGS) {
  describe.skipIf(!existsSync(path))(`topology — differential vs original (${name})`, () => {
    it("agrees with the original evaluator on every event", () => {
      const events = readLog(path);
      expect(events.length).toBeGreaterThan(100);
      const disagreements: string[] = [];
      events.forEach((e, i) => {
        const mine = laneStepForEvent(e);
        const theirs = originalLaneStepForEvent(e);
        const a = mine ? `${mine.lane}/${mine.step}` : "none";
        const b = theirs.lane ? `${theirs.lane}/${theirs.step}` : "none";
        if (a !== b) {
          const md = (e.metadata || {}) as Record<string, unknown>;
          disagreements.push(`#${i} ${e.role}/${e.event} phase=${md.phase} bm=${md.buildMode}: ${a} vs ${b}`);
        }
      });
      expect(disagreements).toEqual([]);
    });

    it("lights a meaningful share of the log (the port is not inert)", () => {
      const events = readLog(path);
      const lit = events.filter((e) => laneStepForEvent(e) !== null).length;
      expect(lit).toBeGreaterThan(events.length * 0.1);
    });

    it("every phase present in the log maps to a lifecycle node", () => {
      // Guards against a new kit phase silently falling off the graph — the failure
      // that hid `assess-refactor`.
      const unmapped = new Set<string>();
      for (const e of readLog(path)) {
        const md = (e.metadata || {}) as Record<string, unknown>;
        const p = md.phase;
        if (typeof p === "string" && p.trim() && !nodeForPhase(p)) unmapped.add(p);
      }
      expect([...unmapped]).toEqual([]);
    });

    it("reaches the full lifecycle spine over a complete run", () => {
      const seen = passedNodes(readLog(path));
      for (const id of ["plan", "design", "build", "deploy"]) expect(seen, id).toContain(id);
    });

    it("exercises every non-gate sub-step across a complete run", () => {
      // If a step never lights on a real full run its predicate is suspect, so require
      // every one to light except those this fixture declares (with a reason) as
      // legitimately unreachable for what that run actually did.
      const p = laneProgress(readLog(path));
      const missing: string[] = [];
      for (const lane of LANE_IDS) {
        for (const s of WORKFLOW.lanes[lane].steps) {
          if (s.match === null) continue; // human gates never light from events
          if (!p.done[lane].has(s.id)) missing.push(`${lane}/${s.id}`);
        }
      }
      expect(missing.filter((m) => !(m in neverLit))).toEqual([]);
    });

    it("declares no stale neverLit exemptions", () => {
      // Keeps the exemption list honest: if a step starts lighting (new kit, new corpus),
      // its entry must be removed rather than quietly masking a future regression.
      const p = laneProgress(readLog(path));
      const nowLit = Object.keys(neverLit).filter((k) => {
        const [lane, step] = k.split("/") as [LaneId, string];
        return p.done[lane]?.has(step);
      });
      expect(nowLit).toEqual([]);
    });

    it("laneProgress is a monotonic prefix fold over the real log", () => {
      const events = readLog(path);
      let prev = 0;
      for (let i = 0; i <= events.length; i += 17) {
        const p = laneProgress(events, i);
        const total = LANE_IDS.reduce((n, l) => n + p.done[l].size, 0);
        expect(total).toBeGreaterThanOrEqual(prev);
        prev = total;
      }
    });
  });
}
