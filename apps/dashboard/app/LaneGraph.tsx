"use client";

import {
  LANE_IDS,
  WORKFLOW,
  type BackEdge,
  type Lane,
  type LaneId,
  type LaneStep,
} from "@/lib/topology";
import { colorForRole, font, radius } from "@/lib/theme";
import type { DashboardState } from "@/lib/types";

// The per-lane inter-agent sub-workflows (Kevin's Figure 2) — what happens *inside* each
// lifecycle node the top-level WorkflowGraph shows as one box.
//
// Layout: the lane the playhead is in renders as a full graph; the other two collapse to a
// one-line summary you can click to expand. Three full graphs would cost ~3x WorkflowGraph's
// vertical space for two lanes you are usually not looking at.
//
// Everything derives from the folded state (`topology.laneSteps` / `laneCurrent`), so this
// works identically live and scrubbed back. Two facts about that data shape this component:
//
//   1. Gate steps NEVER light from events (`match: null` — human-decided, out of band). So a
//      gate's state comes from the run's gate list, not from laneSteps. Rendering them off the
//      step data alone would draw every gate permanently pending.
//   2. 52% of playhead positions light no lane step at all (measured on the 421-event corpus),
//      so `laneCurrent` is frequently null. "Nothing lit" is the common case, not an error —
//      the lane still shows its reached steps, just with no pulsing one.

const STEP_W = 104;
const STEP_H = 46;
const GAP = 30;
const PAD = 14;
const BACK_LANE_H = 34; // vertical room under the row for back-edges

// Which lifecycle node each lane sits inside, and which node's arrival proves the lane is
// finished. The lane's own step predicates cannot answer either question: `b-perm` only lights
// on a supersession (so a clean run never reaches every build step), and no plan step matches
// `breakdown` (so a feature's planning can complete without lighting one). The lifecycle nodes
// are the honest signal, and this is the single place that mapping lives.
const LANE_NODE: Record<LaneId, { own: string; after: string[] }> = {
  plan: { own: "plan", after: ["design", "build"] },
  design: { own: "design", after: ["build", "deploy"] },
  build: { own: "build", after: ["deploy"] },
};

// The gate each lane's terminal gate step reflects. Lane gates are human-decided and never
// appear in laneSteps, so their status comes from state.gates.
const LANE_STEP_GATE: Record<string, string> = {
  "p-gate": "plan",
  "d-gate": "spec",
  "b-accept": "acceptance",
};

type StepState = "done" | "current" | "pending" | "gate-open" | "gate-approved";

export function LaneGraph({ state }: { state: DashboardState }) {
  const current = state.topology.laneCurrent;
  // `laneCurrent.lane` is typed `string` (DashboardState is the wire format, and a replay source
  // may not share this vocabulary), so validate rather than cast to find the ACTIVE lane.
  const currentLane = LANE_IDS.find((l) => l === current?.lane) ?? null;
  // ALL lanes stay expanded , no accordion , so clicking one never collapses the others. The
  // active lane is highlighted (LanePanel's accent border + header tint); the rest render quietly.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {LANE_IDS.map((laneId) => (
        <LanePanel
          key={laneId}
          laneId={laneId}
          lane={WORKFLOW.lanes[laneId]}
          done={new Set(state.topology.laneSteps[laneId] ?? [])}
          currentStep={currentLane === laneId ? current!.step : null}
          state={state}
        />
      ))}
    </div>
  );
}

