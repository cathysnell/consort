// Cross-feature test SUPERSESSION: the Navigator flags PRIOR tests a new AC
// supersedes; the Driver's GREEN turn may then permissively refactor ONLY those.
// These pin the allowlist store + its one-attempt bound + the smell taxonomy so
// the honest-GREEN backstop stays intact for genuine (unflagged) regressions.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readSupersededTests,
  writeSupersededTests,
  hasPendingSupersession,
  markSupersessionRefactored,
  supersededTestsJson,
  writeGreenFailure,
  readGreenFailure,
  readRegressionAssessment,
  writeRegressionAssessment,
  hasPendingRegressionFix,
  markRegressionFixAttempted,
  composeAssessedGreenFailure,
  hasPendingSpecDefect,
  specDefectFromRole,
  MAX_REGRESSION_FIX_ATTEMPTS,
} from "../../consort/smells/supersession.js";
import { isBuildRefactorRoutableSmell, SMELL_CATALOG } from "../../consort/smells/smells.js";
import { cycleDir } from "../../consort/config/consort-paths.js";

let tdd: string;
const F = "F5-review-submissions";
const S = "S1-hold-submissions-out";
const AC = "AC1-submitted-absent-from-home";

beforeEach(() => {
  tdd = fs.mkdtempSync(path.join(os.tmpdir(), "supersession-"));
});
afterEach(() => {
  fs.rmSync(tdd, { recursive: true, force: true });
});

