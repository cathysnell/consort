// Shared support for the per-role LIVE BUILD chains (navigator-red, navigator-assess). The
// build-lane sibling of support.ts: run ONE build role's isolated seed -> live chain, assert it
// produced its output + terminated cleanly, then run the appropriate QUALITY gate and emit
// telemetry. NOT a .test.ts (no vitest include match), so importing it adds no suite.
//
// The two navigator outputs are judged DIFFERENTLY (the whole point of the discriminator work):
//   - RED  : the produced tests are judged for COVERAGE + FAITHFULNESS against the TEST-LIST SPEC
//            (buildRedCoverageJudgePrompt, opus), NOT turn-for-turn vs recorded tests.
//   - ASSESS: ALIGNMENT – an independent opus oracle (makeBuildDiscriminatorJudge) re-evaluates
//            the SAME driver code the navigator assessed, and the gate passes iff the navigator's
//            marker verdict aligns with the oracle (did the navigator judge the driver correctly).
//
// LEAN – NO cloud project. The navigator is tool-scoped to Write/Read (never runs ./scripts/lk).

import { expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  BUILD_ROLE_CHAINS,
  runBuildRoleChainLive,
  BUILD_CORPUS_REL,
  BUILD_FEATURE,
  BUILD_STORY,
  BUILD_AC,
  ASSESS_STORY,
  ASSESS_AC,
  type BuildRoleChain,
} from "../../../consort/optimize/build-role-chains.js";
import {
  buildRedCoverageJudgePrompt,
  parseJudgeReply,
  evaluateNavigatorAssessAlignment,
  parseNavigatorAssessMarker,
  makeSupersessionDeltaJudge,
  readTree,
  FUNCTIONAL_THRESHOLD,
  type DiscriminatorVerdict,
} from "../../../consort/evaluation/semantic-gate.js";
import { formatRoleTelemetry, writeRoleTelemetry, type RoleTelemetry } from "../../../consort/optimize/role-telemetry.js";
import type { ManifestTurn } from "../../../consort/orchestrator/runners/manifest-runner.js";

export const KIT = process.cwd();
export const TELEMETRY_DIR = process.env.LAKEBASE_ROLE_TELEMETRY_DIR ?? join(KIT, ".role-telemetry");

export { BUILD_ROLE_CHAINS, type BuildRoleChain };

/** The RECORDED GROUND-TRUTH assess verdict – the canonical navigator's marker for this turn,
 *  parsed into a discriminator-shaped verdict. This is the alignment reference (the navigator's
 *  live verdict is judged against THIS, not a cold re-derivation). ASSESS runs on S1; its
 *  ground-truth marker is the 004-navigator-assess turn's superseded-tests.json in the fixtures. */
function recordedGroundTruthVerdict(): DiscriminatorVerdict {
  const cycleDir = join(
    KIT,
    BUILD_CORPUS_REL,
    "recorded-build/features",
    BUILD_FEATURE,
    "stories",
    ASSESS_STORY,
    "turns/004-navigator-assess-AC1-batch-serial-columns-added/tdd/cycles",
    BUILD_FEATURE,
    ASSESS_STORY,
    ASSESS_AC,
  );
  // parseNavigatorAssessMarker reads superseded-tests.json / regression-assessment.json from a dir
  // into {classification, supersededTests, ...} – exactly the shape the alignment gate compares.
  return parseNavigatorAssessMarker(cycleDir);
}

/** The seeded test-list spec (the RED coverage bar) + the story AC, read from the recorded
 *  design artifacts (the same files the seed lays into the workspace). */
function seededSpec(): { testList: string; acs: string } {
  const rec = join(KIT, BUILD_CORPUS_REL, "recorded-artifacts", "features", BUILD_FEATURE);
  const readFileOr = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    testList: readFileOr(join(rec, "test-list.json")),
    acs: readFileOr(join(rec, "stories", BUILD_STORY, "acs", `${BUILD_AC}.json`)),
  };
}

/**
 * Run ONE navigator build chain (seed replay -> live navigator), assert it produced its output +
 * terminated cleanly, run the role-appropriate quality gate (RED coverage OR assess alignment),
 * and emit telemetry. Assertions live here (the live test file is a thin wrapper).
 */
export async function runBuildRoleChain(chain: BuildRoleChain): Promise<void> {
  const seedId = `${chain.dir}-seed`;
  const liveId = `${chain.dir}-live`;

  const { turns, producedArtifacts } = await runBuildRoleChainLive(chain);

  expect(turns.map((t) => t.manifestId)).toEqual([seedId, liveId]);
  for (const t of turns) {
    expect(t.result.violations, `${t.manifestId}: ${t.result.violations.join("; ")}`).toEqual([]);
  }
  const liveTurn = turns[turns.length - 1];
  expect(liveTurn.manifestId).toBe(liveId);
  expect(liveTurn.result.bounded.action).toEqual({ kind: "design-complete" });

  if (chain.assertKind === "red") {
    await runRedCoverageGate(chain, producedArtifacts);
  } else {
    await runAssessAlignmentGate(producedArtifacts);
  }

  emitBuildTelemetry(chain, liveTurn.telemetry);
}

