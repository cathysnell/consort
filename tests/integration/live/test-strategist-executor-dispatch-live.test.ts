// LIVE (gated RUN_LIVE_STEP=1): the test-strategist design turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/test-strategist-executor-dispatch-live.test.ts
//
// Real test-strategist turn via performViaExecutor: reads the story acs/ + feature-scoped
// architecture.json + db-design.json (the {feature} source fix), lands test-list.json under .consort
// at features/<F>/ (artifact channel) + the reconciled agent-log (meta), and runs its `after` test-list
// CLI. LEAN, no cloud. The spec is the catalogue's shared entry (DESIGN_LIVE_SPECS["test-list"]) – one
// source of truth for the role turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: test-strategist through the shipped executor (artifact channel)", () => {
  it("reads acs/ + feature architecture + db-design + lands test-list.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("test-list")), 900_000);
});
