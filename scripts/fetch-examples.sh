#!/usr/bin/env bash
# Populate examples/replay/{corpora,optimize-results} from the consort-examples repo (pinned
# tag). The heavy recorded corpora live in kevin-hartman/consort-examples, NOT in this repo, so
# a plugin install / clone stays lean. The dev / replay / optimize / live-test paths run this to
# fetch them into place (same layout). Idempotent: skips when already present.
set -euo pipefail
REPO="${CONSORT_EXAMPLES_REPO:-https://github.com/kevin-hartman/consort-examples.git}"
REF="${CONSORT_EXAMPLES_REF:-v1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/examples/replay"
if [ -d "$DEST/corpora" ] && [ -z "${CONSORT_EXAMPLES_FORCE:-}" ]; then
  echo "examples/replay/corpora already present; skipping (CONSORT_EXAMPLES_FORCE=1 to refetch)."
  exit 0
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Fetching consort-examples@$REF from $REPO ..."
git clone --depth 1 --branch "$REF" "$REPO" "$TMP" >/dev/null 2>&1
rm -rf "$DEST/corpora" "$DEST/optimize-results"
mkdir -p "$DEST"
cp -R "$TMP/examples/replay/corpora" "$DEST/corpora"
cp -R "$TMP/examples/replay/optimize-results" "$DEST/optimize-results"
echo "Fetched examples/replay/{corpora,optimize-results} at $REF."
