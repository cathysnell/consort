"use client";

import type { AgentLogEvent, DashboardState } from "@/lib/types";
import { font, radius } from "@/lib/theme";

// The scrum-master / orchestrator coordination panel (the template's top `.lane` box): what the
// deterministic driver is doing right now — its latest dispatch, and the recent gate coordination
// it has surfaced. Replaces the old "live build not recording" fidelity slot. Everything is derived
// from the folded state (recentEvents + gates + blockers), so it works live and scrubbed alike.

export interface OrchestratorStatus {
  /** The current dispatch line, from the most recent handoff (message, else synthesized). */
  current: string | null;
  /** A one-line coordination detail: "dispatch to <role> (<phase>)". */
  coord: string | null;
  /** Recent gate coordination rows, e.g. "acceptance: story S3-…" — newest last, deduped, capped. */
  gateRows: string[];
  /** Open gates (gate) + escalations/blockers (esc), for the chip row. */
  chips: { kind: "gate" | "esc"; label: string }[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Pure derivation of the orchestrator's coordination status from the folded event tail + gates +
 *  blockers. Kept separate from the component so it is unit-tested directly. */
export function orchestratorStatus(
  events: AgentLogEvent[],
  gates: DashboardState["gates"],
  blockers: DashboardState["blockers"],
): OrchestratorStatus {
  // Most recent handoff → the current dispatch. `to_role` + `phase` synthesize the line when the
  // event carried no message.
  let current: string | null = null;
  let coord: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "handoff") continue;
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const to = str(md.to_role);
    const phase = str(md.phase);
    current = str(e.message) ?? (to ? `dispatch ${to}${phase ? ` for ${phase}` : ""}` : "coordinating");
    coord = to ? `dispatch to ${to}${phase ? ` (${phase})` : ""}` : null;
    break;
  }

  // Recent gate coordination rows (gate.surfaced / gate.approved), newest last, deduped, capped.
  const rows: string[] = [];
  for (const e of events) {
    if (e.event !== "gate.surfaced" && e.event !== "gate.approved") continue;
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const gate = str(md.gate) ?? "gate";
    const subject = str(md.subject) ?? str(md.story);
    const row = subject ? `${gate}: story ${subject}` : gate;
    if (!rows.includes(row)) rows.push(row);
  }
  const gateRows = rows.slice(-6);

  // Chips: unresolved gates + escalations/blockers.
  const chips: { kind: "gate" | "esc"; label: string }[] = [];
  for (const g of gates) if (g.status !== "approved") chips.push({ kind: "gate", label: g.name });
  for (const b of blockers) chips.push({ kind: "esc", label: b.source });

  return { current, coord, gateRows, chips };
}

export function OrchestratorLane({ state }: { state: DashboardState }) {
  const { gateRows, chips } = orchestratorStatus(state.recentEvents, state.gates, state.blockers);
  // The orchestrator runs the drive session itself, so its card carries the run's own vitals: the
  // dispatch it is on now ("orchestrator START <phase>" + the story it's driving), the running
  // tally of turns it has driven, and the session's cumulative cost. Both totals are RUN-level
  // (summed across every agent) — the orchestrator's OWN turn count is zero (it's deterministic),
  // which is not what you want to see; the tally of turns it has orchestrated is.
  const activity = state.orchestratorActivity;
  const story = activity?.story ?? state.stories.find((s) => s.active)?.id ?? null;
  const turns = state.agents.reduce((sum, a) => sum + a.turns, 0);
  const cost = state.totalCost;
  // The card carries the orchestrator's SLATE identity (its role colour), and turns PURPLE only when
  // it's WAITING on a human (an open gate/escalation). It pulses while active or waiting and goes
  // quiet once the run completes. `softpulse` glows in `currentColor`, so `accent` (set as the card
  // colour below) is what tints the pulse; children set their own explicit colours.
  const waiting = chips.length > 0;
  const running = activity !== null && state.lane !== "complete";
  const flashing = waiting || running;
  const accent = waiting ? "var(--status-gate)" : "var(--role-orchestrator)";
  const status = waiting ? "waiting on you" : running ? "coordinating" : "idle";
  return (
    <div
      style={{
        background: waiting ? "var(--status-gate-tint-faint)" : "var(--surface-card)",
        // Longhands only (no `border` shorthand): the left edge is a 3px accent stripe while the
        // other three sides are 1px, and mixing shorthand with borderLeft warns on rerender.
        borderTop: `1px solid ${flashing ? accent : "var(--border-default)"}`,
        borderRight: `1px solid ${flashing ? accent : "var(--border-default)"}`,
        borderBottom: `1px solid ${flashing ? accent : "var(--border-default)"}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: radius.panel,
        padding: "10px 14px",
        marginBottom: 12,
        ...(flashing ? { color: accent, animation: "softpulse 2.2s ease-in-out infinite" } : {}),
      }}
    >
      <div style={{ fontSize: "0.95rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-strong)" }}>
        orchestrator
      </div>
      <div
        style={{
          fontSize: "0.9rem",
          fontWeight: 700,
          color: waiting ? "var(--status-gate-text)" : "var(--text-strong)",
          marginTop: 4,
        }}
      >
        {status}
      </div>
      {activity?.action ? (
        <div style={{ fontSize: "0.78rem", color: "var(--text-body)", marginTop: 3, fontFamily: font.mono }}>{activity.action}</div>
      ) : null}
      {story ? (
        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--status-accent-text)", marginTop: 2 }}>▸ {story}</div>
      ) : null}
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
        {turns} turn{turns === 1 ? "" : "s"} · ${cost.toFixed(2)}
      </div>

      {gateRows.length > 0 ? (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {gateRows.map((r) => (
            <div key={r} style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: font.mono }}>
              {r}
            </div>
          ))}
        </div>
      ) : null}

      {chips.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {chips.map((c, i) => (
            <span
              key={`${c.kind}-${c.label}-${i}`}
              style={{
                fontSize: "0.64rem",
                padding: "2px 8px",
                borderRadius: radius.chip,
                border: `1px solid ${c.kind === "esc" ? "var(--status-critical)" : "var(--status-gate)"}`,
                color: c.kind === "esc" ? "var(--status-critical-text)" : "var(--status-gate-text)",
                textTransform: "uppercase",
                letterSpacing: "0.03em",
              }}
            >
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