/** RED gate: the produced tests must cover + faithfully assert the test-list spec (opus judge). */
async function runRedCoverageGate(chain: BuildRoleChain, produced: Record<string, string>): Promise<void> {
  // The produced tests: every captured file under tests/ (extraSnapshotRoots preserved them).
  const testFiles = Object.entries(produced)
    .filter(([rel]) => rel.startsWith("tests/") || rel.startsWith("client/tests/"))
    .map(([rel, body]) => `// ${rel}\n${body}`)
    .join("\n\n");
  expect(testFiles.trim().length, `${chain.name}: no test files captured under tests/`).toBeGreaterThan(0);

  const { testList, acs } = seededSpec();
  // The RED coverage judge scores the produced tests against the TEST-LIST SPEC (coverage +
  // faithfulness), fixed-opus, via its dedicated prompt (not a functional/design comparison).
  const verdict = parseJudgeReply(spawnRawJudge(buildRedCoverageJudgePrompt(testList, acs, testFiles)));
  expect(
    verdict.score >= FUNCTIONAL_THRESHOLD,
    `RED coverage below ${FUNCTIONAL_THRESHOLD} (score ${verdict.score.toFixed(2)}); missing: ${(verdict.missing ?? []).join("; ")}`,
  ).toBe(true);
}

/** ASSESS gate: the navigator's marker verdict must ALIGN with the RECORDED GROUND TRUTH. The
 *  classification is the hard gate; for superseded-shift the navigator's flagged SET is delta-
 *  judged against the recorded set (coverage-equivalent vs materially different). No cold oracle. */
async function runAssessAlignmentGate(produced: Record<string, string>): Promise<void> {
  // The reference is the canonical navigator's recorded verdict for this turn (not a re-derivation).
  const recordedVerdict = recordedGroundTruthVerdict();

  // Materialize the navigator's LIVE marker (from the preserved tree) into a temp dir the parser reads.
  const markerRel = `.sftdd/cycles/${BUILD_FEATURE}/${ASSESS_STORY}/${ASSESS_AC}`;
  const markerDir = join(TELEMETRY_DIR, "assess-marker", `${Date.now()}`);
  mkdirSync(markerDir, { recursive: true });
  for (const name of ["superseded-tests.json", "regression-assessment.json"]) {
    const body = produced[`${markerRel}/${name}`];
    if (body !== undefined) writeFileSync(join(markerDir, name), body);
  }

  const navVerdict = parseNavigatorAssessMarker(markerDir);
  const deltaJudge = makeSupersessionDeltaJudge({ cwd: KIT });
  const alignment = await evaluateNavigatorAssessAlignment({ recordedVerdict, navigatorMarkerDir: markerDir, deltaJudge });
  // PRESERVE the evidence (both sets + the verdict), so a review does not need to re-derive.
  writeFileSync(
    join(markerDir, "alignment-evidence.json"),
    JSON.stringify({ navigator: navVerdict, groundTruth: recordedVerdict, alignment }, null, 2),
  );
  // eslint-disable-next-line no-console
  console.log(
    `[navigator-assess] navigator=${navVerdict.classification} groundTruth=${recordedVerdict.classification} -> ${alignment.passed ? "ALIGNED" : "MISALIGNED"} (${alignment.reason})`,
  );
  expect(alignment.passed, `navigator ASSESS misaligned with the recorded ground truth: ${alignment.reason}`).toBe(true);
}

/** Spawn the fixed-opus judge on a raw prompt (the RED coverage prompt isn't a functional/design
 *  comparison, so it goes through a direct spawn rather than makeOpusJudge's prompt selection). */
function spawnRawJudge(prompt: string): string {
  try {
    const out = execFileSync(
      "claude",
      ["-p", prompt, "--model", "opus", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--output-format", "json"],
      { cwd: KIT, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000, encoding: "utf8" },
    );
    try {
      const parsed = JSON.parse(out) as { result?: string };
      return typeof parsed.result === "string" ? parsed.result : out;
    } catch {
      return out;
    }
  } catch (e) {
    return `judge spawn failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Build + persist + print the build turn's telemetry (same survival discipline as the design chains). */
function emitBuildTelemetry(chain: BuildRoleChain, telemetry: ManifestTurn["telemetry"]): void {
  const usage = telemetry?.agentResult?.usage;
  const rec: RoleTelemetry = {
    role: telemetry?.role ?? "navigator",
    chain: chain.dir,
    levers: {},
    outerDurationMs: telemetry?.outerDurationMs ?? 0,
    ...(usage
      ? {
          agent: {
            ...(usage.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
            ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
          },
        }
      : {}),
    outcome: "produced",
    producedFile: chain.outputFile,
    ...(telemetry?.agentResult?.finalText ? { transcript: { prompt: chain.prompt, finalText: telemetry.agentResult.finalText, tools: [] } } : {}),
  };
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    const path = writeRoleTelemetry(TELEMETRY_DIR, rec);
    // eslint-disable-next-line no-console
    console.log(formatRoleTelemetry(rec) + ` | -> ${path}`);
  } catch {
    // eslint-disable-next-line no-console
    console.log(formatRoleTelemetry(rec));
  }
}
