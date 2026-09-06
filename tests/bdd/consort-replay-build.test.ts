// Per-turn build replay: replayBuildTurn SYNCS the Kth recorded turn's code
// snapshot onto the project (mirror, incl. deletions within the codeTreeFilter
// scope), in place of spawning the Navigator/Driver. The driver visits EVERY
// build turn (assess/repair detours included) so the events run live against a
// tree byte-identical to record-time; the live verify then produces the verdict.
// Only the artifact delivery is mocked. Hermetic: real fs, tmpdirs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  replayBuildTurn,
  listBuildTurns,
  codeTreeFilter,
  recordedBuildVerdict,
  liveBuildVerdict,
  assertReplayBuildVerdictMatch,
  ReplayDivergenceError,
} from "../../consort/logging/replay-build.js";

const F = "F1-file-bug";
const S = "S1-create-bug";
let corpus: string;
let proj: string;
let tdd: string;

/** Write one recorded turn dir: turns/<slug>/code/<files> (+ optional cycle). */
function writeTurn(slug: string, files: Record<string, string>): void {
  const code = join(corpus, "features", F, "stories", S, "turns", slug, "code");
  for (const [rel, body] of Object.entries(files)) {
    const p = join(code, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
}

beforeEach(() => {
  corpus = mkdtempSync(join(tmpdir(), "rb-corpus-"));
  proj = mkdtempSync(join(tmpdir(), "rb-proj-"));
  tdd = join(proj, ".tdd");
  // A fresh scaffold's scripts/lk must NOT be clobbered by a snapshot copy.
  mkdirSync(join(proj, "scripts"), { recursive: true });
  writeFileSync(join(proj, "scripts", "lk"), "#FRESH scaffold lk\n");

  // Turn 1 (navigator): the first failing test. Includes junk that must NOT copy.
  writeTurn("001-navigator", {
    "tests/test_ac1.py": "def test_ac1(): assert False\n",
    "scripts/lk": "#stale snapshot lk – must NOT clobber the fresh scaffold\n",
    ".venv/bin/python": "binary-junk",
    "app/__pycache__/x.pyc": "bytecode-junk",
    ".env": "SECRET=should-not-copy\n",
  });
  // Turn 2 (driver): the impl that makes it pass.
  writeTurn("002-driver", {
    "tests/test_ac1.py": "def test_ac1(): assert True\n",
    "app/main.py": "# impl by the driver\n",
  });
});
afterEach(() => {
  rmSync(corpus, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("replayBuildTurn (per-turn build replay)", () => {
  it("lists the story's turns in order", () => {
    expect(listBuildTurns(corpus, F, S)).toEqual(["001-navigator", "002-driver"]);
    expect(listBuildTurns(corpus, F, "S2-uncovered")).toEqual([]);
  });

  it("overlays the Kth turn's code, skipping scaffold-owned + junk + secrets", () => {
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 1 })).toBe(true);
    // turn 1 RED test landed
    expect(readFileSync(join(proj, "tests", "test_ac1.py"), "utf8")).toMatch(/assert False/);
    // scaffold-owned scripts/lk untouched
    expect(readFileSync(join(proj, "scripts", "lk"), "utf8")).toBe("#FRESH scaffold lk\n");
    // junk + secrets never copied
    expect(existsSync(join(proj, ".venv"))).toBe(false);
    expect(existsSync(join(proj, "app", "__pycache__"))).toBe(false);
    expect(existsSync(join(proj, ".env"))).toBe(false);
  });

  it("advances turn by turn: turn 2 syncs the GREEN impl over turn 1", () => {
    replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 1 });
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 2 })).toBe(true);
    expect(readFileSync(join(proj, "tests", "test_ac1.py"), "utf8")).toMatch(/assert True/); // RED -> GREEN
    expect(existsSync(join(proj, "app", "main.py"))).toBe(true);
  });

  it("SYNCS the snapshot: a file present in the project but ABSENT from the turn's snapshot is DELETED", () => {
    // Turn 1 lays a scratch file the build later abandons; turn 2's snapshot does
    // not contain it. A faithful per-turn sync must REMOVE it so the tree is
    // byte-identical to record-time (an additive overlay would leave it behind).
    writeTurn("001-navigator", { "tests/test_ac1.py": "def test_ac1(): assert False\n", "app/scratch.py": "# abandoned after turn 1\n" });
    replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 1 });
    expect(existsSync(join(proj, "app", "scratch.py"))).toBe(true); // present after turn 1
    // Turn 2's snapshot (from beforeEach: tests/test_ac1.py + app/main.py) has NO app/scratch.py.
    replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 2 });
    expect(existsSync(join(proj, "app", "scratch.py"))).toBe(false); // DELETED by the sync
    expect(existsSync(join(proj, "app", "main.py"))).toBe(true); // turn 2's real code present
    // A sync must NEVER delete scaffold-owned / junk / secrets outside the captured scope.
    expect(readFileSync(join(proj, "scripts", "lk"), "utf8")).toBe("#FRESH scaffold lk\n");
  });

  it("returns false past the last recorded turn (a corpus miss; the driver hard-fails, never runs a live agent)", () => {
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 3 })).toBe(false);
  });

  it("REPLAYS every recorded turn incl. assess/repair detours, each syncing its own snapshot (the page lands AT the repair turn)", () => {
    // A capture that hit a per-turn verify failure records navigator-assess +
    // driver-repair detours between green and review. Replay MUST re-dispatch
    // them: with a faithful per-turn snapshot the tree matches record-time, so
    // the live verify reproduces the recorded failure and the router routes
    // assess -> repair on its own. Each turn syncs ITS snapshot; the page is
    // authored in the repair turn, so it must land AT the repair turn (turn 4),
    // NOT be smuggled in early via a cumulative review snapshot. listBuildTurns
    // therefore keeps assess/repair (reflect stays special-cased elsewhere).
    const src = join(corpus, "features", F, "stories", "S3-detour", "turns");
    const w = (slug: string, files: Record<string, string>) => {
      for (const [rel, body] of Object.entries(files)) {
        const p = join(src, slug, "code", rel);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, body);
      }
    };
    w("001-navigator", { "tests/test_ac1.py": "assert False\n" });
    w("002-driver", { "app/main.py": "# green, no page yet\n" });
    w("003-navigator-assess-AC1", { "app/main.py": "# assess: still no page\n" });
    w("004-driver-repair-AC1", { "app/main.py": "# repaired\n", "app/page.py": "# THE PAGE (authored in repair)\n" });
    w("005-navigator-review", { "app/main.py": "# repaired\n", "app/page.py": "# THE PAGE (present at review)\n" });

    // Every recorded turn is dispatchable, in order: red(1) green(2) assess(3)
    // repair(4) review(5). The page does NOT exist before the repair turn.
    replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 1 });
    replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 2 });
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 3 })).toBe(true);
    expect(existsSync(join(proj, "app", "page.py"))).toBe(false); // NOT present before repair (faithful)
    // The repair turn (4) authors the page – it lands HERE, at the step it was written.
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 4 })).toBe(true);
    expect(readFileSync(join(proj, "app", "page.py"), "utf8")).toMatch(/authored in repair/);
    // The review turn (5) is also replayed.
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 5 })).toBe(true);
    expect(readFileSync(join(proj, "app", "page.py"), "utf8")).toMatch(/present at review/);
    // Exactly 5 recorded turns: turn 6 is a miss.
    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S3-detour", turnIndex: 6 })).toBe(false);
  });

  it("returns false for a story the corpus does not cover", () => {
    const ok = replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: "S2-uncovered", turnIndex: 1 });
    expect(ok).toBe(false);
    expect(existsSync(join(proj, "app"))).toBe(false);
  });

  it("a review turn delivers review-verdict.json (drives refactors) but NOT timestamped cycle-NNN.json", () => {
    // Record turn 3 as a review turn: code + a verdict + a cycle timestamp file.
    const c = join(corpus, "features", F, "stories", S, "turns", "003-navigator-review-AC1", "tdd", "cycles", F, S, "AC1");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "review-verdict.json"), JSON.stringify({ refactor: true, notes: "extract route" }));
    writeFileSync(join(c, "cycle-001.json"), JSON.stringify({ red_at: "t", green_at: "t" }));
    writeTurn("003-navigator-review-AC1", { "app/main.py": "# reviewed\n" });

    const ok = replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 3 });
    expect(ok).toBe(true);
    // verdict delivered into .tdd/cycles (so the live review drives the refactor)
    const dst = join(tdd, "cycles", F, S, "AC1");
    expect(existsSync(join(dst, "review-verdict.json"))).toBe(true);
    // the timestamped cycle file is NOT delivered (live cycle CLIs own RED/GREEN)
    expect(existsSync(join(dst, "cycle-001.json"))).toBe(false);
  });

  it("an assess turn delivers the Navigator's regression-assessment + superseded markers (route repair/supersede), NOT the bare cycle/green-failure", () => {
    // The recorded ASSESS turn carries the Navigator's classification: a driver-fixable
    // regression-assessment (with fixDirective) routes a Driver REPAIR next; the live assess CLI
    // reads it off disk. Without delivery it re-derives from a bare failure -> mis-routes to HIL.
    const c = join(corpus, "features", F, "stories", S, "turns", "003-navigator-assess-AC1", "tdd", "cycles", F, S, "AC1");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "regression-assessment.json"), JSON.stringify({ diagnosis: "client pages absent", fixDirective: "create the pages" }));
    writeFileSync(join(c, "superseded-tests.json"), JSON.stringify({ tests: ["tests/old.py"], reason: "superseded" }));
    writeFileSync(join(c, "green-failure.json"), JSON.stringify({ assessed: true, summary: "client suite failed" }));
    writeFileSync(join(c, "cycle-001.json"), JSON.stringify({ red_at: "t" }));
    writeTurn("003-navigator-assess-AC1", { "app/main.py": "# assessed\n" });

    expect(replayBuildTurn({ replayBuildDir: corpus, projectDir: proj, consortDir: tdd, featureId: F, story: S, turnIndex: 3 })).toBe(true);
    const dst = join(tdd, "cycles", F, S, "AC1");
    expect(existsSync(join(dst, "regression-assessment.json"))).toBe(true); // routes the repair
    expect(existsSync(join(dst, "superseded-tests.json"))).toBe(true); // routes a supersession green
    // The live cycle CLIs still own RED/GREEN + the bare green-failure marker.
    expect(existsSync(join(dst, "cycle-001.json"))).toBe(false);
    expect(existsSync(join(dst, "green-failure.json"))).toBe(false);
  });

  describe("divergence guard: the recorded verdict is the oracle for the live verify", () => {
    // Write a recorded turn's cycle state (the oracle) into its snapshot's tdd/cycles.
    const writeRecordedCycle = (slug: string, ac: string, cyc: Record<string, unknown>, greenFailure?: Record<string, unknown>): void => {
      const d = join(corpus, "features", F, "stories", S, "turns", slug, "tdd", "cycles", F, S, ac);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "cycle-001.json"), JSON.stringify(cyc));
      if (greenFailure) writeFileSync(join(d, "green-failure.json"), JSON.stringify(greenFailure));
    };
    // Write the LIVE tree's cycle state under the project consortDir.
    const writeLiveCycle = (ac: string, cyc: Record<string, unknown>, greenFailure?: Record<string, unknown>): void => {
      const d = join(tdd, "cycles", F, S, ac);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "cycle-001.json"), JSON.stringify(cyc));
      if (greenFailure) writeFileSync(join(d, "green-failure.json"), JSON.stringify(greenFailure));
    };

    it("recordedBuildVerdict reads PASS (green_at set) / FAIL (unassessed green-failure) / undefined (RED-only), reflect-skipped", () => {
      // turns for S: 001-navigator (RED, no green), 002-driver (GREEN pass), 003-driver (recorded FAIL).
      writeTurn("001-navigator", { "tests/t.py": "assert False\n" });
      writeRecordedCycle("001-navigator", "AC1", { red_at: "t" });
      writeTurn("002-driver", { "app/main.py": "# green\n" });
      writeRecordedCycle("002-driver", "AC1", { red_at: "t", green_at: "t2" });
      writeTurn("003-driver", { "app/main.py": "# fail\n" });
      writeRecordedCycle("003-driver", "AC1", { red_at: "t" }, { assessed: false, summary: "client suite failed" });
      expect(recordedBuildVerdict(corpus, F, S, 1)).toBeUndefined(); // RED-only
      expect(recordedBuildVerdict(corpus, F, S, 2)).toBe("pass");
      expect(recordedBuildVerdict(corpus, F, S, 3)).toBe("fail");
      expect(recordedBuildVerdict(corpus, F, S, 9)).toBeUndefined(); // out of range
    });

    it("liveBuildVerdict reads the SAME shape from the project tree", () => {
      writeLiveCycle("AC1", { red_at: "t", green_at: "t2" });
      expect(liveBuildVerdict(tdd, F, S)).toBe("pass");
      writeLiveCycle("AC2", { red_at: "t" }, { assessed: false, summary: "x" });
      expect(liveBuildVerdict(tdd, F, S)).toBe("fail"); // an unassessed failure dominates
    });

    it("MATCH (recorded FAIL + live FAIL) does NOT throw – the normal self-heal path", () => {
      writeTurn("001-navigator", { "tests/t.py": "x\n" });
      writeRecordedCycle("001-navigator", "AC1", { red_at: "t" }, { assessed: false, summary: "recorded fail" });
      writeLiveCycle("AC1", { red_at: "t" }, { assessed: false, summary: "live fail too" });
      expect(() => assertReplayBuildVerdictMatch({ replayBuildDir: corpus, consortDir: tdd, featureId: F, story: S, turnIndex: 1, role: "driver" })).not.toThrow();
    });

    it("DIVERGENCE (recorded PASS but live FAIL) THROWS ReplayDivergenceError + halts", () => {
      writeTurn("001-navigator", { "app/main.py": "# was green when recorded\n" });
      writeRecordedCycle("001-navigator", "AC1", { red_at: "t", green_at: "t2" }); // recorded PASS
      writeLiveCycle("AC1", { red_at: "t" }, { assessed: false, summary: "but live regressed" }); // live FAIL
      expect(() => assertReplayBuildVerdictMatch({ replayBuildDir: corpus, consortDir: tdd, featureId: F, story: S, turnIndex: 1, role: "driver" }))
        .toThrow(ReplayDivergenceError);
    });

    it("DIVERGENCE (recorded FAIL but live PASS) THROWS – the recorded self-heal turn won't be dispatched", () => {
      writeTurn("001-navigator", { "app/main.py": "# recorded a failure here\n" });
      writeRecordedCycle("001-navigator", "AC1", { red_at: "t" }, { assessed: false, summary: "recorded fail" }); // recorded FAIL
      writeLiveCycle("AC1", { red_at: "t", green_at: "t2" }); // live PASS
      expect(() => assertReplayBuildVerdictMatch({ replayBuildDir: corpus, consortDir: tdd, featureId: F, story: S, turnIndex: 1, role: "driver" }))
        .toThrow(/REPLAY DIVERGENCE/);
    });

    it("no recorded verdict (RED-only turn) is a no-op (nothing to compare)", () => {
      writeTurn("001-navigator", { "tests/t.py": "assert False\n" });
      writeRecordedCycle("001-navigator", "AC1", { red_at: "t" }); // no green, no failure
      writeLiveCycle("AC1", { red_at: "t" });
      expect(() => assertReplayBuildVerdictMatch({ replayBuildDir: corpus, consortDir: tdd, featureId: F, story: S, turnIndex: 1, role: "navigator" })).not.toThrow();
    });
  });

  it("codeTreeFilter rejects scaffold/junk/secret paths, keeps real source", () => {
    const root = "/p";
    const f = codeTreeFilter(root);
    expect(f("/p/app/main.py")).toBe(true);
    expect(f("/p/tests/test_x.py")).toBe(true);
    expect(f("/p/scripts/lk")).toBe(false); // scaffold-owned top dir
    expect(f("/p/app/__pycache__/x.pyc")).toBe(false); // junk at depth
    expect(f("/p/.venv/bin/python")).toBe(false);
    expect(f("/p/.env")).toBe(false); // secret
    expect(f("/p/.env.example")).toBe(true); // template kept
    expect(f("/p/Makefile")).toBe(false); // scaffold config – corpus must not clobber
    expect(f("/p/deploy-targets.yaml")).toBe(false); // scaffold config (run command)
    // Dependency manifests + lock files are scaffold-owned (carry the project
    // name + env-specific lock fields); overlaying a corpus copy dirties the
    // tracked lock file and blocks the next story's experiment fork.
    expect(f("/p/client/package.json")).toBe(false);
    expect(f("/p/client/package-lock.json")).toBe(false);
    expect(f("/p/client/yarn.lock")).toBe(false);
    expect(f("/p/client/src/App.tsx")).toBe(true); // real client SOURCE still kept
  });
});
