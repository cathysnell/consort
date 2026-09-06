// role-levers: candidate generation for the per-role chain sweep. A candidate is a PATCH on the
// live role's AgentLevers – what the sweep varies to try to beat the role's baseline turn. The
// axes mirror the drive-bound optimize-candidates lane set (model tiers, effort rungs, scan-tight),
// but the target is the chain's live-role agent config (model/effort/tool scope), not a
// sftdd-config.json – because the chain's ClaudeStepAgent reads its levers directly from the
// manifest's agent.config. Pure: enumerate only, no I/O.
//
// TRY ALL POSSIBILITIES from the identical pre-turn state (the replay-seeded workspace):
//   (1) every OTHER model tier – cheaper AND more capable (a bigger model can win wall-clock via
//       fewer round-trips; a cheaper one wins on cost if it still passes the gate),
//   (2) each cheaper effort rung (low, medium) at the base model,
//   (3) the model x low-effort CROSS for every other model (change the model AND think less – often
//       the biggest single win, invisible when either lever is tried alone),
//   (4) a scan-tight variant that DENIES Grep/Glob (the inject-vs-scan lever, enforced).
// The gate (conformance) is the same structural bar for every candidate, so wall-clock/cost alone
// decides among the gate-passers.

/** The candidate's lever patch on the live role's AgentLevers. All optional; absent = the role's
 *  default (baseline). tool-scope patches restrict what the turn may call. */
export interface RoleLeverPatch {
  model?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Session lever: "resume" warms the turn from a prior same-key session (the real drive's
   *  per-story build warmth). Only meaningful on a MULTI-TURN substrate that ran a prior turn to
   *  resume – the single-turn chain cannot measure it (see `roleCandidates` multiTurn gate). */
  session?: "fresh" | "resume";
  /** TEST-STRATEGIST ONLY: per-analyst subagent lever overrides (behavior/fitness/client), keyed by
   *  analyst kind. The test-strategist is a SUPERVISOR – its own model/effort is not the interesting
   *  lever; what matters is the per-analyst subagent levers it fans out to. This patch does NOT touch
   *  the supervisor's AgentLevers; it is projected into the injected test-analyst roster (see
   *  renderTestAnalystRoster overrides), so the supervisor spawns each analyst Task with the swept
   *  model/effort/tool_scope. Absent on every non-test-strategist candidate. */
  analystOverrides?: Record<string, { model?: string; effort?: "low" | "default" | "high"; toolScope?: string[] }>;
  /** DRIVER-GREEN enforcement (E1): install a per-candidate PreToolUse hook that DENIES a no-arg
   *  full-suite invocation (`run-tests.sh` / `make test` / `npm test`) while allowing a targeted
   *  `pytest <path>` / `run-tests.sh <path>`. A hook (not a deny-glob) because the no-arg-vs-path
   *  distinction is argument-level, which deny-globs match unreliably. See DRIVER-GREEN-LEVERS.md. */
  guardSuite?: boolean;
  /** DRIVER-GREEN enforcement (E2): deny directory-SCANNING commands (ls/find/grep/rg) via the SAME
   *  PreToolUse hook as guardSuite. A hook (not `permissions.deny` globs) because globs match only the
   *  command PREFIX – they miss `cd <dir> && ls` and piped `… | grep`, which the driver actually uses
   *  (proven in the first sweep: deny-scan was inert). The hook splits the command on &&/||/;/| and
   *  checks each segment's verb, so a scan anywhere in a compound/pipeline is caught. */
  guardScan?: boolean;
  /** DEPRECATED raw `permissions.deny` globs (prefix-only; miss `cd && ls`). Kept for callers that
   *  want literal deny rules, but driverGreenCandidates uses guardScan (hook-based) instead. */
  denyBash?: string[];
  /** DRIVER-GREEN context (C1/C2): the pre-computed context sections to enable in `buildContextPack`
   *  (`"db-state"` = inject `alembic current`/`heads` once; `"failing-test"` = inject the failing RED
   *  test body). Applied by setting the `LAKEBASE_CONSORT_CTX_*` env the drive inherits. */
  ctxPack?: ("db-state" | "failing-test" | "scope-note" | "migration")[];
  /** ENVIRONMENT/replay levers. Like model/effort above, each DEFAULTS to the RECORDED corpus run-config
   *  value (the sweep replays that recording) and a candidate OVERRIDEs it to test a perturbation. Absent
   *  => use the recorded value. (The corpus is the single source for ALL turn settings – models, effort,
   *  and these env knobs alike; levers are the only deviation.) */
  uiTrack?: boolean;
  loopGranularity?: "story" | "ac" | "hybrid-a";
  deployTarget?: "local" | "workspace";
  buildSessionScope?: "cycle" | "story";
  batchCap?: number;
}

