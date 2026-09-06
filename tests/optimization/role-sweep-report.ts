// role-sweep-report: the before/after view over a per-role sweep's trials. Ranks the GATE-PASSING
// candidates by wall-clock (the thing being optimized), names the fastest one that BEAT the
// baseline as the winner (with the % speedup + the cost delta), and formats a human-readable
// report. A faster-but-gate-FAILING candidate is never the winner (the gate is the floor: a win
// must still produce a conformant artifact). If nothing beats the baseline, there is no winner ,
// the role's default levers stand.

import { formatRoleTelemetry, type RoleTelemetry } from "../../consort/optimize/role-telemetry.js";
import type { SweepTrial } from "./role-sweep.js";

/** One ranked row in the report (a gate-passing candidate + its deltas vs baseline). */
export interface SweepRow {
  candidateId: string;
  levers: SweepTrial["levers"];
  outerDurationMs: number;
  costUsd?: number;
  /** % faster than baseline by wall-clock (positive = faster). */
  speedupPct: number;
  /** Dollar delta vs baseline (negative = cheaper). */
  costDeltaUsd?: number;
  /** BUILD discriminator classification (build sweeps only), surfaced as a positive note. */
  classification?: string;
}

/** A human note for a build discriminator classification (a clean verdict reads as a WIN, not
 *  merely "passed"). Empty on a design sweep (no classification). */
function classificationNote(classification?: string): string {
  switch (classification) {
    case "equivalent":
      return "  [converged clean – no self-heal needed]";
    case "superseded-shift":
      return "  [superseded-shift – permissive refactor (viable)]";
    case "regression":
      return "  [driver-fixable regression (viable)]";
    default:
      return "";
  }
}

/** The full sweep report. */
export interface SweepReport {
  role: string;
  baselineMs: number;
  baselineCostUsd?: number;
  /** Gate-passers ranked fastest-first (includes the baseline). */
  ranked: SweepRow[];
  /** The fastest gate-passer that BEAT the baseline, or undefined when none did. */
  winner?: SweepRow;
  /** Candidates that failed the gate or crashed (id + why), for the report tail. */
  rejected: Array<{ candidateId: string; reason: string }>;
}

function rowFrom(t: RoleTelemetry, baselineMs: number, baselineCost?: number): SweepRow {
  const speedupPct = baselineMs > 0 ? ((baselineMs - t.outerDurationMs) / baselineMs) * 100 : 0;
  const cost = t.agent?.costUsd;
  return {
    candidateId: t.chain.split("#")[1] ?? t.chain,
    levers: t.levers,
    outerDurationMs: t.outerDurationMs,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    speedupPct,
    ...(cost !== undefined && baselineCost !== undefined ? { costDeltaUsd: cost - baselineCost } : {}),
    ...(t.classification ? { classification: t.classification } : {}),
  };
}

/**
 * Build the before/after report from the sweep trials. The baseline trial (candidateId
 * "baseline") sets the reference wall-clock + cost. Gate-passers are ranked fastest-first; the
 * winner is the fastest gate-passer strictly faster than the baseline (never the baseline itself,
 * never a gate-failer). Everything else lands in `rejected` with a reason.
 */
