// optimize-role CLI arg parsing + chain-set expansion: --chains is a SET keyword (design or
// navigator) or a comma list of handles; --role is the back-compat single-chain alias;
// --concurrency caps in-flight candidates. The live run itself (runOptimizeRole) spawns real
// agents, so it is exercised by the gated live sweep, not here; this pins only the parser + expander.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, expandChains, selectDriverCandidates, expandReplicas, readCampAppDir, DRIVER_GREEN_CODE_PIN_REL, DRIVER_TURN_SPECS, concatTreeFiles, loadPreservedArtifacts, classifyReproduce, isMissingJudgeTarget, buildDriverNextStepJudge } from "../optimization/optimize-role.cli";
import { mkdtempSync, mkdirSync as mkdirSyncFs, writeFileSync as writeFileSyncFs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROLE_CHAINS } from "../../consort/optimize/role-chains";
import { BUILD_ROLE_CHAINS, BUILD_CORPUS_REL } from "../../consort/optimize/build-role-chains";
import { parseNavigatorAssessMarker, parseVerdictFile } from "../../consort/evaluation/semantic-gate";

describe("optimize-role expandChains", () => {
  it("expands the 'design' set to EVERY design role chain", () => {
    const handles = expandChains("design");
    expect(handles).toEqual(Object.keys(ROLE_CHAINS));
    expect(handles).toContain("spec-author-story");
    expect(handles).toContain("test-strategist");
    expect(handles).toContain("ux-designer");
  });

  it("expands the 'navigator' set to EVERY navigator build chain", () => {
    const handles = expandChains("navigator");
    expect(handles).toEqual(Object.keys(BUILD_ROLE_CHAINS));
    expect(handles).toContain("navigator-red");
    expect(handles).toContain("navigator-assess");
    expect(handles).toContain("navigator-review");
    expect(handles).toContain("navigator-reflect");
  });

  it("expands the 'driver' set to the driver-turn handles", () => {
    const handles = expandChains("driver");
    expect(handles).toEqual(Object.keys(DRIVER_TURN_SPECS));
    expect(handles).toEqual(["driver-green", "driver-green-s2", "driver-repair", "driver-refactor"]);
  });

  it("expands a comma list of handles, de-duping while preserving order", () => {
    expect(expandChains("dba,architect-reviewer,dba")).toEqual(["dba", "architect-reviewer"]);
  });

  it("throws loud on an unknown handle, listing sets + known handles", () => {
    expect(() => expandChains("no-such-chain")).toThrow(/unknown chain.*design/i);
  });

  it("throws when the spec expands to nothing", () => {
    expect(() => expandChains(",")).toThrow(/expanded to nothing/i);
  });
});

describe("optimize-role parseArgs", () => {
  it("parses --chains <set> + optional --base-model / --telemetry-dir / --concurrency", () => {
    const a = parseArgs(["--chains", "design", "--base-model", "opus", "--telemetry-dir", "/tmp/x", "--concurrency", "4"]);
    expect(a.chains).toEqual(Object.keys(ROLE_CHAINS));
    expect(a.baseModel).toBe("opus");
    expect(a.telemetryDir).toBe("/tmp/x");
    expect(a.concurrency).toBe(4);
  });

  it("parses --chains as a comma list of handles", () => {
    expect(parseArgs(["--chains", "dba,test-strategist"]).chains).toEqual(["dba", "test-strategist"]);
  });

  it("back-compat: --role <handle> resolves to a single-chain list", () => {
    expect(parseArgs(["--role", "dba"]).chains).toEqual(["dba"]);
  });

  it("defaults base-model + telemetry-dir + concurrency + candidates to absent (the runner fills them)", () => {
    const a = parseArgs(["--chains", "dba"]);
    expect(a.baseModel).toBeUndefined();
    expect(a.telemetryDir).toBeUndefined();
    expect(a.concurrency).toBeUndefined();
    expect(a.candidates).toBeUndefined();
  });

  it("parses --candidates as a trimmed comma list (the driver-green resume subset)", () => {
    const a = parseArgs(["--chains", "driver-green", "--candidates", "m-haiku-e-low, m-opus-e-low ,scan-tight"]);
    expect(a.candidates).toEqual(["m-haiku-e-low", "m-opus-e-low", "scan-tight"]);
  });

  it("clamps --concurrency to >= 1", () => {
    expect(parseArgs(["--chains", "dba", "--concurrency", "0"]).concurrency).toBe(1);
    expect(parseArgs(["--chains", "dba", "--concurrency", "-3"]).concurrency).toBe(1);
  });

  it("throws loud when neither --chains nor --role is given", () => {
    expect(() => parseArgs([])).toThrow(/--chains .* is required|--role/i);
  });

  it("throws loud on an unknown chain, listing the known ones", () => {
    expect(() => parseArgs(["--chains", "no-such-role"])).toThrow(/unknown chain.*test-strategist/i);
  });
});