function LanePanel({
  laneId,
  lane,
  done,
  currentStep,
  state,
}: {
  laneId: LaneId;
  lane: Lane;
  done: Set<string>;
  currentStep: string | null;
  state: DashboardState;
}) {
  // Gates are excluded from the ratio: they never light from events, so counting them would
  // cap every lane below 100% forever.
  const lightable = lane.steps.filter((s) => s.match !== null);
  const reached = lightable.filter((s) => done.has(s.id)).length;
  const active = currentStep !== null;

  // Lane status takes the LIFECYCLE as its sole authority. The lane's own lit-step count is
  // NOT evidence about completion in either direction, and both directions were shipped bugs:
  //
  //   - A lane can finish without lighting every step (`b-perm` only lights on a supersession)
  //     or even ANY step (no plan predicate matches `breakdown`, the sole plan phase attributed
  //     to a named feature). Judging by steps alone printed "0/3 steps · not started" directly
  //     beneath a green Plan node in the lifecycle graph.
  //   - Conversely, a later node being reached does NOT mean this lane is done with its own
  //     work — a back-edge can send the run around again.
  //
  // The tempting middle rule — "complete only once every step is lit" — was measured across
  // every prefix fold of both real logs and REFUTED: on the shipped end of the corpus the plan
  // lane sits at 1/3 (0/3 on the live log, where `p-req` never lights at all), so that rule
  // labels a shipped feature's planning "in progress". Lit-step counts cannot tell "finished,
  // some steps never applicable" apart from "still going" — only the lifecycle can.
  //
  // So mid-flight is "the lifecycle is still inside this lane's own node", which is exactly
  // what `activeNode` means. Measured over all 421-event corpus and 380-event live playheads,
  // this never once called a lane complete whose own node had not been passed.
  const passed = new Set(state.topology.passedNodes);
  const nodes = LANE_NODE[laneId];
  const entered = done.size > 0 || passed.has(nodes.own) || nodes.after.some((n) => passed.has(n));
  const movedOn = nodes.after.some((n) => passed.has(n)) || (laneId === "build" && state.lane === "complete");
  const inOwnNode = state.topology.activeNode === nodes.own;
  const complete = !active && !inOwnNode && movedOn;

  const statusLabel = active
    ? "active"
    : complete
      ? "complete"
      : entered
        ? "in progress"
        : "not started";
  const statusColor = active ? "var(--status-accent-text)" : complete ? "var(--status-good-text)" : "var(--text-faint)";

  return (
    <div
      style={{
        background: "var(--surface-card)",
        border: `1px solid ${active ? "var(--status-accent)" : "var(--border-default)"}`,
        borderRadius: radius.panel,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
          background: active ? "var(--status-accent-tint-soft)" : "transparent",
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            color: "var(--text-strong)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            minWidth: 62,
          }}
        >
          {laneId}
        </span>
        {/* The ratio is suppressed once a lane is complete. "1/7 steps · complete" contradicts
            itself, and the ratio is the half that's misleading: steps that never light are
            invisible to it, so it under-reports a lane that genuinely finished. Keep it while
            the number is actionable (you're watching progress), drop it once it isn't. It
            stays reachable as the dot strip's tooltips. */}
        {complete ? null : (
          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
            {reached}/{lightable.length} steps
          </span>
        )}
        <span style={{ fontSize: "0.68rem", color: statusColor, fontWeight: active ? 700 : 500 }}>
          · {statusLabel}
        </span>
        {/* Dot strip: the whole lane's shape at a glance, so a collapsed lane still says
            something more specific than a fraction. */}
        <span style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
          {lane.steps.map((s) => (
            <span
              key={s.id}
              title={`${s.label} — ${s.sub}`}
              style={{
                width: 7,
                height: 7,
                borderRadius: s.gate ? 1 : "50%",
                background:
                  s.id === currentStep
                    ? "var(--status-accent)"
                    : done.has(s.id)
                      ? "var(--status-good)"
                      : s.gate
                        ? gateTintFor(s, state)
                        : "var(--border-strong)",
                transform: s.gate ? "rotate(45deg)" : undefined,
              }}
            />
          ))}
        </span>
      </div>

      <div style={{ borderTop: `1px solid var(--border-default)`, padding: "4px 12px 10px" }}>
        <div style={{ fontSize: "0.66rem", color: "var(--text-faint)", margin: "6px 0 2px" }}>{lane.title}</div>
        <LaneSvg laneId={laneId} lane={lane} done={done} currentStep={currentStep} state={state} />
      </div>
    </div>
  );
}

function gateTintFor(step: LaneStep, state: DashboardState): string {
  const gateName = LANE_STEP_GATE[step.id];
  if (!gateName) return "var(--border-strong)";
  const g = state.gates.find((x) => x.name === gateName);
  if (!g) return "var(--border-strong)";
  return g.status === "approved" ? "var(--status-good)" : "var(--status-gate)";
}

// --------------------------------------------------------------------------- the graph

const ROW_GAP = 54; // vertical room between the build lane's two rows, for the connecting arrows + labels
const TOP_LANE = 24; // headroom ABOVE row 0 so a backward loop arc (REVIEW→RED) is not cropped

