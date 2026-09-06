// /design intake precondition: product-overview.md + nfrs.md (project) +
// feature-request.md (per-feature) + design-brief.md (UI) must exist and
// conform before /design enters phase 1. This is what makes intake
// un-skippable in real and headless runs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIntakePreconditions } from "../../consort/intake/intake";

const PRODUCT_OVERVIEW = "# Product\n\nWho it is for and what they need to accomplish.\n";
const NFRS = [
  "# NFRs",
  "## Required",
  "- R1: audited",
  "## Preferences",
  "- logs",
  "## Out of bounds",
  "- no auth",
  "",
].join("\n");
const FEATURE_REQUEST = "# v1\n\nA team needs to file bugs and find them later, in their own words.\n";
const DESIGN_BRIEF = "# Design brief\n\n## References\n- partner-asset-tracker for layout + tone\n";

let proj: string;
let tdd: string;
const FEATURE = "F1-x";

// The project's `.sftdd` artifact root lives under a project dir that also holds
// `.lakebase/sftdd-config.json` (the single source of `uiTrack`), so intake reads
// UI-ness the same way it does in a real scaffolded project.
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "intake-"));
  tdd = join(proj, ".sftdd");
  mkdirSync(join(tdd, "features", FEATURE), { recursive: true });
});
afterEach(() => rmSync(proj, { recursive: true, force: true }));

/** Mark the project a UI project via its single source (config.project.uiTrack). */
const markUiProject = (): void => {
  mkdirSync(join(proj, ".lakebase"), { recursive: true });
  writeFileSync(
    join(proj, ".lakebase", "sftdd-config.json"),
    JSON.stringify({ version: 1, project: { uiTrack: true } }),
  );
};

/** Mark the project a NON-UI project explicitly (uiTrack defaults ON, so a no-frontend
 *  project must opt out via its config – the single source). */
const markNonUiProject = (): void => {
  mkdirSync(join(proj, ".lakebase"), { recursive: true });
  writeFileSync(
    join(proj, ".lakebase", "sftdd-config.json"),
    JSON.stringify({ version: 1, project: { uiTrack: false } }),
  );
};

describe("checkIntakePreconditions", () => {
  it("fails when product-overview.md + nfrs.md are absent", () => {
    markNonUiProject(); // isolate the project-doc preconditions from the UI (design-brief) one
    const r = checkIntakePreconditions({ consortDir: tdd });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["product-overview.md", "nfrs.md"]);
  });

  it("passes with conformant product-overview.md + nfrs.md (no feature, no UI)", () => {
    markNonUiProject();
    writeFileSync(join(tdd, "product-overview.md"), PRODUCT_OVERVIEW);
    writeFileSync(join(tdd, "nfrs.md"), NFRS);
    expect(checkIntakePreconditions({ consortDir: tdd }).ok).toBe(true);
  });

  it("flags a present-but-non-conformant nfrs.md", () => {
    writeFileSync(join(tdd, "product-overview.md"), PRODUCT_OVERVIEW);
    writeFileSync(join(tdd, "nfrs.md"), "# NFRs\n\nprose only, no required sections\n");
    const r = checkIntakePreconditions({ consortDir: tdd });
    expect(r.ok).toBe(false);
    expect(r.nonConformant).toContain("nfrs.md");
  });

  it("requires the feature's feature-request.md when a featureId is given", () => {
    markNonUiProject(); // isolate the feature-request precondition from the UI (design-brief) one
    writeFileSync(join(tdd, "product-overview.md"), PRODUCT_OVERVIEW);
    writeFileSync(join(tdd, "nfrs.md"), NFRS);
    const missing = checkIntakePreconditions({ consortDir: tdd, featureId: FEATURE });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain("feature-request.md");

    writeFileSync(join(tdd, "features", FEATURE, "feature-request.md"), FEATURE_REQUEST);
    expect(checkIntakePreconditions({ consortDir: tdd, featureId: FEATURE }).ok).toBe(true);
  });

  it("requires design-brief.md only for UI projects (read from config.uiTrack, the single source)", () => {
    writeFileSync(join(tdd, "product-overview.md"), PRODUCT_OVERVIEW);
    writeFileSync(join(tdd, "nfrs.md"), NFRS);
    markNonUiProject(); // uiTrack defaults ON, so a no-UI project must opt out explicitly
    expect(checkIntakePreconditions({ consortDir: tdd }).ok).toBe(true); // non-UI: design-brief not required

    markUiProject(); // project.uiTrack = true in sftdd-config.json
    const uiMissing = checkIntakePreconditions({ consortDir: tdd });
    expect(uiMissing.ok).toBe(false);
    expect(uiMissing.missing).toContain("design-brief.md");

    mkdirSync(join(tdd, "design"), { recursive: true });
    writeFileSync(join(tdd, "design", "design-brief.md"), DESIGN_BRIEF);
    expect(checkIntakePreconditions({ consortDir: tdd }).ok).toBe(true);
  });
});
