// driver-green-enforcement: the per-candidate workspace setup for the driver-GREEN enforcement +
// context levers (see consort/optimize/DRIVER-GREEN-LEVERS.md). Sweep-only (not shipped runtime):
// the driver-sweep calls applyDriverLevers on each candidate's throwaway workspace BEFORE the driver
// turn. All writes land under <workspace>/.claude/ – which headless `claude -p --setting-sources
// project` loads (verified), so the hook + deny rules gate the DRIVER AGENT's tool calls only; the
// orchestrator's execSync honest-GREEN verify is untouched.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, dump } from "js-yaml";
import type { RoleLeverPatch } from "./role-levers.js";

/** Deterministic per-candidate deploy port: base + the candidate's index in the sweep. Deterministic
 *  (not OS-allocated) so there is NO allocation race / TOCTOU across the parallel pool – candidate i
 *  always owns port BASE_DEPLOY_PORT+i, unique across the whole candidate set regardless of the
 *  concurrency cap. Base 8100 (above the common :8000) to dodge a stray dev server. */
export const BASE_DEPLOY_PORT = 8100;
export function deployPortForIndex(index: number): number {
  return BASE_DEPLOY_PORT + Math.max(0, index);
}

/**
 * Give a candidate's worktree its OWN deploy port so parallel candidates never collide on the shared
 * :8000 the honest-GREEN verify would otherwise bind. Rewrites the worktree's deploy-targets.yaml
 * `local` target: `base_url` -> http://localhost:<port> AND `run` -> a uvicorn bound to <port> (the
 * scaffold's `make run` is fixed at :8000 and ignores base_url's port, so both must move together, or
 * the reachability poll targets a port nothing is serving). Per-WORKTREE file, so it is concurrency-
 * safe (no shared state) and needs NO change to the shipped deploy substrate. Returns the new base_url.
 */
export function assignWorktreePort(projectDir: string, port: number): string {
  const file = join(projectDir, "deploy-targets.yaml");
  const doc = (load(readFileSync(file, "utf8")) ?? {}) as { targets?: Record<string, Record<string, unknown>> };
  const local = doc.targets?.local;
  if (!local) throw new Error(`assignWorktreePort: no 'local' target in ${file}`);
  const baseUrl = `http://localhost:${port}`;
  local.base_url = baseUrl;
  // Bind uvicorn to the same port (preserve the scaffold's `uv run --env-file .env` prefix + app module).
  local.run = `uv run --env-file .env uvicorn app.main:app --host 127.0.0.1 --port ${port}`;
  writeFileSync(file, dump(doc), "utf8");
  return baseUrl;
}

/**
 * Build the PreToolUse guard hook (python3, present in the scaffold via uv – no jq dep). It reads the
 * Bash tool call on stdin and DENIES per the enabled checks, ALLOWING everything else. Deny = exit-0 +
 * the documented permissionDecision JSON; an unparseable command is ALLOWED (never block on our own
 * parse error). SEGMENT-AWARE: the command is split on &&/||/;/| and each segment's leading verb is
 * checked, so a scan/suite verb ANYWHERE in a compound or pipeline (`cd X && ls`, `pytest … | grep`)
 * is caught – the fix for the glob approach's prefix-only blind spot.
 *   - suite: deny a WHOLE-suite run (run-tests.sh / make test / npm test / bare `pytest` – no test path)
 *     while allowing a targeted `pytest <path>` / `run-tests.sh <path>`.
 *   - scan:  deny ls/find/grep/rg/tree (force reliance on the injected LAYOUT + named paths).
 */
export function guardHookScript(opts: { suite: boolean; scan: boolean }): string {
  return `#!/usr/bin/env python3
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # unparseable -> do not block
cmd = ((data.get("tool_input") or {}).get("command") or "")
SUITE = ${opts.suite ? "True" : "False"}
SCAN = ${opts.scan ? "True" : "False"}
def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)
# Split into &&/||/;/| segments so a verb anywhere in a compound/pipeline is seen.
segs, buf, i = [], "", 0
while i < len(cmd):
    if cmd[i:i+2] in ("&&", "||"):
        segs.append(buf); buf = ""; i += 2; continue
    if cmd[i] in ";|":
        segs.append(buf); buf = ""; i += 1; continue
    buf += cmd[i]; i += 1
segs.append(buf)
SCAN_VERBS = {"ls", "find", "grep", "rg", "egrep", "fgrep", "tree"}
def is_path(a):
    return a.endswith(".py") or a.endswith(".tsx") or a.endswith(".ts") or "::" in a or a.startswith("tests") or a.startswith("client/")
for seg in segs:
    toks = seg.split()
    while toks and ("=" in toks[0]) and toks[0].split("=")[0].isidentifier():
        toks = toks[1:]  # drop leading VAR=val env assignments
    if not toks:
        continue
    verb = toks[0].split("/")[-1]
    args = toks[1:]
    if SCAN and verb in SCAN_VERBS:
        deny("Directory scanning blocked (guard-scan): use the injected LAYOUT + named paths; do NOT ls/find/grep/tree to locate files.")
    if SUITE:
        rt = [t for t in toks if t.split("/")[-1] == "run-tests.sh"]
        if rt and not any(is_path(a) for a in toks[toks.index(rt[0])+1:]):
            deny("Full test suite blocked (single-test-guard): run only the failing test, e.g. 'uv run --env-file .env pytest <path>'. The orchestrator runs the authoritative full suite post-turn.")
        if verb == "make" and args[:1] == ["test"]:
            deny("Full test suite blocked (single-test-guard): 'make test' runs everything; run 'uv run --env-file .env pytest <path>' for the single failing test.")
        if verb == "npm" and "test" in toks:
            deny("Full client suite blocked (single-test-guard): run one vitest file, e.g. 'npx vitest run <path>'.")
        if "pytest" in toks:
            rest = toks[toks.index("pytest")+1:]
            if not any(is_path(a) for a in rest) and not any(a in ("-k", "-m") for a in rest):
                deny("Full test suite blocked (single-test-guard): 'pytest' with no path runs everything; pass the single failing test path.")
sys.exit(0)
`;
}