function LaneSvg({
  laneId,
  lane,
  done,
  currentStep,
  state,
}: {
  laneId: LaneId;
  lane: Lane;
  done: Set<string>;
  currentStep: string | null;
  state: DashboardState;
}) {
  // The BUILD lane is a fixed 3-row grid (col = grid slot, so steps ALIGN across rows): row 0 is
  // the happy path, row 1 is ASSESS placed directly under VERIFY (col 2), row 2 is the fan-out
  // (repair/perm/hil) centred under assess. Every other lane is a single row in declared order.
  const pos = new Map<string, { x: number; y: number; row: number; col: number }>();
  const place = (id: string, row: number, col: number) =>
    pos.set(id, { x: PAD + col * (STEP_W + GAP), y: PAD + TOP_LANE + row * (STEP_H + ROW_GAP), row, col });
  let nRows: number;
  if (laneId === "build") {
    const grid: Record<string, [number, number]> = {
      "b-red": [0, 0], "b-green": [0, 1], "b-verify": [0, 2], "b-review": [0, 3], "b-refactor": [0, 4], "b-accept": [0, 5],
      "b-assess": [1, 2],
      "b-repair": [2, 1], "b-perm": [2, 2], "b-hil": [2, 3],
    };
    lane.steps.forEach((s) => place(s.id, ...(grid[s.id] ?? [0, 0])));
    nRows = 3;
  } else {
    // Every other lane: the main steps run along row 0 in declared order; a raise-to-HIL escalation
    // terminal DROPS to row 1, aligned to the COLUMN of the node that raises it (its backEdge
    // source), so it sits directly under that node (p-hil under author-requests, d-hil under the
    // Navigator reflect). A lane with no escalation stays a single row.
    const mainSteps = lane.steps.filter((s) => !s.escalation);
    const colOf = new Map<string, number>();
    mainSteps.forEach((s, c) => {
      place(s.id, 0, c);
      colOf.set(s.id, c);
    });
    const escalations = lane.steps.filter((s) => s.escalation);
    escalations.forEach((s) => {
      const raiser = lane.backEdges.find(([, to]) => to === s.id)?.[0];
      place(s.id, 1, raiser !== undefined ? (colOf.get(raiser) ?? 0) : 0);
    });
    nRows = escalations.length > 0 ? 2 : 1;
  }
  const maxCol = Math.max(0, ...[...pos.values()].map((p) => p.col));
  const width = PAD * 2 + (maxCol + 1) * STEP_W + maxCol * GAP;
  const height = PAD * 2 + TOP_LANE + nRows * STEP_H + (nRows - 1) * ROW_GAP + BACK_LANE_H;
  const cx = (id: string) => pos.get(id)!.x + STEP_W / 2;
  const cy = (id: string) => pos.get(id)!.y + STEP_H / 2;

  // Route ONE edge from its two endpoint boxes: same-row forward = a straight line; same-row
  // backward (REVIEW→RED, the next dev loop) = an arc ABOVE the row so it never crosses the row
  // below; cross-row = an elbow that drops/rises between the two rows. Branch (failure-arm) edges
  // are amber + dashed and carry their label; happy-path edges go green once traversed.
  const edge = (from: string, to: string, o: { branch?: boolean; label?: string }) => {
    const p = pos.get(from);
    const q = pos.get(to);
    if (!p || !q) return null;
    const isDone = !o.branch && done.has(from) && (done.has(to) || to === currentStep);
    const stroke = o.branch ? "var(--status-warning)" : isDone ? "var(--status-good)" : "var(--border-strong)";
    const marker = o.branch ? "url(#lg-arrow-branch)" : isDone ? "url(#lg-arrow-done)" : "url(#lg-arrow)";
    const sameRow = p.row === q.row;
    let d: string;
    let lx = 0;
    let ly = 0;
    if (sameRow && q.col === p.col + 1) {
      // adjacent forward: straight line
      d = `M ${p.x + STEP_W} ${cy(from)} H ${q.x - 4}`;
      lx = (p.x + STEP_W + q.x) / 2;
      ly = cy(from) - 4;
    } else if (sameRow && q.col > p.col) {
      // forward but SKIPS an intervening step (assess→perm over repair): arc BELOW the row so the
      // line clearly emanates from `from` and never crosses the box in between (which read as a
      // phantom repair→perm edge).
      const yy = p.y + STEP_H + 14;
      d = `M ${cx(from)} ${p.y + STEP_H} V ${yy} H ${cx(to)} V ${q.y + STEP_H}`;
      lx = (cx(from) + cx(to)) / 2;
      ly = yy + 9;
    } else if (sameRow) {
      // Backward same-row loop. In a multi-row lane, row 0's loop (REVIEW→RED) arcs ABOVE, into the
      // TOP_LANE headroom (never crossing the row below); a single-row lane's loop (design's
      // navigator→spec-author revise) arcs BELOW, into the reserved BACK_LANE_H. Either way it stays
      // inside the viewBox , the crop was a backward arc routed to a negative y.
      const above = p.row === 0 && nRows > 1;
      const yy = above ? p.y - 16 : p.y + STEP_H + 16;
      d = `M ${cx(from)} ${above ? p.y : p.y + STEP_H} V ${yy} H ${cx(to)} V ${above ? q.y : q.y + STEP_H}`;
      lx = (cx(from) + cx(to)) / 2;
      ly = above ? yy - 3 : yy + 9;
    } else if (q.row > p.row) {
      const yy = (p.y + STEP_H + q.y) / 2; // drop into the lower row
      d = `M ${cx(from)} ${p.y + STEP_H} V ${yy} H ${cx(to)} V ${q.y - 4}`;
      lx = (cx(from) + cx(to)) / 2;
      ly = yy - 3;
    } else {
      const yy = (q.y + STEP_H + p.y) / 2; // rise into the upper row
      d = `M ${cx(from)} ${p.y} V ${yy} H ${cx(to)} V ${q.y + STEP_H + 4}`;
      lx = (cx(from) + cx(to)) / 2;
      ly = yy - 3;
    }
    const dashed = o.branch || (sameRow && q.col < p.col);
    // A happy-path same-row backward edge is the cycle loop (build's REVIEW→RED) , label it
    // "next cycle" so the green line reads as the next dev loop, not a re-verify. Branch labels
    // (verify fails / regression / re-verify) stay amber; the cycle-loop label is neutral.
    const labelText = o.label ?? (sameRow && q.col < p.col && !o.branch ? "next cycle" : undefined);
    // Branch labels (verify fails / regression / re-verify) are amber; the happy-path "next cycle"
    // label reads green to match its loop line , not muted.
    const labelFill = o.branch ? "var(--status-warning-text)" : "var(--status-good-text)";
    return (
      <g key={`${from}->${to}`}>
        <path
          d={d}
          fill="none"
          style={{ stroke }}
          strokeWidth={isDone ? 2 : 1.4}
          strokeDasharray={dashed ? "4 3" : undefined}
          markerEnd={marker}
          opacity={o.branch ? 0.85 : 1}
        />
        {labelText ? (
          <text x={lx} y={ly} textAnchor="middle" style={{ fontSize: 7.5, fill: labelFill, fontFamily: font.sans }}>
            {labelText}
          </text>
        ) : null}
      </g>
    );
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ display: "block", minWidth: Math.min(width, 720), maxHeight: height + 16 }}
        role="img"
        aria-label={lane.title}
      >
        <defs>
          <marker id="lg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--border-strong)" }} />
          </marker>
          <marker id="lg-arrow-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--status-good)" }} />
          </marker>
          <marker id="lg-arrow-branch" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--status-warning)" }} />
          </marker>
        </defs>

        {lane.edges.map(([from, to]) => edge(from, to, {}))}
        {lane.backEdges.map((be) => edge(be[0], be[1], { branch: true, label: be[2] }))}

        {lane.steps.map((s) => (
          <StepBox key={s.id} step={s} x={pos.get(s.id)!.x} y={pos.get(s.id)!.y} state={stepState(s, done, currentStep, state)} />
        ))}
      </svg>
    </div>
  );
}

