// build-role-chains: the per-role chain CATALOGUE + runner for BUILD turns (navigator/driver),
// the build-lane sibling of role-chains.ts (which is design-lane). The build lane is 84% of a
// run's time (navigator alone 50%), so it is the real optimization target. Each entry names a
// chain dir (its <dir>-seed replay + <dir>-live claude manifests), the start action, what the
// live role produces, and the prompt. ONE isolated build turn, the recorded PRE-turn state
// replayed in as a CODE TREE (+ any markers), the real agent authoring its output.
//
// NAVIGATOR turns run LEAN (no cloud): RED authors tests, ASSESS discriminates a failed GREEN and
// writes a marker – neither needs a running app or DB. That is why navigator turns get the same
// throwaway-.consort substrate as the design roles. DRIVER turns (green/refactor/repair) write code
// that must pass honest-GREEN against a live Lakebase branch – they DO NOT run lean; see the
// driver-phase SEAM at the bottom of this file.
//
// Starting story: F6-split-tracking-code / S3-stock-shows-split-fields (the richest recorded
// turn variety – RED, GREEN, three assess heal-turns, repair, two green-supersedes, review,
// refactor). BUILD_STORY_INDEX=2 (S3 is the 3rd of F6's 3 stories) – the recorded-build
// reference resolves positionally by that index.

import { join } from "node:path";
import { ARTIFACT_ROOT, cycleDir, acReviewVerdictJson } from "../config/consort-paths.js";
import { runIntegrationChain } from "../orchestrator/scenarios/integration-chain.js";
import type { StepManifest } from "../orchestrator/steps/manifest.js";
import type { StepAgent } from "../orchestrator/agents/agent-types.js";
import type { ManifestTurn } from "../orchestrator/runners/manifest-runner.js";
import type { WorkflowAction } from "../orchestrator/workflow/workflow-vocabulary.js";

/** Kit-root-relative locations the build chains read from. The build corpus (design artifacts +
 *  recorded-build code trees) lives under the rerecord scenario, NOT tests/integration/intake
 *  (which holds only the F1 design artifacts). */
export const BUILD_MANIFESTS_REL = "tests/integration/manifests";
// The experiments read their seeds + references from a SELF-CONTAINED evaluation-fixtures dir – a
// snapshot of exactly the recorded artifacts these chains need (recorded-artifacts/ design +
// recorded-build/ code trees + the ground-truth assess marker), copied out of the live corpus. So
// a durable experiment re-run / evidence review does NOT depend on the scenario corpus being
// present (the corpus is a moving reference; the fixtures are pinned). See evaluation/README.md.
export const BUILD_CORPUS_REL = "consort/evaluation/reference-assets/stockflow";
export const BUILD_FEATURE = "F6-split-tracking-code";
// RED runs on S3 (the richest test-authoring story). Its live green is proven there.
export const BUILD_STORY = "S3-stock-shows-split-fields";
export const BUILD_AC = "AC1-split-fields-shown";
/** S3 is the 3rd of F6's 3 stories (S1, S2, S3) – the recorded-build reference is matched
 *  positionally by this index (slugs differ across corpora). */
export const BUILD_STORY_INDEX = 2;

// ASSESS runs on S1 – the PURE-SUPERSESSION case the deterministic pre-localization was built
// for (its green-failure carries supersededTestRefs; the failure IS the column-drop, fully
// pre-localizable). S3's assess is inherently NON-pre-localizable (a missing CLIENT component the
// gate cannot localize), so the navigator must read the client tree – the expensive open-ended
// path, not the fast flag-the-pre-localized-set path this chain is meant to exercise.
export const ASSESS_STORY = "S1-split-columns-migration";
export const ASSESS_AC = "AC1-batch-serial-columns-added";
/** S1 is the 1st of F6's 3 stories – positional index 0 for the recorded-build reference. */
export const ASSESS_STORY_INDEX = 0;

/** The build chains start from the PO seed (the replay seed manifest matches it + overlays the
 *  recorded pre-turn state), then route to the live build action. Same PO_SEED as the design
 *  chains – the seed is a replay, the routing is what reaches the build turn. */
export const BUILD_PO_SEED: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };

const REPORT_BLOCK =
  "As the LAST thing in your reply, emit a fenced report block:\n" +
  "```agent-report\n" +
  `[{ "level": "info", "event": "artifact.written", "message": "<one line: what you wrote>" }]\n` +
  "```\n";
const NO_SHELL =
  ` Then STOP – do NOT run any shell command, do NOT run npx or ./scripts/lk, do NOT self-verify (the orchestrator validates your work). `;

