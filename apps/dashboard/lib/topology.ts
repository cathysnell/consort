// The Consort workflow topology: the lifecycle graph (Figure 1) and the per-lane
// inter-agent sub-workflows (Figure 2, honest-GREEN).
//
// Ported from Kevin Hartman's build_dashboard.py:384-485 (WORKFLOW) plus the matching
// predicate evaluator in _dashboard_template.html:539-573. This is pure data + pure
// functions over events: no I/O, no corpus, no React. It is mode-independent — the same
// topology lights up from a live tail or a finished replay log.
//
// The authoritative order comes from scripts/sftdd/orchestrator-drive.ts
// (deriveDesignAction / deriveBuildAction) and papers/introducing-consort.md. Gates are
// human-decided and fail closed.

import type { AgentLogEvent, LaneStepMeta, Role } from "./types";
// One definition of "which feature does this event belong to", shared with the story
// derivation. derive.ts does not import this module, so there is no cycle.
import { featureIdOf } from "./derive";

// --------------------------------------------------------------------------- types

export type NodeKind = "phase" | "gate";
export type LaneId = "plan" | "design" | "build" | "deploy";

export interface WorkflowNode {
  id: string;
  label: string;
  roles: Role[]; // roles responsible for this node; empty for gates and terminals
  type: NodeKind;
}

// [from, to]
export type WorkflowEdge = readonly [string, string];
// [from, to, label] — a fail/side path drawn as a back-edge
export type BackEdge = readonly [string, string, string];

// Predicate that decides whether an event lights a given sub-step. Every field is
// optional; the fields that are present must all hold (see `matchesStep` for the exact
// semantics, which are subtler than plain AND for the buildMode pair).
export interface StepMatch {
  role?: Role;
  phase?: string;
  phaseAny?: string[];
  phaseNot?: string[];
  buildMode?: string;
  buildModeAny?: string[];
  buildModeNot?: string[];
  eventPrefix?: string;
  // Exact event-name equality (`e.event === m.event`), decided alone like `eventPrefix`. Used by
  // the deploy lane, whose deterministic steps light off specific orchestrator events
  // (deploy.start / deploy.verified) rather than a role+phase the way the LLM-agent lanes do.
  event?: string;
}

export interface LaneStep {
  id: string;
  role: Role | null; // null for gates/verify — no single agent owns them
  label: string;
  sub: string; // one-line description of what happens here
  gate?: boolean;
  branch?: boolean; // a fail/side path rather than the happy path
  escalation?: boolean; // a terminal raise-to-HIL node (critical, no single owner)
  match: StepMatch | null; // null = never lit from an event (human-decided gates)
}

export interface Lane {
  title: string;
  steps: LaneStep[];
  edges: readonly WorkflowEdge[];
  backEdges: readonly BackEdge[];
}

export interface WorkflowTopology {
  nodes: WorkflowNode[];
  edges: readonly WorkflowEdge[];
  phaseToNode: Record<string, string>;
  lanes: Record<LaneId, Lane>;
}

// --------------------------------------------------------------------------- the graph

export const LANE_IDS: readonly LaneId[] = ["plan", "design", "build", "deploy"] as const;

// Which lifecycle node each log phase (metadata.phase) belongs to.
//
// Two deliberate departures from the Python original, both evidence-driven — verified
// against the 421-event stockflow-rerecord corpus log and the 380-event live log:
//
//   1. `assess` / `assess-refactor` map to "build", not "plan". Kevin's table sent
//      `assess` to "plan". Every `assess*` event in both logs is navigator or
//      orchestrator carrying `buildMode: assess*` — it is the honest-GREEN
//      "regression or supersession?" decision inside the build lane (see b-assess
//      below, which already matched it there). Mapping it to "plan" made the top-level
//      graph jump back to Plan mid-build. `assess-refactor` was absent entirely.
//   2. No `"estimate "` (trailing space) or `"RED"` key. Those were spelling defenses;
//      `nodeForPhase` normalizes instead, which covers them and anything similar.
export const PHASE_TO_NODE: Record<string, string> = {
  // intake: the metered Product Owner intake turn (phase="intake") drafts product-overview/nfrs/
  // design-brief. Maps to the Intake lifecycle node so the current-sprint graph lights the Intake
  // box while the PO drafts. A dashboard-native addition (declared in topology.test's
  // INTENTIONAL_DEVIATIONS): Kevin's Python had no intake phase (intake was event-driven via
  // intake.supplied, which still lights the same node).
  intake: "intake",
  // plan: feature proposal, sizing, request authoring, backlog breakdown
  propose: "plan",
  estimate: "plan",
  "estimate-committed": "plan",
  "author-requests": "plan",
  breakdown: "plan",
  feature: "plan",
  workflow: "plan",
  // design: spec-first, per story
  design: "design",
  // build: the honest-GREEN cycle
  build: "build",
  red: "build",
  green: "build",
  refactor: "build",
  review: "build",
  reflect: "build",
  repair: "build",
  assess: "build",
  "assess-refactor": "build",
  // ship
  deploy: "deploy",
  promote: "promote",
};

