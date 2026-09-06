// LIVE (gated RUN_LIVE_STEP=1): the architect-reviewer design turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/architect-reviewer-executor-dispatch-live.test.ts
//
// Real architect turn via performViaExecutor: reads the story's acs/ (story-scoped) + nfrs (root),
// lands architecture.json under .consort at features/<F>/ (artifact channel) + the reconciled
// agent-log under .consort (meta). See ./executor-dispatch-live-support.ts. LEAN, no cloud. The spec
// is the catalogue's shared entry (DESIGN_LIVE_SPECS.architect) – one source of truth for the turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: architect-reviewer through the shipped executor (artifact channel)", () => {
  it("reads the story acs/ + nfrs + lands architecture.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("architect")), 900_000);
});