/** One point in the sweep space: a stable id + the lever patch it applies. */
export interface RoleCandidate {
  /** Stable, filesystem-safe id (also the telemetry record's chain suffix). */
  id: string;
  /** The lever patch merged onto the live manifest's agent.config for this candidate. */
  levers: RoleLeverPatch;
}

/** The identity candidate: the role's default levers, no patch. Always first so the baseline turn
 *  is measured under the same machinery as every candidate (apples-to-apples "before"). */
export const BASELINE_ID = "baseline";

/** The model tiers to try against the base – EVERY OTHER tier, cheaper AND more capable. Ordered
 *  cheapest->most-capable for stable, readable ids. */
const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
function otherModels(base: string): string[] {
  return MODEL_TIERS.filter((m) => m !== base);
}

/** The cheaper effort rungs worth trying below the model default: low (the floor) + medium (a
 *  safety rung, in case low under-thinks + degrades the artifact but medium is still faster). */
const CHEAPER_EFFORTS = ["low", "medium"] as const;

/** The scan-tighten patch: deny the tree-scanning tools so broad scanning is impossible; the turn
 *  must lean on the inputs it was handed (the chain already provides them in the prompt). */
function scanTightPatch(): RoleLeverPatch {
  return { disallowedTools: ["Grep", "Glob"] };
}

/** Sweep-substrate capabilities that GATE which candidates are meaningful. `multiTurn` = the
 *  substrate runs sequenced same-resume-key turns, so a warm (resume) session has a prior turn to
 *  resume – the ONLY way warm-vs-cold is measurable. The single-turn chain leaves it false. */
export interface RoleSweepCapabilities {
  multiTurn?: boolean;
}

/**
 * Generate the candidate list for a role whose baseline runs on `baseModel`. Baseline first, then
 * the four always-on families. Ids are stable + unique. The caller (role-sweep) applies each patch
 * to the live manifest's agent.config + runs the chain once per candidate.
 *
 * The SESSION-WARMTH candidate (`session-warm`) is appended ONLY when `caps.multiTurn` is true. It
 * is a genuine build-time lever in the REAL drive (build roles resume per story – `buildClaudeCommand`
 * `resumeKey = role:story`, default `buildSessionScope: "story"`, with `cycle` = cold safety valve),
 * but warm-vs-cold is a CROSS-TURN effect: it needs a prior same-key turn to resume, which the
 * default single-turn chain substrate does not have. So it is DECLARED here + gated behind the
 * capability, ready for the multi-turn driver phase (gated cloud, unbuilt) without pretending to
 * measure on a substrate that structurally cannot – see PRODUCTION-IMPROVEMENTS-PLAN.md #4.
 */