/** One build-role chain's definition. `assertKind` tells the live test/sweep which output shape to
 *  expect: "red" = a tests/ tree (functional coverage judge), "assess" = a discriminator marker in
 *  the AC cycle dir (alignment judge), "review"/"reflect" = verdict files (verdict-alignment judge).
 *  `outputKind` is the build-output kind for the functional reference (navigator=tests).
 *  `extraSnapshotRoots` names the workspace-root dirs (tests/) the navigator writes, so
 *  producedArtifacts preserves them past teardown. */
export interface BuildRoleChain {
  name: string;
  dir: string;
  start: WorkflowAction;
  assertKind: "red" | "assess" | "review" | "reflect";
  /** The primary output path the live role writes (workspace-relative). For RED = "tests"; for
   *  ASSESS = the AC cycle dir; for REVIEW/REFLECT = the verdict file path. Matches the manifest's
   *  first output filename. */
  outputFile: string;
  /** Workspace-root dirs to also snapshot (the code the navigator writes lives outside .consort). */
  extraSnapshotRoots: string[];
  prompt: string;
  /** Optional: for REVIEW/REFLECT chains, the workspace-relative path where the verdict lands
   *  (the producedArtifacts key that holds the recorded reference verdict). REVIEW =>
   *  `.consort/cycles/<F>/<S>/review-verdict.json`; REFLECT =>
   *  `features/<F>/stories/<S>/reflect-verdict.json`. Omitted for RED/ASSESS (no verdict). */
  verdictFile?: string;
}

/** The AC cycle dir (workspace-relative) the assess marker lands in. Derived from the
 *  canonical cycleDir() helper rooted at ARTIFACT_ROOT, never a hardcoded `.consort/` path.
 *  Assess runs on S1, so the cycle dir is S1's. */
const AC_CYCLE_DIR = cycleDir(ARTIFACT_ROOT, BUILD_FEATURE, ASSESS_STORY, ASSESS_AC);

/** The review verdict path (workspace-relative) the navigator-review role reads and judges.
 *  Derived from acReviewVerdictJson() rooted at ARTIFACT_ROOT (single source of truth for the
 *  cycle layout). Review runs on S1 after a driver completes, so it reads the recorded verdict there. */
const REVIEW_VERDICT_PATH = acReviewVerdictJson(ARTIFACT_ROOT, BUILD_FEATURE, ASSESS_STORY, ASSESS_AC);

/** The reflect verdict path (workspace-relative) the navigator-reflect role reads and judges.
 *  Reflect runs at DESIGN-time, so it writes to the feature/story path. */
const REFLECT_VERDICT_PATH = `features/${BUILD_FEATURE}/stories/${BUILD_STORY}/reflect-verdict.json`;

/** The per-BUILD-role chain catalogue. Navigator turns only (lean); driver turns are the gated
 *  cloud phase (seam below). Keyed by a short handle. */
