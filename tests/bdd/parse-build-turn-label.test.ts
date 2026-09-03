// Unit tests for parseBuildTurnLabel: a recorded-build turn dir label -> role + BuildTurn
// family, mirroring turnKeyForAction (orchestrator-effects.ts) EXACTLY. Pure, hermetic, no
// corpus. The corpus-scanning guard that RUNS this over the recorded-build corpora lives in
// the consort-examples repo (the corpora were factored out of the kit); this keeps the
// label-parser's own coverage in consort. If turnKeyForAction gains a buildMode, add it here.

import { describe, it, expect } from "vitest";

/** The recognized BuildTurn families a label can name, mirroring turnKeyForAction. `undefined`
 *  is the navigator-reflect critic (a real, valid turn with no build key). */
type BuildFamily = "red" | "green" | "review" | "refactor" | "assess" | "repair";

/** Parse a recorded-build turn dir label (`<NNN>-<role>[-<mode>][-<ac...>]`) into its role + the
 *  BuildTurn family, faithful to labelForAction + turnKeyForAction. Returns null when the leading
 *  token is not a build role (navigator/driver) , i.e. not a build turn at all. */
export function parseBuildTurnLabel(dirName: string): { role: string; family: BuildFamily | undefined } | null {
  const withoutOrdinal = dirName.replace(/^\d+-/, "");
  const tokens = withoutOrdinal.split("-");
  const role = tokens[0];
  const rest = tokens.slice(1);
  const has = (kw: string): boolean => rest.includes(kw);

  if (role === "navigator") {
    if (has("reflect")) return { role, family: undefined }; // design-lane critic, no build key
    if (has("review")) return { role, family: "review" };
    if (has("assess")) return { role, family: "assess" }; // assess / assess-deploy / assess-refactor
    return { role, family: "red" }; // plain navigator = RED
  }
  if (role === "driver") {
    if (has("refactor")) return { role, family: "refactor" }; // refactor / -deploy / -superseded
    if (has("repair")) return { role, family: "repair" };
    if (has("green")) return { role, family: "green" }; // green-superseded
    return { role, family: "green" }; // plain driver = GREEN
  }
  return null; // not a build role
}

describe("parseBuildTurnLabel: recorded-build dir label -> role + BuildTurn family (mirrors turnKeyForAction)", () => {
  it.each([
    ["002-navigator", "navigator", "red"],
    ["003-driver", "driver", "green"],
    ["006-navigator-review", "navigator", "review"],
    ["011-driver-refactor", "driver", "refactor"],
    ["004-navigator-assess-AC1-batch-serial-columns-added", "navigator", "assess"],
    ["005-driver-green-superseded", "driver", "green"],
    ["007-driver-repair-AC1-split-fields-shown", "driver", "repair"],
  ])("%s -> %s / %s", (dir, role, family) => {
    const p = parseBuildTurnLabel(dir);
    expect(p?.role).toBe(role);
    expect(p?.family).toBe(family);
  });

  it("navigator-reflect is a VALID build-turn dir with no build family (design-lane critic)", () => {
    const p = parseBuildTurnLabel("001-navigator-reflect");
    expect(p?.role).toBe("navigator");
    expect(p?.family).toBeUndefined();
  });

  it("a non-build label (e.g. a gate) is not a build turn", () => {
    expect(parseBuildTurnLabel("012-gate-deploy")).toBeNull();
  });
});