// Which gate node reflects which gate name in the run's gate state.
export const GATE_NODE_TO_GATE: Record<string, string> = {
  intakegate: "intake",
  plangate: "plan",
  specgate: "spec",
  acceptancegate: "acceptance",
  deploygate: "deploy",
  promgate: "promote",
};

// --------------------------------------------------------------------------- step outputs

/**
 * A deliverable a lifecycle step produces, as it appears on disk.
 *
 * `path` is ROOT-RELATIVE — no `.consort/` prefix — so a source joins it against whichever root
 * it reads from: replay against `recorded-artifacts/`, live against the project's `.consort/`
 * (or the legacy `.sftdd/`). It may carry a `<F>` placeholder a source substitutes with the
 * feature id in scope; a `perFeature` spec is simply skipped when no feature is in scope.
 *
 * `dir` marks a directory whose files are listed rather than a single file — the honest-GREEN
 * cycle writes many files under `cycles/<F>/`, and deploy under `deploy/`, so those are browsed
 * rather than named one by one.
 */
export interface StepOutputSpec {
  path: string;
  perFeature?: boolean;
  dir?: boolean;
}

/**
 * Which deliverables each lifecycle node produced, for the WorkflowGraph drill-down.
 *
 * Keyed by `WorkflowNode.id`. Paths mirror the Consort artifact layout (verified against the
 * stockflow-full corpus's `recorded-artifacts/`). A source lists only the entries that actually
 * exist on disk, so naming a file here that a given run didn't produce is harmless — it just
 * doesn't appear. Nodes with no durable output (`shipped`, `promgate`) are absent.
 */
export const STEP_OUTPUTS: Record<string, StepOutputSpec[]> = {
  intake: [
    { path: "product-overview.md" },
    { path: "nfrs.md" },
    { path: "design/design-brief.md" },
  ],
  plan: [
    { path: "planning/feature-proposals.md" },
    { path: "planning/estimates.json" },
    { path: "selection-log.md" },
  ],
  plangate: [{ path: "features/<F>/gates.json", perFeature: true }],
  design: [
    { path: "design/design-guide.md" },
    { path: "design/ia.md" },
    { path: "features/<F>/feature-spec.md", perFeature: true },
    { path: "features/<F>/architecture.md", perFeature: true },
    { path: "features/<F>/db-design.md", perFeature: true },
  ],
  specgate: [
    { path: "features/<F>/test-list.md", perFeature: true },
    { path: "features/<F>/gates.json", perFeature: true },
  ],
  build: [
    { path: "features/<F>/pipeline.json", perFeature: true },
    { path: "cycles/<F>", perFeature: true, dir: true },
  ],
  deploy: [
    { path: "features/<F>/deploy-evidence.json", perFeature: true },
    { path: "deploy", dir: true },
  ],
  deploygate: [{ path: "features/<F>/gates.json", perFeature: true }],
  promote: [{ path: "sprints", dir: true }],
};

const NODES: WorkflowNode[] = [
  // intake carries the product-owner (its role dot): the metered PO intake turn drafts the intake.
  // A dashboard-native departure from Kevin's Python (roleless there) – declared in topology.test.
  { id: "intake", label: "Intake", roles: ["product-owner"], type: "phase" },
  // The intake gate diamond, between intake and plan: the HITL review of the drafted intake before
  // planning. Dashboard-native added node (declared in topology.test's ADDED_NODES).
  { id: "intakegate", label: "intake gate", roles: [], type: "gate" },
  { id: "plan", label: "Plan", roles: ["spec-author", "architect-reviewer", "product-owner"], type: "phase" },
  { id: "plangate", label: "plan gate", roles: [], type: "gate" },
  {
    id: "design",
    label: "Design lane",
    roles: ["spec-author", "architect-reviewer", "dba", "test-strategist", "ux-designer"],
    type: "phase",
  },
  { id: "specgate", label: "spec + test-list gates", roles: [], type: "gate" },
  { id: "build", label: "Build lane", roles: ["navigator", "driver"], type: "phase" },
  // The acceptance gate diamond, between build and deploy: the PO accepts each story's experiment
  // (the per-story acceptance gate) before the feature deploys. Represented as one spine diamond the
  // way specgate stands in for the per-story spec gates. Dashboard-native added node (topology.test).
  { id: "acceptancegate", label: "acceptance gate", roles: [], type: "gate" },
  { id: "deploy", label: "Deploy", roles: ["release-engineer"], type: "phase" },
  { id: "deploygate", label: "deploy gate", roles: [], type: "gate" },
  { id: "promote", label: "Promote", roles: ["release-engineer"], type: "phase" },
  { id: "promgate", label: "promote gate", roles: [], type: "gate" },
  { id: "shipped", label: "Shipped", roles: [], type: "phase" },
];

