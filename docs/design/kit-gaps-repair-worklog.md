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

`<phase-3-commit-hash>` on `kit-gaps-repair`.