describe("selectDriverCandidates (driver-green resume subset)", () => {
  const all = [{ id: "baseline" }, { id: "m-haiku" }, { id: "e-low" }, { id: "scan-tight" }];

  it("returns ALL candidates when no subset is given", () => {
    expect(selectDriverCandidates(all)).toEqual(all);
    expect(selectDriverCandidates(all, [])).toEqual(all);
  });

  it("filters to the named subset, preserving canonical order", () => {
    expect(selectDriverCandidates(all, ["scan-tight", "m-haiku"]).map((c) => c.id)).toEqual(["m-haiku", "scan-tight"]);
  });

  it("throws loud on an unknown candidate id BEFORE any scaffold (a resume typo must fail fast)", () => {
    expect(() => selectDriverCandidates(all, ["m-haiku", "m-nope"])).toThrow(/unknown driver-green candidate\(s\): m-nope.*Known:.*baseline/i);
  });
});

describe("expandReplicas (--replicas N: run one lever N times in parallel to measure variance)", () => {
  it("N<=1 leaves the set unchanged", () => {
    const cs = [{ id: "ctx-test-elow", levers: { effort: "low" } }];
    expect(expandReplicas(cs)).toEqual(cs);
    expect(expandReplicas(cs, 1)).toEqual(cs);
  });
  it("replicates each candidate into <id>-r1..-rN with the SAME levers + unique ids", () => {
    const out = expandReplicas([{ id: "ctx-test-elow", levers: { ctxPack: ["failing-test"], effort: "low" } }], 3);
    expect(out.map((c) => c.id)).toEqual(["ctx-test-elow-r1", "ctx-test-elow-r2", "ctx-test-elow-r3"]);
    expect(out.every((c) => JSON.stringify(c.levers) === JSON.stringify({ ctxPack: ["failing-test"], effort: "low" }))).toBe(true);
    expect(new Set(out.map((c) => c.id)).size).toBe(3); // unique => distinct deterministic ports
  });
  it("parseArgs reads --replicas (clamped >= 1)", () => {
    expect(parseArgs(["--role", "driver-green-s2", "--replicas", "3"]).replicas).toBe(3);
    expect(parseArgs(["--role", "driver-green-s2", "--replicas", "0"]).replicas).toBe(1);
    expect(parseArgs(["--role", "driver-green-s2"]).replicas).toBeUndefined();
  });
});

describe("driver-green code reference resolves (regression: dir-vs-file EISDIR)", () => {
  // The 003-driver code pin is a DIRECTORY (a tree of .py files), not a single file. The live sweep
  // once did readFileSync on it -> EISDIR at setup, dying before any scaffold. readCampAppDir must read
  // the whole dir + concatenate its .py contents (the SAME shape the judge builds from the candidate's
  // produced app/). This hermetic guard asserts the real camp reference resolves to non-empty text, so
  // the mistake can never reach a live launch again.
  it("reads the driver-green code pin (a directory) into non-empty concatenated .py text", () => {
    const text = readCampAppDir(DRIVER_GREEN_CODE_PIN_REL, "driver-green code pin");
    expect(text.trim().length).toBeGreaterThan(0);
    // it is the recorded app/ – models.py's split columns are the load-bearing content the judge scores.
    expect(text).toMatch(/models\.py|class |def /);
  });

  it("throws loud when the reference directory is absent (missing ref = invalid evaluation, never a silent skip)", () => {
    expect(() => readCampAppDir("recorded-build/does/not/exist/app", "nope")).toThrow(/MISSING recorded reference.*mandatory/i);
  });
});

