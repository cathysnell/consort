// GATED LIVE (RUN_LIVE_STEP=1 + LAKEBASE_TEST_E2E=1): the CODE half of the shared regression
// comparison suite – the driver's product code judged FUNCTIONALLY against the pin.
//
//   RUN_LIVE_STEP=1 LAKEBASE_TEST_E2E=1 npx vitest run tests/integration/live/driver-code-equivalence-live.test.ts
//
// The driver-GREEN dispatch proof (driver-green-executor-dispatch-live) proves the driver writes
// product code that passes honest-GREEN (alembic + tests vs a live Lakebase branch) – the Layer-1
// floor. It does NOT compare that code to the recorded reference. This suite closes that gap: it
// reuses the SAME live driver-GREEN run (runDriverGreenLive, real branch on ecparr) and, before
// teardown, judges the produced app/ tree against the pin's recorded-build reference via the SHARED
// evaluateBuildFunctionalGate + makeBuildDiscriminatorJudge (the FIXED-opus discriminator, the SAME
// judge the optimization build-trial uses). Layer-2 functional bar: classification-driven – clean
// "equivalent"/accept is the best outcome; superseded-shift + driver-fixable regression are viable;
// only "insufficient"/escalate FAILS. A missing pin reference SKIPS (never a false pass).
//
// DOUBLE-gated like driver-green: needs a real Lakebase branch, so it is cloud + config-home gated.
// NEVER interrupt this run before its teardown (an orphaned Lakebase project leaks).

import { describe, it } from "vitest";
import { runDriverGreenLive, resolveDriverGreenRunConfig } from "./driver-build-support.js";
import {
  evaluateBuildFunctionalGate,
  makeBuildDiscriminatorJudge,
  type SemanticJudge,
  type BuildOutputKind,
} from "../../../consort/evaluation/semantic-gate.js";

const KIT = process.cwd();
const cloudReady = !!process.env.RUN_LIVE_STEP && process.env.LAKEBASE_TEST_E2E === "1";
const hostResolvable = (() => {
  try {
    return !!resolveDriverGreenRunConfig().host;
  } catch {
    return false;
  }
})();

/** Adapt the fixed-opus DISCRIMINATOR (kind/reference/candidate -> DiscriminatorVerdict) to the
 *  SemanticJudge shape evaluateBuildFunctionalGate calls. The gate always passes `functional`, so
 *  we route to the discriminator on that kind; the classification then drives the pass/fail. */
function discriminatorJudge(): SemanticJudge {
  const disc = makeBuildDiscriminatorJudge({ cwd: KIT });
  return ({ reference, candidate, functional }) =>
    disc({ kind: (functional ?? "code") as BuildOutputKind, reference, candidate });
}

describe.skipIf(!cloudReady || !hostResolvable)("GATED LIVE: the driver's product code is FUNCTIONALLY equivalent to the pin (discriminator vs recorded-build)", () => {
  it("runs the live driver GREEN, then judges app/ against the pin's F6/S3 recorded code (classification-driven)", () =>
    runDriverGreenLive({
      afterGreen: async ({ projectDir, featureId, storyIndex }) => {
        const outcome = await evaluateBuildFunctionalGate({
          kitRoot: KIT,
          projectDir,
          featureId,
          storyIndex,
          role: "driver",
          judge: discriminatorJudge(),
        });
        // eslint-disable-next-line no-console
        console.log(
          `[driver-code-equivalence] ${featureId}#${storyIndex}: ${outcome.skipped ? "SKIPPED (no pinned reference)" : outcome.passed ? `PASSED (classification=${outcome.classification ?? "n/a"}, nextStep=${outcome.nextStep ?? "n/a"}, score ${outcome.score?.toFixed(2) ?? "n/a"})` : `FAILED – ${outcome.reason}`}`,
        );
        // Assert here (inside the hook, before teardown) via a thrown error – the caller's finally
        // still tears down the project even if this fails, so no Lakebase leak.
        if (!outcome.passed) {
          throw new Error(`driver code not functionally equivalent to the pin: ${outcome.reason ?? `classification ${outcome.classification}`}`);
        }
      },
    }), 1_800_000);
});
