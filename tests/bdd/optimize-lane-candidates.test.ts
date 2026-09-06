// P3-prep (#502): per-role candidate defaults for the DESIGN lane sweep. Design
// roles carry a SCALAR model/effort (roles.<role>.model = "opus"), not the
// per-turn map generateCandidates emits for build turns, so the lane sweep needs
// role-appropriate candidate sets. defaultLaneCandidates builds them: baseline +
// a model-downgrade + an effort-drop + one prompt/scope content variant – the
// "model + effort + a prompt/scope variant" axis. The navigator REFLECT turn is a
// critic gate (it FLAGS defects), not an authoring turn, so it is not swept.

import { describe, expect, it } from "vitest";

import { defaultLaneCandidates, buildTurnForHandoff } from "../../consort/optimize/optimize-candidates";
import type { HandoffPlan } from "../../consort/optimize/optimize-harness";
import type { BuildTurn as BuildTurnKey } from "../../consort/orchestrator/settings/project-settings";

function h(role: string, story?: string, buildMode?: string): HandoffPlan {
  return { id: `${story ? story + "-" : ""}${role}${buildMode ? "-" + buildMode : ""}`, role, story, buildMode };
}

describe("defaultLaneCandidates: design roles (scalar model/effort)", () => {
  it("baseline first, then EVERY OTHER model tier as a scalar (opus base -> sonnet AND haiku)", () => {
    const cands = defaultLaneCandidates(h("architect-reviewer", "S1"));
    expect(cands[0].id).toBe("baseline");
    // A scalar model-only candidate for each OTHER tier (base opus -> the two below).
    const models = cands
      .filter((c) => typeof c.configOverrides.roles?.["architect-reviewer"]?.model === "string" && c.configOverrides.roles?.["architect-reviewer"]?.effort === undefined)
      .map((c) => c.configOverrides.roles!["architect-reviewer"]!.model);
    expect(models).toEqual(expect.arrayContaining(["sonnet", "haiku"]));
    expect(models).not.toContain("opus"); // never re-try the base model
  });

  it("tries a MORE-capable model too: a sonnet-based role (ux-designer) gets an opus candidate", () => {
    // "Try all possibilities" – a bigger model can win wall-clock via fewer round-trips.
    const cands = defaultLaneCandidates(h("ux-designer"));
    const models = cands
      .filter((c) => typeof c.configOverrides.roles?.["ux-designer"]?.model === "string" && c.configOverrides.roles?.["ux-designer"]?.effort === undefined)
      .map((c) => c.configOverrides.roles!["ux-designer"]!.model);
    expect(models).toEqual(expect.arrayContaining(["haiku", "opus"])); // cheaper AND more capable
    expect(models).not.toContain("sonnet"); // never re-try the base
  });

  it("every role gets the SAME candidate count (2 other models x {alone, x-low} + 2 efforts + scan + baseline = 8)", () => {
    // With all-tiers, an opus base and a sonnet base both have exactly 2 other models,
    // so the sweep is uniform: no role is under-swept for being mid-tier.
    for (const role of ["spec-author", "architect-reviewer", "dba", "test-strategist"]) {
      expect(defaultLaneCandidates(h(role, "S1")).length).toBe(8);
    }
    expect(defaultLaneCandidates(h("ux-designer")).length).toBe(8);
  });

  it("includes effort-drop candidates as scalars (low AND medium)", () => {
    const cands = defaultLaneCandidates(h("dba", "S1"));
    const efforts = cands
      .filter((c) => c.configOverrides.roles?.dba?.effort !== undefined && c.configOverrides.roles?.dba?.model === undefined)
      .map((c) => c.configOverrides.roles!.dba!.effort);
    expect(efforts).toEqual(expect.arrayContaining(["low", "medium"]));
  });

  it("includes a model x effort CROSS at low for EVERY other model (model change AND less thinking)", () => {
    const cands = defaultLaneCandidates(h("architect-reviewer", "S1"));
    const crosses = cands
      .filter(
        (c) =>
          typeof c.configOverrides.roles?.["architect-reviewer"]?.model === "string" &&
          c.configOverrides.roles?.["architect-reviewer"]?.effort === "low",
      )
      .map((c) => c.configOverrides.roles!["architect-reviewer"]!.model);
    // opus base -> a cross at low for each of the two other tiers.
    expect(crosses).toEqual(expect.arrayContaining(["sonnet", "haiku"]));
    expect(cands.some((c) => c.id.match(/m-sonnet-e-low/))).toBe(true);
    expect(cands.some((c) => c.id.match(/m-haiku-e-low/))).toBe(true);
  });

  it("includes a HARD scan-tightening content variant: deny Grep/Glob + a directive (enforced, not just requested)", () => {
    const cands = defaultLaneCandidates(h("test-strategist", "S1"));
    const scan = cands.find((c) => c.content?.disallowedTools?.length);
    expect(scan).toBeDefined();
    // the scan lever DENIES the tree-scanning tools, so the tightening is enforced
    expect(scan!.content!.disallowedTools).toEqual(expect.arrayContaining(["Grep", "Glob"]));
    // and still carries the directive explaining the intent
    expect(scan!.content!.taskSuffix).toMatch(/./);
  });

  it("ids are unique + stable", () => {
    const cands = defaultLaneCandidates(h("spec-author", "S1"));
    expect(new Set(cands.map((c) => c.id)).size).toBe(cands.length);
  });

  it("does NOT sweep the navigator reflect critic turn (returns baseline-only)", () => {
    const cands = defaultLaneCandidates(h("navigator", "S1", "reflect"));
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe("baseline");
  });

  it("a feature-scope design role (ux-designer, no story) still gets a candidate set", () => {
    const cands = defaultLaneCandidates(h("ux-designer"));
    expect(cands.length).toBeGreaterThan(1);
    expect(cands.some((c) => typeof c.configOverrides.roles?.["ux-designer"]?.model === "string")).toBe(true);
  });
});

