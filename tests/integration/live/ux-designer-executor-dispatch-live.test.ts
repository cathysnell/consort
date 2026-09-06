// LIVE (gated RUN_LIVE_STEP=1): the ux-designer design turn through the shipped executor.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/ux-designer-executor-dispatch-live.test.ts
//
// Real ux-designer turn via performViaExecutor: reads design/design-brief.md (the design/-scoped
// source fix) + product-overview, lands design-guide.json under .consort at design/ (artifact channel)
// + the reconciled agent-log (meta). LEAN, no cloud. The spec is the catalogue's shared entry
// (DESIGN_LIVE_SPECS.ux) – one source of truth for the role turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: ux-designer through the shipped executor (artifact channel)", () => {
  it("reads design/design-brief.md + product-overview + lands design/design-guide.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("ux")), 900_000);
});
