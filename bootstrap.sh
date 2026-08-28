#!/usr/bin/env bash
#
# consort - one-line bootstrap: get the tools in place, then point you at /consort:start.
#
# Consort runs against a real Lakebase database (no mock mode). This script does
# the "assemble the tools by hand" work for you: it detects each required tool
# (Node, npm, Python, JDK, gh, the Databricks CLI), offers to install or upgrade
# what is missing, and checks that gh and the Databricks CLI are authenticated.
#
# It deliberately does NOT probe whether your workspace has Lakebase enabled.
# That check needs a specific workspace target, and there is no target until you
# create a project. /consort:start (and lakebase-create-project) run the full
# environment doctor, INCLUDING the Lakebase-enabled probe, against your chosen
# workspace before provisioning anything. So a green result here means "tools
# ready"; the workspace check happens at create time, when there is something to
# check against. Running that probe now, in an empty folder, would only report
# "no workspace target yet", which is expected, not a problem to fix.
#
# Usage:
#   bash <(curl -sL https://raw.githubusercontent.com/databricks-solutions/consort/main/bootstrap.sh)
#
#   # Non-interactive: attempt every missing install without prompting.
#   bash <(curl -sL .../bootstrap.sh) --yes
#
#   # Only report what is missing; install nothing.
#   bash <(curl -sL .../bootstrap.sh) --check-only
#
# Exit codes: 0 = all required tools present (any remaining auth step is printed
# as a reminder, not a failure); 1 = a required tool is still missing.

set -euo pipefail

ASSUME_YES=false
CHECK_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=true; shift ;;
    --check-only) CHECK_ONLY=true; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""
fi

have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
BREW=false
if have brew; then BREW=true; fi

# Ask (or auto-yes / auto-no) before an install.
confirm() {
  local prompt="$1"
  if [ "$CHECK_ONLY" = true ]; then return 1; fi
  if [ "$ASSUME_YES" = true ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi  # non-interactive stdin: do not install
  printf '%s [y/N] ' "$prompt"
  local reply; read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Offer a brew install (macOS / linuxbrew). Returns non-zero if not installed.
offer_brew_install() {
  local label="$1" formula="$2"
  # In check-only mode we just report; do not offer or print a skip line.
  if [ "$CHECK_ONLY" = true ]; then return 1; fi
  if [ "$BREW" != true ]; then
    echo -e "  ${YELLOW}→ Install $label manually (no Homebrew detected): $3${NC}"
    return 1
  fi
  if confirm "  Install $label via 'brew install $formula'?"; then
    brew install "$formula"
  else
    echo -e "  ${YELLOW}→ Skipped. Install $label yourself: $3${NC}"
    return 1
  fi
}

# Locate a keg-only formula's install prefix. Two of the three formulas this
# script offers (node@20, openjdk@17, python@3.11 - all but plain `node`) are
# KEG-ONLY: brew installs them without linking them onto PATH, so a successful
# `brew install` does not make the tool usable. Derive the prefix from
# `brew --prefix` so linuxbrew and a custom HOMEBREW_PREFIX work too, and fall
# back to the well-known prefixes only if brew cannot answer.
brew_keg() {
  local formula="$1" prefix
  if [ "$BREW" = true ]; then
    prefix="$( { brew --prefix 2>/dev/null; } || true )"
    if [ -n "$prefix" ] && [ -d "$prefix/opt/$formula" ]; then
      printf '%s' "$prefix/opt/$formula"; return 0
    fi
  fi
  for prefix in /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
    if [ -d "$prefix/opt/$formula" ]; then printf '%s' "$prefix/opt/$formula"; return 0; fi
  done
  return 1
}

# version_at_least MIN ACTUAL -> 0 when ACTUAL >= MIN. One comparison for every
# floor in this script, so a new floor is a one-line addition rather than a
# fourth hand-rolled idiom.
version_at_least() {
  local min="$1" actual="$2"
  [ -n "$actual" ] && [ "$(printf '%s\n%s\n' "$min" "$actual" | sort -V | head -1)" = "$min" ]
}

# The rc file for the user's ACTUAL shell. linuxbrew users are commonly on bash,
# so a hardcoded ~/.zshrc remediation would edit a file their shell never reads.
shell_rc() {
  case "$(basename "${SHELL:-}")" in
    zsh)  printf '%s' "$HOME/.zshrc" ;;
    bash) printf '%s' "$HOME/.bashrc" ;;
    *)    printf '' ;;
  esac
}

