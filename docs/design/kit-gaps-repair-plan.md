# Kit gaps — repair / extend plan

Inventory of the open kit gaps recorded in project memory, verified against the current
`consort/` source, plus a phased plan to repair/extend them. The anchor item is wiring the
**Product Owner intake production step**, which the drive defines but never runs.

Status: planning. Nothing here is implemented yet. Kit changes ship via release (SemVer owned
by the maintainer); each phase is independently shippable and must be live-proven before "done".

---

## Inventory (verified in source)

| # | Gap | Evidence |
|---|-----|----------|
| **G1** | **The PO intake production step never runs.** `skills/consort/agents/product-owner.md` is a real facilitator agent (`model: opus`) that runs the intake interviews and drafts `product-overview.md` / `nfrs.md` / `design-brief.md`, and at planning helps choose features + draft `feature-request.md` — but the drive never spawns it. | `orchestrator-effects.ts:578-580`: `author-requests` is *"Unreachable … it never spawns a role agent."* Intake is always human / Human-Proxy supplied. |
| **G2** | **Planning/intake events carry no usable `feature_id`, so a feature-scoped plan lane is dark** (the "why aren't the plan dots lit" symptom — a kit data gap, not the dashboard). | `human-proxy.ts:245` stamps `feature_id: args.featureId`, but at intake time (before features are chosen) it's empty; the dashboard's deliberate feature-scoping (`apps/dashboard/lib/reducer.ts` + `reducer.test.ts:885`) then excludes it. |
| **G3** | **Orchestrator/driver session cost is never logged** — all `cost_usd` sits on spawned sub-agent turns, so the orchestrator / release-engineer cards read $0. | `orchestrator/drive/claude-runner.ts` (~`turn.usage` emit) covers sub-agents only; the drive session emits none of its own. |
| **G4** | **The plan gate never surfaces.** The drive pauses at `approve-plan-gate` and logs only `gate.approved`; no `gate.surfaced("plan")`, so it doesn't pulse like the spec / acceptance / deploy gates. | `orchestrator/drive/orchestrator-drive.ts:226` (`approve-plan-gate`); no `gate.surfaced` for plan anywhere. |
| **G4b** | **Gate APPROVALS aren't logged.** Gates emit `gate.surfaced` but (almost) never `gate.approved` — a full 277-event run had exactly ONE `gate.approved` (a `test_list`), while spec/acceptance/plan/deploy/promote surfaced repeatedly and were clearly approved (the run shipped S1–S3). Without an approval event carrying `{ gate, story }`, no surface can show a gate as *passed* (only "pending"), and per-story gate state can't be reconstructed — the dashboard currently *infers* approval from a later-lifecycle gate surfacing (interim in `storyGateStatus`). Same family as G4: gate lifecycle isn't fully logged. | Only `gate.surfaced` in the drive's HITL path; `gate.approved` emitted for `test_list` but not the human gates. |
| **G5** | **Intake launcher/supply is incomplete:** (a) the product icon `intake/assets/warehouse.png` is never staged into the scaffolded project (only the 3 `.md`s are copied); (b) intake supply writes no correspondence entry, so the intake docs are invisible as submitted artifacts. | `examples/replay/_replay-smoke.sh` copies only the `.md`s; `gates/human-proxy.ts` `supplyArtifact` emits `intake.supplied` (agent-log) but calls no `recordCorrespondence`. |
| **G6** | *(extend, not a defect)* **Channel-model live proof:** `executorDispatched` allowlists only 3 actions; 8 design roles + build turns still take the legacy path (contained-root not exercised live). Local commits unpushed. | `orchestrator/drive/executor-dispatch.ts` allowlist; `docs/design/refactor/channel-model-live-proof.md`; task #592. |

(Deploy-verify assess-routing, previously tracked as a gap, is already fixed — shipped v0.3.0-beta.14 — and is not on this list.)

---

## Plan

### Phase 1 — PO intake production (anchor; fixes G1, largely resolves G2)

Wire the existing `product-owner` agent as an interactive **co-pilot** at the two touchpoints the
drive currently no-ops:

- **(a) Intake, when no seed is supplied** — spawn the PO to run the interview and draft
  `product-overview.md` / `nfrs.md` / `design-brief.md`; the human approves. When a seed *is*
  supplied (replay/demo), keep today's deterministic supply path (no spawn) so corpora stay
  reproducible.
- **(b) author-requests / choose-features** — spawn the PO to pick from the architect's sized
  candidates and draft each `feature-request.md`; the human approves.

Guardrails (from the agent def): "drafts *for* the human; the human approves; never invents intent."

Side effects that resolve other gaps: the PO now emits real turns → the dashboard PO card
populates, and its outputs are feature-attributed once features exist → G2's plan dots light on
the honest path. Reconcile the README/positioning line (PO = the human's seat *plus* an optional
facilitator co-pilot).

### Phase 2 — observability logging (G3 + G4 + G4b) — DONE (hermetic; live-proof pending)

**Re-verified against source before implementing — the original premise above was stale.** The emit
code already exists (`logging/orchestrator-logging.ts` maps the driver's gate actions to
`gate.surfaced`/`gate.approved`). The real gap: on a **human-live** run the human approves
out-of-band via the CLI, so the driver's approve-emit never fires (it stops *before* `onAction`),
and of the human doors only the feature-gate proxy path logged an approval. The sprint **plan** gate
(`approveSprintPlanGate`) and the **per-story spec** gate (`approveStoryGateFromDisk`) cleared
silently — which is why the real 277-event run logged only ONE `gate.approved` (a `test_list`).

Root-cause fix shipped:
- New shared emitter `consort/logging/gate-decision-log.ts` (`logGateApproved`/`logGateRejected`);
  `human-proxy.ts` delegates to it (DRY), and the two silent doors now call it.
- `approveSprintPlanGate` → `gate.approved{gate:"plan"}`; `approveStoryGateFromDisk` →
  `gate.approved{gate:"spec", story, feature_id}`. Best-effort (never blocks approval).
- **G3** is a non-gap: the driver is deterministic (no own token cost); the orchestrator card already
  shows RUN-level totals. Not chased.
- **Dashboard `storyGateStatus`**: NOT retired. It already prefers a real `gate.approved` and falls
  back to inference — so it now uses exact approvals on new runs and stays a graceful fallback for
  pre-fix corpora (stockflow-3-68 has none). See `kit-gaps-repair-worklog.md` for full detail.

Remaining (not in the hermetic commit): consistent drive-side `gate.surfaced("plan")` timing on a
human-live run (G4 tail) needs a live run to validate.

### Phase 3 — intake launcher/supply completeness (G5) — DONE (live-proof pending)

**Re-verified — mostly already done.** G5(b) (intake-supply correspondence) is fully implemented in
`bin/consort/drive.cli.ts` (kickoff beats 0/1/2: ask + submission, incl. a binary-safe `warehouse.png`
copy into `<REC>/intake/`). G5(a) was only partial: `_replay-smoke.sh` staged the intake
`design/assets/`, but the `--create` **live-capture** path in `capture-scenario.sh` staged only the 3
`.md`s, so the icon never reached `.consort/design/assets/` on a live capture. Fixed by mirroring the
asset-staging block there. See `kit-gaps-repair-worklog.md`.

### Phase 4 — feature-attribution decision (G2 tail)

For genuinely pre-feature *sprint* planning (before any feature is named), decide the display
contract: show the plan lane as **sprint-level** (lit regardless of the scoped feature) vs. keep
today's strict per-feature scoping (dark until a feature is named). This is a deliberate design
point (the current strict scope is intentional and tested), so it's a one-line decision to make
explicitly rather than silently flip in the dashboard.

### Phase 5 (extend) — channel-model live proof (G6)

Widen `executorDispatched` to the remaining design turns + live-prove, then retire the legacy
`commandsForAction` branches. Separate track; local commits already exist.

---

## Sequencing

- **1 → 2 → 3** are independently shippable (each its own release).
- Phase 1 is the big one and the one that makes the dashboard PO card and the plan dots correct on
  the real path.
- Phase 2 is a quick win (tiny; lights up the orchestrator cost + plan gate).
- Phase 4 is a decision, not code.
- Phase 5 is optional/independent.

All of this is kit work in `consort/`, separate from the dashboard observability branch
(`dashboard-drilldown-lanes`).