// The lifecycle spine. `shipped → plan` closes the loop for the next sprint.
const EDGES: readonly WorkflowEdge[] = [
  ["intake", "intakegate"],
  ["intakegate", "plan"],
  ["plan", "plangate"],
  ["plangate", "design"],
  ["design", "specgate"],
  ["specgate", "build"],
  ["build", "acceptancegate"],
  ["acceptancegate", "deploy"],
  ["deploy", "deploygate"],
  ["deploygate", "promote"],
  ["promote", "promgate"],
  ["promgate", "shipped"],
  ["shipped", "plan"],
] as const;

const PLAN_LANE: Lane = {
  title: "Plan  ·  sprint planning",
  steps: [
    {
      id: "p-intake",
      role: "product-owner",
      label: "Product owner",
      sub: "intake: overview/nfrs",
      // Lights on EITHER the metered PO intake turn (phase="intake" on its phase.start/turn.usage)
      // OR the seed's intake.supplied/refused events (eventPrefix). matchesStep ORs eventPrefix with
      // role+phase, so both the live drafting turn AND the headless/replay seed light this step.
      match: { role: "product-owner", eventPrefix: "intake", phaseAny: ["intake"] },
    },
    {
      // Dashboard-native gate step (declared in topology.test.ts ADDED_STEPS): the intake gate – the
      // HITL checkpoint AFTER the PO drafts product-overview/nfrs/design-brief and BEFORE the Spec
      // Author proposes. Human reviews / edits / approves. Lights (purple) from the run's intake gate
      // state, like p-gate does for the plan gate. Closes the INTAKE side of the split lane.
      id: "p-intake-gate",
      role: null,
      label: "Intake gate",
      sub: "human approves intake",
      gate: true,
      match: null,
    },
    {
      id: "p-propose",
      role: "spec-author",
      label: "Spec author",
      sub: "propose features",
      match: { role: "spec-author", phase: "propose" },
    },
    {
      id: "p-size",
      role: "architect-reviewer",
      label: "Architect",
      sub: "t-shirt sizing (estimate)",
      match: { role: "architect-reviewer", phaseAny: ["estimate", "estimate-committed"] },
    },
    {
      id: "p-req",
      role: "product-owner",
      label: "Product owner",
      sub: "choose features",
      match: { role: "product-owner", phaseAny: ["author-requests", "feature"] },
    },
    {
      // Dashboard-native step (declared in topology.test.ts ADDED_STEPS): Kevin's Python routes the
      // `breakdown` phase to the Plan node (PHASE_TO_NODE.breakdown === "plan") but gave it no
      // sub-step, so while the spec author breaks the committed features into stories the plan LANE
      // lit but no STEP did. This makes breakdown light both the lane and a step, in lifecycle order
      // (choose features → break them into stories → plan gate).
      id: "p-breakdown",
      role: "spec-author",
      label: "Spec author",
      sub: "backlog breakdown",
      match: { role: "spec-author", phase: "breakdown" },
    },
    {
      id: "p-gate",
      role: null,
      label: "Plan gate",
      sub: "human approves backlog",
      gate: true,
      match: null,
    },
  ],
  edges: [
    ["p-intake", "p-intake-gate"],
    ["p-intake-gate", "p-propose"],
    ["p-propose", "p-size"],
    ["p-size", "p-req"],
    ["p-req", "p-breakdown"],
    ["p-breakdown", "p-gate"],
  ] as const,
  // No raise-to-HIL: the escalate outcome fires only on a failed run, a build-level smell, or a
  // spec smell with its revise budget spent (step.ts route()) — all of which live in build/design,
  // not planning. A bad backlog surfaces as the human HOLDING at the plan gate, not a mid-lane
  // escalation; and the product-owner IS the human, so it has no one to escalate to.
  backEdges: [] as const,
};