export function roleCandidates(baseModel: string, caps: RoleSweepCapabilities = {}): RoleCandidate[] {
  const others = otherModels(baseModel);
  const out: RoleCandidate[] = [{ id: BASELINE_ID, levers: {} }];

  // (1) every other model tier
  for (const m of others) out.push({ id: `m-${m}`, levers: { model: m } });
  // (2) each cheaper effort rung at the base model
  for (const e of CHEAPER_EFFORTS) out.push({ id: `e-${e}`, levers: { effort: e } });
  // (3) model x low-effort cross for every other model
  for (const m of others) out.push({ id: `m-${m}-e-low`, levers: { model: m, effort: "low" } });
  // (4) scan-tight (deny Grep/Glob)
  out.push({ id: "scan-tight", levers: scanTightPatch() });
  // (5) session-warm – ONLY on a multi-turn substrate (a single-turn chain cannot measure warmth).
  if (caps.multiTurn) out.push({ id: "session-warm", levers: { session: "resume" } });

  return out;
}

/**
 * TEST-STRATEGIST candidate set – the SUPERVISOR's real optimization target is the per-analyst
 * subagent levers, not its own model. The supervisor fans out to enabled analysts (behavior +
 * fitness always; client only when uiTrack), each spawned as a Task at that analyst's model/effort.
 * A candidate here carries `analystOverrides` (projected into the injected roster by
 * renderTestAnalystRoster), NOT a supervisor model/effort patch.
 *
 * BOUNDED – targeted permutations, never the full cartesian product (which would be
 * models^kinds x efforts). The fitness analyst is the densest reasoner + the sole invariant_id
 * owner, so the interesting axis is "cheapen the cheap slices while holding fitness high":
 *   - baseline           : catalogue defaults (behavior/client sonnet-default, fitness sonnet-high)
 *   - a-fitness-opus     : raise ONLY fitness to opus (does the invariant coverage improve?)
 *   - a-behavior-haiku   : cheapen ONLY behavior to haiku (does the cheap slice hold at a faster model?)
 *   - a-all-low          : every enabled analyst at effort low (fastest; does coverage survive?)
 *   - a-cheap-hold-fit   : behavior (+client) haiku/low, fitness held sonnet/high (the headline lever)
 *   - a-fitness-low      : drop fitness to low effort (probe: is fitness's high effort load-bearing?)
 * PLUS the SUPERVISOR's own levers (the reconcile/assemble turn, distinct from the analysts):
 *   - s-low              : supervisor effort low, analysts baseline
 *   - s-haiku            : supervisor on haiku, analysts baseline
 *   - s-low+a-all-low    : supervisor lean AND analysts at the winning lever (effort=low)
 *   - s-haiku+a-all-low  : cheapest end to end (supervisor haiku/low + all analysts low)
 * `enabledKinds` filters each analyst permutation to the project's analysts (no client override on a
 * no-frontend project). Ids are stable + filesystem-safe.
 */
export function testStrategistCandidates(enabledKinds: string[]): RoleCandidate[] {
  const has = (k: string) => enabledKinds.includes(k);
  const pick = (ov: Record<string, { model?: string; effort?: "low" | "default" | "high"; toolScope?: string[] }>) => {
    // Keep only overrides for kinds actually enabled (a client override on a no-frontend project is inert).
    const out: RoleLeverPatch["analystOverrides"] = {};
    for (const [k, v] of Object.entries(ov)) if (has(k)) out![k] = v;
    return out;
  };
  const out: RoleCandidate[] = [{ id: BASELINE_ID, levers: {} }];

  if (has("fitness")) out.push({ id: "a-fitness-opus", levers: { analystOverrides: pick({ fitness: { model: "opus" } }) } });
  if (has("behavior")) out.push({ id: "a-behavior-haiku", levers: { analystOverrides: pick({ behavior: { model: "haiku" } }) } });

  // Every enabled analyst at effort low (the fastest permutation).
  out.push({
    id: "a-all-low",
    levers: { analystOverrides: pick({ behavior: { effort: "low" }, fitness: { effort: "low" }, client: { effort: "low" } }) },
  });
  // The headline lever: cheapen the cheap slices (behavior + client) to haiku/low, HOLD fitness high.
  out.push({
    id: "a-cheap-hold-fit",
    levers: {
      analystOverrides: pick({ behavior: { model: "haiku", effort: "low" }, client: { model: "haiku", effort: "low" }, fitness: { model: "sonnet", effort: "high" } }),
    },
  });
  // Probe whether fitness's high effort is load-bearing: drop ONLY fitness to low.
  if (has("fitness")) out.push({ id: "a-fitness-low", levers: { analystOverrides: pick({ fitness: { effort: "low" } }) } });

  // ── SUPERVISOR levers (the reconciler/assembler turn itself, distinct from the analysts) ──
  // The supervisor's OWN model/effort ride RoleLeverPatch.model/effort (agentForCandidate applies
  // them to the live test-strategist manifest). It does NOT author test items – it spawns analysts,
  // reconciles their slices, orders the master, assigns T-ids – so a leaner supervisor may hold
  // quality while cutting the reconcile wall-clock. Swept ALONE and COMBINED with the analysts pinned
  // at the winning lever (effort=low), to see if a lean supervisor ATOP optimized analysts still holds.
  const analystsLow = pick({ behavior: { effort: "low" }, fitness: { effort: "low" }, client: { effort: "low" } });
  out.push({ id: "s-low", levers: { effort: "low" } }); // supervisor effort low, analysts baseline
  out.push({ id: "s-haiku", levers: { model: "haiku" } }); // supervisor on haiku, analysts baseline
  out.push({ id: "s-low+a-all-low", levers: { effort: "low", analystOverrides: analystsLow } }); // both lean
  out.push({ id: "s-haiku+a-all-low", levers: { model: "haiku", effort: "low", analystOverrides: analystsLow } }); // cheapest end to end

  return out;
}

