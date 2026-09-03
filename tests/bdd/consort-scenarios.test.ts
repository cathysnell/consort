// Recorded-scenario replay framework: hermetic integrity guard.
//
// A "scenario" is a self-contained replay corpus under
// examples/replay/corpora/<name>/ : a recorded-artifacts/ design lane, a
// recorded-build/ build corpus, a turns/ per-turn timeline, and a scenario.json
// manifest (consort/config/schemas/scenario.schema.json). replay-scenario.sh
// replays it live; THIS test is the always-on (no-workspace) guard that every
// committed scenario is well-formed + replay-ready, so a corpus can never rot
// into an un-replayable state unnoticed. See examples/replay/SCENARIOS.md.
//
// The structural assertions live in assertScenarioCorpus() so they are exercised
// here against the existing bug-tracker corpus immediately (proving the checks),
// and run per scenario discovered under examples/replay/corpora/ (guarding new
// captures like stockflow the moment they are dropped in).

import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
// The replay MACHINERY dir (engine, launchers, SCENARIOS.md) stays in the kit; the corpora it
// replays live under examples/replay/corpora/ in the consort-examples repo. This guard keeps the
// MACHINERY checks + the validator-LOGIC exercised against synthetic fixtures; the guard that scans
// the real committed corpora set ("every scenario is replay-ready") moved to consort-examples with
// the corpora.
const REPLAY_DIR = path.join(REPO_ROOT, "examples", "replay");

/** Structural integrity of a recorded corpus (a scenario dir, or any dir that
 *  holds recorded-artifacts/ + optionally recorded-build/ + turns/). `features`
 *  is the ordered feature list the manifest (or the caller) expects to replay. */
function assertScenarioCorpus(
  corpusRoot: string,
  features: { id: string; buildReplay?: boolean }[],
): void {
  const artifacts = path.join(corpusRoot, "recorded-artifacts");
  expect(fs.existsSync(artifacts), `recorded-artifacts/ present in ${corpusRoot}`).toBe(true);

  // Each replayed feature has a recorded design dir; build-replayable ones also
  // have a recorded build dir (consumed by restoreBuildTurn). A feature with no
  // recorded build is design-only (live build), which the manifest marks.
  for (const f of features) {
    const featDesign = path.join(artifacts, "features", f.id);
    expect(fs.existsSync(featDesign), `recorded-artifacts/features/${f.id}/ present`).toBe(true);
    if (f.buildReplay !== false) {
      const featBuild = path.join(corpusRoot, "recorded-build", "features", f.id);
      expect(fs.existsSync(featBuild), `recorded-build/features/${f.id}/ present (buildReplay)`).toBe(true);
    }
  }

  // The per-turn timeline (when present) is an ordered index with strictly
  // monotonic ordinals starting at 0, the invariant replayDesignTurn /
  // restoreBuildTurn + the recorder rely on.
  const indexFile = path.join(corpusRoot, "turns", "index.json");
  if (fs.existsSync(indexFile)) {
    const idx = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { turns?: { ordinal: number; dir: string }[] };
    expect(Array.isArray(idx.turns), `turns/index.json has a turns[] array`).toBe(true);
    const turns = idx.turns ?? [];
    turns.forEach((t, i) => {
      expect(t.ordinal, `turn ${i} ordinal is its index (monotonic from 0)`).toBe(i);
      expect(fs.existsSync(path.join(corpusRoot, "turns", t.dir)), `turn dir ${t.dir} exists`).toBe(true);
    });
  }

  // REPLAY-CONSISTENCY of the build corpus: for every build-replay story, the
  // turns a trusted-green replay actually dispatches must line up with the
  // recorded dirs. This is what shape-only checks missed (a corpus can be
  // structurally present yet un-replayable). See assertBuildTurnsReplayable.
  for (const f of features) {
    if (f.buildReplay === false) continue;
    assertBuildTurnsReplayable(corpusRoot, f.id);
  }
}

