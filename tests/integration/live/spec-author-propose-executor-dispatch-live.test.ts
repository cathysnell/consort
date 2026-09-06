// LIVE (gated RUN_LIVE_STEP=1): the spec-author PROPOSE (plan lane) turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/spec-author-propose-executor-dispatch-live.test.ts
//
// Real spec-author propose turn via performViaExecutor: reads product-overview + nfrs (root), lands
// planning/feature-proposals.md under .consort (artifact channel). PLANNING MODE – the executor SKIPS
// reconcile (no agent-log), matching the legacy !isPlanningMode guard. LEAN, no cloud. The spec is the
// catalogue's shared entry (DESIGN_LIVE_SPECS.propose) – one source of truth for role/seed/prompt/step.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: spec-author propose through the shipped executor (plan lane, no reconcile)", () => {
  it("reads product-overview + nfrs + lands planning/feature-proposals.md under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("propose")), 900_000);
});
