// Design fingerprint for the stale-experiment guardrail.
//
// A story's build experiment is cut to implement a SPECIFIC design (its
// test-list). If the story is later sent back to the design lane and re-authored
// WITHOUT tearing the experiment down (the `withdraw-gate` + `set --status
// designing` hand-surgery, instead of `revise` / `consort-reopen-story`, both of
// which discard the experiment), the rebuild REUSES the still-active experiment
// (nextBuildAction skips cutting a new one when experimentCut is true), so the
// abandoned design's code + tests ride into the accept-merge, surfacing as
// unrelated failures cycles later. No gate flagged the leftover artifacts.
//
// The guardrail: stamp the experiment with a fingerprint of the design it was cut
// to build (the test-list content) at cut time. When the drive would reuse an
// active experiment whose stamped fingerprint no longer matches the CURRENT design
// on disk, the story was re-authored under it , the experiment is STALE , so the
// derivation treats it like a discarded one and forces a fresh re-cut (which drops
// the stale paired branch and re-stamps the current design). The test-list is the
// right source: a normal build never rewrites it, so a changed fingerprint reliably
// means "redesigned since cut" and never a false positive during an ordinary build.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { storyTestListJson } from "../config/consort-paths.js";

/**
 * A stable content fingerprint of the design output a story's build implements ,
 * its test-list. Normalized to canonical JSON so incidental formatting churn does
 * not read as a design change; the semantic content (the ordered test list) is
 * what is hashed. Returns `undefined` when there is no readable/parseable
 * test-list to hash , so a story with no design yet yields NO fingerprint, and an
 * experiment carrying no stamped fingerprint (cut before this guardrail, or with
 * no test-list) is never falsely flagged stale.
 */
export function storyDesignFingerprint(
  consortDir: string,
  feature: string,
  story: string,
): string | undefined {
  try {
    const raw = readFileSync(storyTestListJson(consortDir, feature, story), "utf8");
    const canonical = JSON.stringify(JSON.parse(raw));
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}