/** Per-story replay-consistency of the recorded-build corpus. A trusted-green
 *  replay re-dispatches ONLY the canonical sequence, RED (navigator), GREEN
 *  (driver), optional story REVIEW (navigator), optional REFACTOR (driver), and
 *  NEVER the capture-time detours (reflect / assess / repair / *-superseded), which
 *  replay-build filters out. So after dropping those, each story's remaining turn dirs must:
 *    (a) carry strictly-increasing NUMERIC prefixes (a resume-mislabeled dir with
 *        a stray low number, e.g. 001 after 010, breaks the lexical order replay
 *        sorts by, so it must not exist), and
 *    (b) match the shape navigator, driver, [navigator-review, [driver-refactor]].
 *  Either failure means a live replay would misalign, exactly the drift this
 *  guard exists to catch before it costs a cloud run. */
function assertBuildTurnsReplayable(corpusRoot: string, featureId: string): void {
  const storiesRoot = path.join(corpusRoot, "recorded-build", "features", featureId, "stories");
  if (!fs.existsSync(storiesRoot)) return;
  for (const story of fs.readdirSync(storiesRoot)) {
    const turnsDir = path.join(storiesRoot, story, "turns");
    if (!fs.existsSync(turnsDir)) continue;
    const all = fs.readdirSync(turnsDir).filter((n) => !n.startsWith(".")).sort();
    const kept = all.filter((n) => !/reflect|assess|repair|superseded/i.test(n));

    // (a) numeric prefixes strictly increase in the (lexical) order replay uses.
    const nums = kept.map((n) => {
      const m = /^(\d+)/.exec(n);
      expect(m, `${featureId}/${story}: build turn dir '${n}' has a numeric prefix`).not.toBeNull();
      return parseInt(m![1], 10);
    });
    for (let i = 1; i < nums.length; i++) {
      expect(
        nums[i] > nums[i - 1],
        `${featureId}/${story}: build turn dirs must have strictly increasing numeric prefixes ` +
          `(got ${kept[i - 1]} then ${kept[i]}), a resume-mislabeled dir corrupts replay order`,
      ).toBe(true);
    }

    // (b) the kept sequence is a valid trusted-green dispatch shape. Two cadences
    //     ship: WHOLE-STORY (one red->green for the story) and PER-AC (a red->green
    //     cycle PER acceptance criterion, with a review/refactor at each AC
    //     boundary). Both reduce, after dropping the self-heal detours above, to a
    //     run of complete RED->GREEN cycles interspersed with review/refactor at
    //     cycle boundaries. Validate with a small state machine rather than a fixed
    //     whitelist, so the guard still catches the real defects , an adjacent
    //     red,red / green,green (a retry-duplicated turn), a dangling red with no
    //     green, a leading green, or an unknown role , while allowing N cycles.
    const roles = kept.map((n) => n.replace(/^\d+-/, ""));
    const shape = roles.map((r) => {
      if (/^navigator-review/.test(r)) return "review";
      if (/^driver-refactor/.test(r)) return "refactor";
      if (/^navigator/.test(r)) return "red";
      if (/^driver/.test(r)) return "green";
      return `?(${r})`;
    });
    // States: "start" (nothing yet) | "afterRed" (a red awaits its green) |
    // "boundary" (a cycle just closed; a new cycle / review / refactor / end is ok).
    let state: "start" | "afterRed" | "boundary" = "start";
    let shapeOk = true;
    for (const s of shape) {
      if (s === "red") {
        if (state === "afterRed") { shapeOk = false; break; } // red,red = retry dup / dangling red
        state = "afterRed";
      } else if (s === "green") {
        if (state !== "afterRed") { shapeOk = false; break; } // green without a preceding red
        state = "boundary";
      } else if (s === "review" || s === "refactor") {
        if (state !== "boundary") { shapeOk = false; break; } // review/refactor mid-cycle (between red and its green)
        state = "boundary";
      } else {
        shapeOk = false; break; // unknown role token
      }
    }
    // Must end at a closed boundary (or empty): a trailing unpaired red is invalid.
    if (state === "afterRed") shapeOk = false;
    expect(
      shapeOk,
      `${featureId}/${story}: kept build turns must be a run of complete red->green cycles ` +
        `(whole-story or per-AC), review/refactor only at cycle boundaries; got [${shape.join(",")}] from [${kept.join(", ")}]`,
    ).toBe(true);
  }
}