describe("driver-turn next-step references resolve (the CONTAINED navigator determinations)", () => {
  // Every driver handle (green/repair/refactor) is judged by its next-step navigator determination vs a
  // CONTAINED recorded reference (copied into next-step/<handle>/, corpus assumed deleted). This guard
  // asserts each reference dir exists + PARSES to the expected determination shape, so a missing/broken
  // reference can never reach the gated live sweep (the mandatory-judge invariant: no ref => invalid).
  it("each driver handle's contained reference exists + parses to a real determination", () => {
    for (const [handle, spec] of Object.entries(DRIVER_TURN_SPECS)) {
      const refDir = join(process.cwd(), BUILD_CORPUS_REL, spec.refRel);
      expect(existsSync(refDir), `${handle}: contained ref dir ${refDir} must exist`).toBe(true);
      if (spec.evaluatorKind === "assess") {
        // assess ref parses to a non-equivalent determination (superseded-shift or regression), i.e. the
        // recorded navigator actually found issues – the thing the candidate is compared directionally to.
        const v = parseNavigatorAssessMarker(refDir);
        expect(["superseded-shift", "regression"], `${handle}: recorded assess should carry issues`).toContain(v.classification);
      } else {
        // review ref (driver-refactor): the recorded review directive with refactor:true (the issue to resolve).
        const verdict = parseVerdictFile(readFileSync(join(refDir, "review-verdict.json"), "utf8"));
        expect(verdict.refactor, `${handle}: recorded review directive should be refactor:true`).toBe(true);
      }
    }
  });

  // The repair/refactor SEED bundles (contained under driver-green-setup/) must exist + carry the recorded
  // pre-turn CYCLE MARKERS that route the drive to that turn – guards the corpus-assumed-deleted invariant
  // + that the seed reproduces the routing state (green needs no seed – its open-RED cycle is pipeline-set).
  const SETUP = "tests/integration/live/driver-green-setup";
  it("driver-repair seed carries the recorded post-assess regression markers (routes to REPAIR)", () => {
    const cyc = join(process.cwd(), SETUP, "repair-seed/cycles/F6-split-tracking-code/S3-stock-shows-split-fields/AC1-split-fields-shown");
    expect(existsSync(join(process.cwd(), SETUP, "repair-seed/code-assets/app"))).toBe(true);
    const gf = JSON.parse(readFileSync(join(cyc, "green-failure.json"), "utf8")) as { assessed?: boolean };
    expect(gf.assessed, "repair seed: green-failure must be assessed (routes past plain green)").toBe(true);
    const reg = parseVerdictFile(readFileSync(join(cyc, "regression-assessment.json"), "utf8")) as { fixDirective?: string };
    // a real regression WITH a fixDirective => repairRegressionAc routes to the Driver REPAIR turn.
    expect(typeof reg.fixDirective === "string" && reg.fixDirective.length > 0, "repair seed: regression must carry a fixDirective").toBe(true);
  });
  it("driver-refactor seed carries the recorded review-verdict refactor:true (routes to REFACTOR)", () => {
    const rv = join(process.cwd(), SETUP, "refactor-seed/cycles/F6-split-tracking-code/S3-stock-shows-split-fields/review-verdict.json");
    expect(existsSync(join(process.cwd(), SETUP, "refactor-seed/code-assets/app"))).toBe(true);
    const verdict = parseVerdictFile(readFileSync(rv, "utf8"));
    expect(verdict.refactor, "refactor seed: story review-verdict must be refactor:true").toBe(true);
  });
});

