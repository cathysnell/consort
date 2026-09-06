// replay-turn: the SHARED core every optimization experiment runs through. A recorded corpus turn
// carries a `replay-set/` (written by the recorder for EVERY turn – spec-author, architect, dba,
// test-strategist, ux-designer, navigator, driver): the exact preconditions the agent ran under
// (pre-project tree, resolved inputs, the fully-assembled prompt, the resolved levers). An experiment
// REPLAYS those preconditions byte-for-byte and perturbs ONLY a lever – so a result is attributable to
// the lever, not to a regenerated context. This module reads a replay-set and rehydrates the portable
// <PROJECT_ROOT> token to a live project dir; the caller drives the turn (cfg.instructionsOverride =
// the recorded prompt as the base body, context levers appended via contextPackSuffix) and judges the
// next-step determination against the recording. Deliberately dependency-light (fs) + unit-testable.
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT_TOKEN } from "../../consort/logging/turn-recorder.js";

/** The resolved levers the recorded turn ran with (replay-set/levers.json). model/effort are the
 *  baseline a candidate lever overrides; session/resumeKeyFrom/role are the turn's identity. */
export interface RecordedTurnLevers {
  model?: string;
  effort?: string;
  session?: string;
  resumeKeyFrom?: string;
  role?: string;
}

/** A recorded turn's replay-set: everything needed to reproduce its preconditions. */
export interface ReplaySet {
  /** The corpus turn dir (…/turns/NNNN-<label>). */
  turnDir: string;
  /** ordinal + role + story + the recorded action (from turn.json). */
  ordinal: number;
  role: string;
  story?: string;
  action: Record<string, unknown>;
  /** The FULLY ASSEMBLED prompt the agent saw, with the <PROJECT_ROOT> token still in place (rehydrate
   *  it to the live dir with `rehydrate`). This is the recorded CONTEXT held constant across the sweep. */
  promptRaw: string;
  /** The resolved levers the turn ran with (baseline for model/effort perturbation). */
  levers: RecordedTurnLevers;
  /** Resolved input contents, keyed by logical input id (replay-set/inputs/<id>). */
  inputs: Record<string, string>;
  /** Absolute path to replay-set/pre-project (the exact pre-turn code tree). */
  preProjectDir: string;
}

/** Rehydrate the portable <PROJECT_ROOT> token in recorded text back to a live project dir – the exact
 *  inverse of the recorder's relativizeProjectPaths. So the prompt the agent gets points at the real
 *  rehydrated tree, byte-identical to the recording modulo the (necessarily different) root path. */
export function rehydrate(text: string, projectDir: string): string {
  const root = projectDir.replace(/\/+$/, "");
  if (!text || !root) return text;
  return text.split(PROJECT_ROOT_TOKEN).join(root);
}

/** Read a corpus turn's replay-set. Throws if the turn dir has no replay-set (an un-replayable turn). */
export function readReplaySet(turnDir: string): ReplaySet {
  const setDir = join(turnDir, "replay-set");
  const promptPath = join(setDir, "prompt.txt");
  if (!existsSync(promptPath)) throw new Error(`replay-set incomplete: no prompt.txt under ${setDir}`);
  const turn = JSON.parse(readFileSync(join(turnDir, "turn.json"), "utf8")) as {
    ordinal?: number; role?: string; story?: string; action?: Record<string, unknown>;
  };
  const leversPath = join(setDir, "levers.json");
  const levers = existsSync(leversPath) ? (JSON.parse(readFileSync(leversPath, "utf8")) as RecordedTurnLevers) : {};
  const inDir = join(setDir, "inputs");
  const inputs: Record<string, string> = {};
  if (existsSync(inDir)) {
    for (const e of readdirSync(inDir, { withFileTypes: true })) {
      if (e.isFile()) inputs[e.name] = readFileSync(join(inDir, e.name), "utf8");
    }
  }
  return {
    turnDir,
    ordinal: turn.ordinal ?? -1,
    role: turn.role ?? levers.role ?? "",
    story: turn.story,
    action: turn.action ?? {},
    promptRaw: readFileSync(promptPath, "utf8"),
    levers,
    inputs,
    preProjectDir: join(setDir, "pre-project"),
  };
}