describe("defaultLaneCandidates: build roles (per-turn map)", () => {
  it("a build turn uses the per-turn model map (navigator RED)", () => {
    const cands = defaultLaneCandidates(h("navigator", "S1")); // no buildMode -> RED
    const model = cands.find((c) => {
      const m = c.configOverrides.roles?.navigator?.model;
      return m && typeof m === "object";
    });
    expect(model).toBeDefined();
  });

  it("sweeps EVERY build turn type per-turn (review/refactor/assess/repair), not just red/green", () => {
    // Each specialized build turn is a distinct kind of work and must be swept with a
    // per-turn keyed override so it can pick its OWN model/effort. Pre-fix, only
    // red/green were swept; review/refactor/assess/repair fell into the design scalar
    // branch (wrong shape) and were effectively un-optimized.
    const cases: Array<[string, string | undefined, string, BuildTurnKey]> = [
      ["navigator", "review", "navigator", "review"],
      ["driver", "refactor", "driver", "refactor"],
      ["navigator", "assess", "navigator", "assess"],
      ["driver", "repair", "driver", "repair"],
    ];
    for (const [role, mode, r, turn] of cases) {
      const cands = defaultLaneCandidates(h(role, "S1", mode));
      expect(cands.length).toBe(8); // full lever set, same as red/green
      // a model candidate carries a per-TURN map keyed on this exact turn.
      const m = cands.find((c) => {
        const mv = (c.configOverrides.roles as Record<string, { model?: unknown }> | undefined)?.[r]?.model;
        return mv && typeof mv === "object" && (mv as Record<string, unknown>)[turn] !== undefined;
      });
      expect(m, `${role}/${mode} should sweep a per-turn '${turn}' model`).toBeDefined();
    }
  });

  it("collapses specialized buildModes onto their base family (refactor-superseded->refactor, green-superseded->green)", () => {
    expect(buildTurnForHandoff(h("driver", "S1", "refactor-superseded"))).toBe("refactor");
    expect(buildTurnForHandoff(h("driver", "S1", "refactor-deploy"))).toBe("refactor");
    expect(buildTurnForHandoff(h("navigator", "S1", "assess-deploy"))).toBe("assess");
    expect(buildTurnForHandoff(h("navigator", "S1", "assess-refactor"))).toBe("assess");
    expect(buildTurnForHandoff(h("driver", "S1", "green-superseded"))).toBe("green");
    // reflect is the design-lane critic, but a tunable turn in its own right (the sweep
    // measured haiku+low as its winner), so it keys to "reflect", not undefined.
    expect(buildTurnForHandoff(h("navigator", "S1", "reflect"))).toBe("reflect");
    // a design role has no build turn.
    expect(buildTurnForHandoff(h("spec-author", "S1"))).toBeUndefined();
  });
});