export const BUILD_ROLE_CHAINS: Record<string, BuildRoleChain> = {
  "navigator-red": {
    name: "navigator RED (author the story's failing tests)",
    dir: "navigator-red-chain",
    start: { kind: "invoke-role", role: "navigator", story: BUILD_STORY },
    assertKind: "red",
    outputFile: "tests",
    extraSnapshotRoots: ["tests"],
    prompt:
      `You are the Navigator authoring the FAILING (RED) tests for story ${BUILD_STORY}. From the ` +
      `provided design (the test list + the story's acceptance criteria + architecture + db-design, ` +
      `in this prompt), WRITE the story's tests under tests/ (relative to your current working ` +
      `directory). Cover EVERY test-list item for this story; each test must FAITHFULLY assert its ` +
      `item's requirement (the right behavior/invariant), and any DB-writing test must own its own ` +
      `state (a per-run-unique key), never an absolute whole-table assertion. Write real, runnable ` +
      `test code (pytest under tests/, Vitest under client/tests where the item is a UI test).` +
      NO_SHELL + REPORT_BLOCK,
  },
  "navigator-assess": {
    name: "navigator ASSESS (discriminate a failed GREEN)",
    dir: "navigator-assess-chain",
    start: { kind: "invoke-role", role: "navigator", story: ASSESS_STORY, buildMode: "assess", ac: ASSESS_AC } as WorkflowAction,
    assertKind: "assess",
    outputFile: AC_CYCLE_DIR,
    extraSnapshotRoots: ["tests", "app", "client"],
    prompt:
      `You are the Navigator ASSESSING a failed honest-GREEN verify for AC ${ASSESS_AC} in story ` +
      `${ASSESS_STORY}. The Driver made the current test pass, but the full-suite verify FAILED – some ` +
      `test(s) now fail. START from green-failure.json in your AC cycle dir (${AC_CYCLE_DIR}/) – its ` +
      `summary localizes WHICH suite failed, and if it carries a supersededTestRefs / contractRefs ` +
      `advisory, TRUST that pre-localized set (flag EXACTLY those; do NOT re-search the test tree). ` +
      `Otherwise use Grep/Glob to jump to the named failing test + the symbol it imports (the LAYOUT ` +
      `below names the paths) – do NOT Read every file. In a few targeted lookups confirm the root ` +
      `cause, then DECIDE, writing EXACTLY ONE marker file (relative to your current working ` +
      `directory), into ${AC_CYCLE_DIR}/:\n` +
      `  (a) SUPERSEDED – if this AC intentionally supersedes behavior the failing PRIOR tests ` +
      `encode (the latest AC wins), write superseded-tests.json = {"tests":["<path>", ...], "reason":"<new AC + what changed>"}.\n` +
      `  (b) REGRESSION – if the failure is a genuine bug in the Driver's code (this AC does NOT ` +
      `intend to change that behavior), write regression-assessment.json = {"diagnosis":"<root cause: which behavior broke + why>", "fixDirective":"<what the Driver should change>"}. ` +
      `OMIT fixDirective ONLY when it needs a human / a design change.\n` +
      `Write ONLY the ONE correct marker. Do NOT edit product code or tests in this turn.` +
      NO_SHELL + REPORT_BLOCK,
  },
  "navigator-review": {
    name: "navigator REVIEW (evaluate the driver's code against design NFRs)",
    dir: "navigator-review-chain",
    start: { kind: "invoke-role", role: "navigator", story: ASSESS_STORY, buildMode: "review", ac: ASSESS_AC } as WorkflowAction,
    assertKind: "review",
    outputFile: REVIEW_VERDICT_PATH,
    extraSnapshotRoots: ["tests", "app", "client"],
    verdictFile: REVIEW_VERDICT_PATH,
    prompt:
      `You are the Navigator REVIEWING the Driver's code after a successful honest-GREEN for AC ` +
      `${ASSESS_AC} in story ${ASSESS_STORY}. The Driver's implementation passed all tests. Your ` +
      `task: evaluate whether the Driver's code respects the DESIGN NFRs (layer boundaries, ` +
      `naming conventions, cohesion, testability). From the provided architecture contract + ` +
      `design conventions, INSPECT the code tree (app/, tests/, client/) and determine if ` +
      `refactoring is warranted (design debt / cleanups / minor improvements) or if the code ` +
      `already adheres cleanly to the design.\n` +
      `Write a single verdict file into ${REVIEW_VERDICT_PATH} (relative to your current ` +
      `working directory):\n` +
      `  review-verdict.json = {"refactor": <bool>, "notes": "<analysis of NFR compliance + ` +
      `concrete improvement suggestions if refactor=true, or 'no improvement' if false>"}.\n` +
      `Do NOT edit product code or tests. Run no command.` +
      NO_SHELL + REPORT_BLOCK,
  },
  "navigator-reflect": {
    name: "navigator REFLECT (evaluate design completeness at story end)",
    dir: "navigator-reflect-chain",
    start: { kind: "invoke-role", role: "navigator", story: BUILD_STORY, buildMode: "reflect" } as WorkflowAction,
    assertKind: "reflect",
    outputFile: REFLECT_VERDICT_PATH,
    extraSnapshotRoots: ["tests", "app", "client"],
    verdictFile: REFLECT_VERDICT_PATH,
    prompt:
      `You are the Navigator REFLECTING at the end of story ${BUILD_STORY}. The feature has ` +
      `passed all test-list items, all acceptance criteria, and design review. Your task: ` +
      `evaluate whether the design is COMPLETE + CONSISTENT: have all design decisions been ` +
      `faithfully implemented? Are there unresolved design gaps or inconsistencies between the ` +
      `spec (test-list, ACs, architecture) and the produced code?\n` +
      `Inspect the produced tree (app/, tests/, client/) against the design (test-list, ACs, ` +
      `architecture, db-design, conventions). Evaluate the following dimensions:\n` +
      `  - Test coverage completeness (every test-list item + AC covered)\n` +
      `  - Architecture compliance (layers, boundaries, responsibilities)\n` +
      `  - DB schema alignment (migrations, constraints, schema)\n` +
      `  - Design token delivery (if visual)\n` +
      `  - Naming + conventions (module layout, symbol names, file structure)\n` +
      `Write a single verdict file into ${REFLECT_VERDICT_PATH} (relative to your current ` +
      `working directory):\n` +
      `  reflect-verdict.json = {"version": 1, "passed": <bool>, "findings": ["<gap or ` +
      `inconsistency if passed=false>", ...]}.\n` +
      `Do NOT edit product code or specs. Run no command.` +
      NO_SHELL + REPORT_BLOCK,
  },
};

