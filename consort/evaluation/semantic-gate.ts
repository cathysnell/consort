// evaluation/semantic-gate: the SHARED comparison judges , the SEMANTIC / DISCRIMINATOR /
// FUNCTIONAL / RED-coverage bar comparing a produced output to the reference recorded at that same
// step. Used by BOTH the regression path (the executor-dispatch equivalence proofs) and the
// optimization path (the champion-walk sweep) , ONE comparison mechanism, so it lives in
// consort/evaluation/ (a peer family), not optimize-only. The structural self-check
// (optimize-gate.evaluateDesignGate) proves an artifact is well-FORMED; this proves it is
// well-MEANING , that the output conveys the SAME design/behavior as the reference recorded at that
// same step, regardless of wording, slug, or how content is split. An output that drops material
// intent (a design-guide missing the status-badge concept, a spec missing a behavior) is
// disqualified no matter how fast it was produced.
//
// "Comparable" is a SEMANTIC judgment, not a structural diff, so it is judged by an
// LLM-as-judge on a FIXED model (opus) , constant across candidates, so the bar
// never moves with the thing being measured. The judge scores coverage 0..1 and
// names what is missing; the gate passes at >= SEMANTIC_THRESHOLD. The judge call is
// made AFTER the timed spawn (the harness stops its clock first), so it never
// pollutes the wall-clock measurement.
//
// Reference resolution: canonical `stockflow` for every step EXCEPT dba, which uses
// `stockflow-rerecord` (the only corpus that recorded db-design.json). Steps with no
// recorded reference (or a scenario without the corpus on disk) skip the semantic
// bar and fall through to the structural floor alone.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TurnKey } from "../../consort/orchestrator/settings/project-settings.js";
import { designGuideJson, featureSpecJson, architectureJson, featureTestListJson, dbDesignJson, featureProposalsMd, planningEstimatesJson, acsDir, storiesDir, featureDir } from "../../consort/config/consort-paths.js";
import { projectLanguage, productDirForLanguage, productExtsForLanguage, testExtsForLanguage } from "../../consort/config/consort-config-file.js";

/** The .tdd-layout artifact path for a step, built via consort-paths (the single source
 *  of truth for the layout). `base` is a .tdd-shaped root: the live project's .sftdd
 *  for the candidate, or a corpus's recorded-artifacts/ for the reference , both carry
 *  the identical features/<F>/... + design/... shape, so one builder set serves both.
 *  Returns null for a step whose artifact is per-story (acs), handled separately. */
function stepArtifactPath(base: string, step: TurnKey, featureId: string): string | null {
  switch (step) {
    case "ux":
      return designGuideJson(base);
    case "breakdown":
      return featureSpecJson(base, featureId);
    case "propose":
      // The Spec Author's sprint proposal , a project-level (not per-feature) artifact.
      return featureProposalsMd(base);
    case "architect":
      return architectureJson(base, featureId);
    case "estimate":
      // The Architect's feature-level t-shirt sizes , planning/estimates.json (NOT
      // architecture.json). estimate + architect are distinct artifacts by distinct actions.
      return planningEstimatesJson(base);
    case "test-list":
      return featureTestListJson(base, featureId);
    case "dba":
      return dbDesignJson(base, featureId);
    default:
      return null; // acs is per-story; build turns have no design artifact
  }
}

/** The SHARED reference-asset pin, relative to the kit root , the ONE reference set BOTH the
 *  regression + optimization paths compare against (a self-contained snapshot copied from the most
 *  recent re-record; see reference-assets/stockflow/README.md). Design refs live under its
 *  recorded-artifacts/; build seeds/refs under recorded-build/. */
const REFERENCE_ASSETS_REL = "consort/evaluation/reference-assets/stockflow";
/** Kept for the build reference resolver's label only (the pin's provenance corpus name). */
const CANONICAL = "stockflow";

/** The reference corpus ROOT (the dir that CONTAINS recorded-artifacts/ + recorded-build/).
 *  Default = the pinned reference-assets under the kit. Override with CONSORT_REFERENCE_CORPUS to
 *  point at ANY corpus root when re-recording , a FULLY-CONFIGURABLE absolute-or-relative path (NOT
 *  a name appended to a hardcoded scenarios prefix; that prefix is going away). An override is
 *  resolved as-is when absolute, else relative to kitRoot. */
function referenceCorpusRoot(kitRoot: string): string {
  const override = process.env.CONSORT_REFERENCE_CORPUS?.trim();
  if (override) return override.startsWith("/") ? override : join(kitRoot, override);
  return join(kitRoot, REFERENCE_ASSETS_REL);
}

/** Threshold on the judge's 0..1 score. DESIGN artifacts (prose/tokens) demand tight
 *  semantic coverage; BUILD artifacts (code/tests) get a LOOSER functional bar since
 *  code structure legitimately varies more than prose. */
export const SEMANTIC_THRESHOLD = 0.85;
export const FUNCTIONAL_THRESHOLD = 0.75;

/** A BUILD turn's role output kind, for functional-similarity comparison against the
 *  recorded-build reference: navigator authors TESTS (red/review), driver writes CODE
 *  (green/refactor/repair). Used to scope the comparison to the turn's OWN output. */
export type BuildOutputKind = "tests" | "code";
export function buildOutputKind(role: string): BuildOutputKind | undefined {
  if (role === "navigator") return "tests";
  if (role === "driver") return "code";
  return undefined;
}

/** The recorded reference for a step: which corpus + the artifact path(s) under its
 *  recorded-artifacts/ tree, and a human label. `perStoryGlob` marks steps whose
 *  artifact is per-story (acs) , the reference is the union across recorded stories,
 *  since slugs + per-story splits legitimately differ (semantic, not slug, match). */
export interface StepReference {
  corpus: string;
  /** Absolute paths to the recorded reference artifact(s) for this step. */
  paths: string[];
  label: string;
}

/** Which TurnKeys HAVE a design reference (build turns + unknown steps do not). One pinned
 *  reference set now carries every design artifact (feature-spec / architecture / db-design /
 *  test-list / design-guide / proposals / estimates / acs), so there is no per-step corpus split
 *  anymore , the earlier dba->rerecord vs others->canonical split existed only because canonical
 *  lacked db-design.json; the pin has all of them. */
function hasDesignReference(step: TurnKey): boolean {
  switch (step) {
    case "breakdown":
    case "propose":
    case "acs":
    case "architect":
    case "estimate":
    case "test-list":
    case "dba":
    case "ux":
      return true;
    default:
      return false; // build turns + unknown steps have no design reference
  }
}

/** Resolve the recorded reference artifact(s) for a step from the shared reference pin (or the
 *  CONSORT_REFERENCE_CORPUS override), or null if the reference/artifact is not on disk (a step
 *  with no recorded reference, or a corpus root that lacks it). */
export function resolveStepReference(args: {
  kitRoot: string;
  step: TurnKey;
  featureId: string;
  /** For step==="acs" only: restrict the reference to ONE recorded story's ACs (a per-story
   *  comparison) rather than the feature-aggregate union. Used when the candidate turn produced a
   *  single story's ACs (a per-story dispatch), so the comparison is like-for-like. Ignored for
   *  other steps. Omitted => the feature-aggregate union (the default coverage bar). */
  storyId?: string;
}): StepReference | null {
  const { kitRoot, step, featureId, storyId } = args;
  if (!hasDesignReference(step)) return null;
  // recorded-artifacts/ is .tdd-shaped (features/<F>/..., design/...), so the consort-paths builders
  // resolve reference paths the same as live .consort paths. `corpus` is the provenance label.
  const corpus = CANONICAL;
  const root = join(referenceCorpusRoot(kitRoot), "recorded-artifacts");
  if (!existsSync(root)) return null;

  if (step === "acs") {
    // Per-story ACs. By default the reference is the UNION of every recorded story's ACs (the
    // feature-aggregate coverage bar). When storyId is given, restrict to THAT story's recorded
    // ACs , the like-for-like reference for a single-story turn (else a one-story candidate is
    // unfairly judged against all stories' ACs, the scope-mismatch the equivalence suite hit).
    const sdir = storiesDir(root, featureId);
    if (!existsSync(sdir)) return null;
    const paths: string[] = [];
    const stories = storyId ? [storyId] : readdirSync(sdir);
    for (const story of stories) {
      const adir = acsDir(root, featureId, story);
      if (!existsSync(adir)) continue;
      for (const ac of readdirSync(adir)) if (ac.endsWith(".json")) paths.push(join(adir, ac));
    }
    return paths.length
      ? { corpus, paths, label: storyId ? `stories/${storyId}/acs/*.json` : "stories/*/acs/*.json (feature-aggregate)" }
      : null;
  }

  const p = stepArtifactPath(root, step, featureId);
  if (!p || !existsSync(p)) return null;
  return { corpus, paths: [p], label: p.slice(root.length + 1) };
}

/** Read + concatenate the candidate's produced artifact(s) for a step from the live
 *  .consort, mirroring resolveStepReference's path selection so judge sees like-for-like. */
