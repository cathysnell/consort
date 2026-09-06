// Replay a story's BUILD turn by turn from a recorded-build corpus – the engine
// behind run-to-release-engineer. It is the build-stage analog of
// replay-artifacts.ts (which replays each DESIGN role turn): instead of one
// monolithic "skip to the release engineer", the deterministic driver VISITS
// every Navigator/Driver turn and, instead of spawning the model, overlays that
// turn's recorded artifact (the code it would have written, plus its cycle +
// experiment records). Only the artifact DELIVERY is mocked – the events run
// live: the experiment branch is cut from the feature branch for real, the
// cycle-record CLIs stamp RED/GREEN against the overlaid code, reviews + refactors
// drive off the overlaid verdicts. So the log shows every Navigator<->Driver
// interaction and the substrate ends up in the exact state a real build leaves.
//
// CORPUS SHAPE (per-turn): recorded-build/features/<F>/stories/<S>/turns/<NNN-...>/
// each holding code/ (the working tree at that turn, scaffold + junk filtered) +
// tdd/{cycles,experiments}. Turns are ordinal-keyed; the Kth Navigator/Driver
// turn of a deterministic drive maps to the Kth recorded turn dir (sorted).

import { existsSync, cpSync, readdirSync, statSync, rmSync, readFileSync } from "fs";
import { join, relative } from "path";
import { featuresDir, cyclesRootDir, ALL_ARTIFACT_ROOTS } from "../../consort/config/consort-paths.js";

/** Project paths the scaffold owns – never overwrite them from the snapshot, or
 *  the fresh run's kit resolver / pin / hooks break (on replay), and never
 *  capture them into a snapshot (on record) – they are scaffold, not build output.
 *  Matched on the first path segment relative to the code root. The workflow
 *  bookkeeping roots (.consort + legacy) come from the single source of truth. */
export const SCAFFOLD_OWNED = new Set<string>([
  ".git", ...ALL_ARTIFACT_ROOTS, ".lakebase", "scripts", ".claude", ".github", "node_modules",
]);

/** Runtime/build junk that must never enter a snapshot or overlay, matched at ANY
 *  path depth (e.g. app/__pycache__): virtualenvs, caches, vcs, deps. */
const JUNK_DIRS = new Set([
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".git", "node_modules",
]);
/** Files to never capture/overlay: secrets + OS cruft, plus scaffold-owned root
 *  config the build never authors – the corpus must not clobber the fresh
 *  scaffold's copy (e.g. Makefile/deploy-targets.yaml carry the run command; a
 *  stale `--reload` copy would re-break the deploy teardown). (.env.example IS kept.)
 *
 *  Dependency manifests + lock files (package.json / package-lock.json / yarn.lock
 *  / pnpm-lock.yaml) are likewise scaffold-owned: create-project stamps the
 *  PROJECT NAME into them and runs the installer, so a corpus copy carries the
 *  CAPTURE's project name (e.g. `<oldproject>-client`) plus env-specific lock
 *  fields (npm `libc` entries). Overlaying that stale copy, then a live
 *  deploy-verify `npm install`, leaves the tracked lock file dirty with the
 *  replay project's name, which makes the NEXT story's experiment fork refuse
 *  ("uncommitted changes"). Keeping the fresh scaffold's manifests (correct name,
 *  local npm) makes the install idempotent. All current corpora are Python+React
 *  with manifests only under client/ (the build authors client SOURCE, never the
 *  manifest); revisit if a Node-backend corpus ever needs a build-authored
 *  root package.json. */
