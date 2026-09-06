// Stage G (#645) prompt-parity gate – the A-full core proof for the assess turn: the executor-
// assembled prompt (base task body with the green-failure-advisory OMITTED, then phase 2.5 PREPENDS
// the advisory back) is BYTE-IDENTICAL to the legacy inline assess task (advisory + directive built
// as one string). This is what lets the assess turn move onto the formal precondition face without
// changing a byte of what the Navigator sees.
//
// The assertion works at the pure-function level (no spawn, no cloud): buildTaskBody(assess, cfg, ∅)
// is the LEGACY inline body (advisory + directive); buildTaskBody(assess, cfg, {green-failure-advisory})
// is the executor's BASE body (directive only); resolvePreparer("green-failure-advisory") projects
// the advisory. So [advisory-block] + [base body] must equal [full inline body] – the exact
// prepend-position composition phase 2.5 performs.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskBody, type DriveEffectsConfig } from "../../consort/orchestrator/drive/orchestrator-effects";
import { resolvePreparer } from "../../consort/orchestrator/build/preconditions";
import { writeGreenFailure } from "../../consort/smells/supersession";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

const FEATURE = "F1-stock-visibility";
const STORY = "S1-record-stock";
const AC = "AC1-record-stock";

function cfg(consortDir: string): DriveEffectsConfig {
  return {
    projectDir: join(consortDir, ".."),
    consortDir,
    featureId: FEATURE,
    runner: { async run() {} },
    modelForRole: () => "sonnet",
    approver: "human-proxy",
    deployTarget: "local",
  };
}

// The narrowed invoke-role shape buildTaskBody expects (not the wide WorkflowAction union).
const ASSESS = { kind: "invoke-role", role: "navigator", story: STORY, buildMode: "assess", ac: AC } as Extract<WorkflowAction, { kind: "invoke-role" }>;

describe("assess executor prompt parity (Stage G): advisory prepend + omitted body === legacy inline body", () => {
  it("with a seeded green-failure marker: [advisory] + [base body] byte-equals the full inline body", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "assess-parity-"));
    const consortDir = join(projectDir, ".consort");
    mkdirSync(consortDir, { recursive: true });
    try {
      // Seed a green-failure marker with all three advisory sub-blocks so the advisory is non-empty.
      writeGreenFailure(consortDir, FEATURE, STORY, AC, {
        version: 1,
        failureOutput: "FAILED tests/test_x.py::test_a - AssertionError",
        contractRefs: "app/models/sku.py:42 references dropped column `legacy_code`",
        supersededTestRefs: "tests/test_old.py::test_legacy asserts `legacy_code`",
      } as never);
      const c = cfg(consortDir);

      // LEGACY: the full inline body (advisory inline-prepended by roleTaskBody's assess branch).
      const legacyInline = buildTaskBody(ASSESS, c);
      // EXECUTOR: the base body with the advisory OMITTED (phase 2.5 re-injects it).
      const executorBase = buildTaskBody(ASSESS, c, new Set(["green-failure-advisory"]));
      // The advisory block phase 2.5 PREPENDS (the same preparer roleTaskBody used inline).
      const advisory = resolvePreparer("green-failure-advisory")({ consortDir, featureId: FEATURE, story: STORY, ac: AC });

      // The advisory is non-empty (all three sub-blocks seeded).
      expect(advisory.length).toBeGreaterThan(0);
      // The base body must NOT contain the advisory (it was omitted).
      expect(executorBase.startsWith(advisory)).toBe(false);
      // PREPEND composition === legacy inline. This is exactly what phase 2.5 does (prepend position).
      expect(advisory + executorBase).toBe(legacyInline);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refactor (Stage H): [base body] + [context-pack] byte-equals the legacy inline body (APPEND position)", () => {
    // The refactor turn APPENDS the context pack (a clean suffix). On the executor path the pack is
    // a declared APPEND precondition; the base body omits it and phase 2.5 re-appends it. So
    // [base body] + [pack] must equal the legacy inline body – the append-position composition.
    const projectDir = mkdtempSync(join(tmpdir(), "refactor-parity-"));
    const consortDir = join(projectDir, ".consort");
    mkdirSync(consortDir, { recursive: true });
    try {
      const c = cfg(consortDir);
      const refactor = { kind: "invoke-role", role: "driver", story: STORY, buildMode: "refactor" } as Extract<WorkflowAction, { kind: "invoke-role" }>;
      const legacyInline = buildTaskBody(refactor, c);
      const executorBase = buildTaskBody(refactor, c, new Set(["context-pack"]));
      const pack = resolvePreparer("context-pack")({ consortDir, featureId: FEATURE, story: STORY, ac: "" });
      // APPEND: base body then the pack === legacy inline (the pack sits at the end of the directive).
      expect(executorBase + pack).toBe(legacyInline);
      // The base body does NOT already end with the pack (it was omitted).
      expect(executorBase.endsWith(pack) && pack.length > 0).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("with NO marker: advisory is empty and the base body already equals the legacy inline body", () => {
    // No green-failure.json => the advisory projects "" (best-effort degrade). The omitted body and
    // the full inline body are then identical (nothing to omit), so the executor prompt is unchanged.
    const projectDir = mkdtempSync(join(tmpdir(), "assess-parity-"));
    const consortDir = join(projectDir, ".consort");
    mkdirSync(consortDir, { recursive: true });
    try {
      const c = cfg(consortDir);
      const legacyInline = buildTaskBody(ASSESS, c);
      const executorBase = buildTaskBody(ASSESS, c, new Set(["green-failure-advisory"]));
      const advisory = resolvePreparer("green-failure-advisory")({ consortDir, featureId: FEATURE, story: STORY, ac: AC });
      expect(advisory).toBe("");
      expect(executorBase).toBe(legacyInline);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