/**
 * DRIVER-GREEN candidate set – the enforcement + pre-computed-context levers the run-17 analysis
 * surfaced (see DRIVER-GREEN-LEVERS.md). The driver/green turn is 46% of the run's wall-clock and
 * spends it on orientation (`ls`) + redundant self-verification (16 full-suite runs/turn) + DB
 * re-probing, NOT on writing code. Model is already sonnet (opus is slower here), so these are
 * BEHAVIORAL levers, not model tiers:
 * FINDINGS (n=3 S3 sweep + turn-by-turn study – see DRIVER-GREEN-LEVERS.md): the driver's time is
 * PATH variance – the -46% "best case" is the run that scopes to the single failing test and does NOT
 * rabbit-hole the client/SPA surface (fast: ~4 client touches; slow: ~13). ENFORCEMENT backfires:
 * guard-scan (blocking ls/find/grep) made it ~3x SLOWER (the driver relies on exploring); single-test-
 * guard was variance (never fired on a non-thrashing turn). Only CONTEXT/SCOPING is causal. So the set
 * is the scoping axis – make the fast good-path deterministic – plus cheap model levers:
 *   - ctx-test          : inject the failing RED test body (the proven winner, -25/-38%, direction-stable)
 *   - scope-note        : an explicit "make ONLY the failing test green at its layer; do not chase other
 *                         layers (client/SPA)" directive – targets the residual client rabbit-hole
 *   - ctx-test-scope    : hand the test AND scope – the deterministic encoding of the -46% good path
 *   - single-test-guard : KEPT as a directive/control option (proven variance, not expected to win)
 *   - e-low             : CROSS-AXIS comparison – the effort lever (think less). NOT a scoping lever;
 *                         scored so the scoping levers can be read against a pure model-param change.
 * The thesis axis is SCOPING/CONTEXT; e-low is the one effort point kept for comparison (no model tiers).
 * Dropped (proven noise/harm): guard-scan, ctx-db, scope-guard, enforce-all. Run at n>=3.
 */
