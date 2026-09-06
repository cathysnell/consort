// role-telemetry: the per-role turn instrumentation the isolation substrate exists to produce.
// The whole manifest/chain refactor lets us run ONE role's turn on its own (recorded inputs
// replayed in, only that role live), with no full-project scaffold – which is what makes it
// cheap to MEASURE and lever-sweep each role independently. This module is the survival +
// output half: it carries what the optimize harness measured per trial (durationMs / costUsd /
// tokens / the agent-reported num_turns) PLUS the transcript and WHICH LEVERS were in effect,
// persists it to a durable dir (the workspace is thrown away; the record must outlive it), and
// formats a one-line summary the run prints. Pure + JSON-serializable – no I/O beyond the one
// write.
//
// This is deliberately the SAME field set the optimize harness's TrialResult captured
// (durationMs, costUsd, inputTokens, cacheReadTokens) so a per-role live run and a sweep trial
// are directly comparable – a role's isolated baseline here IS a trial the sweep can beat.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The levers in effect for a role's turn (what a sweep varies). Mirrors the manifest
 *  agentOptions + the DriveEffectsConfig scope levers, so a record states exactly what produced
 *  its numbers. All optional – a default-lever run simply omits the ones it did not set. */
export interface RoleLevers {
  model?: string;
  effort?: string;
  session?: "fresh" | "resume";
  resumeKeyFrom?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Free-form note for any non-standard lever a sweep applied (taskSuffix/contextPack/etc.). */
  note?: string;
}

/** The agent-reported usage for the turn (from the stream-json result event via TurnUsage).
 *  Absent when the agent reported none (a mock/replay turn, or a stream with no result event). */
export interface RoleAgentUsage {
  /** Agent-side turn count (`num_turns`) – the retry/loop signal. */
  numTurns?: number;
  /** The CLI-reported wall-clock (`duration_ms`), distinct from the outer step timer. */
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Tool calls the turn made (transcript tool count) – the "how much did it DO" signal. */
  toolCalls?: number;
}

/** The agent's captured trace for the turn (prompt it was dispatched with, its final assistant
 *  text, and the ordered tool actions) – the same triple the legacy turn-recorder persisted. */
export interface RoleTranscript {
  prompt: string;
  finalText: string;
  tools: string[];
}

/** One isolated role turn's full instrumentation record – the thing that SURVIVES the run. */
export interface RoleTelemetry {
  /** The design/plan role whose turn this measures. */
  role: string;
  /** The chain dir the turn ran in (its manifest ids are <chain>-seed / <chain>-live). */
  chain: string;
  /** The model the turn ran on (also in levers.model; hoisted for the summary line). */
  model?: string;
  /** The levers in effect (what a sweep varies to try to beat this baseline). */
  levers: RoleLevers;
  /** The ORCHESTRATOR's outer wall-clock for the whole step (spawn + validate), ms. This is
   *  the number the vitest per-test timer reports; it always exists. */
  outerDurationMs: number;
  /** The agent's self-reported usage (tokens/cost/num_turns/duration), when available. */
  agent?: RoleAgentUsage;
  /** The turn's route outcome (produced / blocked / revise / escalate). */
  outcome: string;
  /** The artifact the role produced (workspace-relative), when it produced one. */
  producedFile?: string;
  /** The agent's trace, when captured. */
  transcript?: RoleTranscript;
  /** The QUALITY score (0..1) of the produced artifact vs the recorded baseline, from the
   *  semantic/functional judge – present only when a sweep ran the quality gate. A fast candidate
   *  with a LOW score produced a conformant-but-thinner artifact than the baseline (the coverage
   *  the conformance gate can't see). Undefined = quality not judged (conformance-only run). */
  semanticScore?: number;
  /** BUILD DISCRIMINATOR classification (build sweeps only): the assess-style verdict on the
   *  produced code – "equivalent" (clean, converged with NO self-heal – the BEST outcome),
   *  "superseded-shift", "regression", or "insufficient" (the only failing verdict). Undefined
   *  on a design sweep (flat semanticScore instead). */
  classification?: string;
  /** The NEXT STEP the discriminator classification warrants (accept / permissive-refactor-
   *  superseded / driver-repair-with-directive / escalate). */
  nextStep?: string;
}

/** Format one record as a single human-scannable line for the run output. Omits any number the
 *  agent did not report (no NaN / undefined leaks). Durations shown in seconds. */
export function formatRoleTelemetry(t: RoleTelemetry): string {
  const secs = (ms: number | undefined): string => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "?");
  const parts: string[] = [`[telemetry] ${t.role} (${t.chain}) – ${t.outcome}`];
  if (t.model) parts.push(`model=${t.model}`);
  // Outer wall-clock always present; agent duration when reported.
  parts.push(`wall=${secs(t.outerDurationMs)}`);
  if (t.agent?.durationMs !== undefined) parts.push(`agent=${secs(t.agent.durationMs)}`);
  if (t.agent?.numTurns !== undefined) parts.push(`turns=${t.agent.numTurns}`);
  if (t.agent?.costUsd !== undefined) parts.push(`cost=$${t.agent.costUsd.toFixed(2)}`);
  if (t.agent?.inputTokens !== undefined) {
    const cache = t.agent.cacheReadTokens !== undefined ? ` (${t.agent.cacheReadTokens} cached)` : "";
    parts.push(`in=${t.agent.inputTokens}${cache}`);
  }
  if (t.agent?.outputTokens !== undefined) parts.push(`out=${t.agent.outputTokens}`);
  if (t.semanticScore !== undefined) parts.push(`quality=${t.semanticScore.toFixed(2)}`);
  return parts.join(" | ");
}

/**
 * Persist one role's telemetry record to `<dir>/<chain>.telemetry.json` (one file per chain, so
 * a whole per-role suite lands as a directory of records the sweep/report can join). Returns the
 * path written. The dir is the CALLER's durable location – NOT the throwaway workspace, so the
 * record outlives the rm'd `.consort`.
 */
export function writeRoleTelemetry(dir: string, record: RoleTelemetry): string {
  const path = join(dir, `${record.chain}.telemetry.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}
