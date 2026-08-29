// The stale-experiment guardrail's fingerprint: storyDesignFingerprint hashes the
// design (test-list) a build implements, so a redesign under a still-active experiment
// is detectable. Also covers cutStoryExperiment stamping the fingerprint on the record.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storyDesignFingerprint } from "../../consort/pipeline/design-fingerprint";
import { storyTestListJson } from "../../consort/config/consort-paths";
import { cutStoryExperiment, type StoryPipeline } from "../../consort/pipeline/story-pipeline";

let tdd: string;
const F = "F1";
const S = "S1";

beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "design-fp-"));
});
afterEach(() => rmSync(tdd, { recursive: true, force: true }));

function writeTestList(items: unknown, pretty = false): void {
  const file = storyTestListJson(tdd, F, S);
  mkdirSync(join(file, ".."), { recursive: true });
  const body = { feature_id: F, story_id: S, items };
  writeFileSync(file, pretty ? JSON.stringify(body, null, 2) + "\n" : JSON.stringify(body));
}

describe("storyDesignFingerprint", () => {
  it("returns undefined when there is no test-list to hash", () => {
    expect(storyDesignFingerprint(tdd, F, S)).toBeUndefined();
  });

  it("is deterministic , the same design hashes to the same fingerprint", () => {
    writeTestList([{ id: "T1", ac_id: "AC1", description: "a" }]);
    const first = storyDesignFingerprint(tdd, F, S);
    const second = storyDesignFingerprint(tdd, F, S);
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it("is stable under incidental formatting churn (canonical JSON, not byte-for-byte)", () => {
    writeTestList([{ id: "T1", ac_id: "AC1", description: "a" }], false);
    const compact = storyDesignFingerprint(tdd, F, S);
    writeTestList([{ id: "T1", ac_id: "AC1", description: "a" }], true); // reformatted, same content
    const pretty = storyDesignFingerprint(tdd, F, S);
    expect(pretty).toBe(compact);
  });

  it("CHANGES when the design (test-list content) is re-authored , the redesign signal", () => {
    writeTestList([{ id: "T1", ac_id: "AC1", description: "reject unknown SKU" }]);
    const before = storyDesignFingerprint(tdd, F, S);
    // A genuine redesign: different tests (the T32/T42.. -> T45.. supersession the bug hit).
    writeTestList([{ id: "T9", ac_id: "AC2", description: "accept known SKU" }]);
    const after = storyDesignFingerprint(tdd, F, S);
    expect(after).not.toBe(before);
  });
});

describe("cutStoryExperiment stamps the design fingerprint", () => {
  it("stores design_fingerprint on the experiment record when provided", () => {
    const p: StoryPipeline = { version: 1, feature_id: F, stories: { [S]: { status: "building" } }, build_queue: [], build_active: S };
    cutStoryExperiment(p, S, { slug: "exp1", branch: "experiment-s1-exp1", parent: "feat", design_fingerprint: "abc123" });
    expect(p.stories[S].experiment?.design_fingerprint).toBe("abc123");
    expect(p.stories[S].experiment?.status).toBe("active");
  });

  it("omits design_fingerprint when none is supplied (backward-compat)", () => {
    const p: StoryPipeline = { version: 1, feature_id: F, stories: { [S]: { status: "building" } }, build_queue: [], build_active: S };
    cutStoryExperiment(p, S, { slug: "exp1", branch: "experiment-s1-exp1", parent: "feat" });
    expect(p.stories[S].experiment?.design_fingerprint).toBeUndefined();
  });
});