describe("replay-scenarios: framework scaffolding", () => {
  it("ships the SCENARIOS.md capture/replay guide", () => {
    expect(fs.existsSync(path.join(REPLAY_DIR, "SCENARIOS.md"))).toBe(true);
  });

  it("ships the generic replay + capture entry scripts", () => {
    expect(fs.existsSync(path.join(REPLAY_DIR, "replay-scenario.sh"))).toBe(true);
    expect(fs.existsSync(path.join(REPLAY_DIR, "capture-scenario.sh"))).toBe(true);
  });
});

// Capture-wiring guard: capture-scenario.sh reads scenario.json (the single source
// for a scenario's conditions) and funnels it into create-project as flags. It must
// not set the e2e-scaffold door while the drive reads a different uiTrack door.
describe("capture-scenario.sh funnels scenario.json into create-project (one way in)", () => {
  const src = fs.readFileSync(path.join(REPLAY_DIR, "capture-scenario.sh"), "utf8");

  it("reads the manifest via the tested scenario-conditions reader", () => {
    expect(src).toMatch(/scenario-conditions\.cli\.js/);
    expect(src).toMatch(/SCENARIO_MANIFEST=/);
    expect(src).toMatch(/sc uiTrack/);
  });

  it("declares the UX track via create-project --ui-track (the ONE door for the UX lane)", () => {
    expect(src).toMatch(/create_flags\+=\(--ui-track\)/);
  });

  it("funnels language / runner / tiers from the manifest, not a harness hardcode", () => {
    expect(src).toMatch(/create_flags\+=\(--language/);
    expect(src).toMatch(/create_flags\+=\(--runner/);
    expect(src).toMatch(/--tiers/);
    // Language + runner come only from the manifest ($SC_LANG / $SC_RUNNER), never
    // a harness hardcode.
    expect(src).not.toMatch(/--language\s+python/);
    expect(src).not.toMatch(/--runner\s+self-hosted/);
  });

  it("has NO second UX door: no --ui->--enable-e2e mapping, no LAKEBASE_SFTDD_UI export", () => {
    expect(src).not.toMatch(/--enable-e2e/); // e2e is derived from uiTrack in create-project
    expect(src).not.toMatch(/LAKEBASE_SFTDD_UI\b/); // the removed env door
  });
});

describe("assertScenarioCorpus: logic exercised against a synthetic fixture", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-fixture-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const mk = (rel: string): void => {
    fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), "{}");
  };

  it("passes for a well-formed corpus (design + build + monotonic turns)", () => {
    mk("recorded-artifacts/features/F1-x/feature-spec.json");
    mk("recorded-build/features/F1-x/code/app.py");
    fs.mkdirSync(path.join(tmp, "turns", "0000-cut"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "turns", "index.json"),
      JSON.stringify({ turns: [{ ordinal: 0, dir: "0000-cut" }] }),
    );
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).not.toThrow();
  });

  it("fails when a build-replay feature is missing its recorded-build dir", () => {
    expect(() => assertScenarioCorpus(tmp, [{ id: "F2-missing", buildReplay: true }])).toThrow();
  });

  it("a design-only feature (buildReplay:false) needs no recorded-build", () => {
    fs.mkdirSync(path.join(tmp, "recorded-artifacts", "features", "F3-designonly"), { recursive: true });
    expect(() => assertScenarioCorpus(tmp, [{ id: "F3-designonly", buildReplay: false }])).not.toThrow();
  });
});

