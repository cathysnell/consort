# Kit-gaps repair — work log

Autonomous execution log for the `kit-gaps-repair` branch (off `dashboard-drilldown-lanes`).
Plan: `kit-gaps-repair-plan.md`. Each phase: findings → changes → tests → commit → live-proof status.

**Ground rules honored:** no pushes, no releases, no version bumps (SemVer is the maintainer's);
the live `stockflow-3-68` run is read-only and never mutated; hermetic tests run per phase; anything
that needs a live cloud run to prove is implemented + hermetic-tested + flagged **LIVE-PROOF PENDING**
rather than claimed done.

---

## Phase 2 — observability logging (G3 + G4 + G4b) — COMMITTED

### Findings (verified against current source + the real 277-event stockflow-3-68 run)

The plan doc's premise was **stale**. Verified reality:

- **The emit code already exists.** `logging/orchestrator-logging.ts` (the deterministic driver's
  `onAction` hook) maps `surface-gate`/`await-acceptance` → `gate.surfaced` and
  `approve-gate`/`approve-plan-gate`/`approve-deploy-gate`/`approve-promote-gate` → `gate.approved`.
- **The real gap is WHICH door runs on a human-live run.** On a human-live run the human approves
  **out-of-band** via `consort-approve-gate` / `consort-pipeline`, so the driver's `onAction`
  approve-emit never fires (the drive stops at the gate *before* `onAction`, at the `stopWhen` check
  in `orchestrator-run.ts`). Of the human doors, only the feature-gate path
  (`drainGatesAsHumanProxy` → `logHitlDecision`, covering deploy/promote/feature-spec) logged an
  approval. The **sprint plan gate** (`approveSprintPlanGate`) and the **per-story spec gate**
  (`approveStoryGateFromDisk`) cleared **silently**.
- **Proof from the real run:** `gate.surfaced` = {plan:1, spec:4, acceptance:4, test_list:1};
  `gate.approved` = **{test_list:1} only** — even though the run shipped S1–S3. That is exactly why
  the dashboard needed the interim `storyGateStatus` inference.
- **G3 is essentially a non-gap.** The driver is deterministic — it spends no tokens of its own, so a
  `$0` orchestrator "own cost" is correct. The orchestrator card already shows RUN-level totals
  (turns + cost summed across agents). Not chased; no invented cost.
- **G4 (plan surfaced):** the plan gate *did* surface once in the real run, so it is not wholly
  absent; consistent drive-side surfacing on a human-live run is a timing question that needs live
  proof, so it is **not** part of this hermetic commit.

### Changes

- **New shared emitter** `consort/logging/gate-decision-log.ts` — `logGateApproved` /
  `logGateRejected` (best-effort; a logging failure never blocks an approval). One source, so every
  gate door logs a decision identically.
- `gates/human-proxy.ts`: `logHitlDecision` now **delegates** to the shared emitter (DRY; behavior
  identical — existing human-proxy tests still green).
- `gates/sprint-gates.ts` `approveSprintPlanGate`: emits `gate.approved{gate:"plan", approver}` on a
  **fresh** approval (not on an idempotent re-approve).
- `pipeline/story-pipeline.ts` `approveStoryGateFromDisk`: emits
  `gate.approved{gate:"spec", story, feature_id, approver}` on success.
- **Dashboard:** no change needed. `storyGateStatus`'s inference already *prefers* a real
  `gate.approved` and falls back to inference — so with this fix new runs get exact per-gate/story
  approvals, and the inference remains a graceful fallback for pre-fix corpora (e.g. stockflow-3-68,
  which has no approvals logged). Kept deliberately, not retired.

### Tests

- New `tests/bdd/gate-decision-log.test.ts` (5): shared emitter shape (gate/approver/validated,
  story only when scoped, rejected event) + `approveSprintPlanGate` emits once on fresh approval and
  **not** on idempotent re-approve.
- `tests/bdd/consort-spec-gate-ac-conformance.test.ts` (+1): `approveStoryGateFromDisk` writes a
  story-scoped `gate.approved`.
- **Full kit suite: 3919 passed, 58 skipped, 2 todo, 0 failures** (`npx vitest run`).
- Kit `tsc --noEmit`: clean.

### Live-proof status

Hermetically complete. A human-live e2e run should now show plan + per-story spec gate approvals in
`agent-log.jsonl` (previously only `test_list`). **LIVE-PROOF PENDING** for the end-to-end
human-live run (cannot be run unattended here).

### Commit

`990c552f` on `kit-gaps-repair`.

---

## Phase 3 — intake launcher / supply completeness (G5) — COMMITTED

### Findings (verified against current source)

Both halves of G5 were **largely already done** — the plan doc is stale again:

- **G5(b) — intake-supply correspondence: DONE.** `bin/consort/drive.cli.ts` writes the intake
  correspondence beats at kickoff: seq 0 kickoff, seq 1 orchestrator ASKS for intake (incl. brand
  asset), seq 2 HIL SUBMITS — each on-disk intake artifact becomes a `submitted[]` entry, and the
  bytes (incl. `warehouse.png`, binary-safe) are copied into `<REC>/intake/` so the corpus is
  portable. Nothing to add.
- **G5(a) — icon staged into the project: PARTIAL → fixed.** `_replay-smoke.sh` already stages the
  intake `design/assets/` (or `assets/`) dir into the project. But the `--create` **live-capture**
  path in `capture-scenario.sh` staged only the 3 `.md`s via `consort-human-proxy supply`, so on a
  live capture the icon never reached `.consort/design/assets/` — and drive.cli's beat-2 read found
  nothing. Real gap.

### Changes

- `examples/replay/capture-scenario.sh` (`--create`): after the 3 `.md` supplies, stage the intake
  `design/assets/` (or `assets/`) into `${SFTDD_DIR}/design/assets/`, mirroring `_replay-smoke.sh`,
  and widen the intake commit message to include brand assets. Now a `--create` capture carries the
  icon too.

### Tests

- `bash -n examples/replay/capture-scenario.sh`: syntax OK. (Shell scaffolding — no hermetic unit
  test; the block is a byte-parity copy of the proven `_replay-smoke.sh` staging.)

### Live-proof status

**LIVE-PROOF PENDING** — a `--create` capture of a scenario whose intake ships `design/assets/` should
now show the icon in the intake correspondence submission + on disk at `.consort/design/assets/`.

### Commit

`e9bc6c83` on `kit-gaps-repair`.

---

## Phase 4 — feature-attribution decision (G2 tail) — DECIDED (no code)

Phase 4 is a decision, not code (per the plan). This is the "plan 1/5" question raised while working
on the dashboard: during a feature, the plan lane lights only the steps the log attributes to that
feature (e.g. just `p-breakdown`), because the pre-naming `propose`/`estimate` planning events carry
`feature_id: ""` and are excluded from the feature's scope.

**Decision: keep strict per-feature scoping. Do NOT flip to sprint-level or forward-attribute.**

Rationale:
- The reducer's per-feature scoping is intentional and tested (`lib/reducer.test.ts` — "attributes
  sprint-1 planning to no feature"). It explicitly refuses to credit pre-feature planning to
  "whichever feature happens to come next" because that is **a guess**.
- Planning genuinely runs *before* a feature exists (it decides *what* the feature will be), so a
  feature's plan lane honestly showing only its own post-naming planning is correct, not a bug.
- The sprint-level view of the plan gate is already available: the orchestrator's gate bubbles treat
  `plan` as sprint-level (never story-filtered), so "the sprint's plan gate passed" is legible there.
- The "N/5" count is therefore honest. The `p-breakdown` step added earlier this session is what
  makes a feature's own planning contribution (breakdown → stories) visible on the lane.

**If sprint-level is later wanted** (a deliberate product choice, not a bug fix): it needs a
sprint-boundary notion the dashboard does not currently track (so the plan lane could scope to the
*sprint* rather than the feature without bleeding sprint-1's planning into sprint-2). That is a
scoped follow-up to green-light, not an autonomous flip — flagged here rather than silently changed.

No commit (documentation only; folded into the wrap commit).

---

## Phase 5 — channel-model live proof (G6) — NOT A GAP (stale doc)

### Findings (verified against current source)

The plan doc's premise ("`executorDispatched` allowlists only 3 actions; 8 design roles + build
turns still take the legacy path") is **badly stale**. The current allowlist
(`consort/orchestrator/drive/executor-dispatch.ts`) already routes **every agent turn** through the
unified executor:

- **Design:** spec-author `breakdown`/`propose`, architect `estimate`, per-story spec-author /
  architect-reviewer / test-strategist, `dba` (story-scoped), `ux-designer` (feature-scoped).
- **Build:** navigator RED + `assess`/`assess-deploy`/`assess-refactor`/`review`/`reflect`; driver
  GREEN + `refactor`/`repair`/`refactor-deploy`/`refactor-superseded`/`green-superseded`.

The only invoke-role actions NOT routed through the executor are `product-owner author-requests` and
`architect-reviewer estimate-committed` — both **intentionally deterministic/agentless**
(`deterministicAgentless` + `commandsForAction`): author-requests is a human-input step, and
estimate-committed is a deterministic sync-backlog. They are not un-migrated legacy agent turns.

### Disposition

No code change. There is nothing safe or correct to "widen" — the executor path is already the one
dispatch path for all agent turns, and the two deterministic exclusions are by design. The
"live-prove the contained-root path across the full set" remains a live-run concern, but the CODE
gap G6 describes is closed. Plan doc corrected.

---

## Phase 1 — PO intake production (G1) — DEFERRED to a supervised live session (with spec)

### Findings (verified against current source)

G1 is **real and remains open**. `skills/consort/agents/product-owner.md` is a full facilitator
agent (`model: opus`) that "runs the intake interviews and drafts product-overview.md / nfrs.md /
design-brief.md" and at `/plan` drafts the `feature-request.md` files. But the drive **never spawns
it to draft**: intake is always human/Human-Proxy supplied, and `product-owner author-requests`
(`orchestrator-drive.ts:213`) is deliberately `deterministicAgentless` (the proxy/human supplies the
recorded requests). So the PO agent is defined but dormant.

### Why this is NOT shipped autonomously

Phase 1 is the plan's anchor and its "big one" — a **behavioral** change that spawns an LLM agent
into the drive's intake/planning path, and the plan itself requires it to be **live-proven** before
done. It cannot be responsibly completed unattended:

- It changes the intake/planning behavior that **every corpus and the live flow depend on**. The
  guardrail (seed supplied → keep today's deterministic path byte-identical; only spawn when no seed)
  is essential and must be live-verified, not asserted.
- Proving a PO **agent** produces valid, human-approvable intake is inherently a live-LLM concern;
  no hermetic test can stand in for it.
- Per the project rules (nothing done until live-tested; never break the live path; the human owns
  risky behavioral changes), a blind, unproven agent-spawn wired into intake would be worse than a
  precise, ready-to-execute spec.

### Ready-to-execute spec (for the supervised session)

1. **Intake, no seed** — at the intake step, when no `$LAKEBASE_CONSORT_RECORDED_INTAKE_DIR` seed is
   present, dispatch `invoke-role product-owner` (intake) through the executor to run the interview
   and draft `product-overview.md` / `nfrs.md` / `design-brief.md`; the human approves. When a seed
   IS present (replay/demo), keep today's deterministic supply path (no spawn) — corpora stay
   byte-identical. Add the PO intake action to `executorDispatched` (it becomes a real agent turn)
   with a shipped manifest step + output paths.
2. **author-requests co-pilot** — when no recorded `SPRINT_REQUESTS`, dispatch `product-owner`
   (author-requests) to draft each `feature-request.md` from the architect's sized candidates; human
   approves. Recorded pairs present → keep deterministic supply. Move author-requests off
   `deterministicAgentless` ONLY for the no-seed branch.
3. **Reconcile positioning** — README/positioning line: PO = the human's seat PLUS an optional
   facilitator co-pilot.
4. **Live proof** — one no-seed run (PO drafts intake + requests, human-approves) AND one seed run
   (byte-identical to today). Regression: the full hermetic suite stays green throughout.

### Disposition

**LIVE-PROOF REQUIRED / SUPERVISED.** Documented, not implemented. This is the one remaining piece of
real work; it needs a human-attended live run.

---

## Summary (for review)

| Phase | Gap | Outcome | Commit |
|---|---|---|---|
| **2** | G3/G4/G4b — gate approvals not logged | **DONE (hermetic).** Shared `gate-decision-log.ts`; plan + per-story spec doors now log `gate.approved`. G3 a non-gap. Full suite 3919 pass. | `990c552f` |
| **3** | G5 — intake supply completeness | **DONE.** G5(b) already implemented; fixed G5(a) — `--create` capture now stages brand assets. | `e9bc6c83` |
| **4** | G2 — plan-lane feature attribution | **DECIDED: keep strict per-feature scoping** (forward-attribution is a guess the reducer refuses). No code. | (wrap) |
| **5** | G6 — channel-model executor path | **NOT A GAP (stale doc).** Executor already routes all agent turns; the 2 exclusions are intentional. No code. | (wrap) |
| **1** | G1 — PO intake production | **DEFERRED — LIVE-PROOF REQUIRED.** PO agent exists but dormant; spec written for a supervised live session. | — |

**Net:** the plan doc was substantially stale — most observability/correspondence/executor work was
already shipped. Two genuine hermetic fixes landed (Phase 2, Phase 3); Phase 4 decided; Phase 5 found
closed; Phase 1 (the true remaining anchor) specced and deferred to a supervised live run. Every kit
change is hermetically green (full suite 3919 pass, tsc clean); no pushes, no releases, no version
bumps; the live `stockflow-3-68` run was never touched.