function stepState(
  s: LaneStep,
  done: Set<string>,
  currentStep: string | null,
  state: DashboardState,
): StepState {
  if (s.id === currentStep) return "current";
  if (done.has(s.id)) return "done";
  // Gates never light from events; take their state from the run's gate list so a cleared
  // gate reads as cleared instead of pending forever.
  if (s.gate && s.match === null) {
    const gateName = LANE_STEP_GATE[s.id];
    const g = gateName ? state.gates.find((x) => x.name === gateName) : undefined;
    if (g?.status === "approved") return "gate-approved";
    if (g) return "gate-open";
  }
  return "pending";
}

// A fail/side path: arcs below the row, labelled, in warning amber so it never reads as the
// happy path. `depth` staggers concentric arcs so multiple back-edges don't overlap.
function BackEdgeArc({
  be,
  xs,
  midY,
  depth,
}: {
  be: BackEdge;
  xs: Map<string, number>;
  midY: number;
  depth: number;
}) {
  const [from, to, label] = be;
  const a = xs.get(from);
  const b = xs.get(to);
  if (a === undefined || b === undefined) return null;
  const y = midY + STEP_H / 2 + 16 + depth * 9;
  const ax = a + STEP_W / 2;
  const bx = b + STEP_W / 2;
  return (
    <g>
      <path
        d={`M ${ax} ${midY + STEP_H / 2} C ${ax} ${y}, ${bx} ${y}, ${bx} ${midY + STEP_H / 2}`}
        fill="none"
        style={{ stroke: "var(--status-warning)" }}
        strokeWidth={1.2}
        strokeDasharray="3 3"
        markerEnd="url(#lg-arrow-branch)"
        opacity={0.75}
      />
      <text
        x={(ax + bx) / 2}
        y={y - 1}
        textAnchor="middle"
        style={{ fontSize: 7.5, fill: "var(--status-warning-text)", fontFamily: font.sans }}
      >
        {label}
      </text>
    </g>
  );
}