describe("assertScenarioCorpus: build-turn replay-consistency guard", () => {
  let tmp: string;
  const mkStory = (feature: string, story: string, turnDirs: string[]): void => {
    for (const d of turnDirs) {
      fs.mkdirSync(path.join(tmp, "recorded-build", "features", feature, "stories", story, "turns", d, "code"), {
        recursive: true,
      });
    }
    // Minimal design side so assertScenarioCorpus's structural checks pass.
    fs.mkdirSync(path.join(tmp, "recorded-artifacts", "features", feature), { recursive: true });
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-consistency-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("accepts a clean red,green,review,refactor story (detours filtered)", () => {
    // Includes reflect + assess + repair detours, which the guard filters out.
    mkStory("F1-x", "S1", [
      "001-navigator-reflect", "002-navigator", "003-driver",
      "004-navigator-assess-AC1", "005-driver-repair-AC1",
      "006-navigator-review", "007-driver-refactor",
    ]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).not.toThrow();
  });

  it("filters a green-superseded detour so the re-green is not a spurious extra green", () => {
    // The reactive-green supersession path: honest-GREEN verify failed, Navigator
    // ASSESSED + flagged superseded prior tests, Driver permissively re-greened
    // (labeled green-superseded). Replay trusts the verify + skips the assess -> re-run
    // pair, so this turn must be filtered; without the filter the kept shape reads
    // [red,green,green,review] (the F6/S1 + F6/S3 regression this guard now catches).
    mkStory("F1-x", "S1b", [
      "001-navigator-reflect", "002-navigator", "003-driver",
      "004-navigator-assess-AC1", "005-driver-green-superseded",
      "006-navigator-review",
    ]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).not.toThrow();
  });

  it("ACCEPTS the per-AC cadence: repeated red->green cycles with a review at each AC boundary", () => {
    // The stockflow-full (run17) cadence: a story built AC-by-AC records a red->green
    // per AC, each closed by a navigator-review at the AC boundary (self-heal detours
    // filtered out). The kept shape is [red,green,review, red,green,review, red,green,
    // review] , many cycles, all complete , which the state-machine shape check accepts
    // while still rejecting an adjacent red,red / green,green.
    mkStory("F1-x", "S-perac", [
      "001-navigator-reflect",
      "002-navigator", "003-driver", "004-navigator-review-AC1",
      "005-navigator", "006-driver", "007-navigator-assess-AC2", "008-driver-repair-AC2", "009-navigator-review-AC2",
      "010-navigator", "011-driver", "012-navigator-review-AC3",
    ]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).not.toThrow();
  });

  it("REJECTS a resume-mislabeled stray low-numbered dir (001 after 010)", () => {
    // The F6/S2 bug: a resumed final refactor written as 001 sorts before 007..010.
    // Lexical sort puts the stray 001 first, so the story reads as [refactor,...]:
    // caught either by the shape check or the monotonic check (both are rejections).
    mkStory("F1-x", "S2", ["007-navigator", "008-driver", "010-navigator-review", "001-driver-refactor"]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).toThrow(
      /strictly increasing|red->green cycles/,
    );
  });

  it("REJECTS a mixed-width numbering that lexically sorts to a valid shape but non-increasing numbers", () => {
    // 01/02/03 (width 2) then a resume-added width-1 '1-driver-refactor': lexical
    // sort keeps 0*-prefixed first, so the SHAPE reads valid (red,green,review,
    // refactor) yet the numbers go 1,2,3,1, the numeric-monotonic check must fire.
    mkStory("F1-x", "S2b", ["01-navigator", "02-driver", "03-navigator-review", "1-driver-refactor"]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).toThrow(/strictly increasing/);
  });

  it("REJECTS a build sequence with a leftover un-filtered shape", () => {
    // e.g. two greens with no review, an impossible trusted-green dispatch.
    mkStory("F1-x", "S3", ["001-navigator", "002-driver", "003-driver"]);
    expect(() => assertScenarioCorpus(tmp, [{ id: "F1-x", buildReplay: true }])).toThrow(/red->green cycles/);
  });
});

// (The "every committed scenario is well-formed + replay-ready" guard scans the real corpora set
//  under examples/replay/corpora/, so it moved to the consort-examples repo with the corpora. Its
//  validator logic — assertScenarioCorpus + assertBuildTurnsReplayable above — stays exercised here
//  against synthetic fixtures, so the shape-machine coverage lives in the kit.)
