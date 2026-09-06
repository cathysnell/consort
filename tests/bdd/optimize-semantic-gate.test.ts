// The SEMANTIC-similarity quality bar: a design candidate's artifact must be
// semantically comparable to the recorded reference at that step (LLM-as-judge on a
// fixed model), on TOP of the structural self-check. Hermetic: the judge is stubbed
// (no model spawned), and a tiny fake kit-root holds recorded reference artifacts so
// resolveStepReference + evaluateSemanticGate are exercised end-to-end without cloud.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateSemanticGate,
  resolveStepReference,
  readCandidateArtifact,
  parseJudgeReply,
  buildJudgePrompt,
  SEMANTIC_THRESHOLD,
  type SemanticJudge,
  // Part 2: the build-code DISCRIMINATOR (mirrors the navigator assess turn).
  buildDiscriminatorPrompt,
  parseDiscriminatorReply,
  buildRedCoverageJudgePrompt,
  evaluateNavigatorAssessAlignment,
  buildSupersessionDeltaPrompt,
  buildRegressionFidelityPrompt,
  parseRegressionFidelityReply,
  type DiscriminatorVerdict,
  // The DRIVER-TURN discriminator: directional next-step navigator determination vs recorded.
  evaluateNextStepDetermination,
  type VerdictOutput,
  type VerdictAlignmentOutcome,
} from "../../consort/evaluation/semantic-gate";

let kitRoot: string;
let consortDir: string;
let refRoot: string; // the CONSORT_REFERENCE_CORPUS override root (a temp reference corpus)
const featureId = "F1-stock-visibility";

/** Seed a recorded reference artifact under the OVERRIDE reference-corpus root. The resolver reads
 *  from the shared pin by default; a test points CONSORT_REFERENCE_CORPUS at this temp root so it
 *  can control the exact references without touching the shipped pin. */