export function readCandidateArtifact(args: {
  consortDir: string;
  step: TurnKey;
  featureId: string;
}): string | null {
  const { consortDir, step, featureId } = args;
  const readIf = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
  if (step === "acs") {
    const sdir = storiesDir(consortDir, featureId);
    if (!existsSync(sdir)) return null;
    const parts: string[] = [];
    for (const story of readdirSync(sdir)) {
      const adir = acsDir(consortDir, featureId, story);
      if (!existsSync(adir)) continue;
      for (const ac of readdirSync(adir)) if (ac.endsWith(".json")) parts.push(readFileSync(join(adir, ac), "utf8"));
    }
    return parts.length ? parts.join("\n---\n") : null;
  }
  const p = stepArtifactPath(consortDir, step, featureId);
  return p ? readIf(p) : null;
}

/** The judge's verdict: a 0..1 semantic-coverage score + (on a miss) what material
 *  intent the candidate dropped relative to the reference. */
export interface SemanticVerdict {
  score: number;
  missing?: string[];
  raw?: string;
}

/** A BUILD-code DISCRIMINATOR classification, mirroring the navigator ASSESS turn's
 *  decision: is the produced code functionally equivalent (nothing to do), a
 *  legitimate behavior SHIFT that supersedes prior tests, a genuine REGRESSION, or
 *  INSUFFICIENT (unrecoverable / needs a human)? */
export type BuildClassification = "equivalent" | "superseded-shift" | "regression" | "insufficient";
/** The NEXT STEP a discriminator classification warrants (the assess turn's routing). */
export type BuildNextStep = "accept" | "permissive-refactor-superseded" | "driver-repair-with-directive" | "escalate";

/** A DISCRIMINATOR verdict over a build turn's code: the {score} bar PLUS the assess-
 *  style classification + the next step it warrants. A CLEAN verdict
 *  (equivalent/accept) is the BEST outcome (the candidate converged with no self-heal
 *  needed, beating the recorded baseline's assess->repair spiral), NEVER a miss. */
export interface DiscriminatorVerdict extends SemanticVerdict {
  classification: BuildClassification;
  nextStep: BuildNextStep;
  /** When classification=regression: the root-cause diagnosis (mirrors regression-assessment.json). */
  diagnosis?: string;
  /** When classification=regression and driver-fixable: the repair directive (its presence => fixable). */
  fixDirective?: string;
  /** When classification=superseded-shift: the prior tests the shift legitimately retires
   *  (mirrors superseded-tests.json), used by the navigator-assess alignment check. */
  supersededTests?: string[];
}

/** Injected LLM-as-judge: given the reference + candidate artifact text for a step,
 *  return a semantic-coverage verdict. Real impl spawns a FIXED opus `claude -p`
 *  (constant across candidates); stubbable for hermetic tests. */
export type SemanticJudge = (args: {
  step: TurnKey;
  reference: string;
  candidate: string;
  /** When set, this is a BUILD-output comparison: score FUNCTIONAL equivalence of
   *  code/tests (looser bar) rather than design-artifact semantic intent. */
  functional?: BuildOutputKind;
}) => Promise<SemanticVerdict | DiscriminatorVerdict>;

export interface SemanticGateOutcome {
  /** true = comparable (>= threshold) OR no reference exists (bar not applicable). */
  passed: boolean;
  /** The judged score, when a judgment was made (undefined when skipped). */
  score?: number;
  reason?: string;
  /** true when there was no recorded reference for this step -> bar skipped. */
  skipped?: boolean;
  /** BUILD-code discriminator fields (only on the build/functional path): the assess-
   *  style classification + the next step it warrants + any diagnosis/fixDirective.
   *  A clean equivalent/accept is the BEST result (passed:true); only "insufficient"
   *  fails. Absent on the design semantic path. */
  classification?: BuildClassification;
  nextStep?: BuildNextStep;
  diagnosis?: string;
  fixDirective?: string;
}

/** Evaluate a design candidate's artifact for SEMANTIC similarity to the recorded
 *  reference at its step. Pure orchestration over the injected judge + fs reads:
 *   - no reference on disk        => skipped:true, passed:true (structural floor only)
 *   - candidate artifact missing  => passed:false (nothing to compare; structural
 *                                     floor should already have caught it)
 *   - judge score >= threshold    => passed:true
 *   - below threshold             => passed:false, reason names what is missing
 *  Concatenates multi-file references (acs) into one reference block. */
export async function evaluateSemanticGate(args: {
  kitRoot: string;
  consortDir: string;
  featureId: string;
  step: TurnKey;
  judge: SemanticJudge;
  threshold?: number;
  /** For step==="acs": restrict the reference to ONE recorded story (per-story like-for-like). */
  storyId?: string;
  /** ABSOLUTE reference file path(s) that REPLACE the resolved recorded reference. Used when the
   *  turn's faithful reference is a per-story/per-scope SLICE that the pin only holds at feature
   *  level (a story-scoped architect/test-list turn produces one story's slice, not the whole
   *  feature). The label reports "(reference override)". Omitted => the resolved recorded reference. */
  referencePaths?: string[];
}): Promise<SemanticGateOutcome> {
  const { kitRoot, consortDir, featureId, step, judge, storyId, referencePaths } = args;
  const threshold = args.threshold ?? SEMANTIC_THRESHOLD;

  const ref = referencePaths?.length
    ? { corpus: CANONICAL, paths: referencePaths.filter((p) => existsSync(p)), label: "(reference override)" }
    : resolveStepReference({ kitRoot, step, featureId, ...(storyId ? { storyId } : {}) });
  if (!ref || ref.paths.length === 0) return { passed: true, skipped: true };

  const candidate = readCandidateArtifact({ consortDir, step, featureId });
  if (candidate === null) {
    return { passed: false, reason: `semantic: candidate produced no artifact for step '${step}' to compare against ${ref.label}` };
  }

  const reference = ref.paths.map((p) => readFileSync(p, "utf8")).join("\n---\n");
  const verdict = await judge({ step, reference, candidate });
  if (verdict.score >= threshold) return { passed: true, score: verdict.score };

  const missing = verdict.missing?.length ? ` missing: ${verdict.missing.join("; ")}` : "";
  return {
    passed: false,
    score: verdict.score,
    reason: `semantic: score ${verdict.score.toFixed(2)} < ${threshold} vs ${ref.corpus} ${ref.label}.${missing}`,
  };
}

/** Read + concatenate all source files under a dir subtree matching an extension set,
 *  each prefixed with its relative path (so the judge sees file boundaries). Skips
 *  node_modules / dist / __pycache__. Bounded so a runaway tree cannot blow the buffer:
 *  stops after maxBytes, appending a truncation marker. */
export function readTree(root: string, exts: string[], maxBytes = 200_000): string {
  if (!existsSync(root)) return "";
  const parts: string[] = [];
  let total = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "dist" || name === "__pycache__" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (exts.some((e) => name.endsWith(e))) {
        if (total >= maxBytes) return;
        const body = readFileSync(p, "utf8");
        const rel = p.slice(root.length + 1);
        const chunk = `// FILE: ${rel}\n${body}\n`;
        parts.push(chunk);
        total += chunk.length;
      }
    }
  };
  walk(root);
  const joined = parts.join("\n");
  return joined.length > maxBytes ? joined.slice(0, maxBytes) + "\n// ...[truncated]\n" : joined;
}

/** The recorded-build reference for a BUILD turn's output: the LAST recorded turn dir
 *  for the story under recorded-build (its terminal-good code tree), scoped to the
 *  role's output subtree , tests/ for a navigator (tests) turn, app/ for a driver
 *  (code) turn. Story matched POSITIONALLY (slugs differ across corpora), by the
 *  story's index in storyOrder, since the reference and candidate feature decompose
 *  the same way. Returns null when no recorded-build reference exists. */
export function resolveBuildReference(args: {
  kitRoot: string;
  featureId: string;
  storyIndex: number;
  kind: BuildOutputKind;
}): { paths: string[]; label: string; text: string } | null {
  const { kitRoot, featureId, storyIndex, kind } = args;
  // The recorded-build tree is .tdd-shaped (features/<F>/stories/...), so route its
  // paths through the consort-paths builders too (single-source layout rule). The
  // recorded-build root plays the `tdd` role; featureDir/storiesDir take it from there.
  const rbRoot = join(referenceCorpusRoot(kitRoot), "recorded-build");
  const rbFeature = join(featureDir(rbRoot, featureId), "stories");
  if (!existsSync(rbFeature)) return null;
  const stories = readdirSync(rbFeature).filter((d) => statSync(join(rbFeature, d)).isDirectory()).sort();
  const story = stories[storyIndex];
  if (!story) return null;
  const turnsDir = join(rbFeature, story, "turns");
  if (!existsSync(turnsDir)) return null;
  const turns = readdirSync(turnsDir).filter((d) => statSync(join(turnsDir, d)).isDirectory()).sort();
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) return null;
  const codeRoot = join(turnsDir, lastTurn, "code");
  const sub = kind === "tests" ? join(codeRoot, "tests") : join(codeRoot, "app");
  if (!existsSync(sub)) return null;
  const text = readTree(sub, kind === "tests" ? [".py", ".tsx", ".ts"] : [".py"]);
  if (!text.trim()) return null;
  return { paths: [sub], label: `${CANONICAL} recorded-build/${story}/${lastTurn}/code/${kind === "tests" ? "tests" : "app"}`, text };
}

