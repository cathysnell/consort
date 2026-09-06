// Route-scenario suite: each entry in ROUTE_SCENARIOS is ONE route pathway out of a spec-author
// breakdown, run in ISOLATION against its own throwaway `.sftdd` workspace. It exercises the
// REAL stack – the manifest runner, the StepExecutor, a real escalation planted on disk, and the
// real disk probe deriving it back – so the ROUTE decision is genuine, not mocked. It is LEAN:
// no cloud project (the route pathways depend on `.sftdd` state, not Databricks/GitHub). The
// live-claude authoring path is covered separately by stockflow-demo-config-live.test.ts.
//
// The agents are deterministic fixtures (PO replay + a spec-author that writes a conformant
// feature-spec) so each scenario proves its ROUTE, not the model's prose.

import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRouteScenario, routeMatches, type RouteScenarioHooks } from "../../consort/orchestrator/scenarios/route-scenario";
import { ROUTE_SCENARIOS } from "../../consort/orchestrator/scenarios/route-scenarios";
import { makeMockReplayAgent } from "../../consort/orchestrator/agents/mock-replay-agent";
import type { StepAgent } from "../../consort/orchestrator/agents/agent-types";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { ManifestRunnerDeps } from "../../consort/orchestrator/runners/manifest-runner";
import type { DriveEffectsConfig } from "../../consort/orchestrator/drive/orchestrator-effects";

/** A minimal design-guide.json that conforms to design-guide.schema.json (typography +
 *  font_family/scale, colors.brand, spacing). The ux-designer route scenarios need a conformant
 *  primary for the produced/escalate paths; the blocked path skips it. */
const CONFORMANT_DESIGN_GUIDE = JSON.stringify({
  typography: { font_family: "DM Sans", scale: { "text-base": "15px" } },
  colors: { brand: { "navy-900": "#0b1a2b" } },
  spacing: { "space-4": "16px" },
}) + "\n";

/** Deterministic agents: PO replays the recorded intake; the spec-author writes a conformant
 *  feature-spec + log, the ux-designer a conformant design-guide + log – UNLESS the scenario
 *  asks for a nonconformant primary (to drive the blocked outcome), in which case it writes only
 *  the log and NO primary artifact. The route (not authoring) is under test, so these are
 *  fixtures. */
function makeAgentFor(intakeDir: string, nonconformantPrimary: boolean) {
  return (manifest: StepManifest): StepAgent => {
    if (manifest.role === "product-owner") {
      return makeMockReplayAgent({
        corpusRoot: intakeDir,
        seeds: [
          { outputId: "product-overview", from: "product-overview.md", to: "product-overview.md" },
          { outputId: "nfrs", from: "nfrs.md", to: "nfrs.md" },
          { outputId: "design-guideline", from: "design-brief.md", to: "design-brief.md" },
        ],
      });
    }
    const role = manifest.role;
    return {
      async invoke(inv) {
        // Always write the role's log line (agentLogHasRoleEvent binds the role per manifest).
        writeFileSync(
          join(inv.workspaceDir, "agent-log.jsonl"),
          JSON.stringify({ timestamp: "2026-08-03T12:00:00Z", level: "info", role, event: "artifact.written", message: "wrote artifacts" }) + "\n",
        );
        if (nonconformantPrimary) return; // skip the primary -> validate fails -> blocked
        // The primary artifact differs by role: ux-designer -> design-guide.json; everyone else
        // (spec-author breakdown) -> feature-spec.json. (story/propose manifests have agent-log
        // as their primary, already written above.)
        if (role === "ux-designer") {
          writeFileSync(join(inv.workspaceDir, "design-guide.json"), CONFORMANT_DESIGN_GUIDE);
        } else {
          writeFileSync(
            join(inv.workspaceDir, "feature-spec.json"),
            JSON.stringify({ id: "F1-stock-visibility", name: "Stock Visibility", status: "draft", tdd_mode: "N>=2", stories: ["S1-stock-list"] }) + "\n",
          );
        }
      },
    };
  };
}

const hooks: RouteScenarioHooks = {
  runnerDeps(scenario, workspaceDir, cfg: DriveEffectsConfig): ManifestRunnerDeps {
    return { agentFor: makeAgentFor(scenario.intakeDir, scenario.nonconformantPrimary ?? false), workspaceDir, cfg };
  },
};

describe("route-scenario suite: each pathway isolated (spec-author + ux-designer; produced / revise / escalate / blocked)", () => {
  for (const scenario of ROUTE_SCENARIOS) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      const result = await runRouteScenario(scenario, hooks);
      expect(
        routeMatches(result.actualRoute, scenario.expectedRoute),
        `expected route ${JSON.stringify(scenario.expectedRoute)} but got ${JSON.stringify(result.actualRoute)}`,
      ).toBe(true);
    });
  }
});