export function driverGreenCandidates(): RoleCandidate[] {
  // NO live `baseline` candidate: the RECORDED original turn IS the baseline (its determination +
  // duration are in the corpus, used as the judge reference + recordedBaselineMs). A fresh no-lever
  // baseline would just be a redundant – and noisy (S3 swung 180-310s) – extra run. Every candidate is
  // scored same/better/worse vs the recording.
  return [
    { id: "ctx-test", levers: { ctxPack: ["failing-test"] } },
    { id: "scope-note", levers: { ctxPack: ["scope-note"] } },
    { id: "ctx-test-scope", levers: { ctxPack: ["failing-test", "scope-note"] } },
    { id: "single-test-guard", levers: { guardSuite: true } },
    // CROSS-AXIS comparison point (NOT scoping): the effort lever. Kept scored so the scoping levers
    // can be read against a pure model-inference-param change (does thinking-less alone go faster, and
    // does the one-turn green still hold?). Effort/model tiers are otherwise a separate study.
    { id: "e-low", levers: { effort: "low" } },
    // COMBINED: the fastest scoping lever (ctx-test) crossed with think-less (e-low) – does handing the
    // failing test AND lowering effort keep the speed win while holding the determination aligned?
    { id: "ctx-test-elow", levers: { ctxPack: ["failing-test"], effort: "low" } },
    // COMBINED + MODEL TIER: ctx-test-elow on OPUS – the one deliberate model-tier point (does a more
    // capable model + scoping + think-less hold the determination aligned where sonnet ctx-test diverged?).
    { id: "opus-ctx-test-elow", levers: { model: "opus", ctxPack: ["failing-test"], effort: "low" } },
    // MODEL TIER (normal effort): ctx-test on OPUS without think-less – isolates the model-tier effect
    // from the effort lever (does opus at default effort converge tighter / align better than opus-elow?).
    { id: "opus-ctx-test", levers: { model: "opus", ctxPack: ["failing-test"] } },
    // ctx-test x MEDIUM effort on opus – the untested KNEE of the ctx-test effort ladder (low=fast but
    // 1/3 milestone; default/high=377s 3/3). Does medium keep opus fast AND reliably at the milestone?
    { id: "opus-ctx-test-emedium", levers: { model: "opus", ctxPack: ["failing-test"], effort: "medium" } },
    // ctx-test x HIGH effort on opus – the top of the repair effort ladder (repair is harder than green;
    // medium gave PARITY (regression) on driver-repair, so more effort may be what RESOLVES it to equivalent).
    { id: "opus-ctx-test-ehigh", levers: { model: "opus", ctxPack: ["failing-test"], effort: "high" } },
    // The 237s winner + ctx-migration: hand the driver the migration mechanism (path + create command +
    // models loc) so it skips the opening discovery (it grepped scripts/lk to find lakebase-new-migration).
    { id: "opus-ctx-test-emedium-migration", levers: { model: "opus", ctxPack: ["failing-test", "migration"], effort: "medium" } },
    // OPUS-NORMAL x the OTHER levers – explore which scoping/enforcement lever best reaches the clean-code
    // + superseded-shift MILESTONE on opus at default effort (opus-ctx-test already hits it 3/3).
    { id: "opus", levers: { model: "opus" } }, // bare control: does opus reach the milestone WITHOUT scoping context?
    { id: "opus-scope-note", levers: { model: "opus", ctxPack: ["scope-note"] } },
    { id: "opus-ctx-test-scope", levers: { model: "opus", ctxPack: ["failing-test", "scope-note"] } },
    { id: "opus-single-test-guard", levers: { model: "opus", guardSuite: true } },
    // BARE OPUS x EFFORT – the FULL ladder, to LOCATE where the manifest "default" effort (what bare
    // `opus` runs) actually sits, then take the LOWEST rungs BELOW default that still hit the milestone
    // (clean code + superseded-shift) for the n=3 faster-while-holding confirmation. Ladder:
    // low < medium < high < xhigh < max (default = the model's own default, measured via bare `opus`).
    { id: "opus-e-low", levers: { model: "opus", effort: "low" } },
    { id: "opus-e-medium", levers: { model: "opus", effort: "medium" } },
    { id: "opus-e-high", levers: { model: "opus", effort: "high" } },
    { id: "opus-e-xhigh", levers: { model: "opus", effort: "xhigh" } },
    { id: "opus-e-max", levers: { model: "opus", effort: "max" } },
  ];
}