function seedRef(rel: string, body: unknown): void {
  const p = join(refRoot, "recorded-artifacts", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
}
/** Seed the live candidate artifact under the project .sftdd. */
function seedCandidate(rel: string, body: unknown): void {
  const p = join(consortDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
}

beforeEach(() => {
  kitRoot = mkdtempSync(join(tmpdir(), "sem-kit-"));
  consortDir = mkdtempSync(join(tmpdir(), "sem-sftdd-"));
  refRoot = mkdtempSync(join(tmpdir(), "sem-ref-"));
  // Point the resolver at this temp reference corpus (a fully-configurable path override), so the
  // test controls the references without the shipped pin. Absolute path -> used as-is.
  process.env.CONSORT_REFERENCE_CORPUS = refRoot;
});
afterEach(() => {
  delete process.env.CONSORT_REFERENCE_CORPUS;
  rmSync(kitRoot, { recursive: true, force: true });
  rmSync(consortDir, { recursive: true, force: true });
  rmSync(refRoot, { recursive: true, force: true });
});

const passJudge: SemanticJudge = async () => ({ score: 0.95 });
const failJudge: SemanticJudge = async () => ({ score: 0.4, missing: ["status_badge concept", "empty_state"] });

describe("resolveStepReference: the artifact each design step resolves from the shared pin", () => {
  // Move 2: ONE pinned reference set backs every design step (no per-step corpus split). The
  // resolver reads recorded-artifacts/ under the pin, or the CONSORT_REFERENCE_CORPUS override
  // (a fully-configurable path). `ref.corpus` is now a provenance label ("stockflow"), not a
  // per-step corpus selector. These assert the right ARTIFACT PATH per step.
  it("ux -> design/design-guide.json", () => {
    seedRef("design/design-guide.json", { components: { navbar: {} } });
    const ref = resolveStepReference({ kitRoot, step: "ux", featureId });
    expect(ref?.paths[0]).toMatch(/design\/design-guide\.json$/);
  });

  it("dba -> features/<F>/db-design.json (the pin has it; no rerecord-only split anymore)", () => {
    seedRef(`features/${featureId}/db-design.json`, { tables: [] });
    const ref = resolveStepReference({ kitRoot, step: "dba", featureId });
    expect(ref?.paths[0]).toMatch(/db-design\.json$/);
  });

  it("acs -> the UNION of every recorded story's ACs (feature-aggregate, not per-slug)", () => {
    seedRef(`features/${featureId}/stories/S1-record-stock/acs/AC1.json`, { id: "AC1" });
    seedRef(`features/${featureId}/stories/S2-x/acs/AC1.json`, { id: "AC1" });
    seedRef(`features/${featureId}/stories/S2-x/acs/AC2.json`, { id: "AC2" });
    const ref = resolveStepReference({ kitRoot, step: "acs", featureId });
    expect(ref?.paths).toHaveLength(3); // union across stories
  });

  it("propose -> planning/feature-proposals.md (has a reference, not a silent skip)", () => {
    seedRef("planning/feature-proposals.md", "# Sprint 1 proposal\n- F1\n");
    const ref = resolveStepReference({ kitRoot, step: "propose", featureId });
    expect(ref?.paths[0]).toMatch(/planning\/feature-proposals\.md$/);
  });

  it("estimate -> planning/estimates.json (NOT architecture.json)", () => {
    seedRef(`features/${featureId}/architecture.json`, { feature_id: featureId });
    seedRef("planning/estimates.json", { estimates: [{ feature_id: featureId, size: "M" }] });
    const ref = resolveStepReference({ kitRoot, step: "estimate", featureId });
    expect(ref?.paths[0]).toMatch(/planning\/estimates\.json$/);
  });

  it("returns null when the reference artifact is not on disk (bar not applicable)", () => {
    expect(resolveStepReference({ kitRoot, step: "ux", featureId })).toBeNull();
  });
});

describe("readCandidateArtifact: reads the SAME artifact the reference resolves (parity)", () => {
  it("propose reads planning/feature-proposals.md from the candidate .sftdd", () => {
    seedCandidate("planning/feature-proposals.md", "# candidate proposal\n");
    expect(readCandidateArtifact({ consortDir, step: "propose", featureId })).toContain("candidate proposal");
  });

  it("estimate reads planning/estimates.json from the candidate .sftdd (not architecture.json)", () => {
    seedCandidate(`features/${featureId}/architecture.json`, { feature_id: featureId });
    seedCandidate("planning/estimates.json", { estimates: [{ feature_id: featureId, size: "L" }] });
    const body = readCandidateArtifact({ consortDir, step: "estimate", featureId });
    expect(body).toContain('"size":"L"'); // estimates.json content (compact), not architecture
    expect(body).toContain("estimates");
  });
});

describe("evaluateSemanticGate: judge decides comparability above the structural floor", () => {
  it("passes when the judge scores >= threshold", async () => {
    seedRef("design/design-guide.json", { components: { navbar: {}, table: {} } });
    seedCandidate("design/design-guide.json", { components: { navbar: {}, table: {}, extra: {} } });
    const out = await evaluateSemanticGate({ kitRoot, consortDir, featureId, step: "ux", judge: passJudge });
    expect(out.passed).toBe(true);
    expect(out.score).toBe(0.95);
  });

  it("FAILS when the judge scores below threshold, naming the dropped intent", async () => {
    seedRef("design/design-guide.json", { components: { navbar: {}, status_badge: {}, empty_state: {} } });
    seedCandidate("design/design-guide.json", { components: { navbar: {} } });
    const out = await evaluateSemanticGate({ kitRoot, consortDir, featureId, step: "ux", judge: failJudge });
    expect(out.passed).toBe(false);
    expect(out.reason).toMatch(/status_badge/);
    expect(out.reason).toMatch(/0\.40 < 0\.85/);
  });

  it("SKIPS (passes) when there is no recorded reference – structural floor stands alone", async () => {
    seedCandidate("design/design-guide.json", { components: {} });
    let judged = false;
    const spyJudge: SemanticJudge = async () => { judged = true; return { score: 1 }; };
    const out = await evaluateSemanticGate({ kitRoot, consortDir, featureId, step: "ux", judge: spyJudge });
    expect(out.skipped).toBe(true);
    expect(out.passed).toBe(true);
    expect(judged).toBe(false); // no reference => judge never called
  });

  it("FAILS when the reference exists but the candidate produced no artifact", async () => {
    seedRef("design/design-guide.json", { components: { navbar: {} } });
    const out = await evaluateSemanticGate({ kitRoot, consortDir, featureId, step: "ux", judge: passJudge });
    expect(out.passed).toBe(false);
    expect(out.reason).toMatch(/no artifact/);
  });

  it("uses the module threshold constant (0.85)", () => {
    expect(SEMANTIC_THRESHOLD).toBe(0.85);
  });
});

describe("judge prompt + reply parsing", () => {
  it("prompt asks for MEANING not wording, and demands a JSON score verdict", () => {
    const p = buildJudgePrompt("ux", "{ref}", "{cand}");
    expect(p).toMatch(/MEANING, not wording/i);
    expect(p).toMatch(/"score"/);
    expect(p).toMatch(/REFERENCE/);
    expect(p).toMatch(/CANDIDATE/);
  });

  it("parses a clean JSON verdict", () => {
    const v = parseJudgeReply('{"score": 0.9, "missing": []}');
    expect(v.score).toBe(0.9);
    expect(v.missing).toEqual([]);
  });

  it("extracts the verdict even when wrapped in prose", () => {
    const v = parseJudgeReply('Here is my assessment.\n{"score": 0.72, "missing": ["toast"]}\nDone.');
    expect(v.score).toBe(0.72);
    expect(v.missing).toEqual(["toast"]);
  });

  it("a reply with no parseable score scores 0 (a judge that cannot answer must NOT pass the candidate)", () => {
    const v = parseJudgeReply("I could not determine similarity.");
    expect(v.score).toBe(0);
  });

  it("clamps out-of-range scores to [0,1]", () => {
    expect(parseJudgeReply('{"score": 1.4}').score).toBe(1);
    expect(parseJudgeReply('{"score": -0.2}').score).toBe(0);
  });
});

// ── Part 2: the build-code DISCRIMINATOR ───────────────────────────────────────
// Unlike the flat design/functional similarity score, the discriminator mirrors what
// the navigator ASSESS turn does: it CLASSIFIES the produced code and names the NEXT
// STEP the evaluation warrants (accept / permissive-refactor-superseded / driver-repair
// / escalate). A CLEAN verdict ("equivalent"/"accept" – nothing to refactor, no
// regression) is the BEST outcome (the candidate converged cleaner than the recorded
// baseline that needed the assess->repair spiral), NEVER a miss.

describe("build discriminator: prompt asks for a classification + next step, states clean=best", () => {
  it("code prompt asks to classify + name the next step and marks a clean verdict as best", () => {
    const p = buildDiscriminatorPrompt("code", "{ref}", "{cand}");
    expect(p).toMatch(/classif/i);
    expect(p).toMatch(/next step/i);
    expect(p).toMatch(/equivalent/);
    expect(p).toMatch(/superseded-shift/);
    expect(p).toMatch(/regression/);
    expect(p).toMatch(/insufficient/);
    // The refinement: a clean/equivalent verdict is the BEST result, not a low score.
    expect(p).toMatch(/best|ideal|better than/i);
    expect(p).toMatch(/REFERENCE/);
    expect(p).toMatch(/CANDIDATE/);
  });
});

describe("parseDiscriminatorReply: classification + next step + optional diagnosis/fixDirective", () => {
  it("parses a clean equivalent/accept verdict", () => {
    const v = parseDiscriminatorReply('{"score":0.95,"classification":"equivalent","nextStep":"accept","missing":[]}');
    expect(v.classification).toBe("equivalent");
    expect(v.nextStep).toBe("accept");
    expect(v.score).toBe(0.95);
  });

  it("parses a superseded-shift verdict", () => {
    const v = parseDiscriminatorReply('{"score":0.8,"classification":"superseded-shift","nextStep":"permissive-refactor-superseded"}');
    expect(v.classification).toBe("superseded-shift");
    expect(v.nextStep).toBe("permissive-refactor-superseded");
  });

  it("parses a driver-fixable regression with a diagnosis + fixDirective", () => {
    const v = parseDiscriminatorReply('{"score":0.5,"classification":"regression","nextStep":"driver-repair-with-directive","diagnosis":"missing page","fixDirective":"create StockViewPage.tsx"}');
    expect(v.classification).toBe("regression");
    expect(v.nextStep).toBe("driver-repair-with-directive");
    expect(v.diagnosis).toMatch(/missing page/);
    expect(v.fixDirective).toMatch(/StockViewPage/);
  });

  it("an unparseable reply defaults to insufficient/escalate (fail-safe: a judge that cannot answer must NOT pass)", () => {
    const v = parseDiscriminatorReply("I cannot classify this.");
    expect(v.classification).toBe("insufficient");
    expect(v.nextStep).toBe("escalate");
  });

  it("an unknown classification string defaults to insufficient/escalate", () => {
    const v = parseDiscriminatorReply('{"score":0.9,"classification":"looks-great","nextStep":"ship-it"}');
    expect(v.classification).toBe("insufficient");
    expect(v.nextStep).toBe("escalate");
  });
});

describe("build discriminator gate: clean verdict is a PASS (best), only insufficient fails", () => {
  const oracle = (v: DiscriminatorVerdict): SemanticJudge => async () => v;
  const runGate = async (verdict: DiscriminatorVerdict) => {
    // A driver build turn (role=driver => kind=code). Seed a recorded-build ref + a
    // candidate app/ tree so the gate reaches the judge.
    seedRef(`features/${featureId}/architecture.json`, { feature_id: featureId }); // unrelated; ensure ref dir exists
    // The recorded-build reference resolves under the SAME override root the design refs do
    // (referenceCorpusRoot -> CONSORT_REFERENCE_CORPUS = refRoot), NOT the old live-corpus path.
    const rbApp = join(refRoot, "recorded-build", "features", featureId, "stories", "S1", "turns", "003-driver", "code", "app");
    mkdirSync(rbApp, { recursive: true });
    writeFileSync(join(rbApp, "models.py"), "class Stock: pass\n");
    mkdirSync(join(consortDir, "..", "app"), { recursive: true });
    writeFileSync(join(consortDir, "..", "app", "models.py"), "class Stock: pass\n");
    const { evaluateBuildFunctionalGate } = await import("../../consort/evaluation/semantic-gate");
    return evaluateBuildFunctionalGate({
      kitRoot,
      projectDir: join(consortDir, ".."),
      featureId,
      storyIndex: 0,
      role: "driver",
      judge: oracle(verdict),
    });
  };

  it("equivalent/accept => PASS (the clean, best outcome)", async () => {
    const out = await runGate({ score: 0.95, classification: "equivalent", nextStep: "accept" });
    expect(out.passed).toBe(true);
    expect(out.classification).toBe("equivalent");
    expect(out.nextStep).toBe("accept");
  });

  it("superseded-shift => PASS (viable, mirrors assess flag-superseded)", async () => {
    const out = await runGate({ score: 0.8, classification: "superseded-shift", nextStep: "permissive-refactor-superseded" });
    expect(out.passed).toBe(true);
  });

  it("regression + fixDirective => PASS (viable, driver-fixable)", async () => {
    const out = await runGate({ score: 0.6, classification: "regression", nextStep: "driver-repair-with-directive", fixDirective: "do X" });
    expect(out.passed).toBe(true);
  });

  it("insufficient/escalate => the ONLY real FAIL", async () => {
    const out = await runGate({ score: 0.2, classification: "insufficient", nextStep: "escalate" });
    expect(out.passed).toBe(false);
  });
});

describe("evaluateNavigatorAssessAlignment: navigator verdict vs the RECORDED GROUND TRUTH (delta-judged)", () => {
  // The gate no longer re-derives a verdict from raw code (a noisy cold oracle worse-grounded
  // than the navigator it judged). It compares the navigator's flagged set against the RECORDED
  // ground-truth set and asks a delta judge whether the difference is MATERIAL (a real miss /
  // over-flag) or benign (coverage-equivalent). Classification-match stays the hard gate.
  const recorded = (over: Partial<DiscriminatorVerdict>): DiscriminatorVerdict => ({
    score: 1,
    classification: "superseded-shift",
    nextStep: "permissive-refactor-superseded",
    supersededTests: ["tests/a.py", "tests/b.py", "tests/c.py"],
    ...over,
  });
  // Delta judges: one says the sets are coverage-equivalent, one says the difference is material.
  const equivalentJudge = async () => ({ equivalent: true, materialDifferences: [] });
  const materialJudge = async () => ({ equivalent: false, materialDifferences: ["navigator missed tests/core_drop.py – the actual dropped-symbol test"] });

  it("FAILS on misclassification (navigator 'superseded', ground truth 'regression') – the hard gate", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "assess-marker-"));
    writeFileSync(join(markerDir, "superseded-tests.json"), JSON.stringify({ tests: ["tests/a.py"], reason: "retired" }));
    const r = await evaluateNavigatorAssessAlignment({
      recordedVerdict: recorded({ classification: "regression", nextStep: "driver-repair-with-directive", supersededTests: undefined }),
      navigatorMarkerDir: markerDir,
      deltaJudge: equivalentJudge,
    });
    expect(r.passed).toBe(false);
    expect(r.classificationMatch).toBe(false);
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("PASSES the exact-match case WITHOUT calling the judge (identical sets are trivially equivalent)", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "assess-marker-"));
    writeFileSync(join(markerDir, "superseded-tests.json"), JSON.stringify({ tests: ["tests/a.py", "tests/b.py", "tests/c.py"], reason: "retired" }));
    let judged = false;
    const spy = async () => { judged = true; return { equivalent: false, materialDifferences: ["x"] }; };
    const r = await evaluateNavigatorAssessAlignment({ recordedVerdict: recorded({}), navigatorMarkerDir: markerDir, deltaJudge: spy });
    expect(r.passed).toBe(true);
    expect(judged).toBe(false); // identical sets short-circuit – no judge spawn needed
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("PASSES a near-match the delta judge rules COVERAGE-EQUIVALENT (benign non-determinism)", async () => {
    // The S1 case: navigator flagged a set differing by one borderline file; judge says benign.
    const markerDir = mkdtempSync(join(tmpdir(), "assess-marker-"));
    writeFileSync(join(markerDir, "superseded-tests.json"), JSON.stringify({ tests: ["tests/a.py", "tests/b.py", "tests/d.py"], reason: "retired" }));
    const r = await evaluateNavigatorAssessAlignment({ recordedVerdict: recorded({}), navigatorMarkerDir: markerDir, deltaJudge: equivalentJudge });
    expect(r.passed).toBe(true);
    expect(r.reason).toMatch(/equivalent/i);
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("FAILS when the delta judge finds a MATERIAL difference (a real miss / over-flag)", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "assess-marker-"));
    writeFileSync(join(markerDir, "superseded-tests.json"), JSON.stringify({ tests: ["tests/x.py"], reason: "retired" }));
    const r = await evaluateNavigatorAssessAlignment({ recordedVerdict: recorded({}), navigatorMarkerDir: markerDir, deltaJudge: materialJudge });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/core_drop|material/i);
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("PASSES the clean case: ground truth equivalent/accept + navigator wrote no marker (no judge needed)", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "assess-marker-"));
    let judged = false;
    const spy = async () => { judged = true; return { equivalent: false, materialDifferences: ["x"] }; };
    const r = await evaluateNavigatorAssessAlignment({
      recordedVerdict: recorded({ classification: "equivalent", nextStep: "accept", supersededTests: undefined }),
      navigatorMarkerDir: markerDir,
      deltaJudge: spy,
    });
    expect(r.passed).toBe(true);
    expect(judged).toBe(false); // non-superseded classification => classification-match is the whole gate
    rmSync(markerDir, { recursive: true, force: true });
  });
});