describe("supersession allowlist store", () => {
  it("round-trips a written allowlist", () => {
    writeSupersededTests(tdd, F, S, AC, {
      tests: ["tests/e2e/test_S1_browse_recipes.py"],
      reason: "submissions default to held-for-review; browse seeds must be approved",
    });
    const got = readSupersededTests(tdd, F, S, AC);
    expect(got?.tests).toEqual(["tests/e2e/test_S1_browse_recipes.py"]);
    expect(got?.reason).toMatch(/held-for-review/);
    // It lands in the per-AC cycle dir.
    expect(fs.existsSync(supersededTestsJson(tdd, F, S, AC))).toBe(true);
  });

  it("returns undefined when absent, empty, or malformed", () => {
    expect(readSupersededTests(tdd, F, S, AC)).toBeUndefined();
    writeSupersededTests(tdd, F, S, AC, { tests: [], reason: "x" });
    expect(readSupersededTests(tdd, F, S, AC)).toBeUndefined(); // empty list => no allowlist
    fs.writeFileSync(supersededTestsJson(tdd, F, S, AC), "{ not json");
    expect(readSupersededTests(tdd, F, S, AC)).toBeUndefined();
  });

  // Regression (S2 down-migration HIL halt): an assess turn that HAND-WROTE
  // superseded-tests.json (bypassing the flag-superseded CLI) named the array
  // `superseded_tests` — the human-readable/regression-assessment key — instead
  // of the canonical `tests`. The reader only accepted `tests`, so it read the
  // file as undefined → hasPendingSupersession=false → a FULLY-superseded verify
  // failure wrongly escalated to the HIL as a "genuine regression" (the verdict
  // itself said "all superseded, no regression"). The reader must tolerate the
  // alias, like readRegressionAssessment tolerates fix/fixDirective.
  it("tolerates the `superseded_tests` alias a hand-written verdict uses (routes to refactor, not HIL)", () => {
    fs.mkdirSync(cycleDir(tdd, F, S, AC), { recursive: true });
    fs.writeFileSync(
      supersededTestsJson(tdd, F, S, AC),
      JSON.stringify({
        feature: F,
        story: S,
        ac: AC,
        reason: "S2 down-migration reverses the S1 shape; these tests encode the abandoned schema",
        superseded_tests: ["tests/architecture/test_migration_F6.py::test_col_present", "tests/step_defs/test_S1_up.py"],
      }),
    );
    const got = readSupersededTests(tdd, F, S, AC);
    // Normalized onto the canonical `tests` field.
    expect(got?.tests).toEqual(["tests/architecture/test_migration_F6.py::test_col_present", "tests/step_defs/test_S1_up.py"]);
    // And it is PENDING -> the honest-GREEN backstop routes a permissive refactor, NOT a HIL escalation.
    expect(hasPendingSupersession(tdd, F, S, AC)).toBe(true);
  });

  // Regression (class-n: navigator wrote the supersession verdict into the WRONG
  // FILE). On a hard down-migration the navigator concluded supersession but wrote
  // {superseded:true, tests:[...], reason} into regression-assessment.json
  // (conflating the two assess artifacts) and never wrote superseded-tests.json.
  // readSupersededTests found nothing -> hasPendingSupersession=false -> the drive
  // escalated "genuine regression, no superseded tests flagged" to HIL, though the
  // verdict said superseded:true. The reader must honor a superseded:true payload
  // wherever the agent put it.
  it("honors a supersession verdict written into regression-assessment.json (superseded:true + tests)", () => {
    const dir = cycleDir(tdd, F, S, AC);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "regression-assessment.json"),
      JSON.stringify({
        superseded: true,
        tests: ["tests/step_defs/test_S1_file_stock.py", "tests/features/S1-file-stock.feature"],
        reason: "S2 AC1 drops batch_number/serial_number; the T16 round-trip encodes the abandoned shape",
      }),
    );
    const got = readSupersededTests(tdd, F, S, AC);
    expect(got?.tests).toEqual(["tests/step_defs/test_S1_file_stock.py", "tests/features/S1-file-stock.feature"]);
    expect(hasPendingSupersession(tdd, F, S, AC)).toBe(true);
    // A regression-assessment.json WITHOUT superseded:true must NOT be read as supersession.
    fs.writeFileSync(
      path.join(dir, "regression-assessment.json"),
      JSON.stringify({ diagnosis: "a genuine bug", fixDirective: "fix the default" }),
    );
    expect(readSupersededTests(tdd, F, S, AC)).toBeUndefined();
  });

  it("is pending until refactored (bounds the self-heal to one attempt)", () => {
    expect(hasPendingSupersession(tdd, F, S, AC)).toBe(false); // none yet
    writeSupersededTests(tdd, F, S, AC, { tests: ["t.py"], reason: "r" });
    expect(hasPendingSupersession(tdd, F, S, AC)).toBe(true);
    markSupersessionRefactored(tdd, F, S, AC);
    // Allowlist still readable (audit), but no longer PENDING -> a second
    // verify failure escalates as a genuine regression.
    expect(readSupersededTests(tdd, F, S, AC)?.refactored).toBe(true);
    expect(hasPendingSupersession(tdd, F, S, AC)).toBe(false);
  });
});

describe("superseded-tests smell taxonomy", () => {
  it("is build-refactor-routable (self-heals in-loop, does not hard-halt)", () => {
    expect(isBuildRefactorRoutableSmell("superseded-tests")).toBe(true);
  });
  it("has a catalog entry distinguishing it from test-list-drift", () => {
    const entry = SMELL_CATALOG.find((s) => s.name === "superseded-tests");
    expect(entry).toBeTruthy();
    expect(entry?.level).toBe("build");
    expect(entry?.description).toMatch(/supersed/i);
  });
});

