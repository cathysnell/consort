#!/usr/bin/env bash
# Open the Consort dashboard on THIS project, so a human can watch the drive unfold
# (roles, gates, turn transcripts, test counts) in the browser. It reads the project's
# local .consort/ straight off disk — no git, no remote — and uses whatever kit is
# deployed locally (the prebuilt bundle the installed kit ships, or `next dev` from a
# dev-clone kit). Ctrl-C to stop.
#
# Usage: ./scripts/run-dashboard.sh [--no-open] [--port N] [extra args -> consort-dashboard]
#   PORT   override the listen port (default 3000; bumped off any busy port)
#
# Thin wrapper: the kit owns the launch logic (consort-dashboard), and `lk` resolves the
# locally-deployed kit the same way every other kit call does — this never re-implements
# that resolution.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -x "$REPO_ROOT/scripts/lk" ]; then
  echo "run-dashboard: no ./scripts/lk kit resolver in $REPO_ROOT. Run this from a lakebase-create-project root." >&2
  exit 1
fi

# Resolve a free listen port via the shared helper (same free_port run-dev uses, so the two
# never collide), then hand it to the launcher. If a retrofit project predates port-utils.sh,
# omit --port and let consort-dashboard pick one itself.
PORT_ARGS=()
if [ -f "$SCRIPT_DIR/port-utils.sh" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/port-utils.sh"
  REQ="${PORT:-3000}"
  GOT="$(free_port "$REQ")"
  [ "$GOT" != "$REQ" ] && echo "Port $REQ is in use, using $GOT instead." >&2
  PORT_ARGS=(--port "$GOT")
fi

exec "$REPO_ROOT/scripts/lk" consort-dashboard --project-dir "$REPO_ROOT" "${PORT_ARGS[@]}" "$@"