export function reportRoleSweep(trials: SweepTrial[], baselineMsOverride?: number): SweepReport {
  const baseline = trials.find((t) => t.candidateId === "baseline");
  // Prefer an explicit baseline (e.g. the RECORDED original turn's wall-clock from the corpus) so
  // candidates are scored same/better/worse vs the RECORDING, not a noisy fresh baseline run. Falls
  // back to the "baseline" candidate's measured time when no override is given.
  const baselineMs = baselineMsOverride ?? baseline?.telemetry?.outerDurationMs ?? 0;
  const baselineCost = baseline?.telemetry?.agent?.costUsd;
  const role = baseline?.telemetry?.role ?? trials.find((t) => t.telemetry)?.telemetry?.role ?? "unknown";

  // Winner-eligible = conformance PASSED and (no quality gate ran OR quality PASSED). A candidate
  // that is conformant but FAILED the quality gate is conformant-but-thinner-than-baseline – it
  // must NOT win on speed alone (the whole point of the quality gate). It still appears ranked
  // (with its score) for transparency, but is excluded from winner selection + flagged rejected.
  const eligible = trials.filter((t) => t.gatePassed && t.telemetry && t.qualityPassed !== false);
  const ranked = eligible
    .map((t) => rowFrom(t.telemetry!, baselineMs, baselineCost))
    .sort((a, b) => a.outerDurationMs - b.outerDurationMs);

  // The winner: fastest ELIGIBLE candidate that is NOT the baseline AND is strictly faster than it.
  const winner = ranked.find((r) => r.candidateId !== "baseline" && r.outerDurationMs < baselineMs);

  const rejected = trials
    .filter((t) => !t.gatePassed || t.qualityPassed === false)
    .map((t) => ({
      candidateId: t.candidateId,
      reason: t.disqualified
        ? `disqualified: ${t.reason ?? "crashed"}`
        : !t.gatePassed
          ? `gate failed (${t.telemetry?.outcome ?? "no live turn"})`
          : `quality below baseline (score ${t.telemetry?.semanticScore?.toFixed(2) ?? "?"})`,
    }));

  return {
    role,
    baselineMs,
    ...(baselineCost !== undefined ? { baselineCostUsd: baselineCost } : {}),
    ranked,
    ...(winner ? { winner } : {}),
    rejected,
  };
}

/** Format the report as a human-readable block for the sweep CLI output. */
export function formatRoleSweepReport(r: SweepReport): string {
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const lines: string[] = [];
  lines.push(`=== per-role sweep: ${r.role} ===`);
  lines.push(`baseline: ${secs(r.baselineMs)}${r.baselineCostUsd !== undefined ? ` | $${r.baselineCostUsd.toFixed(2)}` : ""}`);
  lines.push(`gate-passers (fastest first):`);
  for (const row of r.ranked) {
    const lever = Object.keys(row.levers).length ? JSON.stringify(row.levers) : "(baseline levers)";
    const cost = row.costUsd !== undefined ? ` | $${row.costUsd.toFixed(2)}` : "";
    const delta = row.candidateId === "baseline" ? "" : ` | ${row.speedupPct >= 0 ? "-" : "+"}${Math.abs(row.speedupPct).toFixed(0)}% wall`;
    // Surface a BUILD discriminator classification as a POSITIVE: a clean "equivalent" verdict is
    // the best outcome (converged with no self-heal), not merely "passed". superseded-shift +
    // regression(+fix) are viable routings; annotate them so the report reads as the assess turn would.
    lines.push(`  ${row.candidateId}: ${secs(row.outerDurationMs)}${cost}${delta} – ${lever}${classificationNote(row.classification)}`);
  }
  if (r.winner) {
    const cd = r.winner.costDeltaUsd;
    lines.push(
      `WINNER: ${r.winner.candidateId} – ${r.winner.speedupPct.toFixed(0)}% faster (${secs(r.winner.outerDurationMs)} vs ${secs(r.baselineMs)})` +
        (cd !== undefined ? `, ${cd <= 0 ? "cheaper" : "pricier"} by $${Math.abs(cd).toFixed(2)}` : "") +
        ` – levers ${JSON.stringify(r.winner.levers)}`,
    );
  } else {
    lines.push(`WINNER: none – no candidate beat the baseline (the role's default levers stand).`);
  }
  if (r.rejected.length) {
    lines.push(`rejected:`);
    for (const rj of r.rejected) lines.push(`  ${rj.candidateId}: ${rj.reason}`);
  }
  return lines.join("\n");
}

/** Re-export for the CLI: format a single trial's telemetry line (baseline/candidate summary). */
export { formatRoleTelemetry };