/** Read the candidate's BUILD output from the live experiment tree: tests/ (navigator)
 *  or app/ (driver), under the project dir (the experiment branch is checked out
 *  there). Returns "" when the subtree is absent. */
export function readCandidateBuildOutput(args: { projectDir: string; kind: BuildOutputKind }): string {
  // Language-aware: the candidate is the LIVE experiment tree, so its product dir + file extensions
  // follow the project's language (python/java/kotlin -> app/ + .py; nodejs -> src/ + .ts/.tsx/.js).
  // The recorded-build REFERENCE reader above stays app/+.py (the reference corpus is python).
  const language = projectLanguage(args.projectDir);
  const sub = join(args.projectDir, args.kind === "tests" ? "tests" : productDirForLanguage(language));
  return readTree(sub, args.kind === "tests" ? testExtsForLanguage(language) : productExtsForLanguage(language));
}

/** Evaluate a BUILD turn's produced output for FUNCTIONAL similarity to the recorded-
 *  build reference. This is Layer 2 (the Layer 1 honest-GREEN floor is the trial's own
 *  gate). Skips (passes) when no recorded-build reference exists. Below FUNCTIONAL_
 *  THRESHOLD => not viable, name the dropped/changed functionality. */
export async function evaluateBuildFunctionalGate(args: {
  kitRoot: string;
  projectDir: string;
  featureId: string;
  storyIndex: number;
  role: string;
  judge: SemanticJudge;
  threshold?: number;
}): Promise<SemanticGateOutcome> {
  const { kitRoot, projectDir, featureId, storyIndex, role, judge } = args;
  const threshold = args.threshold ?? FUNCTIONAL_THRESHOLD;
  const kind = buildOutputKind(role);
  if (!kind) return { passed: true, skipped: true }; // non build-authoring role

  const ref = resolveBuildReference({ kitRoot, featureId, storyIndex, kind });
  if (!ref) return { passed: true, skipped: true };

  const candidate = readCandidateBuildOutput({ projectDir, kind });
  if (!candidate.trim()) {
    return { passed: false, reason: `functional: candidate produced no ${kind} to compare against ${ref.label}` };
  }

  const verdict = await judge({ step: kind as unknown as TurnKey, reference: ref.text, candidate, functional: kind });

  // DISCRIMINATOR path: when the judge returned a classification (the build-code
  // discriminator, not the flat design similarity judge), the outcome is driven by
  // the CLASSIFICATION, not score>=threshold. A clean "equivalent"/accept is the BEST
  // outcome (the candidate converged with no self-heal needed) => PASS. superseded-shift
  // and driver-fixable regression are viable routings => PASS. Only "insufficient"
  // (unrecoverable / needs a human) FAILS. score is advisory here.
  const disc = verdict as Partial<DiscriminatorVerdict>;
  if (disc.classification) {
    const passed = disc.classification !== "insufficient";
    return {
      passed,
      score: verdict.score,
      classification: disc.classification,
      ...(disc.nextStep ? { nextStep: disc.nextStep } : {}),
      ...(disc.diagnosis ? { diagnosis: disc.diagnosis } : {}),
      ...(disc.fixDirective ? { fixDirective: disc.fixDirective } : {}),
      ...(passed
        ? {}
        : { reason: `discriminator: ${disc.classification} (${disc.nextStep ?? "escalate"}) vs ${ref.label}${disc.diagnosis ? ` , ${disc.diagnosis}` : ""}` }),
    };
  }

  // Legacy flat functional-similarity path (no classification): score>=threshold.
  if (verdict.score >= threshold) return { passed: true, score: verdict.score };
  const missing = verdict.missing?.length ? ` missing: ${verdict.missing.join("; ")}` : "";
  return {
    passed: false,
    score: verdict.score,
    reason: `functional: ${kind} score ${verdict.score.toFixed(2)} < ${threshold} vs ${ref.label}.${missing}`,
  };
}

/** Alignment of a navigator ASSESS turn's verdict against the RECORDED GROUND TRUTH. */
export interface AssessAlignment {
  passed: boolean;
  /** The navigator's classification matched the recorded ground-truth classification. */
  classificationMatch: boolean;
  /** For superseded-shift: whether the navigator's flagged set is coverage-equivalent to the
   *  recorded set (delta-judged; true when identical without a judge call). Undefined for the
   *  non-superseded classifications (classification-match is the whole gate there). */
  setEquivalent?: boolean;
  reason: string;
}

/** The delta judge's verdict: are two supersession sets coverage-equivalent, and if not, what
 *  material differences (a real miss / over-flag) separate them? */
export interface SupersessionDeltaVerdict {
  equivalent: boolean;
  materialDifferences?: string[];
}

/** Injected delta judge: given the navigator's flagged set + the recorded ground-truth set (+ the
 *  supersession reason), decide if they are COVERAGE-EQUIVALENT (benign non-determinism) or differ
 *  MATERIALLY (a real miss / over-flag). Real impl spawns fixed-opus; stubbable in tests. */
export type SupersessionDeltaJudge = (args: {
  navigatorSet: string[];
  recordedSet: string[];
  reason?: string;
}) => Promise<SupersessionDeltaVerdict>;

/** The regression-fidelity judge's verdict: does the candidate's regression assessment reach the SAME
 *  root cause (and a fix that would actually resolve the failure) as the recorded ground truth?
 *  aligned:false names the material divergence (a wrong root cause / a fix aimed at the wrong layer).
 *  Mirrors SupersessionDeltaVerdict, for the regression class. */
export interface RegressionFidelityVerdict {
  aligned: boolean;
  materialDifferences?: string[];
}

/** Injected regression-fidelity judge: given the candidate's + recorded diagnosis/fixDirective (both
 *  already classified `regression`), decide whether the candidate FAITHFULLY reaches the same root cause
 *  and prescribes a fix that would resolve the SAME failure. Benign wording/detail differences are
 *  aligned; a different/wrong root cause or a misdirected fix (which would send the driver at the wrong
 *  change) is MATERIAL. Real impl spawns fixed-opus; stubbable in tests. This is the regression analogue
 *  of the superseded-shift set delta , class-match alone never proves two regression assessments agree. */
export type RegressionFidelityJudge = (args: {
  candidate: { diagnosis?: string; fixDirective?: string };
  recorded: { diagnosis?: string; fixDirective?: string };
  failureSummary?: string;
}) => Promise<RegressionFidelityVerdict>;

/** Parse the navigator's ASSESS marker files (in an AC cycle dir) into a discriminator-
 *  shaped verdict, so it can be diffed against the independent oracle. The markers:
 *   - superseded-tests.json {tests,reason}   => superseded-shift / permissive-refactor-superseded
 *   - regression-assessment.json {diagnosis, fixDirective?} => regression / driver-repair (fixable)
 *       or, WITHOUT fixDirective, insufficient / escalate (needs a human)
 *   - neither present => equivalent / accept (the navigator judged the code clean). */
export function parseNavigatorAssessMarker(markerDir: string): DiscriminatorVerdict {
  // Superseded determination filename: the kit's navigator writes `superseded.json`; older corpora used
  // `superseded-tests.json`. Accept EITHER , WITHOUT this the kit's superseded-shift is invisible and the
  // determination falls through to "equivalent" (clean), mis-scoring a real superseded-shift as a pass.
  const sup = ["superseded.json", "superseded-tests.json"].map((n) => join(markerDir, n)).find((p) => existsSync(p));
  const reg = join(markerDir, "regression-assessment.json");
  if (sup) {
    try {
      const j = JSON.parse(readFileSync(sup, "utf8")) as { tests?: unknown; supersededTests?: unknown };
      const raw = Array.isArray(j.tests) ? j.tests : Array.isArray(j.supersededTests) ? j.supersededTests : [];
      const tests = raw.map(String);
      return { score: 1, classification: "superseded-shift", nextStep: "permissive-refactor-superseded", supersededTests: tests };
    } catch {
      /* fall through */
    }
  }
  if (existsSync(reg)) {
    try {
      const j = JSON.parse(readFileSync(reg, "utf8")) as { diagnosis?: unknown; fixDirective?: unknown; fix?: unknown };
      const diagnosis = typeof j.diagnosis === "string" ? j.diagnosis : undefined;
      // The regression's repair directive. Accept `fix` as a legacy/alias alongside `fixDirective`: the
      // kit's navigator (and the recorded corpus) emit `fix`, while consort's canonical key is
      // `fixDirective` , WITHOUT this alias a real regression parses as "insufficient" (no directive) and
      // the driver-turn discriminator mis-scores every kit-produced regression. fixDirective wins if both.
      const fixDirective =
        (typeof j.fixDirective === "string" && j.fixDirective ? j.fixDirective : undefined) ??
        (typeof j.fix === "string" && j.fix ? j.fix : undefined);
      return fixDirective
        ? { score: 1, classification: "regression", nextStep: "driver-repair-with-directive", ...(diagnosis ? { diagnosis } : {}), fixDirective }
        : { score: 1, classification: "insufficient", nextStep: "escalate", ...(diagnosis ? { diagnosis } : {}) };
    } catch {
      /* fall through */
    }
  }
  // No determination marker. A FAILED green with no determination is NOT a clean pass: if green-failure.json
  // records a failed verify (assessed, or a "…FAILED…" summary) but the navigator wrote neither a
  // superseded nor a regression determination, the outcome is UNKNOWN/insufficient (a failed green the
  // navigator did not diagnose), NEVER "equivalent". Only a genuine absence of failure is clean.
  const gf = join(markerDir, "green-failure.json");
  if (existsSync(gf)) {
    try {
      const g = JSON.parse(readFileSync(gf, "utf8")) as { assessed?: unknown; summary?: unknown };
      const summary = typeof g.summary === "string" ? g.summary : "";
      if (g.assessed === true || /fail/i.test(summary)) {
        return { score: 0, classification: "insufficient", nextStep: "escalate" };
      }
    } catch {
      /* fall through */
    }
  }
  // No marker + no recorded green failure => the navigator judged the driver's code clean.
  return { score: 1, classification: "equivalent", nextStep: "accept" };
}