const DESIGN_LANE: Lane = {
  title: "Design lane  ·  spec-first (per story)",
  steps: [
    {
      id: "d-ux",
      role: "ux-designer",
      label: "UX designer",
      sub: "design guide (once)",
      match: { role: "ux-designer" },
    },
    {
      id: "d-spec",
      role: "spec-author",
      label: "Spec author",
      sub: "acceptance criteria",
      // spec-author also acts in the plan lane; exclude those phases so its design
      // work doesn't light both lanes.
      match: { role: "spec-author", phaseNot: ["propose", "estimate", "author-requests", "breakdown"] },
    },
    {
      id: "d-arch",
      role: "architect-reviewer",
      label: "Architect",
      sub: "annotate layers",
      match: { role: "architect-reviewer", phaseNot: ["estimate"] },
    },
    { id: "d-dba", role: "dba", label: "DBA", sub: "realize schema", match: { role: "dba" } },
    {
      id: "d-ts",
      role: "test-strategist",
      label: "Test strategist",
      sub: "test list",
      match: { role: "test-strategist" },
    },
    {
      id: "d-nav",
      role: "navigator",
      label: "Navigator",
      sub: "reflect / critique",
      match: { role: "navigator", buildMode: "reflect", phase: "reflect" },
    },
    { id: "d-gate", role: null, label: "Spec gate", sub: "human approves", gate: true, match: null },
    {
      id: "d-hil",
      role: null,
      label: "Raise to HIL",
      sub: "escalate to human",
      escalation: true,
      match: null,
    },
  ],
  edges: [
    ["d-ux", "d-spec"],
    ["d-spec", "d-arch"],
    ["d-arch", "d-dba"],
    ["d-dba", "d-ts"],
    ["d-ts", "d-nav"],
    ["d-nav", "d-gate"],
  ] as const,
  // reflect findings route back to the owning author (bounded revise), or – when a
  // spec defect can't be auto-resolved – escalate to the human
  backEdges: [
    ["d-nav", "d-spec", "revise on findings"],
    ["d-nav", "d-hil", "escalate"],
  ] as const,
};

const BUILD_LANE: Lane = {
  title: "Build lane  ·  honest-GREEN cycle (Branched-Database TDD)",
  steps: [
    {
      id: "b-red",
      role: "navigator",
      label: "Navigator",
      sub: "write failing test (RED)",
      match: {
        role: "navigator",
        phase: "red",
        buildModeNot: ["reflect", "review", "assess", "assess-refactor", "assess-deploy"],
      },
    },
    {
      id: "b-green",
      role: "driver",
      label: "Driver",
      sub: "minimal honest code (GREEN)",
      match: {
        role: "driver",
        buildModeNot: ["refactor", "repair", "refactor-superseded", "refactor-deploy"],
      },
    },
    {
      id: "b-verify",
      // VERIFY (build-cycle AND deploy) is release work, so the dashboard attributes it to the
      // release-engineer for lane colouring. Kevin's Python left it ownerless; this is a declared
      // dashboard-side departure (see STEP_DEVIATIONS in topology.test.ts). It keeps its
      // verify-prefix match, so it still lights from events and `isHumanGate` stays false — it
      // takes the release-engineer's light-blue, not the purple human-gate colour.
      role: "release-engineer",
      label: "Verify",
      sub: "run vs real branch",
      gate: true,
      match: { eventPrefix: "verify" },
    },
    {
      id: "b-review",
      role: "navigator",
      label: "Navigator",
      sub: "review",
      match: { role: "navigator", buildMode: "review" },
    },
    {
      id: "b-refactor",
      role: "driver",
      label: "Driver",
      sub: "refactor (structure)",
      match: { role: "driver", buildModeAny: ["refactor"] },
    },
    {
      id: "b-assess",
      role: "navigator",
      label: "Navigator",
      sub: "assess: regression or supersession?",
      branch: true,
      match: { role: "navigator", buildModeAny: ["assess", "assess-refactor", "assess-deploy"] },
    },
    {
      id: "b-repair",
      role: "driver",
      label: "Driver",
      sub: "repair code, never tests",
      branch: true,
      match: { role: "driver", buildModeAny: ["repair"] },
    },
    {
      id: "b-perm",
      role: "driver",
      label: "Driver",
      sub: "permissive-green (superseded only)",
      branch: true,
      match: { role: "driver", buildModeAny: ["green-superseded", "refactor-superseded"] },
    },
    {
      id: "b-hil",
      role: null,
      label: "Raise to HIL",
      sub: "genuine regression → escalate",
      escalation: true,
      match: null,
    },
    {
      id: "b-accept",
      role: null,
      label: "Acceptance gate",
      sub: "human accepts the story",
      gate: true,
      match: null,
    },
  ],
  edges: [
    ["b-red", "b-green"],
    ["b-green", "b-verify"],
    ["b-verify", "b-review"],
    ["b-review", "b-refactor"],
    ["b-refactor", "b-red"],
    ["b-refactor", "b-accept"],
  ] as const,
  backEdges: [
    ["b-verify", "b-assess", "verify fails"],
    ["b-assess", "b-repair", "regression"],
    ["b-assess", "b-perm", "supersession"],
    ["b-assess", "b-hil", "genuine"],
  ] as const,
};