describe("concatTreeFiles: reconstruct a DIR-shaped output's judged text (regression: navigator-red primary=undefined)", () => {
  // navigator-red's outputFile is the "tests" DIRECTORY, so producedArtifacts["tests"] is ALWAYS
  // undefined (snapshotTree keys individual files). The red judge must reconstruct its text by
  // concatenating tests/**.{py,ts,tsx}; a bare-key lookup made it always short-circuit to "no tests
  // produced" => passed:false (it never scored). This guards the reconstruction the fix relies on.
  const produced = {
    "tests/conftest.py": "import pytest\n",
    "tests/test_a.py": "def test_a(): assert True\n",
    "tests/step_defs/test_b.py": "def test_b(): assert 1\n",
    "tests/features/x.feature": "Feature: x\n", // non-code, excluded
    ".consort/architecture/conventions.json": "{}\n", // outside tests/, excluded
  };
  it("concatenates only tests/**.{py,ts,tsx}, sorted + deterministic, into non-empty text", () => {
    const text = concatTreeFiles(produced, "tests/", [".py", ".ts", ".tsx"]);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain("def test_a()");
    expect(text).toContain("def test_b()");
    expect(text).not.toContain("Feature: x"); // .feature excluded
    expect(text).not.toContain("conventions"); // outside tests/ excluded
    // deterministic order: conftest (tests/conftest.py) sorts before step_defs/ before test_a.
    expect(text.indexOf("import pytest")).toBeLessThan(text.indexOf("def test_b()"));
  });
  it("returns empty (=> judge reports 'no tests produced') only when NOTHING under tests/ matches", () => {
    expect(concatTreeFiles({ "app/models.py": "x" }, "tests/", [".py"]).trim()).toBe("");
  });
});