/** Evaluate whether the navigator's ASSESS verdict aligns with the RECORDED GROUND TRUTH , the
 *  canonical answer the corpus navigator produced for this turn. This is the right reference: a
 *  cold oracle re-deriving a verdict from raw code (WITHOUT the deterministic pre-localization the
 *  navigator had) is a NOISIER estimator than the navigator it judges , it can diverge from ground
 *  truth even when the navigator matches it exactly (the S1 finding). So:
 *   - classification-match vs the recorded verdict is the HARD gate (a misclassification always fails);
 *   - for superseded-shift, the navigator's flagged SET is compared to the recorded SET, and a
 *     DELTA JUDGE decides if the difference is MATERIAL (a real miss / over-flag) or benign
 *     (coverage-equivalent) , identical sets short-circuit to PASS with no judge call.
 *  This judges two CONCRETE answers against each other (well-grounded), not a re-derivation. */
export async function evaluateNavigatorAssessAlignment(args: {
  recordedVerdict: DiscriminatorVerdict;
  navigatorMarkerDir: string;
  deltaJudge: SupersessionDeltaJudge;
}): Promise<AssessAlignment> {
  const nav = parseNavigatorAssessMarker(args.navigatorMarkerDir);
  const recorded = args.recordedVerdict;
  const classificationMatch = nav.classification === recorded.classification;
  if (!classificationMatch) {
    return {
      passed: false,
      classificationMatch: false,
      reason: `misclassification: navigator said "${nav.classification}" (${nav.nextStep}), ground truth is "${recorded.classification}" (${recorded.nextStep})`,
    };
  }
  // For superseded-shift, compare the flagged SET to the recorded set. Identical => trivially
  // equivalent (no judge). Otherwise the delta judge rules material-vs-benign.
  if (nav.classification === "superseded-shift") {
    const navSet = [...(nav.supersededTests ?? [])].sort();
    const recSet = [...(recorded.supersededTests ?? [])].sort();
    const identical = navSet.length === recSet.length && navSet.every((t, i) => t === recSet[i]);
    if (identical) {
      return { passed: true, classificationMatch: true, setEquivalent: true, reason: `aligned: navigator's superseded set is identical to the recorded ground truth (${navSet.length} tests)` };
    }
    const verdict = await args.deltaJudge({ navigatorSet: navSet, recordedSet: recSet, reason: (nav as { reason?: string }).reason });
    return {
      passed: verdict.equivalent,
      classificationMatch: true,
      setEquivalent: verdict.equivalent,
      reason: verdict.equivalent
        ? `aligned: navigator's superseded set is coverage-equivalent to the recorded ground truth (delta-judged)`
        : `material difference vs the recorded ground truth: ${(verdict.materialDifferences ?? []).join("; ") || "sets not coverage-equivalent"}`,
    };
  }
  // equivalent / regression / insufficient: classification match IS the whole gate (no set to diff).
  return { passed: true, classificationMatch: true, reason: `aligned: both "${nav.classification}"` };
}

/** Build the delta-judge prompt: given the navigator's flagged supersession set + the RECORDED
 *  ground-truth set, decide if they are COVERAGE-EQUIVALENT (supersede the same behaviors / cover
 *  the same dropped-symbol references, tolerating a borderline test either way) or differ
 *  MATERIALLY (the navigator MISSED a test the ground truth flags for the actual dropped symbol,
 *  or OVER-FLAGGED a still-valid test). Judges two CONCRETE answers , it does NOT re-derive. */
export function buildSupersessionDeltaPrompt(navigatorSet: string[], recordedSet: string[], reason?: string): string {
  return [
    `You are a strict senior engineer comparing two SUPERSESSION answers for the same failed build turn , a Navigator's flagged set of prior tests it judged superseded by an intentional change (e.g. a dropped column), and the RECORDED GROUND-TRUTH set the canonical navigator produced for the same turn.`,
    reason ? `The supersession reason (why these tests are retired): ${reason}` : ``,
    `Decide whether the two sets are COVERAGE-EQUIVALENT: do they supersede the SAME behaviors / cover the SAME dropped-symbol references? Two correct assessors legitimately differ at the margin (a fitness test that only INDIRECTLY references the dropped symbol may reasonably be flagged or not) , such a difference is BENIGN. A MATERIAL difference is: the navigator MISSED a test the ground truth flags for the ACTUAL dropped symbol (an under-flag that would leave the verify red), or OVER-FLAGGED a still-valid test the ground truth keeps (which would wrongly retire live coverage).`,
    `Return ONLY a JSON object on a single line: {"equivalent": <bool>, "materialDifferences": ["<a real miss or over-flag, empty when none>", ...]}. equivalent:true when the difference is only benign/borderline; equivalent:false with the specific material difference(s) named otherwise.`,
    ``,
    `NAVIGATOR set (${navigatorSet.length}):`,
    ...navigatorSet.map((t) => `  ${t}`),
    ``,
    `RECORDED GROUND-TRUTH set (${recordedSet.length}):`,
    ...recordedSet.map((t) => `  ${t}`),
  ].join("\n");
}

/** Parse a delta-judge reply into a verdict (tolerant; unparseable => NOT equivalent, fail-safe,
 *  so a judge that cannot answer never silently passes a divergent navigator set). */