// The combined ship lane. Unlike plan/design/build (ported verbatim from Kevin's Python
// WORKFLOW), this lane is dashboard-native: deploy and promote are DETERMINISTIC CLI effects run
// by the orchestrator, not an LLM agent, so they had no per-lane sub-workflow in the Python. The
// dashboard attributes every deterministic step to the `release-engineer` role (light-blue) for
// labelling; the two human gates carry `match: null` so `isHumanGate` keeps them purple.
//
// It reads as two phases — a Deploy section (deploy → verify → deploy gate) and a Promote section
// (prepare-pr → wait-ci → promote gate → merge), which LaneGraph draws with a separator between
// them. Deploy/verify light from the orchestrator's `deploy.start` / `deploy.verified` events; the
// promote sub-steps emit no per-step events (only the promote phase.start + the promote gate), so
// they share a `phaseAny:["promote"]` predicate — structural, faithful to what the kit logs.
//
// The self-heal arm (deploy-verify contamination) mirrors the build lane's assess fan-out. Note
// the deliberate overlap: `assess-deploy` also matches the build lane's `b-assess`, which precedes
// this lane in LANE_IDS and therefore claims the event — so `dp-assess` is structural (it renders,
// but never lights). `refactor-deploy` has no build-lane claimant, so `dp-refactor` does light.
const DEPLOY_LANE: Lane = {
  title: "DEPLOY / PROMOTE",
  steps: [
    {
      id: "dp-deploy",
      role: "release-engineer",
      label: "Deploy",
      sub: "deploy to feature branch",
      match: { event: "deploy.start" },
    },
    {
      id: "dp-verify",
      role: "release-engineer",
      label: "Verify",
      sub: "reachable + verify.passed",
      match: { event: "deploy.verified" },
    },
    { id: "dp-gate", role: null, label: "deploy gate", sub: "human check", gate: true, match: null },
    {
      id: "dp-pr",
      role: "release-engineer",
      label: "Prepare PR",
      sub: "open PR",
      match: { phaseAny: ["promote"] },
    },
    {
      id: "dp-ci",
      role: "release-engineer",
      label: "Wait CI",
      sub: "CI green",
      match: { phaseAny: ["promote"] },
    },
    { id: "dp-promgate", role: null, label: "promote gate", sub: "human check", gate: true, match: null },
    {
      id: "dp-merge",
      role: "release-engineer",
      label: "Merge",
      sub: "release to parent tier",
      match: { phaseAny: ["promote"] },
    },
    {
      id: "dp-assess",
      role: "navigator",
      label: "Assess-deploy",
      sub: "confirm fragile set",
      branch: true,
      match: { buildModeAny: ["assess-deploy"] },
    },
    {
      id: "dp-refactor",
      role: "driver",
      label: "Scope-deploy",
      sub: "tests own their state",
      branch: true,
      match: { buildModeAny: ["refactor-deploy"] },
    },
    {
      id: "dp-hil",
      role: null,
      label: "Raise to HIL",
      sub: "genuine failure",
      escalation: true,
      match: null,
    },
    {
      // The promote-side raise-to-HIL. The deterministic SCM steps (prepare-pr / wait-ci / merge)
      // have no self-heal: a non-zero exit (CI red, a merge conflict/ETIMEDOUT, a PR-prep error)
      // throws a CliEffectError and the drive's top-level catch records a resumable escalation +
      // a "RAISED TO HIL" halt naming the failing step.
      id: "dp-promote-hil",
      role: null,
      label: "Raise to HIL",
      sub: "SCM step fails",
      escalation: true,
      match: null,
    },
  ],
  edges: [
    ["dp-deploy", "dp-verify"],
    ["dp-verify", "dp-gate"],
    ["dp-gate", "dp-pr"],
    ["dp-pr", "dp-ci"],
    ["dp-ci", "dp-promgate"],
    ["dp-promgate", "dp-merge"],
  ] as const,
  backEdges: [
    ["dp-verify", "dp-assess", "verify fails"],
    ["dp-assess", "dp-refactor", ""],
    ["dp-refactor", "dp-deploy", "re-deploy"],
    ["dp-assess", "dp-hil", "genuine"],
    ["dp-pr", "dp-promote-hil", "fails"],
    ["dp-ci", "dp-promote-hil", "CI red"],
    ["dp-merge", "dp-promote-hil", "conflict"],
  ] as const,
};

