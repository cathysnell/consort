# reflection-stockflow fixture

A small, readable, self-contained copy of the recorded StockFlow **F1 design** (architecture +
test-list + per-story ACs, no build cycles) used by `tests/bdd/reflection-stockflow.test.ts` to
drive consort's reflection-gate routing. Owned by the test — it does NOT reference the shared
corpora (which live in the `consort-examples` repo). Regenerate from
`consort-examples/examples/replay/corpora/stockflow/recorded-artifacts/features/F1-stock-visibility`
if the recorded design changes.
