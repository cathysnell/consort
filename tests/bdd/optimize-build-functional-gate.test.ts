// Build-turn Layer 2 = FUNCTIONAL similarity of the produced code/tests to stockflow's
// recorded-build counterpart (navigator writes tests, driver writes code). Looser bar
// (0.75) than design semantic (0.85), since code structure varies more. Hermetic: a
// fake recorded-build tree + a stubbed judge; no cloud, no model.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveBuildReference,
  readCandidateBuildOutput,
  evaluateBuildFunctionalGate,
  buildFunctionalJudgePrompt,
  buildOutputKind,
  FUNCTIONAL_THRESHOLD,
  type SemanticJudge,
} from "../../consort/evaluation/semantic-gate";

let kitRoot: string;
let projectDir: string;
let refRoot: string; // the CONSORT_REFERENCE_CORPUS override root (a temp reference corpus)
const featureId = "F1-stock-visibility";

/** Seed a recorded-build story's terminal turn with code/{tests,app} files, under the OVERRIDE
 *  reference corpus (resolveBuildReference reads referenceCorpusRoot = CONSORT_REFERENCE_CORPUS). */
function seedRecordedBuild(story: string, turn: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(refRoot, "recorded-build/features", featureId, "stories", story, "turns", turn, "code", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
}
/** Seed the live experiment tree's candidate output (app/ or tests/). */
function seedCandidate(rel: string, body: string): void {
  const p = join(projectDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

beforeEach(() => {
  kitRoot = mkdtempSync(join(tmpdir(), "bf-kit-"));
  projectDir = mkdtempSync(join(tmpdir(), "bf-proj-"));
  refRoot = mkdtempSync(join(tmpdir(), "bf-ref-"));
  process.env.CONSORT_REFERENCE_CORPUS = refRoot; // fully-configurable override root (absolute)
});
afterEach(() => {
  delete process.env.CONSORT_REFERENCE_CORPUS;
  rmSync(kitRoot, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(refRoot, { recursive: true, force: true });
});

const pass: SemanticJudge = async () => ({ score: 0.9 });
const fail: SemanticJudge = async () => ({ score: 0.4, missing: ["refile-updates-not-duplicates behavior"] });

describe("buildOutputKind: navigator writes tests, driver writes code", () => {
  it("maps roles to output kind", () => {
    expect(buildOutputKind("navigator")).toBe("tests");
    expect(buildOutputKind("driver")).toBe("code");
    expect(buildOutputKind("dba")).toBeUndefined();
  });
});

describe("resolveBuildReference: terminal turn, positional story, role-scoped subtree", () => {
  beforeEach(() => {
    // two recorded turns; the LAST is the terminal-good reference.
    seedRecordedBuild("S1-record-stock", "004-driver", { "tests/test_app.py": "old", "app/main.py": "old" });
    seedRecordedBuild("S1-record-stock", "005-navigator-review", {
      "tests/test_app.py": "def test_record_form_displayed(): ...",
      "app/main.py": "def create_stock(): ...",
      "app/services/stock_service.py": "class StockService: ...",
    });
  });

  it("navigator (tests) -> the terminal turn's code/tests subtree", () => {
    const ref = resolveBuildReference({ kitRoot, featureId, storyIndex: 0, kind: "tests" });
    expect(ref).not.toBeNull();
    expect(ref!.label).toMatch(/005-navigator-review\/code\/tests$/);
    expect(ref!.text).toMatch(/test_record_form_displayed/);
    expect(ref!.text).not.toMatch(/def create_stock/); // code excluded from a tests ref
  });

  it("driver (code) -> the terminal turn's code/app subtree", () => {
    const ref = resolveBuildReference({ kitRoot, featureId, storyIndex: 0, kind: "code" });
    expect(ref!.label).toMatch(/code\/app$/);
    expect(ref!.text).toMatch(/create_stock/);
    expect(ref!.text).toMatch(/StockService/);
    expect(ref!.text).not.toMatch(/test_record_form_displayed/); // tests excluded from a code ref
  });

  it("matches story POSITIONALLY (index), since slugs differ across corpora", () => {
    seedRecordedBuild("S2-stock-by-location-home", "003-navigator", { "app/routes.py": "list_stock" });
    const ref = resolveBuildReference({ kitRoot, featureId, storyIndex: 1, kind: "code" });
    expect(ref!.text).toMatch(/list_stock/);
  });

  it("returns null when no recorded-build tree exists (bar skipped)", () => {
    rmSync(join(refRoot, "recorded-build"), { recursive: true, force: true });
    expect(resolveBuildReference({ kitRoot, featureId, storyIndex: 0, kind: "tests" })).toBeNull();
  });
});

describe("evaluateBuildFunctionalGate: Layer 2 functional bar (0.75)", () => {
  beforeEach(() => {
    seedRecordedBuild("S1-record-stock", "005-navigator-review", { "app/main.py": "def create_stock(): ...", "tests/test_app.py": "def test_x(): ..." });
  });

  it("passes when the judge scores >= 0.75", async () => {
    seedCandidate("app/main.py", "def add_stock(): ...");
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: pass });
    expect(out.passed).toBe(true);
    expect(out.score).toBe(0.9);
  });

  it("FAILS below 0.75, naming the dropped functionality", async () => {
    seedCandidate("app/main.py", "def add_stock(): ...");
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: fail });
    expect(out.passed).toBe(false);
    expect(out.reason).toMatch(/refile-updates-not-duplicates/);
    expect(out.reason).toMatch(/0\.40 < 0\.75/);
  });

  it("passes the judge the FUNCTIONAL kind (not a design step)", async () => {
    seedCandidate("tests/test_app.py", "def test_y(): ...");
    let sawFunctional: string | undefined;
    const spy: SemanticJudge = async (a) => { sawFunctional = a.functional; return { score: 0.8 }; };
    await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "navigator", judge: spy });
    expect(sawFunctional).toBe("tests");
  });

  it("SKIPS (passes) when no recorded-build reference exists", async () => {
    rmSync(join(refRoot, "recorded-build"), { recursive: true, force: true });
    let judged = false;
    const spy: SemanticJudge = async () => { judged = true; return { score: 1 }; };
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: spy });
    expect(out.skipped).toBe(true);
    expect(out.passed).toBe(true);
    expect(judged).toBe(false);
  });

  it("FAILS when the candidate produced no output for its kind", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: pass });
    expect(out.passed).toBe(false);
    expect(out.reason).toMatch(/no code/);
  });

  it("SKIPS a non build-authoring role", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "dba", judge: pass });
    expect(out.skipped).toBe(true);
  });
});