# Print the keg-only remediation for <label>/<formula>. Returns non-zero when no
# keg is present (i.e. the tool is genuinely absent, not merely unlinked).
keg_hint() {
  local label="$1" formula="$2" keg rc
  keg="$( brew_keg "$formula" || true )"
  [ -z "$keg" ] && return 1
  [ -d "$keg/bin" ] || return 1
  rc="$(shell_rc)"
  echo -e "  ${YELLOW}!${NC} $label is at $keg but is keg-only, so it is not on PATH."
  if [ -n "$rc" ]; then
    echo -e "     Add it, then re-run this script:"
    echo -e "       echo 'export PATH=\"$keg/bin:\$PATH\"' >> $rc"
  else
    echo -e "     Add its bin directory to PATH, then re-run this script:"
    echo -e "       export PATH=\"$keg/bin:\$PATH\""
  fi
  return 0
}

# `java` probes read the FULL output, never `head -1`: a JVM may print a
# "Picked up JAVA_TOOL_OPTIONS: ..." preamble first, which would make a
# first-line probe report a perfectly good JDK as missing.
java_raw()     { { java -version 2>&1; } || true; }
java_works()   { printf '%s' "$1" | grep -qiE 'version|openjdk'; }
java_version() { printf '%s' "$1" | sed -nE 's/.*"([0-9][^"]*)".*/\1/p' | head -1; }

echo -e "${BLUE}consort bootstrap: checking prerequisites${NC}"
echo

MISSING=0
AUTH_REMINDERS=()
# Advisories are NOT failures. Per consort/lakebase/create-doctor-gate.ts, the
# JDK blocks creation only for java/kotlin projects: "a Python (alembic) or Node
# project does not need a JDK and must not be gated on it". bootstrap.sh has no
# --language, so it must report a JDK problem without failing the run.
ADVISORIES=()

# node + npm (npm ships with node). `node@20` is keg-only, so judge the END
# STATE after any install rather than the installer's exit status.
NODE_MIN=20
node_major() { { node -v 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/'; } || true; }
NODE_MAJOR="$(node_major)"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge "$NODE_MIN" ] 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
else
  if [ -n "$NODE_MAJOR" ]; then
    echo -e "  ${YELLOW}!${NC} Node.js $(node -v) - Consort needs ${NODE_MIN}+"
    offer_brew_install "Node.js $NODE_MIN" "node@$NODE_MIN" "https://nodejs.org" || true
    NODE_FORMULA="node@$NODE_MIN"
  else
    echo -e "  ${RED}✗${NC} Node.js not found"
    offer_brew_install "Node.js" "node" "https://nodejs.org" || true
    NODE_FORMULA="node"
  fi
  NODE_MAJOR="$(node_major)"
  if [ -z "$NODE_MAJOR" ] || ! [ "$NODE_MAJOR" -ge "$NODE_MIN" ] 2>/dev/null; then
    keg_hint "Node.js $NODE_MIN" "$NODE_FORMULA" || true
    MISSING=$((MISSING+1))
  fi
fi
have npm && echo -e "  ${GREEN}✓${NC} npm $(npm -v)" || { echo -e "  ${RED}✗${NC} npm not found (ships with Node.js)"; MISSING=$((MISSING+1)); }

# python 3.10+ (CONTRIBUTING). `have python3` alone is not enough: macOS ships
# /usr/bin/python3 (3.9 on current releases), which satisfies a presence check
# but sits below the floor, so an unusable interpreter reported green. And
# `python@3.11` is keg-only - it installs python3.11 without taking over
# `python3` - so re-test the END STATE instead of trusting the install.
PY_MIN="3.10"
py_ver() { { python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null; } || true; }
PY_VER="$(py_ver)"
if version_at_least "$PY_MIN" "$PY_VER"; then
  echo -e "  ${GREEN}✓${NC} Python $PY_VER"
else
  if [ -n "$PY_VER" ]; then
    echo -e "  ${YELLOW}!${NC} Python $PY_VER found, but ${PY_MIN}+ is required"
  else
    echo -e "  ${RED}✗${NC} Python 3 not found"
  fi
  offer_brew_install "Python 3.11" "python@3.11" "https://www.python.org/downloads" || true
  PY_VER="$(py_ver)"
  if ! version_at_least "$PY_MIN" "$PY_VER"; then
    keg_hint "Python 3.11" "python@3.11" || true
    MISSING=$((MISSING+1))
  fi
fi

# jdk 17+ (CONTRIBUTING), for the Flyway live path. This is an ADVISORY, not a
# blocker: create-doctor-gate.ts gates the JDK only for java/kotlin projects, and
# bootstrap has no --language, so failing the run here would block a Python or
# Node author who needs no JDK at all. Report it accurately, do not gate on it.
JDK_MIN="17"
JAVA_RAW="$(java_raw)"
JAVA_VER="$(java_version "$JAVA_RAW")"
if java_works "$JAVA_RAW" && version_at_least "$JDK_MIN" "$JAVA_VER"; then
  echo -e "  ${GREEN}✓${NC} JDK $JAVA_VER"
else
  if java_works "$JAVA_RAW"; then
    echo -e "  ${YELLOW}!${NC} JDK $JAVA_VER found, but ${JDK_MIN}+ is needed for the Flyway live path"
  else
    echo -e "  ${YELLOW}!${NC} JDK not found on PATH (needed for the Flyway live path)"
  fi
  offer_brew_install "JDK $JDK_MIN" "openjdk@$JDK_MIN" "https://adoptium.net" || true
  JAVA_RAW="$(java_raw)"
  JAVA_VER="$(java_version "$JAVA_RAW")"
  if ! java_works "$JAVA_RAW" || ! version_at_least "$JDK_MIN" "$JAVA_VER"; then
    keg_hint "JDK $JDK_MIN" "openjdk@$JDK_MIN" || true
    ADVISORIES+=("JDK ${JDK_MIN}+ is not on PATH. Only java/kotlin projects need it; the Flyway live path will fail without it.")
  fi
fi

# gh: presence is the tool requirement; authentication is a reminder, not a
# blocker (the tool is installed; `gh auth login` is a one-liner run later).
if have gh; then
  if gh auth status >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} GitHub CLI (authenticated)"
  else
    echo -e "  ${GREEN}✓${NC} GitHub CLI (installed; not yet authenticated)"
    AUTH_REMINDERS+=("gh auth login   # authenticate the GitHub CLI")
  fi
