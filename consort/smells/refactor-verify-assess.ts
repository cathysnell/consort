// Refactor-verify self-heal. A REFACTOR-phase verify failure used to hard-halt to
// the HIL, unlike the structurally identical GREEN and deploy-verify failures,
// which route to a bounded Navigator supersession assess. That gap stranded a
// LEGITIMATE supersession: when a later story's refactor removes a retired field,
// a PRIOR story's test that still asserts the old field breaks, and only the
// Navigator can flag it as superseded so the Driver may permissively refactor it.
//
// This is the story-scoped marker + one-shot bound for that path, modeled on
// deploy-verify-assess (same shape: post-green full-suite verify failure, a
// Navigator assess that either flags superseded tests to refactor or vetoes to a
// genuine regression, then ONE honest re-verify). PURE (no substrate/spawn): the
// refactor path writes the marker, the orchestrator probe reads it, the CLI
// finalizes it. The honest re-verify still gates every round, so this never
// green-washes; it only distinguishes a supersession from broken software.

import * as fs from "node:fs";
import * as path from "node:path";
import { findFeatureDir } from "../../consort/config/consort-paths.js";

export interface RefactorVerifyAssessMarker {
  version: 1;
  story_id: string;
  /** The refactor-verify failure summary (the failing suite + reason), for the
   *  Navigator assess turn's context. */
  summary: string;
  /** Deterministic supersession advisory (prior tests referencing a symbol the
   *  refactor removed), injected into the assess directive so the Navigator does
   *  not re-search. Advisory only; the Navigator decides. */
  superseded_advisory?: string;
  /** True once the Navigator's assess turn ran (flagged superseded tests, or
   *  vetoed as a genuine regression). */
  assessed: boolean;
  /** Assess attempts spent. One-shot: at 1 the marker is no longer
   *  assess-eligible, so a repeat refactor-verify failure takes the terminal HIL. */
  attempts: number;
  /** The prior tests the Navigator confirmed as superseded (its flag set). Present
   *  + non-empty routes the Driver permissive-refactor turn; empty (the Navigator
   *  vetoed => genuine regression) routes the terminal HIL. */
  flagged_tests?: string[];
  /** True once the Driver permissively refactored the flagged superseded tests.
   *  Gates the one re-verify. */
  refactored?: boolean;
}

function markerPath(consortDir: string, featureId: string, storyId: string): string | undefined {
  const fdir = findFeatureDir(consortDir, featureId);
  if (!fdir) return undefined;
  return path.join(fdir, "stories", storyId, "refactor-verify-assess.json");
}

export function readRefactorVerifyAssessMarker(
  consortDir: string,
  featureId: string,
  storyId: string,
): RefactorVerifyAssessMarker | undefined {
  const file = markerPath(consortDir, featureId, storyId);
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RefactorVerifyAssessMarker;
  } catch {
    return undefined;
  }
}

/** Record a fresh refactor-verify failure marker (assessed:false). Idempotent on
 *  re-detection: refreshes the summary/advisory but preserves the spent
 *  `attempts` so the one-shot bound is not reset by a repeat refactor of the same
 *  story. */
export function writeRefactorVerifyAssessMarker(
  consortDir: string,
  featureId: string,
  storyId: string,
  args: { summary: string; supersededAdvisory?: string },
): string | undefined {
  const file = markerPath(consortDir, featureId, storyId);
  if (!file) return undefined;
  const prior = readRefactorVerifyAssessMarker(consortDir, featureId, storyId);
  const marker: RefactorVerifyAssessMarker = {
    version: 1,
    story_id: storyId,
    summary: args.summary,
    ...(args.supersededAdvisory ? { superseded_advisory: args.supersededAdvisory } : {}),
    assessed: false,
    attempts: prior?.attempts ?? 0,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", "utf8");
  return file;
}

/** Mark the failure assessed (the Navigator turn ran) and count the attempt.
 *  `flaggedTests` (the superseded set) is recorded when given: non-empty routes
 *  the Driver permissive-refactor turn; omitted/empty leaves nothing to refactor
 *  (the Navigator vetoed), so the finalize escalates. */
export function markRefactorVerifyAssessed(
  consortDir: string,
  featureId: string,
  storyId: string,
  flaggedTests?: string[],
): void {
  const file = markerPath(consortDir, featureId, storyId);
  const m = readRefactorVerifyAssessMarker(consortDir, featureId, storyId);
  if (!file || !m) return;
  m.assessed = true;
  m.attempts += 1;
  if (flaggedTests && flaggedTests.length > 0) m.flagged_tests = flaggedTests;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Mark the Driver's permissive-refactor turn done. Gates the one re-verify. */
export function markRefactorVerifyRefactored(consortDir: string, featureId: string, storyId: string): void {
  const file = markerPath(consortDir, featureId, storyId);
  const m = readRefactorVerifyAssessMarker(consortDir, featureId, storyId);
  if (!file || !m) return;
  m.refactored = true;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Clear the marker (the re-verify passed – the supersession refactor worked). */
export function clearRefactorVerifyAssessMarker(consortDir: string, featureId: string, storyId: string): void {
  const file = markerPath(consortDir, featureId, storyId);
  if (file && fs.existsSync(file)) fs.rmSync(file);
}

/** One-shot bound: assess-eligible while the marker exists, is not yet assessed,
 *  and is under the single-attempt cap. */
export function refactorVerifyNeedsAssess(consortDir: string, featureId: string, storyId: string): boolean {
  const m = readRefactorVerifyAssessMarker(consortDir, featureId, storyId);
  return !!m && !m.assessed && m.attempts < 1;
}

/** The assessed failure has a non-empty superseded set the Driver has not yet
 *  refactored: routes the one Driver permissive-refactor turn. */
export function refactorVerifyRefactorPending(consortDir: string, featureId: string, storyId: string): boolean {
  const m = readRefactorVerifyAssessMarker(consortDir, featureId, storyId);
  return !!m && m.assessed === true && (m.flagged_tests?.length ?? 0) > 0 && m.refactored !== true;
}