/** Back-compat: the suite-only guard (single-test-guard lever). */
export const SINGLE_TEST_GUARD_HOOK = guardHookScript({ suite: true, scan: false });

/** Relative path (under the workspace) the guard hook is written to. */
export const GUARD_HOOK_REL = ".claude/hooks/driver-guard.py";

/** Shape of the subset of `.claude/settings.json` we write/merge. */
interface ClaudeSettings {
  permissions?: { deny?: string[]; allow?: string[]; ask?: string[] };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
}

function readSettings(file: string): ClaudeSettings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

/** The env patch a candidate's `ctxPack` contributes – the drive inherits these so buildContextPack
 *  turns the matching section on. Pure: enumerate only. */
export function ctxPackEnv(ctxPack: RoleLeverPatch["ctxPack"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of ctxPack ?? []) {
    if (s === "db-state") env.LAKEBASE_CONSORT_CTX_DBSTATE = "1";
    if (s === "failing-test") env.LAKEBASE_CONSORT_CTX_FAILINGTEST = "1";
    if (s === "scope-note") env.LAKEBASE_CONSORT_CTX_SCOPENOTE = "1";
    if (s === "migration") env.LAKEBASE_CONSORT_CTX_MIGRATION = "1";
  }
  return env;
}

export interface AppliedLevers {
  /** Env vars to add to the driver turn's environment (from ctxPack). Belt-and-suspenders with the
   *  per-workspace marker below; the marker is the concurrency-safe source, env is the fallback. */
  env: Record<string, string>;
  /** Absolute path to the settings file written (undefined when no enforcement lever applied). */
  settingsPath?: string;
  /** Absolute path to the guard hook script (undefined when guardSuite is off). */
  hookPath?: string;
  /** Absolute path to the ctx-levers marker written (undefined when ctxPack is empty / no consortDir). */
  markerPath?: string;
}

/**
 * Apply a candidate's DRIVER-GREEN levers to a workspace: write/merge `.claude/settings.json` with the
 * deny globs (E2) and/or the single-test-guard PreToolUse hook (E1); write the per-project
 * `<consortDir>/ctx-levers.json` marker for the ctxPack sections (C1/C2, read by buildContextPack ,
 * a per-WORKSPACE file so parallel candidates never race on process env); and return the ctxPack env
 * patch (the fallback source). Idempotent + merge-preserving. `consortDir` is where the marker lands
 * (omit to skip the marker + rely on the returned env for a sequential run).
 */
export function applyDriverLevers(workspaceDir: string, levers: RoleLeverPatch, consortDir?: string): AppliedLevers {
  const env = ctxPackEnv(levers.ctxPack);
  const result: AppliedLevers = { env };

  // C1/C2: the per-workspace ctx-levers marker (race-safe toggle for buildContextPack).
  if ((levers.ctxPack?.length ?? 0) > 0 && consortDir) {
    const markerPath = join(consortDir, "ctx-levers.json");
    mkdirSync(consortDir, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          dbState: levers.ctxPack!.includes("db-state"),
          failingTest: levers.ctxPack!.includes("failing-test"),
          scopeNote: levers.ctxPack!.includes("scope-note"),
          migration: levers.ctxPack!.includes("migration"),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    result.markerPath = markerPath;
  }

  const needsHook = levers.guardSuite === true || levers.guardScan === true;
  const needsSettings = needsHook || (levers.denyBash?.length ?? 0) > 0;
  if (!needsSettings) return result;

  const settingsPath = join(workspaceDir, ".claude", "settings.json");
  const settings = readSettings(settingsPath);

  // Legacy raw deny globs (prefix-only; kept for callers that pass denyBash directly).
  if (levers.denyBash?.length) {
    const perms = (settings.permissions ??= {});
    const deny = new Set(perms.deny ?? []);
    for (const p of levers.denyBash) deny.add(p);
    perms.deny = [...deny];
  }

  // E1/E2: write the composed guard hook (suite and/or scan) + register the PreToolUse matcher.
  if (needsHook) {
    const hookPath = join(workspaceDir, GUARD_HOOK_REL);
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, guardHookScript({ suite: levers.guardSuite === true, scan: levers.guardScan === true }), "utf8");
    chmodSync(hookPath, 0o755);
    const hooks = (settings.hooks ??= {});
    const pre = (hooks.PreToolUse ??= []);
    const already = pre.some((m) => m.hooks?.some((h) => h.command === hookPath));
    if (!already) pre.push({ matcher: "Bash", hooks: [{ type: "command", command: hookPath }] });
    result.hookPath = hookPath;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  result.settingsPath = settingsPath;
  return result;
}