describe("loadPreservedArtifacts: read a preserved candidate's artifacts/ back to the producedArtifacts map", () => {
  // The re-judge harness reconstructs producedArtifacts from disk so the SAME discriminator can re-score
  // a preserved output. This guards the round-trip: persistTrial writes artifacts/<relpath>; this reads
  // them back keyed by the SAME relpath (so primary=producedArtifacts[outputFile] resolves identically).
  it("round-trips a nested artifacts/ tree, keyed by relpath (no 'artifacts/' prefix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rejudge-cand-"));
    try {
      mkdirSyncFs(join(dir, "artifacts", "app", "routes"), { recursive: true });
      mkdirSyncFs(join(dir, "artifacts", "navigator-eval"), { recursive: true });
      writeFileSyncFs(join(dir, "artifacts", "app", "models.py"), "class Stock: pass\n");
      writeFileSyncFs(join(dir, "artifacts", "app", "routes", "stock.py"), "router = 1\n");
      writeFileSyncFs(join(dir, "artifacts", "navigator-eval", "superseded-tests.json"), '{"tests":["t"]}');
      writeFileSyncFs(join(dir, "telemetry.json"), "{}"); // sibling, NOT under artifacts/ – must be excluded
      const map = loadPreservedArtifacts(dir);
      expect(Object.keys(map).sort()).toEqual(["app/models.py", "app/routes/stock.py", "navigator-eval/superseded-tests.json"]);
      expect(map["app/models.py"]).toContain("class Stock");
      expect(map["telemetry.json"]).toBeUndefined(); // sibling of artifacts/, not inside it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns {} when the candidate preserved NO artifacts/ (un-rejudgeable – e.g. navigator-assess)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rejudge-empty-"));
    try {
      expect(loadPreservedArtifacts(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyReproduce: first-verdict vs REPRODUCED vs DIVERGED (regression: never-judged mislabeled REPRODUCED)", () => {
  // The bug: a telemetry.json can EXIST with NO verdict (navigator-red predated the working judge), so
  // stored={} – comparing storedClass===freshClass gave undefined===undefined => a false "REPRODUCED".
  // classifyReproduce keys on whether a stored verdict VALUE exists, and compares the right kind.
  it("no stored verdict (never judged) => first-verdict, NEVER a false REPRODUCED", () => {
    expect(classifyReproduce({}, { score: 0.82 })).toMatch(/first-verdict/);
    expect(classifyReproduce({}, { classification: "equivalent" })).toMatch(/first-verdict/);
  });
  it("classification-based: exact match => REPRODUCED, mismatch => DIVERGED", () => {
    expect(classifyReproduce({ storedClass: "equivalent" }, { classification: "equivalent" })).toBe("REPRODUCED");
    expect(classifyReproduce({ storedClass: "equivalent" }, { classification: "regression" })).toMatch(/^DIVERGED/);
  });
  it("score-based: within tolerance => REPRODUCED, beyond => DIVERGED", () => {
    expect(classifyReproduce({ storedScore: 0.93 }, { score: 0.90 })).toMatch(/^REPRODUCED/);
    expect(classifyReproduce({ storedScore: 0.93 }, { score: 0.60 })).toMatch(/^DIVERGED/);
  });
});

describe("isMissingJudgeTarget: a judge short-circuit for an absent target is NOT a real FAIL (not-rejudgeable)", () => {
  // The bug: navigator-reflect preserved its code tree but NOT reflect-verdict.json, so the reflect judge
  // returned passed:false 'no reflect-verdict produced to judge'. The harness recorded that as a fresh
  // FAIL (mislabeled REPRODUCED). It must instead be not-rejudgeable (judge target not preserved).
  it("matches every judge's 'no ... to judge' missing-target reason family", () => {
    expect(isMissingJudgeTarget("no primary artifact to judge")).toBe(true);
    expect(isMissingJudgeTarget("no tests produced to judge")).toBe(true);
    expect(isMissingJudgeTarget("no reflect-verdict produced to judge")).toBe(true);
    expect(isMissingJudgeTarget("no review-verdict produced to judge")).toBe(true);
    expect(isMissingJudgeTarget("no app/ code produced to judge")).toBe(true);
  });
  it("does NOT match a genuine content FAIL reason (a real judged verdict)", () => {
    expect(isMissingJudgeTarget("material difference vs the recorded ground truth: navigator missed tests/core.py")).toBe(false);
    expect(isMissingJudgeTarget("candidate's post-refactor review STILL requests refactor for the same issue")).toBe(false);
    expect(isMissingJudgeTarget(undefined)).toBe(false);
  });
});

describe("buildDriverNextStepJudge IS the next-turn assessment (ENFORCED: no bespoke discriminator)", () => {
  // ENFORCED INVARIANT: the judge maps evaluateNextStepDetermination straight through – the RECORDED
  // next-turn navigator determination vs the candidate's captured one, ranked same / better / worse. It
  // must NOT read the produced CODE, shortcut on honest-GREEN, or apply any milestone/resolution overlay:
  // the next-turn agent (navigator assess/review) AND the orchestrator's deterministic assess already
  // evaluate the code results / smells / superseded tests. This locks TWO reverted regressions – an
  // honest-GREEN shortcut, and a code-scanning "milestone" (productionCodeReferencesSymbol). Any richer
  // evaluation belongs in the next-turn assessment, not this closure. driver-green-s2's recorded same-step
  // determination is a REGRESSION.
  const REG = { "navigator-eval/regression-assessment.json": JSON.stringify({ diagnosis: "code still references inventory_code", fix: "remove it" }) };

  // These four exercise the LIVE regression-fidelity / delta / verdict judges (real model calls); the 30s
  // default is too tight under API latency and flakes the pre-push gate, so give the live path room.
  it("SAME: candidate's next-turn navigator reproduces the recorded regression => pass (same, not honors)", { timeout: 120_000 }, async () => {
    const v = await buildDriverNextStepJudge("driver-green-s2").judgeCandidate({ candidateId: "faithful", primary: undefined, producedArtifacts: REG });
    expect(v.passed).toBe(true);
    expect(v.classification).not.toBe("pass-with-honors");
  });
  it("BETTER: candidate's next-turn navigator found the code clean (equivalent) => pass-with-honors", { timeout: 120_000 }, async () => {
    const v = await buildDriverNextStepJudge("driver-green-s2").judgeCandidate({ candidateId: "clean", primary: undefined, producedArtifacts: {} });
    expect(v.passed).toBe(true);
    expect(v.classification).toBe("pass-with-honors");
  });
  it("BETTER: superseded-shift outranks the recorded regression on the resolution ladder => pass-with-honors", { timeout: 120_000 }, async () => {
    // The resolution ladder scores same/better/worse over the DETERMINATION classes: superseded-shift (code
    // correct, prior tests superseded) is MORE resolved than a regression (code broken). driver-green-s2's
    // recorded next-turn determination is a regression, so a candidate whose navigator returns superseded-shift
    // is BETTER – the contract-change case (the drop resolved; only test bookkeeping remains). No code scan.
    const v = await buildDriverNextStepJudge("driver-green-s2").judgeCandidate({
      candidateId: "resolved-drop",
      primary: undefined,
      producedArtifacts: { "navigator-eval/superseded.json": JSON.stringify({ verdict: "superseded", tests: ["tests/step_defs/test_S1_file_stock.py"], reason: "the drop supersedes prior tests" }) },
    });
    expect(v.passed).toBe(true);
    expect(v.classification).toBe("pass-with-honors");
  });
  it("the verdict is driven ONLY by the next-turn determination, NOT the produced code (no code-scan)", { timeout: 120_000 }, async () => {
    // SAME determination (regression), wildly different app/ code: the verdict must be IDENTICAL. A
    // code-scanning discriminator (the removed milestone) would diverge these; the pure delegate cannot.
    const judge = buildDriverNextStepJudge("driver-green-s2");
    const dirty = await judge.judgeCandidate({ candidateId: "dirty", primary: undefined, producedArtifacts: { ...REG, "app/repositories/stock.py": "values(inventory_code=inventory_code)\n" } });
    const clean = await judge.judgeCandidate({ candidateId: "cleanish", primary: undefined, producedArtifacts: { ...REG, "app/repositories/stock.py": "def upsert(db):\n    return db\n" } });
    expect(dirty.passed).toBe(clean.passed);
    expect(dirty.classification).toBe(clean.classification); // code content did NOT change the verdict
  });
});

describe("parseNavigatorAssessMarker recognizes the kit's determination shapes (anti-false-clean guard)", () => {
  // The kit-produced determinations were being MISREAD as clean, creating false pass-with-honors:
  //  (1) the kit writes `superseded.json` (not `superseded-tests.json`) => a real superseded-shift fell
  //      through to "equivalent" (clean); (2) a FAILED green with no determination file defaulted to
  //      "equivalent" too. Both must be recognized. Uses a temp marker dir – no cloud, no LLM.
  const mk = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "navmarker-"));
    for (const [name, body] of Object.entries(files)) writeFileSyncFs(join(dir, name), JSON.stringify(body));
    return dir;
  };
  it("reads `superseded.json` (the kit's filename) as superseded-shift with its test set", () => {
    const dir = mk({ "superseded.json": { verdict: "superseded", tests: ["tests/step_defs/test_S1_file_stock.py", "tests/test_stock_db_invariants.py"] } });
    try {
      const v = parseNavigatorAssessMarker(dir);
      expect(v.classification).toBe("superseded-shift");
      expect(v.supersededTests).toEqual(["tests/step_defs/test_S1_file_stock.py", "tests/test_stock_db_invariants.py"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a FAILED green with NO determination is 'insufficient', NOT 'equivalent' (a failed green is never clean)", () => {
    const dir = mk({ "green-failure.json": { assessed: true, summary: "GREEN verify FAILED against the running app" } });
    try {
      expect(parseNavigatorAssessMarker(dir).classification).toBe("insufficient");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("genuinely no markers + no recorded failure => equivalent (the clean case still holds)", () => {
    const dir = mkdtempSync(join(tmpdir(), "navmarker-clean-"));
    try {
      expect(parseNavigatorAssessMarker(dir).classification).toBe("equivalent");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