export const WORKFLOW: WorkflowTopology = {
  nodes: NODES,
  edges: EDGES,
  phaseToNode: PHASE_TO_NODE,
  lanes: { plan: PLAN_LANE, design: DESIGN_LANE, build: BUILD_LANE, deploy: DEPLOY_LANE },
};

// --------------------------------------------------------------------------- lookups

export function nodeById(id: string): WorkflowNode | null {
  return NODES.find((n) => n.id === id) ?? null;
}

// The lifecycle node whose recorded deliverables a role AUTHORS — the first node (in lifecycle
// order) that both lists `role` and has a STEP_OUTPUTS entry. Used by the role drill-down: on a live
// board (no per-turn transcript corpus) clicking a role opens WHAT IT PRODUCED — e.g. the
// product-owner → the `intake` node's product-overview/nfrs/design-brief — via the same
// step-outputs panel the node itself opens. Returns null for a role that authors no output-bearing
// node (e.g. a gate-only or terminal role), so the caller can fall back to the empty role shell.
export function primaryOutputNodeForRole(role: string): string | null {
  const n = NODES.find((node) => node.roles.includes(role as Role) && Object.hasOwn(STEP_OUTPUTS, node.id));
  return n?.id ?? null;
}

// Look up a key in one of the maps above without inheriting from Object.prototype.
// A bare `table[key]` resolves "constructor"/"toString"/"valueOf" to a function, which
// would flow into a Set<string> in passedNodes and serialize to null over the API — and
// would slip past a truthiness guard, since a function is truthy. Phase names come from
// log metadata, so they are effectively untrusted input.
function lookup(table: Record<string, string>, key: string): string | null {
  return Object.hasOwn(table, key) ? table[key] : null;
}

// Lifecycle node for a log phase. Tolerates the surrounding whitespace and casing
// variants seen in real logs (`"estimate "`, `"RED"`) instead of enumerating them.
export function nodeForPhase(phase: string | null | undefined): string | null {
  if (!phase) return null;
  const trimmed = phase.trim();
  if (!trimmed) return null;
  return lookup(PHASE_TO_NODE, trimmed) ?? lookup(PHASE_TO_NODE, trimmed.toLowerCase());
}

// The gate name whose state a gate node displays (plangate → "plan").
export function gateForNode(nodeId: string): string | null {
  return lookup(GATE_NODE_TO_GATE, nodeId);
}

// --------------------------------------------------------------------------- matching

function phaseOf(e: AgentLogEvent): string | null {
  const md = (e.metadata || {}) as Record<string, unknown>;
  const p = md.phase;
  return typeof p === "string" ? p : null;
}

function buildModeOf(e: AgentLogEvent): string | null {
  const md = (e.metadata || {}) as Record<string, unknown>;
  const bm = md.buildMode;
  return typeof bm === "string" ? bm : null;
}

