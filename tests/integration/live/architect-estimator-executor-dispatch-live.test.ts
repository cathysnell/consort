// LIVE (gated RUN_LIVE_STEP=1): the architect ESTIMATE (plan lane) turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/architect-estimator-executor-dispatch-live.test.ts
//
// Real architect estimate turn via performViaExecutor: reads planning/feature-proposals.md, lands
// planning/estimates.json under .consort (artifact channel). PLANNING MODE – the executor SKIPS
// reconcile (no agent-log), matching the legacy !isPlanningMode guard. LEAN, no cloud. The spec is the
// catalogue's shared entry (DESIGN_LIVE_SPECS.estimate) – one source of truth for the role turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: architect estimate through the shipped executor (plan lane, no reconcile)", () => {
  it("reads planning/feature-proposals.md + lands planning/estimates.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("estimate")), 900_000);
});
