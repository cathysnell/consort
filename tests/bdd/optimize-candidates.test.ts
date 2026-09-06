// P2b optimize-candidates: the PURE candidate model. A Candidate is one point in
// the sweep space – a set of CONFIG overrides (Family 1: model/effort/scope/loop,
// merged into a sftdd-config.json) plus optional CONTENT/SCOPE variants (Family 2:
// agent-.md overlay, task/context suffixes, tool scope). This module has NO I/O:
// it generates the candidate list from a sweep spec and merges a candidate's
// config overrides onto a base config. Applying + running them is the harness's job.

import { describe, expect, it } from "vitest";

import {
  generateCandidates,
  applyCandidateConfig,
  BASELINE_CANDIDATE_ID,
  type Candidate,
} from "../../consort/optimize/optimize-candidates";
import { defaultConsortConfig } from "../../consort/orchestrator/settings/project-settings";

describe("generateCandidates", () => {
  it("always includes an identity baseline candidate FIRST (empty overrides)", () => {
    const cands = generateCandidates({});
    expect(cands[0].id).toBe(BASELINE_CANDIDATE_ID);
    expect(cands[0].configOverrides).toEqual({});
    expect(cands[0].content ?? {}).toEqual({});
  });

  it("crosses a model x effort sweep for a role into distinct candidates", () => {
    const cands = generateCandidates({
      role: "driver",
      models: { green: ["haiku", "sonnet"] },
      efforts: { green: ["low", "medium"] },
    });
    // baseline + 2 models x 2 efforts = 5
    expect(cands).toHaveLength(5);
    // ids are unique + stable
    expect(new Set(cands.map((c) => c.id)).size).toBe(5);
    // every non-baseline candidate carries a driver role override
    for (const c of cands.slice(1)) {
      expect(c.configOverrides.roles?.driver).toBeDefined();
    }
  });

  it("emits session-warmth candidates (sessionScope x contextFreeFraction)", () => {
    const cands = generateCandidates({
      sessionScopes: ["story", "cycle"],
      contextFreeFractions: [0.3, 0.5],
    });
    // baseline + 2x2 = 5; the fraction rides on env (not the config file), so
    // it is carried on the candidate's env, not configOverrides.
    expect(cands).toHaveLength(5);
    const withEnv = cands.find((c) => c.env?.CONTEXT_FREE_FRACTION === "0.3");
    expect(withEnv).toBeDefined();
  });

  it("emits loop-granularity candidates", () => {
    const cands = generateCandidates({ loopGranularities: ["story", "ac"] });
    expect(cands).toHaveLength(3);
    expect(cands.some((c) => c.configOverrides.build?.loopGranularity === "ac")).toBe(true);
  });

  it("carries Family-2 content variants verbatim (agent overlay + suffixes + tool scope)", () => {
    const content: Candidate["content"] = {
      agentOverlay: { role: "driver", markdown: "# tighter driver\n" },
      taskSuffix: " Prefer editing existing files.",
      contextPackSuffix: " MODULE MAP: services/inventory.py",
      allowedTools: ["Read", "Edit", "Bash"],
    };
    const cands = generateCandidates({ contentVariants: [content] });
    expect(cands).toHaveLength(2);
    expect(cands[1].content).toEqual(content);
  });
});

describe("applyCandidateConfig (deep merge onto a base config)", () => {
  it("baseline overrides leave the base config unchanged", () => {
    const base = defaultConsortConfig();
    const merged = applyCandidateConfig(base, { id: BASELINE_CANDIDATE_ID, configOverrides: {} });
    expect(merged).toEqual(base);
  });

  it("merges a per-turn model override without dropping sibling role settings", () => {
    // An explicit base with per-turn maps – this exercises applyCandidateConfig's merge semantics
    // directly (defaultConsortConfig no longer carries per-turn maps; the manifest is that home now).
    const base = {
      version: 1 as const,
      roles: { driver: { model: { red: "sonnet", green: "opus" } }, navigator: { effort: { review: "low" } } },
    } as unknown as ReturnType<typeof defaultConsortConfig>;
    const merged = applyCandidateConfig(base, {
      id: "c1",
      configOverrides: { roles: { driver: { model: { green: "haiku" } } } },
    });
    // driver.green overridden...
    expect((merged.roles?.driver?.model as Record<string, string>).green).toBe("haiku");
    // ...but the driver's OTHER turns + other roles survive
    expect((merged.roles?.driver?.model as Record<string, string>).red).toBe("sonnet");
    expect(merged.roles?.navigator).toEqual(base.roles?.navigator);
  });

  it("does not mutate the base config (returns a fresh object)", () => {
    const base = defaultConsortConfig();
    const snapshot = JSON.parse(JSON.stringify(base));
    applyCandidateConfig(base, { id: "c1", configOverrides: { build: { loopGranularity: "ac" } } });
    expect(base).toEqual(snapshot);
  });

  it("merges build knobs onto the base build block", () => {
    const base = defaultConsortConfig();
    const merged = applyCandidateConfig(base, {
      id: "c1",
      configOverrides: { build: { sessionScope: "cycle" } },
    });
    expect(merged.build?.sessionScope).toBe("cycle");
    // batchCap + loopGranularity from the base survive
    expect(merged.build?.batchCap).toBe(base.build?.batchCap);
    expect(merged.build?.loopGranularity).toBe(base.build?.loopGranularity);
  });
});