describe("evaluateNextStepDetermination: driver-turn discriminator = next-step navigator determination vs recorded (directional)", () => {
  // assess evaluator (driver-green / driver-repair): compare the candidate's assess marker to the recorded one.
  const writeMarker = (files: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), "nextstep-marker-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
    return dir;
  };
  const equivalentDelta = async () => ({ equivalent: true, materialDifferences: [] });
  const materialDelta = async () => ({ equivalent: false, materialDifferences: ["navigator over-flagged tests/keep.py – still-live coverage"] });
  // A verdict-alignment stub: decisionMatch true => same issue; false => different issue.
  const sameIssueJudge = async (): Promise<VerdictAlignmentOutcome> => ({ passed: false, decisionMatch: true, reason: "same issue still open" });
  const diffIssueJudge = async (): Promise<VerdictAlignmentOutcome> => ({ passed: false, decisionMatch: false, reason: "a different issue" });

  it("assess: identical superseded set => PASS (no delta judge needed)", async () => {
    const rec = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/b.py"], reason: "r" } });
    const cand = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/b.py"], reason: "r" } });
    let judged = false;
    const spy = async () => { judged = true; return { equivalent: false, materialDifferences: ["x"] }; };
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: spy, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("pass");
    expect(judged).toBe(false);
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: candidate CLEAN (equivalent) where recorded found superseded => PASS-WITH-HONORS (fewer issues, flagged)", async () => {
    const rec = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/b.py"], reason: "r" } });
    const cand = mkdtempSync(join(tmpdir(), "nextstep-empty-")); // no marker => equivalent
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("pass-with-honors");
    expect(r.betterThanRecorded).toBe(true);
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: candidate strict SUBSET (delta not equivalent) => PASS-WITH-HONORS (fewer, flagged)", async () => {
    const rec = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/b.py", "tests/c.py"], reason: "r" } });
    const cand = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/b.py"], reason: "r" } }); // ⊂
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: materialDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("pass-with-honors");
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: candidate OVER-flags (superset, material) => FAIL (more issues)", async () => {
    const rec = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py"], reason: "r" } });
    const cand = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py", "tests/keep.py"], reason: "r" } }); // ⊋
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: materialDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("fail");
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: candidate escalates to REGRESSION where recorded was superseded => FAIL (worse)", async () => {
    const rec = writeMarker({ "superseded-tests.json": { tests: ["tests/a.py"], reason: "r" } });
    const cand = writeMarker({ "regression-assessment.json": { diagnosis: "bug", fixDirective: "fix it" } });
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("fail");
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  // BOTH regression (same rung): class-match alone is not enough. A fidelity judge grades the diagnosis +
  // fixDirective CONTENT vs the recorded ground truth – the panel finding (fast candidates held the class
  // but misdiagnosed the root cause). Aligned => pass; material divergence => fail. Absent judge => legacy.
  const alignedFidelity = async () => ({ aligned: true, materialDifferences: [] });
  const materialFidelity = async () => ({ aligned: false, materialDifferences: ["blames the ORM serializer; the real bug is an empty repositories/__init__.py (import-ordering)"] });

  it("assess: both regression, fidelity judge ALIGNED => PASS", async () => {
    const rec = writeMarker({ "regression-assessment.json": { diagnosis: "repos.stock unresolved – empty __init__.py", fixDirective: "add 'from . import stock'" } });
    const cand = writeMarker({ "regression-assessment.json": { diagnosis: "same import-ordering bug, worded differently", fixDirective: "import the submodule in __init__" } });
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge, regressionJudge: alignedFidelity });
    expect(r.verdict).toBe("pass");
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: both regression, fidelity judge MATERIAL (wrong root cause) => FAIL", async () => {
    const rec = writeMarker({ "regression-assessment.json": { diagnosis: "repos.stock unresolved – empty __init__.py", fixDirective: "add 'from . import stock'" } });
    const cand = writeMarker({ "regression-assessment.json": { diagnosis: "the ORM serializer mishandles null batch_number", fixDirective: "fix StockOut.model_validate" } });
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge, regressionJudge: materialFidelity });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/diverges materially|root cause|misdirected/i);
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("assess: both regression, NO fidelity judge => PASS (legacy class-only ladder, unchanged)", async () => {
    const rec = writeMarker({ "regression-assessment.json": { diagnosis: "a", fixDirective: "b" } });
    const cand = writeMarker({ "regression-assessment.json": { diagnosis: "totally different", fixDirective: "different" } });
    const r = await evaluateNextStepDetermination({ evaluatorKind: "assess", recordedMarkerDir: rec, candidateMarkerDir: cand, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("pass"); // no regressionJudge => same rung passes (prior behavior)
    rmSync(rec, { recursive: true, force: true }); rmSync(cand, { recursive: true, force: true });
  });

  it("review (driver-refactor): candidate post-refactor review CLEAN (refactor=false) => PASS (issue resolved)", async () => {
    const directive: VerdictOutput = { refactor: true, notes: "client still uses inventory_code" };
    const candidate: VerdictOutput = { refactor: false, notes: "swapped to batch/serial; clean" };
    let judged = false;
    const spy = async () => { judged = true; return { passed: false, decisionMatch: true, reason: "x" }; };
    const r = await evaluateNextStepDetermination({ evaluatorKind: "review", recordedReviewDirective: directive, candidateReview: candidate, deltaJudge: equivalentDelta, verdictJudge: spy });
    expect(r.verdict).toBe("pass");
    expect(judged).toBe(false); // clean short-circuits, no alignment spawn
  });

  it("review (driver-refactor): candidate STILL refactor=true, same issue => FAIL (unresolved)", async () => {
    const directive: VerdictOutput = { refactor: true, notes: "client still uses inventory_code" };
    const candidate: VerdictOutput = { refactor: true, notes: "client still uses inventory_code" };
    const r = await evaluateNextStepDetermination({ evaluatorKind: "review", recordedReviewDirective: directive, candidateReview: candidate, deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/unresolved|same issue/i);
  });

  it("review (driver-refactor): candidate refactor=true for a DIFFERENT issue => FAIL (introduced/left a new problem)", async () => {
    const directive: VerdictOutput = { refactor: true, notes: "client still uses inventory_code" };
    const candidate: VerdictOutput = { refactor: true, notes: "unrelated token-class problem" };
    const r = await evaluateNextStepDetermination({ evaluatorKind: "review", recordedReviewDirective: directive, candidateReview: candidate, deltaJudge: equivalentDelta, verdictJudge: diffIssueJudge });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/different issue|new problem/i);
  });

  it("throws when an assess evaluation is missing its marker dirs (missing reference = invalid, never silent)", async () => {
    await expect(
      evaluateNextStepDetermination({ evaluatorKind: "assess", deltaJudge: equivalentDelta, verdictJudge: sameIssueJudge }),
    ).rejects.toThrow(/requires recordedMarkerDir/);
  });
});

