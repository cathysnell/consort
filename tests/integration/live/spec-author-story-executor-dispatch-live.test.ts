// LIVE (gated RUN_LIVE_STEP=1): the spec-author per-story ACs turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/spec-author-story-executor-dispatch-live.test.ts
//
// Real spec-author turn via performViaExecutor: reads the story stub (story-scoped) + product-overview
// (root), lands >=1 acs/<AC>.json under .consort at features/<F>/stories/<S>/acs/ (artifact channel,
// a DIRECTORY primary – acsDirConformant) + the reconciled agent-log (meta). LEAN, no cloud. The spec
// is the catalogue's shared entry (DESIGN_LIVE_SPECS.acs) – one source of truth for the role turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: spec-author per-story ACs through the shipped executor (artifact channel, dir primary)", () => {
  it("reads the story stub + lands >=1 acs/<AC>.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("acs")), 900_000);
});
