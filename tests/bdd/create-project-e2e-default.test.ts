// E2E shift-left: a UI project ALWAYS wires the Playwright E2E harness so the LOCAL
// deploy-verify gate (which runs before prepare-pr -> CI) runs E2E – instead of CI being
// the first place it runs. The gap was that `enable-e2e` defaulted OFF, so a
// default-scaffolded UI project's Playwright suite went un-run until CI.

import { describe, it, expect } from "vitest";
import { resolveEnableE2e } from "../../consort/lakebase/create-project";

describe("resolveEnableE2e (UI projects always wire E2E)", () => {
  it("forces E2E ON for a React SPA project – even over an explicit --no-e2e", () => {
    expect(resolveEnableE2e({ clientFramework: "react" })).toBe(true);
    expect(resolveEnableE2e({ clientFramework: "react", enableE2e: false })).toBe(true); // "always"
    expect(resolveEnableE2e({ clientFramework: "react", enableE2e: true })).toBe(true);
  });

  it("a backend-only project honors the flag (default off / undefined)", () => {
    expect(resolveEnableE2e({ clientFramework: "none" })).toBeUndefined(); // base default = off
    expect(resolveEnableE2e({ clientFramework: "none", enableE2e: true })).toBe(true);
    expect(resolveEnableE2e({ clientFramework: "none", enableE2e: false })).toBe(false);
    expect(resolveEnableE2e({})).toBeUndefined();
  });
});