describe("evaluateBuildFunctionalGate: DISCRIMINATOR path (classification-driven, clean=best)", () => {
  beforeEach(() => {
    seedRecordedBuild("S1-record-stock", "005-navigator-review", { "app/main.py": "def create_stock(): ...", "tests/test_app.py": "def test_x(): ..." });
    seedCandidate("app/main.py", "def add_stock(): ...");
  });
  const disc = (v: Awaited<ReturnType<SemanticJudge>>): SemanticJudge => async () => v;

  it("equivalent/accept => PASS (the clean, best outcome; not scored down)", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: disc({ score: 0.95, classification: "equivalent", nextStep: "accept" }) });
    expect(out.passed).toBe(true);
    expect(out.classification).toBe("equivalent");
    expect(out.nextStep).toBe("accept");
  });

  it("superseded-shift => PASS (viable routing)", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: disc({ score: 0.8, classification: "superseded-shift", nextStep: "permissive-refactor-superseded" }) });
    expect(out.passed).toBe(true);
    expect(out.classification).toBe("superseded-shift");
  });

  it("regression + fixDirective => PASS (driver-fixable), carrying the directive", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: disc({ score: 0.6, classification: "regression", nextStep: "driver-repair-with-directive", diagnosis: "missing page", fixDirective: "create StockViewPage" }) });
    expect(out.passed).toBe(true);
    expect(out.fixDirective).toMatch(/StockViewPage/);
  });

  it("insufficient/escalate => the ONLY real FAIL", async () => {
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: disc({ score: 0.2, classification: "insufficient", nextStep: "escalate" }) });
    expect(out.passed).toBe(false);
    expect(out.classification).toBe("insufficient");
  });

  it("a low SCORE does NOT fail a clean equivalent verdict (classification drives, not score)", async () => {
    // Even a modest score is a PASS when the classification is equivalent – the point of
    // the discriminator: clean convergence is the best outcome regardless of the score.
    const out = await evaluateBuildFunctionalGate({ kitRoot, projectDir, featureId, storyIndex: 0, role: "driver", judge: disc({ score: 0.5, classification: "equivalent", nextStep: "accept" }) });
    expect(out.passed).toBe(true);
  });
});

describe("buildFunctionalJudgePrompt: function not form", () => {
  it("asks for FUNCTIONAL equivalence and to ignore naming/formatting/structure", () => {
    const p = buildFunctionalJudgePrompt("code", "{ref}", "{cand}");
    expect(p).toMatch(/FUNCTIONAL/);
    expect(p).toMatch(/not form/i);
    expect(p).toMatch(/layer responsibilities/i);
    expect(p).toMatch(/"score"/);
  });

  it("uses test-coverage framing for a tests comparison", () => {
    const p = buildFunctionalJudgePrompt("tests", "{ref}", "{cand}");
    expect(p).toMatch(/same behaviors \/ acceptance criteria|assert the SAME behaviors/i);
  });

  it("FUNCTIONAL_THRESHOLD is 0.75 (looser than design 0.85)", () => {
    expect(FUNCTIONAL_THRESHOLD).toBe(0.75);
  });
});
