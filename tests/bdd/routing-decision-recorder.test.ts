// Routing-decision observability (the diagnostic stream the turn recorder lacks): the drive loop
// must emit onRoutingDecision once per iteration with the action AND the DriveState bag that chose
// it, and recordRoutingDecision must persist that bag to routing-decisions.jsonl. This is the
// "why did this turn route here" capture; these guards pin the seam + the projection + the writer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projectRoutingStateBag,
  recordRoutingDecision,
  type RoutingDecisionRecord,
} from "../../consort/logging/turn-recorder";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary";

describe("projectRoutingStateBag: extract the routing 'why' from a DriveState", () => {
  it("projects phase + the ACTIVE build story's state bag (review-vs-assess fields)", () => {
    const state = {
      phase: "feature",
      buildActive: "S3",
      stories: {
        S3: {
          build: {
            experimentCut: true,
            testsWritten: true,
            codeWritten: true,
            reviewStoryPending: true,
            assessGreenAc: null,
            accepted: false,
          },
        },
        S1: { build: { accepted: true } }, // NOT active -> not projected
      },
    };
    const bag = projectRoutingStateBag(state);
    expect(bag.phase).toBe("feature");
    expect(bag.buildActive).toBe("S3");
    // The load-bearing fields for the review-vs-assess fork are captured verbatim.
    expect(bag.reviewStoryPending).toBe(true);
    expect(bag.assessGreenAc).toBe(null);
    expect(bag.testsWritten).toBe(true);
    expect(bag.codeWritten).toBe(true);
  });

  it("captures assessGreenAc when the green FAILED (the assess branch), distinct from review", () => {
    const state = {
      phase: "feature",
      buildActive: "S3",
      stories: { S3: { build: { reviewStoryPending: false, assessGreenAc: "AC1", codeWritten: false } } },
    };
    const bag = projectRoutingStateBag(state);
    // This is exactly the state that routes to ASSESS, not review – the record must show it.
    expect(bag.assessGreenAc).toBe("AC1");
    expect(bag.reviewStoryPending).toBe(false);
  });

  it("is defensive on a non-build phase (planning) – no active story, no crash", () => {
    const bag = projectRoutingStateBag({ phase: "planning", buildActive: null });
    expect(bag.phase).toBe("planning");
    expect(bag.buildActive).toBe(null);
    expect(bag.reviewStoryPending).toBeUndefined();
  });

  it("is defensive on an empty/absent state", () => {
    expect(projectRoutingStateBag(undefined)).toEqual({});
    expect(projectRoutingStateBag({})).toEqual({});
  });
});

describe("recordRoutingDecision: append the decision + bag to routing-decisions.jsonl", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "routing-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const action: WorkflowAction = { kind: "invoke-role", role: "navigator", story: "S3", buildMode: "review" } as WorkflowAction;

  it("writes one JSONL line per call, each carrying action + source + the state bag + a timestamp", () => {
    const state = { phase: "feature", buildActive: "S3", stories: { S3: { build: { reviewStoryPending: true, assessGreenAc: null } } } };
    recordRoutingDecision(dir, action, state, 7, "nextTransition");

    const f = join(dir, "routing-decisions.jsonl");
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as RoutingDecisionRecord;
    expect(rec.iteration).toBe(7);
    expect(rec.source).toBe("nextTransition");
    expect(rec.action).toEqual(action);
    expect(rec.stateBag.reviewStoryPending).toBe(true);
    expect(rec.stateBag.assessGreenAc).toBe(null);
    expect(typeof rec.at).toBe("string");
  });

  it("APPENDS (one line per iteration), so a whole run's decisions accumulate in order", () => {
    recordRoutingDecision(dir, action, { phase: "feature", buildActive: "S3", stories: { S3: { build: { testsWritten: false } } } }, 0, "nextTransition");
    recordRoutingDecision(dir, action, { phase: "feature", buildActive: "S3", stories: { S3: { build: { testsWritten: true, codeWritten: false } } } }, 1, "nextTransition");
    const lines = readFileSync(join(dir, "routing-decisions.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as RoutingDecisionRecord).iteration).toBe(0);
    expect((JSON.parse(lines[1]) as RoutingDecisionRecord).iteration).toBe(1);
  });
});