else
  echo -e "  ${RED}✗${NC} GitHub CLI not found"
  offer_brew_install "GitHub CLI" "gh" "https://cli.github.com" || MISSING=$((MISSING+1))
fi

# databricks CLI: presence is the tool requirement. Whether it is authenticated
# to a Lakebase-enabled workspace is verified by the doctor at /consort:start
# (which has a workspace target); here we only nudge if no auth exists at all.
if have databricks; then
  echo -e "  ${GREEN}✓${NC} Databricks CLI $(databricks --version 2>/dev/null | tail -1)"
  if ! databricks auth describe >/dev/null 2>&1; then
    AUTH_REMINDERS+=("databricks auth login --host <your-lakebase-workspace>   # authenticate the Databricks CLI")
  fi
else
  echo -e "  ${RED}✗${NC} Databricks CLI not found"
  offer_brew_install "Databricks CLI" "databricks/tap/databricks" "https://docs.databricks.com/dev-tools/cli/install.html" || MISSING=$((MISSING+1))
fi

echo
if [ "$MISSING" -gt 0 ]; then
  echo -e "${YELLOW}$MISSING required tool(s) still missing. Install them (see above), then re-run.${NC}"
  if [ "${#ADVISORIES[@]}" -gt 0 ]; then
    for a in "${ADVISORIES[@]}"; do echo -e "  ${YELLOW}-${NC} $a"; done
  fi
  exit 1
fi

echo -e "${GREEN}All required tools are present.${NC}"

# Advisories print on the success path too: a green "all present" that hides a
# broken JDK is the false-green this script exists to avoid.
if [ "${#ADVISORIES[@]}" -gt 0 ]; then
  echo
  echo -e "${YELLOW}Advisories (not blocking):${NC}"
  for a in "${ADVISORIES[@]}"; do echo "  - $a"; done
fi

# Auth reminders are NOT failures: the tools are installed, and these one-liners
# are quick to run whenever you are ready.
if [ "${#AUTH_REMINDERS[@]}" -gt 0 ]; then
  echo
  echo -e "${YELLOW}Before your first project, authenticate:${NC}"
  for r in "${AUTH_REMINDERS[@]}"; do echo "  $r"; done
fi

echo
echo -e "${BLUE}Next:${NC}"
echo "  claude plugin marketplace add databricks-solutions/consort"
echo "  claude plugin install consort@databricks-solutions"
echo "  # then, in the folder for your project:"
echo "  /consort:start"
echo
echo "/consort:start runs the full environment doctor against your chosen"
echo "workspace, INCLUDING the check that it has Lakebase enabled, before it"
echo "provisions anything. That workspace check belongs there, not here: it needs"
echo "a target, and there is no target until you pick a workspace at create time."
exit 0
