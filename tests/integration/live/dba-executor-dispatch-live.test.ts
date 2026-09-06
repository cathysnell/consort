// LIVE (gated RUN_LIVE_STEP=1): the DBA design turn dispatched THROUGH the shipped executor path.
//
//   RUN_LIVE_STEP=1 npx vitest run tests/integration/live/dba-executor-dispatch-live.test.ts
//
// Proves the Stage 1/1b widening LIVE: a REAL dba `claude -p` turn, dispatched via
// buildDriveEffects(cfg).performViaExecutor, resolves its feature-scoped input
// (feature:features/{feature}/architecture.json – the {feature} scope fix) on a real .consort tree
// and lands db-design.json under .consort at features/<F>/ (the artifact channel) + the reconciled
// agent-log under .consort (meta). LEAN, no cloud. The spec is the catalogue's shared entry
// (DESIGN_LIVE_SPECS.dba) – one source of truth for the role turn.

import { describe, it } from "vitest";
import { runDesignExecutorDispatchLive, designSpec } from "./executor-dispatch-live-support.js";

describe.skipIf(!process.env.RUN_LIVE_STEP)("LIVE: dba through the shipped executor (artifact channel, {feature}-scoped input)", () => {
  it("resolves features/<F>/architecture.json + lands db-design.json under .consort", () =>
    runDesignExecutorDispatchLive(designSpec("dba")), 900_000);
});
