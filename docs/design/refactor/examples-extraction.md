# Extract the replay/optimize corpora to `consort-examples`

## Context

`claude plugin install consort@databricks-solutions` takes ~3m20s (Milan Stokic reported it;
users may cancel). Root cause: consort tracks **48k dev/test corpus files (~353 MB)** under
`examples/replay/corpora` (45,327 files / 263 MB) and `examples/replay/optimize-results`
(2,795 / 90 MB). The plugin install does a **shallow clone**, but a shallow clone still fetches
the entire HEAD tree — verified: the local marketplace clone is `shallow=true` yet its `.git`
is 151 MB. Because the clone is shallow, **git history is never fetched, so no history rewrite
is needed** — removing the corpora from HEAD shrinks the install directly.

## Goal

Move the heavy corpora to a new public repo **`kevin-hartman/consort-examples`** (same
directory layout), pulled back into consort on demand via `scripts/fetch-examples.sh` (pinned
to a tag). Consort's tree drops to a lean clone; `npm test` stays green **and fully offline**;
`examples/first-project/` and the small replay machinery stay in consort.

## What moves vs stays

**Move corpora to `consort-examples` (same layout):**
- `examples/replay/corpora/**` (the recorded design/build corpora)
- `examples/replay/optimize-results/**` (optimize sweep outputs)

**Test surgery — three buckets, not one.** The corpus-coupled tests are not all "corpus guards";
several source files are *mixed*. Each assertion is one of:

1. **Machinery / layout assertions** (read the `.sh` scripts, check machinery dirs exist, retired
   trees gone) → **stay in consort** (the machinery stays). No corpora needed.
2. **Consort-CODE tests that use corpus-shaped input** (the reflection gate, artifact-conformance on
   a doc, run-config-loader on a run.json, the build-turn label parser) → **stay in consort with a
   readable inline fixture** the test OWNS (`tests/fixtures/`), never reaching into `examples/`.
3. **Corpus-SET guards** (scan the whole corpora set: every scenario replay-ready, every ac_id
   tracked, recorded-build baselines, corpora layout/nesting) → **move to `consort-examples`** with
   the corpora (`tests/guards/`; run in that repo's CI, which `npm i`s the published consort for the
   validators a guard imports).

Concretely:

| File | Disposition |
|---|---|
| `reflection-stockflow.test.ts` | **inline fixture** `tests/fixtures/reflection-stockflow/` (bucket 2) |
| `consort-workflow-smoke.test.ts` | **split**: machinery `run-smoke.sh`/`assertions` checks stay; bug-tracker intake docs → **inline fixture** `tests/fixtures/smoke-bug-tracker/` (buckets 1+2) |
| `consort-scenarios.test.ts` | **split**: machinery + synthetic-fixture validator tests stay; the real-corpora "every scenario replay-ready" describe → `consort-examples` (buckets 1+2+3) |
| `replay-layout-guard.test.ts` | **split**: machinery-dir + retired-trees checks stay; corpora-nesting check → `consort-examples` (buckets 1+3) |
| `consort-artifact-conformance.test.ts` | **drop** the one "reference architecture.json conforms" `it()` (bucket 3, redundant with the inline conformance coverage that stays) |
| `run-config-loader.test.ts` | **drop** the one "loads the shipped stockflow-demo.run.json" `it()` (bucket 3) |
| `scenario-conditions.test.ts` | **drop** the one "stockflow scenario.json declares its conditions" describe (bucket 3) |
| `recorded-build-baseline-guard.test.ts` | **move** the corpus scan to `consort-examples`; the pure `parseBuildTurnLabel` unit tests are **extracted** to `tests/bdd/parse-build-turn-label.test.ts` in consort (bucket 2/3 split) |
| `scenario-corpus-integrity.test.ts` | **move** — pure corpus-set guard (bucket 3) |

**Stay in consort regardless:**
- `examples/first-project/**` (user-facing StockFlow walkthrough) and the replay **machinery**
  (`examples/replay/lk`, `SCENARIOS.md`, `assertions/`, launch/rebuild scripts, `optimize-experiments/`).

**Key invariant:** after this, consort has **zero live references into `examples/replay/corpora`**
in the hermetic suite (only live-only, env-gated tests reference the fetched corpora), so `npm test`
runs green with no corpora present. Verified: `npm test` = **273 files / 3893 tests green with the
corpora physically absent**.

## Mechanism

- `.gitignore` adds `examples/replay/corpora/` + `examples/replay/optimize-results/`.
- `scripts/fetch-examples.sh` shallow-clones `consort-examples` at a pinned tag into those
  paths (idempotent; used by the live/replay/optimize paths + `scripts/run-live-tests.sh`).
- No git history rewrite (clone is shallow — see Context).

## Execution (on branch `chore/extract-examples-corpora`; consort-examples created fresh)

1. Create `kevin-hartman/consort-examples` (public).
2. Populate it (same layout) from the working tree: `examples/replay/corpora`,
   `examples/replay/optimize-results`, the moved guard tests, a `README`, and a CI that runs the
   guards against the full corpora. Commit + push + tag (e.g. `v1`).
3. In consort: apply the test surgery per the table above (inline fixtures for bucket 2; split the
   mixed files keeping machinery + synthetic; drop the redundant bucket-3 `it()`s; `git rm` the pure
   corpus-set guards), then `git rm -r` the two corpora dirs, add the `.gitignore` entries +
   `scripts/fetch-examples.sh` (pinned to the tag).
4. Repoint the machinery that assumed the corpora are always present to fetch-first: both live-test
   doors (`scripts/run-live-tests.sh` and `scripts/run-all-live-tests.sh`) now run
   `scripts/fetch-examples.sh` before the replay + vitest paths.

## Verification

- Consort `npm test` green **with the corpora physically moved aside** (offline) — 273 files /
  3893 tests. No live `examples/replay/corpora` reference remains in any hermetic test (only
  live-only, env-gated tests under `tests/live/**`, `tests/integration/live/**`, and the
  `LAKEBASE_TEST_AGENTS`-gated `per-agent-isolation-live.test.ts` reference the fetched corpora).
- `git clone --depth 1` of consort's new HEAD ≈ a few MB (down from 151 MB).
- `scripts/fetch-examples.sh` repopulates the corpora; the live/replay/optimize paths still resolve.

## Follow-up (not on this branch)
- Wire a test harness + CI in `consort-examples` (vitest scoped to `tests/guards/**`, `npm i` the
  published consort for the validators a guard imports) so the moved corpus-set guards run there.
  See `consort-examples/tests/guards/README.md`.

## Not in scope
No git history rewrite (unneeded); `examples/first-project` stays; no monorepo.