// Does this event light this sub-step?
//
// Field semantics, preserved from the template's evaluator:
//   eventPrefix  — decided alone: the event name must start with it, and nothing else
//                  is consulted (this is how `verify.*` lights b-verify regardless of role).
//   event        — decided alone: the event name must equal it exactly (deploy.start /
//                  deploy.verified light the deploy lane's deterministic steps).
//   role         — must be equal.
//   phaseAny     — phase must be a member. Decides on its own once role has passed.
//   phaseNot     — excluded when the phase is present and listed. A missing phase does
//                  NOT exclude, which is what lets a role's non-phase events still match.
//   buildModeNot — likewise for buildMode.
//   buildMode /
//   buildModeAny — buildMode must be in the set, OR the phase equals `phase` as a
//                  fallback. Some phases (`reflect`) are logged without a buildMode on
//                  the phase.start, so requiring buildMode alone would miss them.
//   phase        — required equality, but only when no buildMode constraint is present
//                  (otherwise it acts as the fallback above rather than a requirement).
export function matchesStep(m: StepMatch | null, e: AgentLogEvent): boolean {
  if (!m) return false;

  // Exact event-name match, decided alone (the deploy lane lights dp-deploy / dp-verify off specific
  // orchestrator events).
  if (m.event) return e.event === m.event;

  // eventPrefix: the event NAME starts with it. When the step ALSO declares a role/phase, treat the
  // two as an OR – the step matches by event name (e.g. p-intake on the seed's `intake.supplied`) OR
  // by role+phase (e.g. p-intake on the metered PO intake turn's `phase.start`/`turn.usage`, which
  // carry phase="intake" but an event name that does not start with "intake"). An eventPrefix-ONLY
  // step (e.g. b-verify, `eventPrefix:"verify"` with no role/phase) stays NAME-ALONE – a name miss is
  // a miss, never a fall-through to the always-true tail.
  if (m.eventPrefix) {
    if (typeof e.event === "string" && e.event.startsWith(m.eventPrefix)) return true;
    const hasRoleOrPhase =
      m.role !== undefined || m.phase !== undefined || m.phaseAny !== undefined ||
      m.buildMode !== undefined || m.buildModeAny !== undefined;
    if (!hasRoleOrPhase) return false;
    // else fall through to the role/phase checks below (the OR's second arm).
  }

  if (m.role && e.role !== m.role) return false;

  const phase = phaseOf(e);
  const bm = buildModeOf(e);

  if (m.phaseAny) return phase !== null && m.phaseAny.includes(phase);

  if (m.phaseNot && phase !== null && m.phaseNot.includes(phase)) return false;
  if (m.buildModeNot && bm !== null && m.buildModeNot.includes(bm)) return false;

  const bmSet = m.buildModeAny ?? (m.buildMode ? [m.buildMode] : null);
  if (bmSet) {
    const bmHit = bm !== null && bmSet.includes(bm);
    const phaseFallback = m.phase !== undefined && phase === m.phase;
    return bmHit || phaseFallback;
  }

  if (m.phase !== undefined && phase !== m.phase) return false;

  return true;
}

export interface LaneHit {
  lane: LaneId;
  step: string;
}

// First sub-step (lanes in plan→design→build order, steps in declared order) that this
// event lights, or null. First match wins, as in the original.
export function laneStepForEvent(e: AgentLogEvent | null | undefined): LaneHit | null {
  if (!e) return null;
  for (const lane of LANE_IDS) {
    for (const s of WORKFLOW.lanes[lane].steps) {
      if (matchesStep(s.match, e)) return { lane, step: s.id };
    }
  }
  return null;
}

// Per-step agent metrics for the step cards, folded over the whole event stream: model + effort from
// each step's phase.start, and the cost + turn count of the turns credited to it. A turn.usage carries
// cost but not buildMode, so it cannot be matched to a build step directly — instead each role's
// most-recent phase.start fixes the step its next turn.usage is credited to. First-match wins across
// lanes (laneStepForEvent), so an event two steps share (assess-deploy lights both b-assess and
// dp-assess) is counted once, on the build step, exactly as the lane lighting resolves it.
export function laneStepMeta(events: AgentLogEvent[]): Record<string, LaneStepMeta> {
  const meta: Record<string, LaneStepMeta> = {};
  const lastStepForRole: Record<string, string> = {};
  const ensure = (id: string): LaneStepMeta => (meta[id] ??= { model: null, effort: null, cost: 0, turns: 0 });
  for (const e of events) {
    if (e.event === "phase.start") {
      const hit = laneStepForEvent(e);
      if (!hit) continue;
      lastStepForRole[e.role] = hit.step;
      const m = ensure(hit.step);
      if (e.model) m.model = e.model;
      if (e.effort) m.effort = e.effort;
    } else if (e.event === "turn.usage") {
      const id = lastStepForRole[e.role];
      if (!id) continue;
      const m = ensure(id);
      const md = (e.metadata || {}) as Record<string, unknown>;
      m.cost += Number(md.cost_usd || 0);
      m.turns += 1;
    }
  }
  return meta;
}

// --------------------------------------------------------------------------- progress

/**
 * Walk events[0..upTo), reporting which feature AND which phase each one belongs to.
 *
 * Both are carried forward: not every event stamps a feature_id (5 `phase.start`s in the corpus
 * carry `""`) or a phase (a role's `turn.usage` / `artifact.written` / `reasoning` events carry
 * NONE — only the preceding `handoff` / `phase.start` names the phase), so the value in force is
 * the last one seen. `featureIdOf` skips `reasoning` events, whose feature_id is unreliable — see
 * its docstring. Carrying the phase forward is what stops a spec-author breakdown artifact (phase
 * absent) from looking identical to a design spec-author turn and lighting the DESIGN lane during
 * PLANNING: with the enclosing `breakdown` phase attached it maps to plan's p-breakdown, not d-spec.
 *
 * Shared by `passedNodes` and `laneProgress` so the two cannot disagree about which feature/phase
 * an event belongs to, which would light a node in one view and not the other.
 */