describe("buildSupersessionDeltaPrompt: judge the DELTA between two concrete sets, not re-derive", () => {
  it("asks whether the two flagged sets are coverage-equivalent + names material differences", () => {
    const p = buildSupersessionDeltaPrompt(["tests/a.py", "tests/d.py"], ["tests/a.py", "tests/b.py"], "AC drops inventory_code");
    expect(p).toMatch(/equivalent/i);
    expect(p).toMatch(/material/i);
    expect(p).toMatch(/tests\/d\.py/); // the navigator set is IN the prompt
    expect(p).toMatch(/tests\/b\.py/); // the recorded ground-truth set is IN the prompt
    expect(p).toMatch(/"equivalent"/); // demands a JSON verdict
  });
});

describe("buildRegressionFidelityPrompt + parse: judge the ROOT CAUSE + fix, not just the class", () => {
  it("asks whether the candidate reaches the SAME root cause + a resolving fix, and demands a JSON verdict", () => {
    const p = buildRegressionFidelityPrompt(
      { diagnosis: "ORM serializer null bug", fixDirective: "fix model_validate" },
      { diagnosis: "empty repositories __init__.py", fixDirective: "import the submodule" },
      "1 failing test: T48 AttributeError",
    );
    expect(p).toMatch(/root cause/i);
    expect(p).toMatch(/misdirect/i);
    expect(p).toMatch(/model_validate/); // the candidate is IN the prompt
    expect(p).toMatch(/repositories __init__|import the submodule/); // the recorded ground truth is IN the prompt
    expect(p).toMatch(/T48/); // the failure context is IN the prompt
    expect(p).toMatch(/"aligned"/); // demands a JSON verdict
  });
  it("parses an aligned verdict; unparseable => NOT aligned (fail-safe)", () => {
    expect(parseRegressionFidelityReply('{"aligned":true,"materialDifferences":[]}').aligned).toBe(true);
    expect(parseRegressionFidelityReply('{"aligned":false,"materialDifferences":["wrong layer"]}')).toEqual({ aligned: false, materialDifferences: ["wrong layer"] });
    expect(parseRegressionFidelityReply("the model could not decide").aligned).toBe(false);
  });
});

describe("buildRedCoverageJudgePrompt: RED tests judged vs the test-list SPEC (coverage + faithfulness)", () => {
  it("asks whether every test-list item is COVERED and FAITHFULLY asserted, not matched to recorded tests", () => {
    const p = buildRedCoverageJudgePrompt('{"tests":[{"id":"T1"}]}', '[{"id":"AC1"}]', "def test_x(): ...");
    expect(p).toMatch(/coverage/i);
    expect(p).toMatch(/faithful/i);
    expect(p).toMatch(/test-list|test list/i);
    // The bar is the SPEC. The prompt should make explicit it is NOT matching recorded tests.
    expect(p).toMatch(/not against any recorded tests|not.*recorded tests/i);
    expect(p).toMatch(/"score"/);
  });
});
