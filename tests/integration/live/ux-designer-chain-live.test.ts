// LIVE integration chain (gated behind RUN_LIVE_STEP=1):
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/ux-designer-chain-live.test.ts
//
// The 2-turn per-role chain (uniform with the other design-role chains), driven by
// folder-discovery over tests/integration/manifests/ux-designer-chain/:
//   1. replay seed          – lays the ux-designer's real-drive inputs (design-brief.md +
//                             product-overview.md) into the workspace, routes to the live role.
//   2. LIVE ux-designer (claude) – translates the brief into a schema-conformant design-guide.json.
//
// ONLY step 2 is a live agent; step 1 is a deterministic replay. LEAN – the whole chain runs in a
// throwaway `.sftdd` workspace via the folder-discovery runner. NO cloud project (the live
// ux-designer is tool-scoped out of Bash and reports via the agent-report channel).

import { describe, it, expect } from "vitest";
import { runRoleChainLive } from "../../../consort/optimize/role-chains.js";
import { ROLE_CHAINS } from "../../../consort/optimize/role-chains.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE (lean): replay seed -> live ux-designer chain", () => {
  it("seeds the design-brief + product-overview and drives the live ux-designer to a conformant design-guide", async () => {
    const chain = ROLE_CHAINS["ux-designer"];
    const { turns, producedArtifacts } = await runRoleChainLive(chain);

    // Two turns ran, in order (seed -> live), each clean.
    expect(turns.map((t) => t.manifestId)).toEqual(["ux-designer-chain-seed", "ux-designer-chain-live"]);
    for (const t of turns) {
      expect(t.result.violations, `${t.manifestId}: ${t.result.violations.join("; ")}`).toEqual([]);
    }

    // The LIVE ux-designer produced a schema-conformant design-guide.json (designGuideConformant,
    // no violations), and it was CAPTURED in producedArtifacts under its outputFile – which is
    // exactly what the quality gate keys on (proving the snapshot-root fix).
    const uxTurn = turns[turns.length - 1];
    expect(uxTurn.manifestId).toBe("ux-designer-chain-live");
    expect(producedArtifacts[chain.outputFile], `produced artifacts: ${Object.keys(producedArtifacts).join(", ")}`).toBeDefined();
    expect(uxTurn.result.bounded.action).toEqual({ kind: "design-complete" });
  }, 900_000);
});