// ── Navigator->Driver regression-diagnosis handoff ───────────────────────────
// The genuine-regression counterpart of supersession: the Navigator records a
// root-cause diagnosis (and, when driver-fixable, a repair directive) so it
// reaches the Driver / the human instead of being lost to a generic "verify
// FAILED". These pin the store + the one-attempt bound.
describe("regression assessment + driver-fix handoff", () => {
  it("records the Navigator's diagnosis + fix directive (regression-assessment.json)", () => {
    writeRegressionAssessment(tdd, F, S, AC, { diagnosis: "review_state model default is 'submitted'", fixDirective: "default it to 'approved'" });
    const r = readRegressionAssessment(tdd, F, S, AC);
    expect(r?.diagnosis).toMatch(/review_state/);
    expect(r?.fixDirective).toMatch(/approved/);
  });

  it("ignores a diagnosis-less assessment (empty diagnosis => undefined)", () => {
    writeRegressionAssessment(tdd, F, S, AC, { diagnosis: "" });
    expect(readRegressionAssessment(tdd, F, S, AC)).toBeUndefined();
  });

  // TOLERANT READ regression guard. Three live captures halted because the
  // navigator produced a correct driver-fixable verdict but did not persist it
  // via the assess-regression CLI (flaky shell-escaping), so a fixable regression
  // wrongly escalated to HIL. The reader now ALSO honors the agent's natural
  // hand-written form so a reliable Write tool records the verdict.
  it("honors the `fix` key alias in the canonical file (agent-natural key name)", () => {
    const dir = cycleDir(tdd, F, S, AC);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "regression-assessment.json"),
      JSON.stringify({ diagnosis: "downgrade drops the table", fix: "rename_table instead of drop_table" }),
    );
    const r = readRegressionAssessment(tdd, F, S, AC);
    expect(r?.diagnosis).toMatch(/downgrade/);
    expect(r?.fixDirective).toMatch(/rename_table/); // `fix` mapped to fixDirective => routes a repair
  });

  it("honors the agent-natural filename `assess-regression.json` (mirrors the CLI verb)", () => {
    const dir = cycleDir(tdd, F, S, AC);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "assess-regression.json"),
      JSON.stringify({ diagnosis: "wrong default", fix: "default it to approved" }),
    );
    const r = readRegressionAssessment(tdd, F, S, AC);
    expect(r?.diagnosis).toMatch(/wrong default/);
    expect(r?.fixDirective).toMatch(/approved/);
  });

  it("prefers the canonical file + fixDirective when both files/keys are present", () => {
    const dir = cycleDir(tdd, F, S, AC);
    fs.mkdirSync(dir, { recursive: true });
    // canonical wins over the alternate filename
    writeRegressionAssessment(tdd, F, S, AC, { diagnosis: "canonical", fixDirective: "canonical fix" });
    fs.writeFileSync(path.join(dir, "assess-regression.json"), JSON.stringify({ diagnosis: "alt", fix: "alt fix" }));
    const r = readRegressionAssessment(tdd, F, S, AC);
    expect(r?.diagnosis).toBe("canonical");
    expect(r?.fixDirective).toBe("canonical fix");
  });

  it("hasPendingRegressionFix is true only for an ASSESSED green-failure carrying a fixDirective, not yet repaired", () => {
    // not assessed yet -> not pending
    writeGreenFailure(tdd, F, S, AC, { assessed: false, summary: "x", fixDirective: "do y" });
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(false);
    // assessed + fixDirective -> pending (routes the Driver repair)
    writeGreenFailure(tdd, F, S, AC, { assessed: true, summary: "x", diagnosis: "why", fixDirective: "do y" });
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(true);
    // assessed but NO fixDirective (not driver-fixable) -> not pending (escalates instead)
    writeGreenFailure(tdd, F, S, AC, { assessed: true, summary: "x", diagnosis: "why" });
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(false);
  });

  it("hasPendingSpecDefect is true only for an ASSESSED spec-defect; carries the re-author scope", () => {
    // A spec-defect assessment: the test/NFR is wrong (not the code). No fixDirective, no supersession.
    // not assessed yet -> not pending
    writeGreenFailure(tdd, F, S, AC, { assessed: false, summary: "x", specDefect: { fromRole: "test-strategist", reason: "flaky p95" } });
    expect(hasPendingSpecDefect(tdd, F, S, AC)).toBe(false);
    // assessed + specDefect -> pending (routes the raise-to-hil design-lane reopen)
    writeGreenFailure(tdd, F, S, AC, { assessed: true, summary: "x", specDefect: { fromRole: "test-strategist", reason: "p95 measures cold remote round-trips" } });
    expect(hasPendingSpecDefect(tdd, F, S, AC)).toBe(true);
    // it is NOT a driver-fixable regression (no fixDirective) — so repair is NOT routed
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(false);
    // the recommended re-author scope is surfaced (defaults to the test-strategist when unset)
    expect(specDefectFromRole(tdd, F, S, AC)).toBe("test-strategist");
    // composeAssessedGreenFailure carries specDefect through, preserving fixAttempts
    const composed = composeAssessedGreenFailure({ assessed: false, summary: "x", fixAttempts: 2 }, { specDefect: { fromRole: "architect-reviewer" } });
    expect(composed.assessed).toBe(true);
    expect(composed.specDefect).toEqual({ fromRole: "architect-reviewer" });
    expect(composed.fixAttempts).toBe(2);
  });

  it("readRegressionAssessment parses a spec-defect — the CLI object form AND the agent-natural classification hand-write", () => {
    // Canonical object form (what `assess-regression --spec-defect --from` writes).
    writeRegressionAssessment(tdd, F, S, AC, { diagnosis: "p95 bar measures cold remote round-trips", specDefect: { fromRole: "test-strategist", reason: "no headroom" } });
    const a = readRegressionAssessment(tdd, F, S, AC);
    expect(a?.specDefect?.fromRole).toBe("test-strategist");
    expect(a?.fixDirective).toBeUndefined(); // a spec-defect is NOT driver-fixable
    // Agent-natural hand-write (flaky at CLIs, reliable with the Write tool): classification + fromRole.
    fs.writeFileSync(path.join(cycleDir(tdd, F, S, AC), "regression-assessment.json"), JSON.stringify({ diagnosis: "flaky latency test", classification: "spec-defect", fromRole: "architect-reviewer" }));
    const b = readRegressionAssessment(tdd, F, S, AC);
    expect(b?.specDefect?.fromRole).toBe("architect-reviewer");
  });

  it("markRegressionFixAttempted consumes the one repair (pending -> not pending)", () => {
    writeGreenFailure(tdd, F, S, AC, { assessed: true, summary: "x", diagnosis: "why", fixDirective: "do y" });
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(true);
    markRegressionFixAttempted(tdd, F, S, AC);
    expect(hasPendingRegressionFix(tdd, F, S, AC)).toBe(false);
    expect(readGreenFailure(tdd, F, S, AC)?.repairAttempted).toBe(true);
    // diagnosis + directive are preserved (the escalation still carries the WHY)
    expect(readGreenFailure(tdd, F, S, AC)?.diagnosis).toBe("why");
  });
});

