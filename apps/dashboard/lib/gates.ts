// The single source of truth for the workflow's HUMAN GATES.
//
// Before this existed, the gate concept was hand-wired across ~three maps that each keyed a gate
// slightly differently — `LANE_STEP_GATE` (lane step → name) in LaneGraph, `GATE_NODE_TO_GATE`
// (lifecycle node → name) in topology, and `GATE_ORDER` (ordered names) in OrchestratorLane — plus
// per-surface re-derivation of "is this a human gate vs an escalation". They drifted: the
// backlog-commit gate has a lane step but NO lifecycle node, so it fell through the maps that
// assumed every gate has both.
//
// Now every gate is ONE row here, keyed by `key` — the gate name carried in the run's
// gate.surfaced / gate.approved events and next.json. Each surface derives from this list:
//   - the lane sub-workflow node        (LaneGraph, via GATE_KEY_BY_STEP)
//   - the lifecycle-spine node          (WorkflowGraph, via GATE_KEY_BY_NODE / gateForNode)
//   - the orchestrator's gate bubbles   (OrchestratorLane, via LIFECYCLE_GATE_KEYS)
// and the reducer's ONE `focus` observation (kind "gate" carrying the key) drives all three at
// once: the parked gate's node glows, the orchestrator glows, and the transport reads WAITING.
// A new gate is a single row here, not an edit in six files.

export interface GateDef {
  /** The gate name carried in the run's gate state / gate.surfaced / gate.approved / next.json. */
  key: string;
  /** The lane sub-workflow step id (LaneGraph.WORKFLOW). */
  laneStep: string;
  /** The lifecycle-spine node id (WorkflowGraph), or null for a lane-only gate (the backlog commit). */
  node: string | null;
}

// In lifecycle order. `backlog` sits after intake (the human commits the sized backlog before the
// plan gate); it is lane-only (node null) — it has no diamond on the lifecycle spine.
export const GATES: readonly GateDef[] = [
  { key: "intake", laneStep: "p-intake-gate", node: "intakegate" },
  { key: "backlog", laneStep: "p-backlog-gate", node: null },
  { key: "plan", laneStep: "p-gate", node: "plangate" },
  { key: "spec", laneStep: "d-gate", node: "specgate" },
  { key: "acceptance", laneStep: "b-accept", node: "acceptancegate" },
  { key: "deploy", laneStep: "dp-gate", node: "deploygate" },
  { key: "promote", laneStep: "dp-promgate", node: "promgate" },
] as const;

/** Lane step id → gate key (replaces LaneGraph's LANE_STEP_GATE). */
export const GATE_KEY_BY_STEP: Record<string, string> = Object.fromEntries(GATES.map((g) => [g.laneStep, g.key]));

/** Lifecycle node id → gate key (replaces topology's GATE_NODE_TO_GATE); lane-only gates are absent. */
export const GATE_KEY_BY_NODE: Record<string, string> = Object.fromEntries(
  GATES.filter((g) => g.node).map((g) => [g.node as string, g.key]),
);

/** Gate key → lane step id. */
export const GATE_STEP_BY_KEY: Record<string, string> = Object.fromEntries(GATES.map((g) => [g.key, g.laneStep]));

/** The gates on the lifecycle spine, in order — the orchestrator's bubble row (was GATE_ORDER). */
export const LIFECYCLE_GATE_KEYS: string[] = GATES.filter((g) => g.node).map((g) => g.key);
