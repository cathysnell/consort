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

// The HIL gates the run passes, in lifecycle order. test_list is a design SUB-gate, not one of the
// human decision points shown here.
const GATE_ORDER = ["intake", "plan", "spec", "acceptance", "deploy", "promote"] as const;

// Each gate's status FOR THE CURRENT STORY, derived from the log so the bubbles reset when the story
// changes instead of showing every gate ever opened. `plan` is sprint-level (not story-scoped); the
// rest reset per story — a gate the current story hasn't reached yet is absent (→ "upcoming").
export function storyGateStatus(events: DashboardState["recentEvents"], story: string | null): Record<string, "approved" | "pending"> {
  // Raw signal from the log: a gate is "pending" once it surfaces, "approved" if an approval is
  // logged. Scoped to the current story (plan is sprint-level, so never story-filtered).
  const raw: Record<string, "approved" | "pending"> = {};
  for (const e of events) {
    if (e.event !== "gate.surfaced" && e.event !== "gate.approved") continue;
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    const gate = typeof md.gate === "string" ? md.gate : null;
    if (!gate) continue;
    const evStory = typeof md.story === "string" ? md.story : typeof md.subject === "string" ? md.subject : null;
    if (gate !== "plan" && story && evStory && evStory !== story) continue;
    raw[gate] = e.event === "gate.approved" ? "approved" : raw[gate] === "approved" ? "approved" : "pending";
  }
  // INTERIM inference: the kit rarely logs `gate.approved` (see docs/design/kit-gaps-repair-plan.md),
  // so a gate that surfaced would read "pending" forever. But reaching a LATER-lifecycle gate proves
  // the earlier ones were approved — so mark a gate approved once ANY later gate has been reached.
  // The last-reached gate stays "pending" (the run is at it); gates never reached stay "upcoming".
  const out: Record<string, "approved" | "pending"> = {};
  GATE_ORDER.forEach((g, i) => {
    const laterReached = GATE_ORDER.slice(i + 1).some((gj) => raw[gj]);
    if (raw[g] === "approved" || laterReached) out[g] = "approved";
    else if (raw[g] === "pending") out[g] = "pending";
  });
  return out;
}

export function OrchestratorLane({ state }: { state: DashboardState }) {
  const { gateRows } = orchestratorStatus(state.recentEvents, state.gates, state.blockers);
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
  // Read the ONE focus observation instead of re-deriving from laneCurrent/gates/blockers: the run
  // is "waiting on you" when parked at a gate, "coordinating" when a step is actively running. (This
  // is the single source; the lane dots + step cards read the same focus.)
  const focus = state.focus;
  // An unresolved HIL escalation (a role kicked a problem up , a failed verify that couldn't
  // auto-heal) is the most urgent state, so it takes precedence over waiting/coordinating and turns
  // the card RED, matching the agent bubble's "issue" colour. Blockers are the escalation set.
  const issue = state.blockers.length > 0;
  const waiting = focus.kind === "gate";
  const running = focus.kind === "step";
  // The gate bubbles: the five HIL gates in lifecycle order, scoped to (and resetting with) the
  // current story. When PARKED at a gate, scope to THAT gate's story — `activity.story` can lag onto
  // a later story that began designing while this one awaits its gate, which would hide the parked
  // story's own passed gates. Otherwise use the active step's story.
  const bubbleStory =
    focus.kind === "gate"
      ? (() => {
          for (let i = state.recentEvents.length - 1; i >= 0; i--) {
            const e = state.recentEvents[i];
            if (e.event !== "gate.surfaced") continue;
            const md = (e.metadata ?? {}) as Record<string, unknown>;
            if (md.gate === focus.gate) return typeof md.story === "string" ? md.story : story;
          }
          return story;
        })()
      : story;
  const gateStatus = storyGateStatus(state.recentEvents, bubbleStory);
  const flashing = issue || waiting || running;
  const accent = issue ? "var(--status-critical)" : waiting ? "var(--status-gate)" : "var(--role-orchestrator)";
  const status = issue ? "issue" : waiting ? "waiting on you" : running ? "coordinating" : "idle";
  return (
    <div
      style={{
        background: issue ? "var(--status-critical-tint-faint)" : waiting ? "var(--status-gate-tint-faint)" : "var(--surface-card)",
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
      {/* RUN totals, summed across every agent – NOT the orchestrator's own (it is deterministic and
          spends nothing). Labeled "run" so the number isn't misread as the orchestrator's cost. */}
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
        run: {turns} turn{turns === 1 ? "" : "s"} · ${cost.toFixed(2)}
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

      {/* The five HIL gates in lifecycle order, scoped to the current story. A gate that has been
          reached is PURPLE — approved (done) and pending alike — with the one the run is parked at
          (focus) pulsing; still-to-come gates are dim grey. Purple, not green, marks a done human
          gate. Resets when the story changes because storyGateStatus only counts the current
          story's gate events. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {GATE_ORDER.map((g) => {
          const st = gateStatus[g];
          const isFocus = focus.kind === "gate" && focus.gate === g;
          const reached = st === "approved" || st === "pending" || isFocus;
          const border = reached ? "var(--status-gate)" : "var(--border-default)";
          const color = reached ? "var(--status-gate-text)" : "var(--text-faint)";
          return (
            <span
              key={g}
              title={`${g} gate — ${st ?? "not yet reached"}${g === "plan" ? " (sprint)" : ""}`}
              style={{
                fontSize: "0.64rem",
                padding: "2px 8px",
                borderRadius: radius.chip,
                border: `1px solid ${border}`,
                color,
                textTransform: "uppercase",
                letterSpacing: "0.03em",
                opacity: st || isFocus ? 1 : 0.5,
                ...(isFocus ? { animation: "lightflash 1.1s ease-in-out infinite" } : {}),
              }}
            >
              {g}
            </span>
          );
        })}
      </div>
    </div>
  );
}