const JUNK_FILES = new Set([
  ".env", ".DS_Store", "Makefile", "deploy-targets.yaml",
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

/** A cpSync filter that copies a code tree under `root` while skipping (a) the
 *  scaffold-owned top-level dirs (replay must not clobber the fresh scaffold's
 *  kit resolver/pin/hooks), (b) runtime/build junk at any depth, and (c) secrets.
 *  Shared by replay (overlay) + record (snapshot) so both stay clean. */
export function codeTreeFilter(root: string): (src: string) => boolean {
  return (src: string) => {
    const rel = src.slice(root.length).replace(/^[/\\]+/, "");
    if (rel === "") return true;
    const segs = rel.split(/[/\\]/);
    if (SCAFFOLD_OWNED.has(segs[0])) return false;
    if (segs.some((s) => JUNK_DIRS.has(s))) return false;
    const base = segs[segs.length - 1];
    return !(JUNK_FILES.has(base) || base.endsWith(".pyc"));
  };
}

/** Recursively collect the codeTreeFilter-INCLUDED file paths under `root`, relative to it. The
 *  same filter record + replay share, so the "in scope" set is identical on both sides. */
function inScopeFiles(root: string): Set<string> {
  const keep = codeTreeFilter(root);
  const out = new Set<string>();
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (!keep(p)) continue; // scaffold-owned / junk / secret – never in scope
      if (statSync(p).isDirectory()) walk(p);
      else out.add(relative(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** SYNC the project's working tree to a recorded `code/` snapshot: mirror it so the tree becomes
 *  byte-identical to record-time WITHIN the captured scope. Copies new/changed files from the
 *  snapshot AND DELETES files present in the project but ABSENT from the snapshot – but ONLY for
 *  files codeTreeFilter includes (scaffold-owned top dirs, junk, secrets, lockfiles are never
 *  touched, exactly as the copy side skips them). An additive copy alone would leave a prior turn's
 *  abandoned file behind and break fidelity; the delete pass is what makes replay faithful. */
function syncTreeFromSnapshot(codeSrc: string, projectDir: string): void {
  // 1) Delete in-scope project files the snapshot does not carry (the mirror's removal half).
  const snapshot = inScopeFiles(codeSrc);
  for (const rel of inScopeFiles(projectDir)) {
    if (!snapshot.has(rel)) rmSync(join(projectDir, rel), { force: true });
  }
  // 2) Copy the snapshot over the tree (add + overwrite), same filter as before.
  cpSync(codeSrc, projectDir, { recursive: true, force: true, filter: codeTreeFilter(codeSrc) });
}

/** The story's per-turn corpus dir (…/stories/<S>/turns). */
export function storyTurnsDir(replayBuildDir: string, featureId: string, story: string): string {
  return join(featuresDir(replayBuildDir), featureId, "stories", story, "turns");
}

/** Ordered turn dir names for a story (001-…, 002-…), or [] when uncovered. */
export function listBuildTurns(replayBuildDir: string, featureId: string, story: string): string[] {
  const dir = storyTurnsDir(replayBuildDir, featureId, story);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
}

export interface ReplayBuildTurnArgs {
  /** The recorded-build corpus root (LAKEBASE_CONSORT_REPLAY_BUILD_DIR). */
  replayBuildDir: string;
  /** The target project working tree (the experiment branch is checked out). */
  projectDir: string;
  /** The target project .tdd dir. */
  consortDir: string;
  featureId: string;
  story: string;
  /** 1-based ordinal of THIS Navigator/Driver turn within the story's build. */
  turnIndex: number;
}

/**
 * Replay one build turn: overlay the turnIndex-th recorded turn's CODE onto the
 * project, in place of spawning the Navigator/Driver. Returns false (a miss) when
 * the corpus lacks this story OR has fewer turns than turnIndex, so the caller
 * falls back to the live model for that turn.
 *
 * Delivers the turn's CODE (the LLM's output) plus, for a REVIEW turn, the
 * Navigator's `review-verdict.json` (its actual artifact: refactor true/false).
 * The verdict is what drives the refactor turns – without it, the live review CLI
 * defaults to "looks good", the Driver never refactors, and the tree freezes at
 * the pre-refactor state instead of the corpus's FINAL state. We deliver ONLY
 * review-verdict.json from .tdd, NEVER the timestamped cycle-NNN.json (overlaying
 * those corrupts the live cycle state machine – mis-sequenced RED/GREEN). So the
 * LIVE substrate still owns RED/GREEN + the experiment branch; we mock only the
 * two artifacts a turn actually produces (code, and the review verdict).
 */
export function replayBuildTurn(args: ReplayBuildTurnArgs): boolean {
  const { replayBuildDir, projectDir, consortDir, featureId, story, turnIndex } = args;
  // Replay EVERY recorded Navigator/Driver turn, each SYNCING its own snapshot – the honest
  // per-turn model. Because the tree becomes byte-identical to record-time, the LIVE verify
  // reproduces the recorded verdict: a recorded GREEN failure re-fails, the router routes
  // assess -> repair on its own, and the repair turn's snapshot lands the code AT the turn it
  // was authored. So assess/repair/superseded detours are KEPT (the router re-dispatches them);
  // dropping them was the old trusted-green model that orphaned a repair-authored file.
  //   - reflect is the ONE exception: a DESIGN gate that runs in the build lane, verdict-only
  //     (no code). The runner restores its verdict separately (restoreReflectVerdict) and does
  //     NOT count it as a build turn, so it stays filtered from the turn INDEX (the Kth counted
  //     Navigator/Driver dispatch maps to the Kth non-reflect recorded turn).
  const turns = listBuildTurns(replayBuildDir, featureId, story).filter((n) => !/reflect/i.test(n));
  if (turnIndex < 1 || turnIndex > turns.length) return false; // uncovered -> live
  const turnDir = join(storyTurnsDir(replayBuildDir, featureId, story), turns[turnIndex - 1]);

  const codeSrc = join(turnDir, "code");
  if (!existsSync(codeSrc)) return false;
  // SYNC (mirror + in-scope delete), not an additive copy: the tree must match record-time so a
  // later turn's absent-file (e.g. a page authored two turns on) is not left behind from a prior turn.
  syncTreeFromSnapshot(codeSrc, projectDir);

  // Deliver the Navigator's recorded JUDGMENT markers – the role OUTPUTS the live cycle CLIs read
  // to route the recorded self-heal, exactly as they were decided at record time:
  //   - review-verdict.json      : the REVIEW turn's refactor decision (drives the refactor turns);
  //   - regression-assessment.json + superseded-tests.json : the ASSESS turn's classification
  //       (driver-fixable regression w/ fixDirective -> routes a Driver REPAIR; supersession -> a
  //       permissive green). Without these the live assess CLI re-derives from a bare failure marker
  //       and mis-routes a recorded driver-fixable regression to HIL, freezing the story before the
  //       repair turn that authors its code.
  // Everything ELSE in tdd/cycles (RED/GREEN timestamps, review.json, the bare green-failure) stays
  // owned by the live cycle-record CLIs – the honest verify + @build-cycle stamps produce it.
  const REPLAYED_VERDICTS = ["review-verdict.json", "regression-assessment.json", "superseded-tests.json"];
  const cyclesSrc = join(turnDir, "tdd", "cycles");
  if (existsSync(cyclesSrc)) {
    cpSync(cyclesSrc, cyclesRootDir(consortDir), {
      recursive: true,
      force: true,
      filter: (src) => statSync(src).isDirectory() || REPLAYED_VERDICTS.some((v) => src.endsWith(v)),
    });
  }
  return true;
}

/** The GREEN verdict a recorded build turn captured, read from its snapshot's `tdd/cycles/<F>/<S>/`.
 *  This is the ORACLE the divergence guard compares the LIVE verify against under a faithful replay:
 *  because the tree is synced byte-identical to record-time, the live verify MUST reach this same
 *  verdict. Returns:
 *   - "pass" : a cycle whose `green_at` is set + no unassessed green-failure (the turn was GREEN);
 *   - "fail" : an unassessed `green-failure.json` present (a GREEN failure that drove assess->repair);
 *   - undefined : this recorded turn has no GREEN verdict (RED-only, review-verdict-only, or the
 *     turnIndex is out of range / the snapshot has no cycle state) – the guard skips it.
 *  turnIndex is the 1-based Kth Navigator/Driver dispatch, mapped to the Kth NON-reflect recorded
 *  turn (reflect is verdict-only + not counted – same index space as replayBuildTurn). */
/** Read a GREEN verdict from a story's cycles dir (`<root>/<F>/<S>/` holding per-AC dirs). Shared by
 *  the recorded oracle (snapshot's tdd/cycles) AND the live tree (consortDir's cycles) so both read
 *  the verdict IDENTICALLY. An unassessed green-failure (FAIL) dominates a greened cycle; a greened
 *  cycle with no unassessed failure is PASS; neither present is undefined (a RED/verdict-only turn). */
function verdictFromStoryCyclesDir(storyCyclesDir: string): "pass" | "fail" | undefined {
  if (!existsSync(storyCyclesDir)) return undefined;
  let sawPass = false;
  for (const ac of readdirSync(storyCyclesDir)) {
    const acDir = join(storyCyclesDir, ac);
    if (!statSync(acDir).isDirectory()) continue;
    const gf = join(acDir, "green-failure.json");
    if (existsSync(gf)) {
      try {
        if (JSON.parse(readFileSync(gf, "utf8")).assessed === false) return "fail";
      } catch { /* unparseable marker: ignore, fall through */ }
    }
    for (const f of readdirSync(acDir)) {
      if (!/^cycle-.*\.json$/.test(f)) continue;
      try {
        if (JSON.parse(readFileSync(join(acDir, f), "utf8")).green_at) sawPass = true;
      } catch { /* ignore */ }
    }
  }
  return sawPass ? "pass" : undefined;
}

export function recordedBuildVerdict(
  replayBuildDir: string,
  featureId: string,
  story: string,
  turnIndex: number,
): "pass" | "fail" | undefined {
  const turns = listBuildTurns(replayBuildDir, featureId, story).filter((n) => !/reflect/i.test(n));
  if (turnIndex < 1 || turnIndex > turns.length) return undefined;
  return verdictFromStoryCyclesDir(
    join(storyTurnsDir(replayBuildDir, featureId, story), turns[turnIndex - 1], "tdd", "cycles", featureId, story),
  );
}

/** The LIVE GREEN verdict on the project tree after a build turn's @build-cycle verify ran – read
 *  from `<consortDir>/cycles/<F>/<S>/`. Compared against recordedBuildVerdict by the divergence guard. */
export function liveBuildVerdict(consortDir: string, featureId: string, story: string): "pass" | "fail" | undefined {
  return verdictFromStoryCyclesDir(join(cyclesRootDir(consortDir), featureId, story));
}

/** A faithful replay reproduces the RECORDED verdict at each turn (the tree is synced byte-identical
 *  to record-time, so the honest live verify must reach the same pass/fail). A live verdict that
 *  DIVERGES from the recording is a regression – the corpus + code no longer agree – and must HALT
 *  the replay loudly rather than silently drift (mirrors ReplayCorpusMissError's discipline). */
export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/** Guard: after a build turn's live @build-cycle verify ran, assert the LIVE verdict matches what the
 *  Kth recorded build turn captured. THROWS ReplayDivergenceError on a true divergence:
 *   - recorded PASS but live FAIL  (a regression the recording never had), or
 *   - recorded FAIL but live PASS  (the recorded self-heal turn won't be dispatched – the tree drifted).
 *  A MATCH (pass==pass, fail==fail) is silent – recorded-FAIL+live-FAIL is the NORMAL self-heal path
 *  (the router will dispatch the recorded assess->repair). When either verdict is undefined (a RED-only
 *  / verdict-only turn, or no recorded cycle state) there is nothing to compare – no-op. Replay-only:
 *  callers gate on REPLAY_BUILD_DIR being set. */
export function assertReplayBuildVerdictMatch(args: {
  replayBuildDir: string;
  consortDir: string;
  featureId: string;
  story: string;
  turnIndex: number;
  role: string;
}): void {
  const recorded = recordedBuildVerdict(args.replayBuildDir, args.featureId, args.story, args.turnIndex);
  if (!recorded) return; // this recorded turn has no GREEN verdict to compare
  const live = liveBuildVerdict(args.consortDir, args.featureId, args.story);
  if (!live || live === recorded) return; // undefined = nothing produced yet; equal = match
  throw new ReplayDivergenceError(
    `[drive] REPLAY DIVERGENCE: build turn ${args.turnIndex} (${args.role} ${args.story}) – recorded verdict was ${recorded.toUpperCase()} ` +
      `but the live verify returned ${live.toUpperCase()}. The synced tree reproduces record-time, so a differing verdict means the ` +
      `corpus + code have drifted (a regression). Halting – debug the turn's snapshot vs the live verify; do not silently continue.`,
  );
}
