import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readScenarioConditions,
  formatScenarioConditionField,
  SCENARIO_CONDITION_DEFAULTS,
} from "../../consort/session/scenario-conditions.js";

let dir: string;
const manifest = (obj: unknown): string => {
  const p = join(dir, "scenario.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scenario-cond-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readScenarioConditions", () => {
  it("reads uiTrack / tiers / pauseBefore / language / runner from the manifest", () => {
    const c = readScenarioConditions(
      manifest({ name: "x", uiTrack: true, tiers: 2, pauseBefore: "navigator", language: "python", runner: "self-hosted" }),
    );
    expect(c.uiTrack).toBe(true);
    expect(c.tiers).toBe(2);
    expect(c.pauseBefore).toBe("navigator");
    expect(c.language).toBe("python");
    expect(c.runner).toBe("self-hosted");
  });

  it("returns schema defaults for an ABSENT manifest (never throws)", () => {
    const c = readScenarioConditions(join(dir, "nope.json"));
    expect(c).toEqual(SCENARIO_CONDITION_DEFAULTS);
    expect(c.uiTrack).toBe(true); // uiTrack defaults ON
    expect(c.language).toBeUndefined(); // optional, undeclared
  });

  it("returns defaults for a MALFORMED manifest (never throws)", () => {
    const p = join(dir, "scenario.json");
    writeFileSync(p, "{ not json");
    expect(readScenarioConditions(p)).toEqual(SCENARIO_CONDITION_DEFAULTS);
  });

  it("a partial manifest keeps schema defaults for the fields it omits", () => {
    const c = readScenarioConditions(manifest({ name: "x", uiTrack: true }));
    expect(c.uiTrack).toBe(true);
    expect(c.tiers).toBe(2); // default
    expect(c.pauseBefore).toBe("release-engineer"); // default
    expect(c.language).toBeUndefined();
    expect(c.runner).toBeUndefined();
  });
});

describe("formatScenarioConditionField (shell-friendly)", () => {
  let c: ReturnType<typeof readScenarioConditions>;
  beforeEach(() => {
    // built inside beforeEach so `dir` (set by the outer beforeEach) exists.
    c = readScenarioConditions(manifest({ name: "x", uiTrack: true, tiers: 3, language: "python" }));
  });
  it("renders booleans as true/false", () => {
    expect(formatScenarioConditionField(c, "uiTrack")).toBe("true");
  });
  it("renders numbers + strings verbatim", () => {
    expect(formatScenarioConditionField(c, "tiers")).toBe("3");
    expect(formatScenarioConditionField(c, "language")).toBe("python");
  });
  it("renders an absent optional as the empty string (so a shell -n guard skips it)", () => {
    expect(formatScenarioConditionField(c, "runner")).toBe("");
  });
});

// (The "stockflow scenario.json declares its conditions" guard moved to consort-examples
//  with the corpus scenario.json it reads.)