function StepBox({ step, x, y, state }: { step: LaneStep; x: number; y: number; state: StepState }) {
  const isGate = step.gate === true;

  // ONLY the active step is highlighted (accent fill + role-coloured border + pulse). Every other
  // state stays quiet , done steps are readable but not highlighted, so the one active agent is the
  // sole thing that pops. Each step still carries its agent's colour via the role stripe below. A
  // pending human GATE keeps a thin gate-coloured border so it stays legible, but no fill.
  // A HUMAN gate (plan / spec / acceptance) is `gate:true` AND never lights from events
  // (match === null) , its status comes from the human's decision. The automated VERIFY checkpoint
  // is also `gate:true` but DOES light from events (match: verify), so it is NOT a human gate and
  // must not wear the purple gate colour. Only human gates get purple/green; everything else is
  // quiet unless it's the active step.
  const isHumanGate = isGate && step.match === null;
  const highlighted = state === "current";
  const stroke = highlighted
    ? step.role
      ? colorForRole(step.role)
      : "var(--status-accent)"
    : step.escalation
      ? "var(--status-critical)" // a raise-to-HIL terminal reads CRITICAL (red), distinct from amber branches + purple gates
      : isHumanGate
        ? state === "gate-approved"
          ? "var(--status-good)"
          : "var(--status-gate)"
        : "var(--border-default)";

  const fill = highlighted ? "var(--status-accent-tint)" : "var(--surface-inset)";

  const labelColor = highlighted
    ? "var(--status-accent-text)"
    : state === "done" || state === "gate-approved"
      ? "var(--text-muted)"
      : "var(--text-faint)";

  const title = `${step.label} — ${step.sub}${isGate ? " (human gate)" : ""}${
    step.branch ? " (branch: only on failure)" : ""
  } · ${state.replace("gate-", "gate ")}`;

  return (
    <g style={state === "current" ? { animation: "softpulse 2s ease-in-out infinite" } : undefined}>
      <title>{title}</title>
      <rect
        x={x}
        y={y}
        width={STEP_W}
        height={STEP_H}
        rx={isGate ? 4 : 8}
        style={{ fill, stroke }}
        strokeWidth={state === "current" ? 2.5 : 1.4}
        strokeDasharray={step.branch ? "5 3" : undefined}
      />
      {/* Role stripe: ties a step to its agent bubble by colour. Full strength in EVERY state so
          each agent's colour always reads (the active step is set apart by fill + pulse, not by
          dimming the others' colours). Gates have no owner. */}
      {step.role ? (
        <rect x={x} y={y} width={3.5} height={STEP_H} rx={1.5} style={{ fill: colorForRole(step.role) }} />
      ) : null}
      <text
        x={x + STEP_W / 2}
        y={y + 18}
        textAnchor="middle"
        style={{
          fontSize: 9,
          fontWeight: 700,
          fill: labelColor,
          fontFamily: font.sans,
          textTransform: "uppercase",
          letterSpacing: "0.02em",
        }}
      >
        {step.label}
      </text>
      <text
        x={x + STEP_W / 2}
        y={y + 32}
        textAnchor="middle"
        style={{ fontSize: 7.5, fill: state === "pending" ? "var(--text-faint)" : "var(--text-muted)", fontFamily: font.sans }}
      >
        {truncate(step.sub, 22)}
      </text>
    </g>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