export function parseSupersessionDeltaReply(reply: string): SupersessionDeltaVerdict {
  const m = reply.match(/\{[\s\S]*"equivalent"[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { equivalent?: unknown; materialDifferences?: unknown };
      const equivalent = obj.equivalent === true;
      const materialDifferences = Array.isArray(obj.materialDifferences) ? obj.materialDifferences.map(String) : undefined;
      return { equivalent, ...(materialDifferences ? { materialDifferences } : {}) };
    } catch {
      /* fall through */
    }
  }
  return { equivalent: false, materialDifferences: ["delta-judge reply not parseable"] };
}

/** The real delta judge: fixed-opus, judges the two concrete sets. */
export function makeSupersessionDeltaJudge(opts: { cwd: string }): SupersessionDeltaJudge {
  return ({ navigatorSet, recordedSet, reason }) =>
    spawnOpusJudge(
      opts.cwd,
      buildSupersessionDeltaPrompt(navigatorSet, recordedSet, reason),
      parseSupersessionDeltaReply,
      (msg) => ({ equivalent: false, materialDifferences: [msg] }),
    );
}

/** Build the regression-fidelity judge prompt: ask a FIXED model whether the candidate's regression
 *  diagnosis reaches the SAME root cause as the recorded ground truth AND whether its fixDirective would
 *  resolve the SAME failure. Benign = different wording / level of detail / an equivalent way to express
 *  the same cause+fix. MATERIAL = a different or wrong root cause, or a fix aimed at the wrong layer that
 *  would NOT resolve the actual failure (which would misdirect the driver). */
export function buildRegressionFidelityPrompt(
  candidate: { diagnosis?: string; fixDirective?: string },
  recorded: { diagnosis?: string; fixDirective?: string },
  failureSummary?: string,
): string {
  return [
    `You are a strict senior engineer comparing two REGRESSION assessments for the SAME failed build-verify , a Navigator's diagnosis + fix directive, and the RECORDED GROUND-TRUTH assessment the canonical navigator produced for the same failure.`,
    failureSummary ? `The failure being diagnosed: ${failureSummary}` : ``,
    `Both assessments already agree it is a genuine, driver-fixable regression. Decide whether the CANDIDATE reaches the SAME ROOT CAUSE and prescribes a fix that would ACTUALLY RESOLVE that failure , the way the ground truth does.`,
    `Benign (aligned:true): the candidate names the same underlying root cause and a fix that would resolve the same failure, even with different wording, a different level of detail, or a different-but-equivalent way to express the same change.`,
    `MATERIAL (aligned:false): the candidate blames a DIFFERENT or WRONG root cause, or its fix targets the WRONG layer / would NOT resolve the actual failure , anything that would MISDIRECT the driver into the wrong change.`,
    `Return ONLY a JSON object on a single line: {"aligned": <bool>, "materialDifferences": ["<the wrong root cause or misdirected fix, empty when none>", ...]}. aligned:true when the difference is only benign/wording; aligned:false with the specific material divergence(s) named otherwise.`,
    ``,
    `RECORDED GROUND-TRUTH diagnosis:`,
    recorded.diagnosis ?? "(none)",
    ``,
    `RECORDED GROUND-TRUTH fixDirective:`,
    recorded.fixDirective ?? "(none)",
    ``,
    `CANDIDATE diagnosis:`,
    candidate.diagnosis ?? "(none)",
    ``,
    `CANDIDATE fixDirective:`,
    candidate.fixDirective ?? "(none)",
  ].join("\n");
}

/** Parse a regression-fidelity reply into a verdict (tolerant; unparseable => NOT aligned, fail-safe, so
 *  a judge that cannot answer never silently passes a divergent diagnosis). */
export function parseRegressionFidelityReply(reply: string): RegressionFidelityVerdict {
  const m = reply.match(/\{[\s\S]*"aligned"[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { aligned?: unknown; materialDifferences?: unknown };
      const aligned = obj.aligned === true;
      const materialDifferences = Array.isArray(obj.materialDifferences) ? obj.materialDifferences.map(String) : undefined;
      return { aligned, ...(materialDifferences ? { materialDifferences } : {}) };
    } catch {
      /* fall through */
    }
  }
  return { aligned: false, materialDifferences: ["regression-fidelity judge reply not parseable"] };
}

/** The real regression-fidelity judge: fixed-opus, judges the two concrete regression assessments. */
export function makeRegressionFidelityJudge(opts: { cwd: string }): RegressionFidelityJudge {
  return ({ candidate, recorded, failureSummary }) =>
    spawnOpusJudge(
      opts.cwd,
      buildRegressionFidelityPrompt(candidate, recorded, failureSummary),
      parseRegressionFidelityReply,
      (msg) => ({ aligned: false, materialDifferences: [msg] }),
    );
}

/** Build the judge prompt: ask a FIXED model whether the candidate artifact conveys
 *  the SAME design/behavior as the recorded reference at this step. Meaning, not
 *  wording/slug/split. Demands a strict JSON verdict so the score is machine-read. */
export function buildJudgePrompt(step: TurnKey, reference: string, candidate: string): string {
  return [
    `You are a strict design reviewer scoring SEMANTIC similarity for a "${step}" design-step artifact.`,
    `The REFERENCE is a known-good artifact recorded at this step. The CANDIDATE is a newly produced artifact for the same step.`,
    `Judge whether the CANDIDATE conveys the SAME design intent and behavioral coverage as the REFERENCE.`,
    `Judge MEANING, not wording: different phrasing, different ids/slugs, or a different split of the same content across sections is FINE.`,
    `What matters: every material behavior, entity, component, decision, or constraint the REFERENCE expresses is present (equivalently) in the CANDIDATE. Extra content in the CANDIDATE is fine and not penalized.`,
    `Return ONLY a JSON object on a single line: {"score": <0..1 float>, "missing": ["<material intent the CANDIDATE dropped>", ...]}. score 1.0 = full semantic coverage; lower as material intent is missing. missing lists ONLY dropped items (empty array when none).`,
    ``,
    `REFERENCE:`,
    "```json",
    reference,
    "```",
    ``,
    `CANDIDATE:`,
    "```json",
    candidate,
    "```",
  ].join("\n");
}

/** Build the FUNCTIONAL-similarity judge prompt for a BUILD turn's output (code or
 *  tests). Unlike the design prompt (same intent), this asks for FUNCTIONAL
 *  equivalence: same behaviors tested / same functionality implemented / same layer
 *  responsibilities , explicitly ignoring naming, formatting, and structural
 *  arrangement (code varies more than prose, hence the looser bar). */
export function buildFunctionalJudgePrompt(kind: BuildOutputKind, reference: string, candidate: string): string {
  const what =
    kind === "tests"
      ? `These are TEST files. Judge whether the CANDIDATE tests assert the SAME behaviors / acceptance criteria as the REFERENCE tests , the same things are verified (endpoints, validations, persistence invariants, edge/empty cases, migration reversibility).`
      : `These are CODE files. Judge whether the CANDIDATE code implements the SAME functionality as the REFERENCE , the same operations/endpoints, the same layer responsibilities (boundary/route, service, repository, model), the same persistence behavior.`;
  return [
    `You are a strict senior engineer scoring FUNCTIONAL similarity of ${kind} produced for one build turn.`,
    `The REFERENCE is the known-good ${kind} recorded for this story in a prior build. The CANDIDATE is newly produced ${kind} for the same story.`,
    what,
    `Judge FUNCTION, not form: different file names, symbol names, ordering, formatting, or a different structural split of the SAME behavior/functionality is FINE and must NOT lower the score. Only MISSING or CHANGED behavior/functionality lowers it. Extra behavior in the CANDIDATE is fine and not penalized.`,
    `Return ONLY a JSON object on a single line: {"score": <0..1 float>, "missing": ["<behavior/functionality the CANDIDATE dropped or changed>", ...]}. score 1.0 = full functional coverage; lower as material behavior/functionality is missing or altered. missing lists ONLY dropped/changed items (empty array when none).`,
    ``,
    `REFERENCE ${kind}:`,
    "```",
    reference,
    "```",
    ``,
    `CANDIDATE ${kind}:`,
    "```",
    candidate,
    "```",
  ].join("\n");
}

/** Build the DISCRIMINATOR prompt for a build turn's code/tests. Unlike the flat
 *  functional-similarity prompt (which returns only a score), this mirrors the
 *  navigator ASSESS turn: the judge must CLASSIFY the candidate and name the NEXT STEP
 *  it warrants. Crucially, a CLEAN verdict (equivalent/accept , the candidate needs no
 *  refactor and introduced no regression) is the BEST possible result , the candidate
 *  converged cleaner than the recorded baseline that needed the assess->repair spiral ,
 *  and must score HIGH, never be treated as a miss. */
export function buildDiscriminatorPrompt(kind: BuildOutputKind, reference: string, candidate: string): string {
  const what =
    kind === "tests"
      ? `These are TEST files a navigator authored. The REFERENCE is the known-good tests recorded for this story.`
      : `These are CODE files a driver produced. The REFERENCE is the known-good code recorded for this story (after its full self-heal).`;
  return [
    `You are a strict senior engineer acting as an independent DISCRIMINATOR over ${kind} produced for one build turn, mirroring what a Navigator does when it ASSESSES a build.`,
    what,
    `Judge FUNCTION, not form: different file/symbol names, ordering, formatting, or a different structural split of the SAME behavior is FINE and must NOT lower the verdict.`,
    ``,
    `CLASSIFY the CANDIDATE into exactly one:`,
    `  - "equivalent"      : the candidate implements/asserts the same functionality with NO gap and NO regression. This is the BEST, IDEAL outcome , the candidate is done and needs no follow-up (it converged cleaner / better than the reference, which may have needed extra repair turns). Score it HIGH (>= 0.9).`,
    `  - "superseded-shift": the candidate legitimately CHANGES behavior the reference/prior tests encode (the latest requirement wins), so some PRIOR tests are now superseded and should be permissively refactored , NOT a bug.`,
    `  - "regression"      : the candidate is genuinely WRONG (missing/broken functionality the requirement needs). If a driver could fix it, provide a concrete fixDirective; the diagnosis states the root cause.`,
    `  - "insufficient"    : the candidate is unrecoverable or the problem needs a human / a design or spec change (NO safe driver fix). This is the ONLY failing verdict.`,
    ``,
    `Then name the NEXT STEP: "accept" (equivalent), "permissive-refactor-superseded" (superseded-shift), "driver-repair-with-directive" (fixable regression), or "escalate" (insufficient).`,
    ``,
    `Return ONLY a JSON object on a single line: {"score": <0..1>, "classification": "<one of the four>", "nextStep": "<one of the four>", "missing": ["<dropped/changed behavior>", ...], "diagnosis": "<root cause, regression only>", "fixDirective": "<what a driver should change, fixable regression only>", "supersededTests": ["<prior test path>", ...]}. Omit diagnosis/fixDirective/supersededTests when not applicable. A clean "equivalent" verdict with empty missing is the best answer , do NOT invent problems.`,
    ``,
    `REFERENCE ${kind}:`,
    "```",
    reference,
    "```",
    ``,
    `CANDIDATE ${kind}:`,
    "```",
    candidate,
    "```",
  ].join("\n");
}

/** Build the RED coverage+faithfulness judge prompt: judge a navigator's authored
 *  tests against the TEST-LIST SPEC (+ the story's ACs), NOT turn-for-turn against
 *  recorded tests. Two dimensions: (coverage) every test-list item / AC is covered by
 *  a test; (faithfulness) each test actually asserts the requirement its item
 *  describes (right behavior/invariant, owns its DB state). The bar is the SPEC. */
export function buildRedCoverageJudgePrompt(testListJson: string, acsJson: string, candidateTests: string): string {
  return [
    `You are a strict senior engineer scoring a Navigator's authored RED tests against the TEST-LIST SPEC for a story , NOT against any recorded tests. The bar is the SPEC: do these tests correctly encode what the test list + acceptance criteria require?`,
    `Judge two things:`,
    `  (1) COVERAGE , every item in the test list (and every acceptance criterion) is covered by at least one produced test.`,
    `  (2) FAITHFULNESS , each test actually ASSERTS the requirement its test-list item describes (the right behavior / invariant / edge case), and any DB-writing test owns its own state (a per-run-unique key), not a shared/absolute whole-table assertion.`,
    `Judge FUNCTION, not form: test/file/symbol names, ordering, and structure are irrelevant , only whether the requirements are covered + faithfully asserted.`,
    `Return ONLY a JSON object on a single line: {"score": <0..1>, "missing": ["<test-list item or AC that is uncovered OR unfaithfully asserted>", ...]}. score 1.0 = every item covered + faithful; lower as items are missing or wrongly asserted. missing lists ONLY the gaps (empty array when none).`,
    ``,
    `TEST LIST (the spec):`,
    "```json",
    testListJson,
    "```",
    ``,
    `ACCEPTANCE CRITERIA:`,
    "```json",
    acsJson,
    "```",
    ``,
    `CANDIDATE TESTS:`,
    "```",
    candidateTests,
    "```",
  ].join("\n");
}

/** The valid discriminator classifications + next steps (for parse validation). */
const BUILD_CLASSIFICATIONS = new Set<BuildClassification>(["equivalent", "superseded-shift", "regression", "insufficient"]);
const BUILD_NEXT_STEPS = new Set<BuildNextStep>(["accept", "permissive-refactor-superseded", "driver-repair-with-directive", "escalate"]);

/** Parse a DISCRIMINATOR reply into a classified verdict. Tolerant like parseJudgeReply,
 *  but an UNPARSEABLE reply OR an unknown classification defaults to
 *  insufficient/escalate (fail-safe: a judge that cannot classify must NOT pass the
 *  candidate , the same posture as score 0 on the flat judge). */
export function parseDiscriminatorReply(reply: string): DiscriminatorVerdict {
  const base = parseJudgeReply(reply);
  const m = reply.match(/\{[\s\S]*"classification"[\s\S]*\}/);
  const fail: DiscriminatorVerdict = { ...base, classification: "insufficient", nextStep: "escalate" };
  if (!m) return fail;
  try {
    const obj = JSON.parse(m[0]) as {
      classification?: unknown;
      nextStep?: unknown;
      diagnosis?: unknown;
      fixDirective?: unknown;
      supersededTests?: unknown;
    };
    const classification = obj.classification as BuildClassification;
    if (!BUILD_CLASSIFICATIONS.has(classification)) return fail;
    const nextStep = BUILD_NEXT_STEPS.has(obj.nextStep as BuildNextStep) ? (obj.nextStep as BuildNextStep) : defaultNextStep(classification);
    return {
      ...base,
      classification,
      nextStep,
      ...(typeof obj.diagnosis === "string" ? { diagnosis: obj.diagnosis } : {}),
      ...(typeof obj.fixDirective === "string" && obj.fixDirective ? { fixDirective: obj.fixDirective } : {}),
      ...(Array.isArray(obj.supersededTests) ? { supersededTests: obj.supersededTests.map(String) } : {}),
    };
  } catch {
    return fail;
  }
}

/** The next step a classification implies when the judge omitted/garbled it. */
function defaultNextStep(c: BuildClassification): BuildNextStep {
  switch (c) {
    case "equivalent":
      return "accept";
    case "superseded-shift":
      return "permissive-refactor-superseded";
    case "regression":
      return "driver-repair-with-directive";
    default:
      return "escalate";
  }
}

/** Parse the judge's reply into a verdict. Tolerant: extracts the first JSON object
 *  with a numeric `score`. A reply without a parseable score is treated as score 0
 *  (a judge that could not answer must not silently pass the candidate). */
export function parseJudgeReply(reply: string): SemanticVerdict {
  const m = reply.match(/\{[\s\S]*?"score"[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { score?: unknown; missing?: unknown };
      const score = typeof obj.score === "number" ? Math.max(0, Math.min(1, obj.score)) : 0;
      const missing = Array.isArray(obj.missing) ? obj.missing.map(String) : undefined;
      return { score, missing, raw: reply };
    } catch {
      /* fall through */
    }
  }
  return { score: 0, missing: ["judge reply not parseable as a score"], raw: reply };
}

/** The REAL judge: a fixed-model `claude -p` (opus by default), constant across
 *  candidates so the bar never moves with the thing being measured. Uses
 *  --output-format json + --strict-mcp-config + acceptEdits (no writes needed, but
 *  consistent with the drive's headless posture). Reads the assistant text from the
 *  json result and parses the verdict. cwd is the project dir. */
export function makeOpusJudge(opts: { cwd: string; model?: string }): SemanticJudge {
  const model = opts.model ?? "opus";
  return ({ step, reference, candidate, functional }) =>
    new Promise<SemanticVerdict>((resolve) => {
      // A build-output comparison uses the FUNCTIONAL-equivalence prompt (looser, code/
      // tests); a design artifact uses the semantic-intent prompt.
      const prompt = functional
        ? buildFunctionalJudgePrompt(functional, reference, candidate)
        : buildJudgePrompt(step, reference, candidate);
      execFile(
        "claude",
        ["-p", prompt, "--model", model, "--permission-mode", "acceptEdits", "--strict-mcp-config", "--output-format", "json"],
        { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000 },
        (err, stdout) => {
          if (err && !stdout) {
            // A judge that could not run must not silently pass the candidate.
            resolve({ score: 0, missing: [`judge spawn failed: ${err.message}`] });
            return;
          }
          // claude -p --output-format json wraps the reply in { result: "<text>" }.
          let text = stdout;
          try {
            const parsed = JSON.parse(stdout) as { result?: string };
            if (typeof parsed.result === "string") text = parsed.result;
          } catch {
            /* stdout was not the json envelope; parse it directly */
          }
          resolve(parseJudgeReply(text));
        },
      );
    });
}

/** Spawn the FIXED-opus judge on a prepared prompt and parse the reply with `parse`.
 *  Shared by the discriminator + design judges. opus is HARDCODED for the
 *  discriminator (the bar must not move with the thing being measured); a spawn
 *  failure resolves via `onFail` (fail-safe: never silently pass). */
function spawnOpusJudge<T>(cwd: string, prompt: string, parse: (text: string) => T, onFail: (msg: string) => T): Promise<T> {
  return new Promise<T>((resolve) => {
    execFile(
      "claude",
      ["-p", prompt, "--model", "opus", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--output-format", "json"],
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(onFail(`judge spawn failed: ${err.message}`));
          return;
        }
        let text = stdout;
        try {
          const parsed = JSON.parse(stdout) as { result?: string };
          if (typeof parsed.result === "string") text = parsed.result;
        } catch {
          /* stdout was not the json envelope; parse it directly */
        }
        resolve(parse(text));
      },
    );
  });
}

/** The build-code DISCRIMINATOR judge: a FIXED-opus `claude -p` (model NON-overridable,
 *  by design , the discriminator is the constant bar an assess turn's judgment is
 *  measured against + the independent oracle the navigator-assess alignment check
 *  reuses, so its model must never vary). Given the reference + candidate build output,
 *  returns a classified DiscriminatorVerdict (classification + next step). An
 *  unparseable / failed judge resolves to insufficient/escalate (fail-safe). */
export function makeBuildDiscriminatorJudge(opts: { cwd: string }): (args: { kind: BuildOutputKind; reference: string; candidate: string }) => Promise<DiscriminatorVerdict> {
  return ({ kind, reference, candidate }) =>
    spawnOpusJudge(
      opts.cwd,
      buildDiscriminatorPrompt(kind, reference, candidate),
      parseDiscriminatorReply,
      (msg) => ({ score: 0, missing: [msg], classification: "insufficient", nextStep: "escalate" }),
    );
}

/** A REVIEW/REFLECT verdict as produced by the navigator. For REVIEW: {"refactor": bool,
 *  "notes": "..."}. For REFLECT: {"version": 1, "passed": bool, "findings": [...]}. */
export interface VerdictOutput {
  refactor?: boolean; // REVIEW only
  passed?: boolean;   // REFLECT only
  version?: number;   // REFLECT only
  notes?: string;     // REVIEW only
  findings?: string[]; // REFLECT only
}

/** Parse a verdict file (review or reflect) from JSON into the VerdictOutput shape. */
export function parseVerdictFile(body: string): VerdictOutput {
  try {
    return JSON.parse(body) as VerdictOutput;
  } catch {
    return {};
  }
}

/** Build the VERDICT-ALIGNMENT judge prompt: given the RECORDED verdict + the CANDIDATE
 *  verdict from a review or reflect turn, decide if the DECISION matches (refactor? /
 *  passed?). Hard gate: decisions must align. For REVIEW: also check the notes are
 *  substantive + consistent with recorded critique (not a judge-score but a binary match:
 *  either the navigator is reasoning clearly or not). Fail-safe: an unparseable verdict
 *  or a decision mismatch always fails. */
export function buildVerdictAlignmentJudgePrompt(recordedVerdict: VerdictOutput, candidateVerdict: VerdictOutput, kind: "review" | "reflect"): string {
  const recordedJson = JSON.stringify(recordedVerdict, null, 2);
  const candidateJson = JSON.stringify(candidateVerdict, null, 2);
  if (kind === "review") {
    return [
      `You are a strict senior engineer comparing two REVIEW verdicts for the same driver turn.`,
      `The RECORDED GROUND-TRUTH verdict is the canonical navigator's review for this turn. The CANDIDATE is a newly produced review verdict.`,
      ``,
      `Judge two things:`,
      `  (1) DECISION: does the candidate's refactor decision match the recorded decision (both true, or both false)? This is a HARD gate: mismatched decisions always fail.`,
      `  (2) SUBSTANCE: if decisions match, are the candidate's notes substantive and consistent with the recorded critique? Substantive means: specific NFR analysis + concrete observations. Consistency means: the candidate's notes support the same decision (e.g. if refactor=false, the notes say "no improvement warranted" or similar; if refactor=true, the notes cite specific NFR gaps).`,
      ``,
      `Return ONLY a JSON object on a single line: {"decisionMatch": <bool>, "substantive": <bool>, "reason": "<brief explanation>"}. decisionMatch is hard-required; substantive is only checked when decisionMatch=true.`,
      ``,
      `RECORDED verdict:`,
      "```json",
      recordedJson,
      "```",
      ``,
      `CANDIDATE verdict:`,
      "```json",
      candidateJson,
      "```",
    ].join("\n");
  } else {
    // kind === "reflect"
    return [
      `You are a strict senior engineer comparing two REFLECT verdicts for the same story end.`,
      `The RECORDED GROUND-TRUTH verdict is the canonical navigator's reflect for this story. The CANDIDATE is a newly produced reflect verdict.`,
      ``,
      `Judge two things:`,
      `  (1) DECISION: does the candidate's passed decision match the recorded decision (both true, or both false)? This is a HARD gate: mismatched decisions always fail.`,
      `  (2) SUBSTANCE: if decisions match, are the candidate's findings substantive and consistent with the recorded findings? Substantive means: specific design gaps / inconsistencies identified (e.g. "test coverage missing <item>", "layer boundary violation in <file>"). Consistency means: the candidate identifies real gaps that align with the recorded findings (or correctly finds none when passed=true).`,
      ``,
      `Return ONLY a JSON object on a single line: {"decisionMatch": <bool>, "substantive": <bool>, "reason": "<brief explanation>"}. decisionMatch is hard-required; substantive is only checked when decisionMatch=true.`,
      ``,
      `RECORDED verdict:`,
      "```json",
      recordedJson,
      "```",
      ``,
      `CANDIDATE verdict:`,
      "```json",
      candidateJson,
      "```",
    ].join("\n");
  }
}

/** Parse a verdict-alignment judge reply into a pass/fail outcome. */
export interface VerdictAlignmentOutcome {
  passed: boolean;
  decisionMatch: boolean;
  substantive?: boolean;
  reason: string;
}

export function parseVerdictAlignmentReply(reply: string): VerdictAlignmentOutcome {
  const m = reply.match(/\{[\s\S]*"decisionMatch"[\s\S]*\}/);
  if (!m) {
    return { passed: false, decisionMatch: false, reason: "verdict-alignment judge reply not parseable" };
  }
  try {
    const obj = JSON.parse(m[0]) as { decisionMatch?: unknown; substantive?: unknown; reason?: unknown };
    const decisionMatch = obj.decisionMatch === true;
    const substantive = obj.substantive === true;
    const reason = typeof obj.reason === "string" ? obj.reason : "no reason provided";
    // Hard gate: decisionMatch must be true. If true, check substantive (if provided).
    const passed = decisionMatch && (obj.substantive === undefined ? true : substantive);
    return { passed, decisionMatch, ...(obj.substantive !== undefined ? { substantive } : {}), reason };
  } catch {
    return { passed: false, decisionMatch: false, reason: "verdict-alignment judge reply not parseable" };
  }
}

/** The VERDICT-ALIGNMENT judge: a FIXED-opus `claude -p` that compares a recorded verdict
 *  (ground truth from the canonical navigator) against a candidate verdict from a review or
 *  reflect turn. Decisions must align (hard gate); substance is checked when decisions match.
 *  Fail-safe: unparseable or mismatched decisions always fail. */
export function makeVerdictAlignmentJudge(opts: { cwd: string }): (args: { recordedVerdict: VerdictOutput; candidateVerdict: VerdictOutput; kind: "review" | "reflect" }) => Promise<VerdictAlignmentOutcome> {
  return ({ recordedVerdict, candidateVerdict, kind }) =>
    spawnOpusJudge(
      opts.cwd,
      buildVerdictAlignmentJudgePrompt(recordedVerdict, candidateVerdict, kind),
      parseVerdictAlignmentReply,
      (msg) => ({ passed: false, decisionMatch: false, reason: msg }),
    );
}

// ── The DRIVER-TURN discriminator: judge a driver candidate by the NEXT-STEP navigator's determination ──
//
// A driver candidate is judged the way the real workflow judges it: run the navigator evaluation turn
// that actually follows that driver turn (pinned opus-high, done by the harness), then compare THAT
// navigator's determination to the recorded navigator determination at the same step. The verdict is
// DIRECTIONAL on the issues found (candidate's issues vs the recorded issues):
//   - PASS               , the candidate's determination reaches the SAME / coverage-equivalent conclusion.
//   - PASS-WITH-HONORS    , the candidate's determination found FEWER / NO issues where recorded found some
//                           (better than the recorded run). ALWAYS surfaced/flagged, never a silent pass.
//   - FAIL                , the candidate's determination found MORE / DIFFERENT issues than recorded.
// None of the existing judges model this direction, so this is the one new discriminator; it REUSES the
// existing parsers + judges (parseNavigatorAssessMarker / makeSupersessionDeltaJudge for assess;
// parseVerdictFile / makeVerdictAlignmentJudge for review) and adds only the directional decision on top.

/** The directional outcome of comparing a candidate driver turn's next-step navigator determination to
 *  the recorded one. `verdict` is the trichotomy; `betterThanRecorded` flags the with-honors case so the
 *  report can surface it distinctly. `recordedClass`/`candidateClass` are the two assess classifications
 *  (or "review:refactor"/"review:clean" for the review evaluator) for the record. */
export interface NextStepOutcome {
  verdict: "pass" | "pass-with-honors" | "fail";
  recordedClass: string;
  candidateClass: string;
  reason: string;
  /** true only on pass-with-honors , the candidate's determination was cleaner than the recorded run. */
  betterThanRecorded?: boolean;
}

/** ASSESS-evaluator directional comparison (driver-green, driver-repair). Both determinations are read
 *  from their marker DIRS via parseNavigatorAssessMarker (superseded-tests.json / regression-assessment.json
 *  / none => equivalent). Directional rule: candidate issues ⊆ recorded issues => pass (strict ⊂ => honors);
 *  candidate ⊋ / different / worse => fail. The superseded SET delta is judged by the shared
 *  makeSupersessionDeltaJudge (never re-implemented here). */
async function evaluateAssessNextStep(args: {
  recordedMarkerDir: string;
  candidateMarkerDir: string;
  deltaJudge: SupersessionDeltaJudge;
  regressionJudge?: RegressionFidelityJudge;
  failureSummary?: string;
}): Promise<NextStepOutcome> {
  const recorded = parseNavigatorAssessMarker(args.recordedMarkerDir);
  const candidate = parseNavigatorAssessMarker(args.candidateMarkerDir);
  const rc = recorded.classification;
  const cc = candidate.classification;
  const base = { recordedClass: rc, candidateClass: cc };

  // Both superseded-shift: SAME rung on the ladder below , the flagged SET decides same/better/worse
  // (identical / coverage-equivalent => same; strict subset => fewer issues => honors; superset / divergent
  // set => more/different => worse). The shared makeSupersessionDeltaJudge owns the set comparison.
  if (rc === "superseded-shift" && cc === "superseded-shift") {
    const recSet = [...(recorded.supersededTests ?? [])].sort();
    const navSet = [...(candidate.supersededTests ?? [])].sort();
    const recIn = new Set(recSet);
    const navIn = new Set(navSet);
    const identical = navSet.length === recSet.length && navSet.every((t, i) => t === recSet[i]);
    if (identical) {
      return { ...base, verdict: "pass", reason: `candidate's superseded set is identical to the recorded ground truth (${navSet.length} tests)` };
    }
    const candidateSubset = navSet.every((t) => recIn.has(t)) && navSet.length < recSet.length; // strict ⊂
    const candidateSuperset = recSet.every((t) => navIn.has(t)) && navSet.length > recSet.length; // ⊋
    const verdict = await args.deltaJudge({ navigatorSet: navSet, recordedSet: recSet, reason: (candidate as { reason?: string }).reason });
    if (verdict.equivalent) {
      return { ...base, verdict: "pass", reason: `candidate's superseded set is coverage-equivalent to the recorded ground truth (delta-judged)` };
    }
    if (candidateSubset) {
      return { ...base, verdict: "pass-with-honors", betterThanRecorded: true, reason: `candidate flagged a strict subset of the recorded superseded set (${navSet.length} of ${recSet.length}) , fewer issues: ${(verdict.materialDifferences ?? []).join("; ")}` };
    }
    return { ...base, verdict: "fail", reason: `candidate's superseded set differs materially from the recorded ground truth${candidateSuperset ? " (over-flagged more tests)" : ""}: ${(verdict.materialDifferences ?? []).join("; ") || "sets not coverage-equivalent"}` };
  }

  // Both regression (SAME rung): class-match alone is NOT enough , a candidate can land the regression
  // class with a WRONG root cause or a fix aimed at the wrong layer, which would MISDIRECT the driver into
  // the wrong change (the navigator-assess panel finding: two fast candidates "held the class" but
  // misdiagnosed). When a fidelity judge is supplied, grade the diagnosis + fixDirective CONTENT against
  // the recorded ground truth , the regression analogue of the superseded-shift SET delta: aligned => pass;
  // a material divergence => fail. Absent judge => fall through to the class-only resolution ladder (legacy).
  if (rc === "regression" && cc === "regression" && args.regressionJudge) {
    const verdict = await args.regressionJudge({
      candidate: { diagnosis: candidate.diagnosis, fixDirective: candidate.fixDirective },
      recorded: { diagnosis: recorded.diagnosis, fixDirective: recorded.fixDirective },
      ...(args.failureSummary ? { failureSummary: args.failureSummary } : {}),
    });
    if (verdict.aligned) {
      return { ...base, verdict: "pass", reason: `candidate's regression assessment reaches the same root cause + a resolving fix as the recorded ground truth (fidelity-judged)` };
    }
    return { ...base, verdict: "fail", reason: `candidate's regression assessment diverges materially from the recorded ground truth: ${(verdict.materialDifferences ?? []).join("; ") || "different root cause / misdirected fix"}` };
  }

  // RESOLUTION LADDER , the "same or better" directional scorer over the next-turn navigator
  // determination classes. A HIGHER rung is a MORE-RESOLVED outcome (the code is closer to correct-and-done):
  //   equivalent (3)       : the navigator found the code clean , fully resolved.
  //   superseded-shift (2) : the code is CORRECT; only PRIOR tests are now obsolete (a permissive refactor
  //                          remains). The AC's change SUCCEEDED , strictly MORE resolved than a regression.
  //   regression (1)       : the code is WRONG (broke behavior the AC did not intend).
  //   insufficient (0)     : a failed verify the navigator could not even diagnose , least resolved.
  // "same or better" = candidate rung >= recorded rung. This is the layered scorer that recognizes, e.g., a
  // candidate reaching `superseded-shift` as BETTER than a recorded `regression` (the drop/change resolved;
  // only test bookkeeping is left) , the case that matters for contract-change turns.
  const RANK: Record<string, number> = { equivalent: 3, "superseded-shift": 2, regression: 1, insufficient: 0 };
  const rr = RANK[rc] ?? 1;
  const cr = RANK[cc] ?? 1;
  if (cr > rr) {
    return { ...base, verdict: "pass-with-honors", betterThanRecorded: true, reason: `candidate's next-turn navigator reached a MORE-RESOLVED determination "${cc}" than the recorded "${rc}" (resolution ladder: ${rc} -> ${cc})` };
  }
  if (cr < rr) {
    return { ...base, verdict: "fail", reason: `candidate's next-turn navigator determination "${cc}" is LESS resolved than the recorded "${rc}" (resolution ladder)` };
  }
  return { ...base, verdict: "pass", reason: `candidate's next-turn navigator reached an equally-resolved determination ("${cc}", same as recorded)` };
}

/** REVIEW-evaluator comparison for driver-REFACTOR (RESOLUTION semantics, not match). The corpus has no
 *  navigator turn after the refactor; the recorded review verdict is the UPSTREAM directive the refactor
 *  executes (refactor=true + the issue notes). A good candidate refactor RESOLVES that issue, so its OWN
 *  post-refactor review verdict should come back refactor=false. Directional:
 *   - candidate review refactor=false => PASS (the flagged cleanup landed; nothing left to refactor).
 *   - candidate review still refactor=true => FAIL (issue not resolved) , the alignment judge confirms the
 *     candidate's notes are still about the SAME issue the recorded directive raised (a different, genuinely
 *     new issue is also a FAIL: the refactor introduced/left a different problem).
 *  Uses makeVerdictAlignmentJudge to check the candidate's review notes concern the recorded directive's
 *  issue (not to require decision-MATCH , here a matching refactor=true would mean "unresolved"). */
async function evaluateReviewResolution(args: {
  recordedDirective: VerdictOutput; // the recorded upstream review (refactor:true + issue notes)
  candidateReview: VerdictOutput; // the candidate's OWN post-refactor review verdict
  verdictJudge: (a: { recordedVerdict: VerdictOutput; candidateVerdict: VerdictOutput; kind: "review" | "reflect" }) => Promise<VerdictAlignmentOutcome>;
}): Promise<NextStepOutcome> {
  const base = { recordedClass: "review:refactor-requested", candidateClass: args.candidateReview.refactor ? "review:refactor-requested" : "review:clean" };
  // The candidate's post-refactor review says the code is clean => the flagged cleanup was resolved => PASS.
  if (args.candidateReview.refactor === false) {
    return { ...base, verdict: "pass", reason: `candidate's post-refactor review is clean (refactor=false) , the recorded directive's issue was resolved` };
  }
  // Still refactor-requested: confirm (via the alignment judge) whether it is the SAME issue (unresolved)
  // or a genuinely new one , both are FAIL, but we name which for the record.
  const align = await args.verdictJudge({ recordedVerdict: args.recordedDirective, candidateVerdict: args.candidateReview, kind: "review" });
  return {
    ...base,
    verdict: "fail",
    reason: align.decisionMatch
      ? `candidate's post-refactor review STILL requests refactor for the same issue (unresolved): ${align.reason}`
      : `candidate's post-refactor review requests refactor for a DIFFERENT issue than the recorded directive (introduced/left a new problem): ${align.reason}`,
  };
}

/** Evaluate a driver candidate by its NEXT-STEP navigator determination vs the recorded determination.
 *  `evaluatorKind` picks the comparison: "assess" (driver-green, driver-repair , directional over the
 *  recorded vs candidate assess markers) or "review" (driver-refactor , resolution semantics: the
 *  candidate's post-refactor review must come back clean). Reuses the existing parsers + judges; the only
 *  new logic is the directional trichotomy (pass / pass-with-honors / fail). */
export async function evaluateNextStepDetermination(args: {
  evaluatorKind: "assess" | "review";
  /** The recorded next-step determination: a marker DIR (assess) whose files parseNavigatorAssessMarker
   *  reads, OR (review) the recorded upstream review VerdictOutput (the directive). */
  recordedMarkerDir?: string;
  recordedReviewDirective?: VerdictOutput;
  /** The candidate's produced next-step determination: a marker DIR (assess), OR (review) the candidate's
   *  OWN post-refactor review VerdictOutput. */
  candidateMarkerDir?: string;
  candidateReview?: VerdictOutput;
  deltaJudge: SupersessionDeltaJudge;
  verdictJudge: (a: { recordedVerdict: VerdictOutput; candidateVerdict: VerdictOutput; kind: "review" | "reflect" }) => Promise<VerdictAlignmentOutcome>;
  /** OPTIONAL regression-fidelity judge: when both determinations are `regression` (same rung), grade the
   *  diagnosis + fixDirective CONTENT against the recorded ground truth , class-match alone can pass a
   *  candidate that landed the regression class with a WRONG root cause. Absent => class-only (legacy). */
  regressionJudge?: RegressionFidelityJudge;
  /** OPTIONAL failure context for the regression-fidelity judge (the failed-verify summary). */
  failureSummary?: string;
}): Promise<NextStepOutcome> {
  if (args.evaluatorKind === "assess") {
    if (args.recordedMarkerDir === undefined || args.candidateMarkerDir === undefined) {
      throw new Error("evaluateNextStepDetermination(assess) requires recordedMarkerDir + candidateMarkerDir");
    }
    return evaluateAssessNextStep({
      recordedMarkerDir: args.recordedMarkerDir,
      candidateMarkerDir: args.candidateMarkerDir,
      deltaJudge: args.deltaJudge,
      ...(args.regressionJudge ? { regressionJudge: args.regressionJudge } : {}),
      ...(args.failureSummary ? { failureSummary: args.failureSummary } : {}),
    });
  }
  if (args.recordedReviewDirective === undefined || args.candidateReview === undefined) {
    throw new Error("evaluateNextStepDetermination(review) requires recordedReviewDirective + candidateReview");
  }
  return evaluateReviewResolution({ recordedDirective: args.recordedReviewDirective, candidateReview: args.candidateReview, verdictJudge: args.verdictJudge });
}