function* eventsWithFeature(
  events: AgentLogEvent[],
  upTo?: number,
): Generator<{ e: AgentLogEvent; feature: string | null; phase: string | null }> {
  const end = upTo === undefined ? events.length : Math.max(0, Math.min(upTo, events.length));
  let feature: string | null = null;
  let phase: string | null = null;
  for (let i = 0; i < end; i++) {
    const f = featureIdOf(events[i]);
    if (f) feature = f;
    const p = phaseOf(events[i]);
    if (p) phase = p;
    yield { e: events[i], feature, phase };
  }
}

/** The event as seen with its effective (carried-forward) phase attached, so a phase-less event is
 *  disambiguated by the phase the run is actually in. A no-op when the event already carries one. */
function withPhase(e: AgentLogEvent, phase: string | null): AgentLogEvent {
  return phase && phaseOf(e) !== phase ? { ...e, metadata: { ...(e.metadata ?? {}), phase } } : e;
}

/**
 * Lifecycle nodes reached by folding events[0..upTo). `intake.supplied` is the one node
 * established by an event name rather than a phase.
 *
 * @param feature scope to one feature; omit for the whole run. Scoping matters on
 *   multi-feature runs: unscoped, the second sprint of the stockflow-rerecord corpus inherits
 *   sprint 1's spine, so at event 230 a feature that has not built anything reads as having
 *   reached `deploy` and `promote` — drawing a shipped lifecycle for work that hasn't started.
 */
export function passedNodes(events: AgentLogEvent[], upTo?: number, feature?: string): Set<string> {
  const seen = new Set<string>();
  for (const { e, feature: f, phase } of eventsWithFeature(events, upTo)) {
    if (feature !== undefined && f !== feature) continue;
    const node = nodeForPhase(phase);
    if (node) seen.add(node);
    if (e.event === "intake.supplied") seen.add("intake");
  }
  return seen;
}

export interface LaneProgress {
  // sub-steps reached in each lane
  done: Record<LaneId, Set<string>>;
  // last sub-step reached in each lane, null if the lane was never entered
  last: Record<LaneId, string | null>;
  // the step the final folded event lights — the "playhead" step
  current: LaneHit | null;
}

/**
 * Fold events[0..upTo) into per-lane sub-step progress, for done-shading the lane graphs.
 *
 * @param feature scope to one feature; omit for the whole run. Unscoped, a multi-feature run
 *   accumulates: at event 230 of the stockflow-rerecord corpus, sprint 2 has only just begun
 *   designing, yet all seven build sub-steps read as reached because sprint 1 lit them.
 */
export function laneProgress(events: AgentLogEvent[], upTo?: number, feature?: string): LaneProgress {
  const done: Record<LaneId, Set<string>> = { plan: new Set(), design: new Set(), build: new Set(), deploy: new Set() };
  const last: Record<LaneId, string | null> = { plan: null, design: null, build: null, deploy: null };

  // The playhead event with its effective phase — tracked here (before the feature filter) because
  // `current` is deliberately NOT feature-filtered, while the done-set below is.
  let playhead: AgentLogEvent | null = null;
  for (const { e, feature: f, phase } of eventsWithFeature(events, upTo)) {
    playhead = withPhase(e, phase);
    if (feature !== undefined && f !== feature) continue;
    // Match with the carried phase attached, so a phase-less breakdown artifact maps to plan's
    // p-breakdown (not design's d-spec) and a phase-less design artifact still maps into design.
    const hit = laneStepForEvent(withPhase(e, phase));
    if (!hit) continue;
    done[hit.lane].add(hit.step);
    last[hit.lane] = hit.step;
  }

  // `current` reflects the event AT the playhead, not the last event that happened to match
  // something — otherwise a stale step stays lit across unmatched events. It reads the SAME
  // carried-phase event as the done-set (via `eventsWithFeature` → `withPhase`), so the two views
  // agree; a gate.surfaced/handoff still maps to no role step (wrong role), so a gate park stays
  // step-less.
  const current: LaneHit | null = playhead ? laneStepForEvent(playhead) : null;

  return { done, last, current };
}

// An edge is complete when both of its endpoints have been reached.
export function edgeDone(lane: LaneId, edge: WorkflowEdge, progress: LaneProgress): boolean {
  const reached = progress.done[lane];
  return reached.has(edge[0]) && reached.has(edge[1]);
}