describe("composeAssessedGreenFailure preserves the self-heal counter across the assess turn", () => {
  it("carries fixAttempts (so the refactor-until-clean cap actually accumulates)", () => {
    const prior = { assessed: false, summary: "verify FAILED", fixAttempts: 2 };
    const out = composeAssessedGreenFailure(prior, { diagnosis: "orphan file", fixDirective: "git rm app/models.py" });
    expect(out.assessed).toBe(true);
    expect(out.fixAttempts).toBe(2); // NOT reset – the bug that made the loop unbounded
    expect(out.summary).toBe("verify FAILED");
    expect(out.diagnosis).toBe("orphan file");
    expect(out.fixDirective).toBe("git rm app/models.py");
  });
  it("across a full round-trip the counter reaches the cap and then exhausts", () => {
    // Simulate rounds: each round = assess (compose, preserving count) -> repair (increment).
    let gf = { assessed: false, summary: "x" } as ReturnType<typeof composeAssessedGreenFailure>;
    for (let round = 1; round <= MAX_REGRESSION_FIX_ATTEMPTS; round++) {
      gf = composeAssessedGreenFailure(gf, { fixDirective: "fix" });
      gf = { ...gf, fixAttempts: (gf.fixAttempts ?? 0) + 1 }; // markRegressionFixAttempted
    }
    expect(gf.fixAttempts).toBe(MAX_REGRESSION_FIX_ATTEMPTS); // reaches the cap (was stuck at 1 before the fix)
  });
  it("omits fixAttempts when the prior record had none (first assess)", () => {
    const out = composeAssessedGreenFailure({ assessed: false, summary: "x" });
    expect(out.fixAttempts).toBeUndefined();
  });
});