/** Options for one build-chain run: the kit root + an optional per-manifest agent override (the
 *  sweep's lever-injection seam, same as the design chains). */
export interface RunBuildRoleChainOptions {
  kitDir?: string;
  agentFor?(manifest: StepManifest): StepAgent | undefined;
}

/** What a build-chain run returns: the turns + the preserved produced-artifact tree (INCLUDING
 *  the code the navigator wrote at the workspace root, via extraSnapshotRoots). */
export interface BuildRoleChainRun {
  turns: ManifestTurn[];
  producedArtifacts: Record<string, string>;
}

/**
 * Run ONE build-role chain end to end (seed replay overlays the pre-turn code + markers -> live
 * build role) and return every turn + the preserved produced tree. LEAN – navigator only (no
 * cloud project). Shared by the build live tests (no agentFor = default levers) and the build
 * sweep (agentFor patches the live role's levers per candidate). Mirrors runRoleChainLive but
 * threads extraSnapshotRoots so the navigator's tests/ code survives teardown.
 */
export async function runBuildRoleChainLive(chain: BuildRoleChain, opts: RunBuildRoleChainOptions = {}): Promise<BuildRoleChainRun> {
  const kit = opts.kitDir ?? process.cwd();
  const { turns, producedArtifacts } = await runIntegrationChain({
    manifestDir: join(kit, BUILD_MANIFESTS_REL, chain.dir),
    intakeDir: join(kit, BUILD_CORPUS_REL),
    feature: BUILD_FEATURE,
    start: BUILD_PO_SEED,
    extraSnapshotRoots: chain.extraSnapshotRoots,
    instructionsFor: (m: StepManifest, _ws: string) =>
      m.agent?.kind === "claude"
        ? {
            // Just the base directive – the pre-conditioning (RED's context-pack; ASSESS's
            // green-failure advisory) is now DECLARED on the manifest's `preconditions` and
            // PREPARED + appended by the executor's PREPARE-PRECONDITIONS phase, against the
            // SEEDED workspace .consort. So the isolated turn is pre-conditioned by the SAME
            // mechanism as a dispatched one, with no per-chain prompt assembly (and the assess
            // chain now gets the green-failure advisory the real assess uses, not a context-pack).
            prompt: chain.prompt,
            guidelines: [`Author your output as instructed; end with the agent-report block; run no command.`],
          }
        : { prompt: `Replay-seed the pre-turn state for ${chain.name}.`, guidelines: [] },
    ...(opts.agentFor ? { agentFor: opts.agentFor } : {}),
  });
  return { turns, producedArtifacts };
}

// ─── DRIVER-PHASE SEAM (a later, GATED cloud phase – NOT built here) ────────────────────────────
//
// Driver turns (green / refactor / repair) plug into THIS catalogue as future entries – e.g.
// "driver-green" (start {invoke-role, driver, story: S3}) / "driver-repair" ({...buildMode:"repair", ac}).
// They are additive DATA + manifests. But a driver turn writes CODE that must pass honest-GREEN:
// cycle-record.ts:defaultGreenVerifier -> ensureDeployedAndVerify runs `alembic upgrade head` +
// pytest against a LIVE Lakebase branch, and experiment.ts:cutExperiment THROWS if the branch's
// .env DATABASE_URL is unset. So a driver chain CANNOT run in the lean throwaway .consort temp dir.
//
// The driver phase (out of scope here) uses ONE shared scaffolded Lakebase environment for all
// experiments + a reset script between them (see scripts/consort/reset-experiment-db – design-only):
// a future runBuildDriverChainLive swaps runIntegrationChain's temp-dir workspace for the
// scaffolded project + a cutExperiment before the live driver turn, and resets the shared branch
// DB to its baseline (one alembic_version row) between candidates so `alembic upgrade head`
// rebuilds deterministically. The build-code DISCRIMINATOR judge (evaluation/semantic-gate
// makeBuildDiscriminatorJudge) is the driver-turn quality gate – and its independent-oracle reuse
// is what the navigator-ASSESS alignment gate already calls here.
