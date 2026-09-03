# smoke-bug-tracker (inline fixture)

A readable, self-contained copy of the recorded bug-tracker intake docs
(product-overview.md, nfrs.md, design-brief.md, feature-requests/v1,v2) that
consort-workflow-smoke.test.ts OWNS. These exercise the role-voice conventions +
artifact-conformance validators on representative intake artifacts, so the test
never reaches into examples/replay/corpora (which lives in the consort-examples
repo, fetched via scripts/fetch-examples.sh). The run-smoke.sh MACHINERY checks in
that same test still read examples/replay/ directly (machinery stays in consort).
