// Coverage guard for the shared reference-asset pin (shared-eval Move 2): every design role the
// comparison judges score MUST have a resolvable reference in the SHIPPED pin
// (consort/evaluation/reference-assets/stockflow), and the build-code reference must resolve too.
// Without this, a role whose reference was never pinned would SILENTLY skip its comparison (the
// gate passes when no reference exists) – the exact hole this suite closes. The guard reads the
// REAL kit pin (no CONSORT_REFERENCE_CORPUS override), so it bites if the F1 design slice or the
// build seed is ever dropped from the pin.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveStepReference, resolveBuildReference } from "../../consort/evaluation/semantic-gate";
import type { TurnKey } from "../../consort/orchestrator/settings/project-settings";

const KIT = process.cwd();
const FEATURE = "F1-stock-visibility";

// The design steps the semantic gate compares (build turns judge via resolveBuildReference below).
const DESIGN_STEPS: TurnKey[] = ["breakdown", "propose", "acs", "architect", "estimate", "test-list", "dba", "ux"];

describe("reference-assets pin coverage: every judged role resolves a reference (no silent skip)", () => {
  beforeEach(() => {
    // The guard checks the SHIPPED pin – make sure no stray override is in effect.
    delete process.env.CONSORT_REFERENCE_CORPUS;
  });
  afterEach(() => {
    delete process.env.CONSORT_REFERENCE_CORPUS;
  });

  it.each(DESIGN_STEPS.map((s) => [s] as [TurnKey]))(
    "design step %s resolves a pinned reference artifact",
    (step) => {
      const ref = resolveStepReference({ kitRoot: KIT, step, featureId: FEATURE });
      expect(ref, `design step "${step}" has NO reference in the pin – add its F1 artifact to consort/evaluation/reference-assets/stockflow/recorded-artifacts (else its comparison silently skips)`).not.toBeNull();
      expect(ref!.paths.length).toBeGreaterThan(0);
    },
  );

  it("build code reference resolves (the driver/navigator recorded code tree)", () => {
    // storyIndex 0 = the first recorded story under the pin's recorded-build (F6, the build seed
    // feature). code = the driver's app tree.
    const ref = resolveBuildReference({ kitRoot: KIT, featureId: "F6-split-tracking-code", storyIndex: 0, kind: "code" });
    expect(ref, "no recorded-build CODE reference in the pin – the build discriminator would silently skip").not.toBeNull();
    expect(ref!.text.length).toBeGreaterThan(0);
  });

  it("build tests reference resolves (the navigator recorded tests tree)", () => {
    const ref = resolveBuildReference({ kitRoot: KIT, featureId: "F6-split-tracking-code", storyIndex: 0, kind: "tests" });
    expect(ref, "no recorded-build TESTS reference in the pin – the RED coverage judge would silently skip").not.toBeNull();
    expect(ref!.text.length).toBeGreaterThan(0);
  });
});
