// driver-green-levers: proves the run-17-derived driver/green optimization levers are real, controllable,
// and flow through a dispatched turn. See consort/optimize/DRIVER-GREEN-LEVERS.md.
//
// Coverage:
//  1. driverGreenCandidates()          – the candidate set is well-formed (ids/levers).
//  2. buildContextPack ctx sections    – C1 (db-state) + C2 (failing-test) appear ONLY when enabled,
//                                          via BOTH the opt and the per-workspace marker; readers injected.
//  3. applyDriverLevers                – writes .claude/settings.json (deny E2 + guard hook E1) + the
//                                          ctx-levers marker, and returns the ctxPack env.
//  4. the single-test-guard hook       – executed as a real python3 subprocess: no-arg full suite -> DENY,
//                                          targeted `pytest <path>` / `run-tests.sh <path>` -> ALLOW.
//  5. LIVE dispatch (mock step executor), the real Step + driver-green manifest + a mock StepAgent: the
//                                          agent receives a prompt carrying the enabled ctx sections, and
//                                          the enforcement files are in the workspace it runs in.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { driverGreenCandidates } from "../../tests/optimization/role-levers";
import { applyDriverLevers, ctxPackEnv, guardHookScript, assignWorktreePort, deployPortForIndex, BASE_DEPLOY_PORT } from "../../tests/optimization/driver-green-enforcement";
import { load } from "js-yaml";
import { buildContextPack } from "../../consort/orchestrator/build/build-context";
import { execute } from "../../consort/orchestrator/turns/step-executor";
import type { StepExecutorDeps, StepCtx } from "../../consort/orchestrator/turns/step-executor";
import { Step } from "../../consort/orchestrator/steps/step";
import { manifestForAction } from "../../consort/orchestrator/steps/manifest";
import type { StepAgent, AgentInvocation } from "../../consort/orchestrator/agents/agent-types";
import type { WorkflowAction, DriveState } from "../../consort/orchestrator/drive/orchestrator-drive";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dg-levers-"));
});
afterEach(() => {
  // best-effort cleanup
  try {
    require("fs").rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("driverGreenCandidates: the candidate set is well-formed", () => {
  it("NO live baseline (the recording is the baseline), unique fs-safe ids, each carries exactly its lever", () => {
    const cs = driverGreenCandidates();
    const ids = cs.map((c) => c.id);
    expect(ids).not.toContain("baseline"); // the recorded original IS the baseline (recordedBaselineMs + ref)
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/); // filesystem-safe

    const by = Object.fromEntries(cs.map((c) => [c.id, c.levers]));
    // The scoping/context axis (enforcement dropped as noise/harm) + e-low as the cross-axis effort point.
    expect(by["ctx-test"].ctxPack).toEqual(["failing-test"]);
    expect(by["scope-note"].ctxPack).toEqual(["scope-note"]);
    expect(by["ctx-test-scope"].ctxPack).toEqual(["failing-test", "scope-note"]);
    expect(by["single-test-guard"]).toEqual({ guardSuite: true }); // KEPT as a directive/control option
    expect(by["e-low"]).toEqual({ effort: "low" }); // CROSS-AXIS comparison (effort lever, scored alongside)
    expect(by["ctx-test-elow"]).toEqual({ ctxPack: ["failing-test"], effort: "low" }); // COMBINED scoping + think-less
    expect(by["opus-ctx-test-elow"]).toEqual({ model: "opus", ctxPack: ["failing-test"], effort: "low" }); // COMBINED + opus tier
    expect(by["opus-ctx-test"]).toEqual({ model: "opus", ctxPack: ["failing-test"] }); // opus tier, normal effort
    expect(by["opus-ctx-test-emedium"]).toEqual({ model: "opus", ctxPack: ["failing-test"], effort: "medium" }); // ctx-test knee
    expect(by["opus-ctx-test-ehigh"]).toEqual({ model: "opus", ctxPack: ["failing-test"], effort: "high" }); // repair effort ladder top
    expect(by["opus-ctx-test-emedium-migration"]).toEqual({ model: "opus", ctxPack: ["failing-test", "migration"], effort: "medium" }); // winner + ctx-migration
    // opus-normal x the other levers (exploration): bare control + scope-note + ctx-test-scope + guard.
    expect(by["opus"]).toEqual({ model: "opus" });
    expect(by["opus-scope-note"]).toEqual({ model: "opus", ctxPack: ["scope-note"] });
    expect(by["opus-ctx-test-scope"]).toEqual({ model: "opus", ctxPack: ["failing-test", "scope-note"] });
    expect(by["opus-single-test-guard"]).toEqual({ model: "opus", guardSuite: true });
    // bare opus x the FULL effort ladder – locate where "default" (bare opus) sits, then n=3 the lowest
    // passing rungs below it. low < medium < high < xhigh < max.
    expect(by["opus-e-low"]).toEqual({ model: "opus", effort: "low" });
    expect(by["opus-e-medium"]).toEqual({ model: "opus", effort: "medium" });
    expect(by["opus-e-high"]).toEqual({ model: "opus", effort: "high" });
    expect(by["opus-e-xhigh"]).toEqual({ model: "opus", effort: "xhigh" });
    expect(by["opus-e-max"]).toEqual({ model: "opus", effort: "max" });
    // No proven-harmful guardScan, no deprecated denyBash. Every opus-model lever is explicit below.
    for (const c of cs) {
      expect(c.levers.guardScan).toBeUndefined();
      expect(c.levers.denyBash).toBeUndefined();
    }
    expect(cs.filter((c) => c.levers.model).map((c) => c.id)).toEqual([
      "opus-ctx-test-elow", "opus-ctx-test", "opus-ctx-test-emedium", "opus-ctx-test-ehigh", "opus-ctx-test-emedium-migration",
      "opus", "opus-scope-note", "opus-ctx-test-scope", "opus-single-test-guard",
      "opus-e-low", "opus-e-medium", "opus-e-high", "opus-e-xhigh", "opus-e-max",
    ]);
  });
});

describe("buildContextPack: ctx-db (C1) + ctx-test (C2) sections are OPT- and MARKER-gated", () => {
  const F = "F6-x";
  const S = "S2-drop-combined-code";
  const dbReader = () => ({ current: "20260811000000 (head)", heads: "20260811000002 (head)" });
  const testReader = () => "def test_column_dropped():\n    assert 'inventory_code' not in cols\n";

  function consortDir(): string {
    const d = join(root, ".consort");
    mkdirSync(d, { recursive: true });
    return d;
  }

  it("omits both sections by default (no opt, no marker, no env)", () => {
    const pack = buildContextPack(consortDir(), F, S, "", { dbStateReader: dbReader, failingTestReader: testReader });
    expect(pack).not.toMatch(/DB STATE/);
    expect(pack).not.toMatch(/FAILING TEST/);
  });

  it("includes ONLY the section enabled by opt (with injected readers)", () => {
    const cd = consortDir();
    const dbOnly = buildContextPack(cd, F, S, "", { dbState: true, dbStateReader: dbReader, failingTestReader: testReader });
    expect(dbOnly).toMatch(/DB STATE .*current=20260811000000/);
    expect(dbOnly).not.toMatch(/FAILING TEST/);

    const testOnly = buildContextPack(cd, F, S, "", { failingTest: true, dbStateReader: dbReader, failingTestReader: testReader });
    expect(testOnly).toMatch(/FAILING TEST/);
    expect(testOnly).toMatch(/inventory_code/);
    expect(testOnly).not.toMatch(/DB STATE/);
  });

  it("is driven by the per-workspace ctx-levers marker (the concurrency-safe sweep toggle)", () => {
    const cd = consortDir();
    writeFileSync(join(cd, "ctx-levers.json"), JSON.stringify({ dbState: true, failingTest: true, scopeNote: true }));
    const pack = buildContextPack(cd, F, S, "", { dbStateReader: dbReader, failingTestReader: testReader });
    expect(pack).toMatch(/DB STATE/);
    expect(pack).toMatch(/FAILING TEST/);
    expect(pack).toMatch(/SCOPE ::/);
  });

  it("scope-note: emits the layer-scoping directive ONLY when enabled (no reader needed – it is static)", () => {
    const cd = consortDir();
    expect(buildContextPack(cd, F, S, "")).not.toMatch(/SCOPE ::/); // off by default
    const on = buildContextPack(cd, F, S, "", { scopeNote: true });
    expect(on).toMatch(/SCOPE ::/);
    expect(on).toMatch(/do NOT investigate, build, or run OTHER layers/i);
    expect(on).toMatch(/client\/SPA/); // names the exact rabbit-hole the -46% analysis found
  });

  it("migration: emits the migration mechanism ONLY when enabled (kills the opening discovery)", () => {
    const cd = consortDir();
    expect(buildContextPack(cd, F, S, "")).not.toMatch(/MIGRATION ::/); // off by default
    const on = buildContextPack(cd, F, S, "", { migration: true });
    expect(on).toMatch(/MIGRATION ::/);
    expect(on).toMatch(/alembic\/versions/); // the path the driver otherwise guesses
    expect(on).toMatch(/lakebase-new-migration/); // the command it otherwise greps scripts/lk to find
  });
});

describe("applyDriverLevers: writes the enforcement + context artifacts into the workspace", () => {
  it("guard-scan installs the composed hook (scan enabled, suite off)", () => {
    const applied = applyDriverLevers(root, { guardScan: true });
    expect(existsSync(applied.hookPath!)).toBe(true);
    const hook = readFileSync(applied.hookPath!, "utf8");
    expect(hook).toMatch(/SCAN = True/);
    expect(hook).toMatch(/SUITE = False/);
    const s = JSON.parse(readFileSync(applied.settingsPath!, "utf8"));
    expect(s.hooks.PreToolUse.some((m: { matcher?: string; hooks: { command: string }[] }) => m.matcher === "Bash")).toBe(true);
  });

  it("single-test-guard writes the composed hook (suite enabled, scan off) + registers a PreToolUse Bash matcher", () => {
    const applied = applyDriverLevers(root, { guardSuite: true });
    expect(existsSync(applied.hookPath!)).toBe(true);
    const hook = readFileSync(applied.hookPath!, "utf8");
    expect(hook).toMatch(/SUITE = True/);
    expect(hook).toMatch(/SCAN = False/);
    const s = JSON.parse(readFileSync(applied.settingsPath!, "utf8"));
    const pre = s.hooks.PreToolUse;
    expect(pre.some((m: { matcher?: string; hooks: { command: string }[] }) => m.matcher === "Bash" && m.hooks.some((h) => h.command === applied.hookPath))).toBe(true);
  });

  it("both guards compose into ONE hook (suite AND scan enabled)", () => {
    const applied = applyDriverLevers(root, { guardSuite: true, guardScan: true });
    const hook = readFileSync(applied.hookPath!, "utf8");
    expect(hook).toMatch(/SUITE = True/);
    expect(hook).toMatch(/SCAN = True/);
  });

  it("ctxPack writes the marker (given a consortDir) AND returns the env patch", () => {
    const cd = join(root, ".consort");
    const applied = applyDriverLevers(root, { ctxPack: ["failing-test", "scope-note"] }, cd);
    expect(applied.env).toEqual({ LAKEBASE_CONSORT_CTX_FAILINGTEST: "1", LAKEBASE_CONSORT_CTX_SCOPENOTE: "1" });
    expect(JSON.parse(readFileSync(applied.markerPath!, "utf8"))).toEqual({ dbState: false, failingTest: true, scopeNote: true, migration: false });
  });

  it("ctxPackEnv is a pure enumeration", () => {
    expect(ctxPackEnv(["db-state"])).toEqual({ LAKEBASE_CONSORT_CTX_DBSTATE: "1" });
    expect(ctxPackEnv(["scope-note"])).toEqual({ LAKEBASE_CONSORT_CTX_SCOPENOTE: "1" });
    expect(ctxPackEnv(["migration"])).toEqual({ LAKEBASE_CONSORT_CTX_MIGRATION: "1" });
    expect(ctxPackEnv(["failing-test", "migration"])).toEqual({ LAKEBASE_CONSORT_CTX_FAILINGTEST: "1", LAKEBASE_CONSORT_CTX_MIGRATION: "1" });
    expect(ctxPackEnv(undefined)).toEqual({});
  });
});

describe("per-candidate deploy port (concurrency safety): distinct ports + a consistent worktree rewrite", () => {
  const TARGETS =
    ["targets:", "  local:", "    type: local", "    run: make run", "    base_url: http://localhost:8000",
     "    health_path: /", "    verify: ./scripts/run-tests.sh",
     "  prod:", "    type: databricks-app", "    workspace_profile: x", ""].join("\n");

  it("deployPortForIndex assigns a distinct, deterministic port per candidate index", () => {
    expect(deployPortForIndex(0)).toBe(BASE_DEPLOY_PORT);
    const ports = [0, 1, 2, 3, 4, 5, 6].map(deployPortForIndex);
    expect(new Set(ports).size).toBe(ports.length); // all distinct – no two candidates share a port
    expect(deployPortForIndex(3)).toBe(BASE_DEPLOY_PORT + 3);
  });

  it("assignWorktreePort rewrites base_url AND the uvicorn run to the SAME port (they must agree)", () => {
    writeFileSync(join(root, "deploy-targets.yaml"), TARGETS);
    const url = assignWorktreePort(root, 8103);
    expect(url).toBe("http://localhost:8103");
    const doc = load(readFileSync(join(root, "deploy-targets.yaml"), "utf8")) as { targets: Record<string, { base_url?: string; run?: string; type?: string }> };
    expect(doc.targets.local.base_url).toBe("http://localhost:8103");
    expect(doc.targets.local.run).toMatch(/uvicorn app\.main:app .*--port 8103/);
    expect(doc.targets.local.run).toMatch(/uv run --env-file \.env/); // preserved the scaffold prefix
    // The prod target is untouched (only `local` is re-ported).
    expect(doc.targets.prod.type).toBe("databricks-app");
    expect(doc.targets.prod.base_url).toBeUndefined();
  });

  it("two candidates rewrite to DIFFERENT ports (the collision the fix removes)", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "deploy-targets.yaml"), TARGETS);
    writeFileSync(join(b, "deploy-targets.yaml"), TARGETS);
    const urlA = assignWorktreePort(a, deployPortForIndex(0));
    const urlB = assignWorktreePort(b, deployPortForIndex(1));
    expect(urlA).not.toBe(urlB);
  });
});

describe("guard hook: executed as a real subprocess, segment-aware suite + scan denial", () => {
  // Write a hook with the given checks and run it with a Bash tool call on stdin.
  function runGuard(opts: { suite: boolean; scan: boolean }, command: string): boolean {
    const hookPath = join(root, `guard-${opts.suite}-${opts.scan}.py`);
    writeFileSync(hookPath, guardHookScript(opts));
    const out = execFileSync("python3", [hookPath], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
    return /"permissionDecision"\s*:\s*"deny"/.test(out);
  }
  const SUITE = { suite: true, scan: false };
  const SCAN = { suite: false, scan: true };

  it("suite: DENIES a no-arg full suite (incl. bare pytest), ALLOWS a targeted test", () => {
    expect(runGuard(SUITE, "./scripts/run-tests.sh")).toBe(true);
    expect(runGuard(SUITE, "make test")).toBe(true);
    expect(runGuard(SUITE, "npm test")).toBe(true);
    expect(runGuard(SUITE, "uv run --extra dev pytest")).toBe(true); // bare pytest = whole suite
    expect(runGuard(SUITE, "cd /w && ./scripts/run-tests.sh")).toBe(true); // compound: caught (glob missed this)
    // allowed:
    expect(runGuard(SUITE, "./scripts/run-tests.sh tests/step_defs/test_S2.py")).toBe(false);
    expect(runGuard(SUITE, "uv run --env-file .env pytest tests/step_defs/test_S2.py::scenario")).toBe(false);
    expect(runGuard(SUITE, "make migrate")).toBe(false);
    expect(runGuard(SUITE, "ls tests/")).toBe(false); // suite-only hook does NOT block scanning
  });

  it("scan: DENIES ls/find/grep even inside `cd && …` and pipes (the deny-glob blind spot)", () => {
    expect(runGuard(SCAN, "ls app/")).toBe(true);
    expect(runGuard(SCAN, "cd /w && ls tests/step_defs/")).toBe(true); // compound – the case globs miss
    expect(runGuard(SCAN, "find . -name '*.py'")).toBe(true);
    expect(runGuard(SCAN, "uv run pytest x.py 2>&1 | grep PASSED")).toBe(true); // piped grep – caught
    // allowed: a normal command is not scanning
    expect(runGuard(SCAN, "uv run --env-file .env pytest tests/step_defs/test_S2.py")).toBe(false);
    expect(runGuard(SCAN, "cat app/models.py")).toBe(false);
    expect(runGuard(SCAN, "./scripts/run-tests.sh")).toBe(false); // scan-only hook does NOT block the suite
  });

  it("does not block an unparseable command (never fail-closed on our own parse error)", () => {
    const hookPath = join(root, "guard-parse.py");
    writeFileSync(hookPath, guardHookScript({ suite: true, scan: true }));
    const out = execFileSync("python3", [hookPath], { input: "not json" }).toString();
    expect(/"deny"/.test(out)).toBe(false);
  });
});

describe("S2 migration re-pin bundle: well-formed (the thrashing-turn pin)", () => {
  const B = "tests/integration/live/driver-green-setup-s2";
  const REF = "consort/evaluation/reference-assets/stockflow/next-step/driver-green-s2";
  const repo = join(__dirname, "..", "..");
  const has = (p: string) => existsSync(join(repo, p));

  it("code-assets carries the S2 post-RED tree INCLUDING the failing drop-combined test", () => {
    expect(has(`${B}/code-assets/app`)).toBe(true);
    expect(has(`${B}/code-assets/alembic`)).toBe(true);
    expect(has(`${B}/code-assets/tests/step_defs/test_S2_drop_combined_code.py`)).toBe(true); // the RED test to green
    expect(has(`${B}/code-assets/tests/features/S2-drop-combined-code.feature`)).toBe(true);
  });

  it("design carries the feature artifacts + the target AC + the layout", () => {
    for (const f of ["architecture.json", "db-design.json", "test-list.json", "architecture/conventions.json"]) {
      expect(has(`${B}/design/${f}`)).toBe(true);
    }
    expect(has(`${B}/design/stories/S2-drop-combined-code/acs/AC1-column-dropped.json`)).toBe(true);
  });

  it("the judge reference is the SAME-STEP evaluation – 003-navigator-assess's REGRESSION determination", () => {
    // The reference is how the corpus evaluated THIS step: the navigator turn after the S2 driver-green
    // (003-navigator-assess) determined a regression (drop left code referencing the dropped column). It
    // must parse as classification "regression" (fixDirective present, schema-modernized on curation), so
    // a candidate that reproduces the regression scores SAME. NOT superseded-tests.json (a later, different
    // step). See consort/optimize/DRIVER-GREEN-LEVERS.md + curate-driver-green-s2.sh.
    expect(has(`${REF}/regression-assessment.json`)).toBe(true);
    expect(has(`${REF}/superseded-tests.json`)).toBe(false); // ONLY the regression file, else it'd parse as superseded-shift
    const reg = JSON.parse(readFileSync(join(repo, REF, "regression-assessment.json"), "utf8"));
    expect(typeof reg.diagnosis).toBe("string");
    // The repair directive that classifies this as a regression. The reference is byte-faithful to the
    // kit-recorded 003 (key `fix`); parseNavigatorAssessMarker accepts `fix` as an alias for `fixDirective`.
    const directive = reg.fixDirective ?? reg.fix;
    expect(typeof directive).toBe("string");
    expect(directive.length).toBeGreaterThan(0);
  });

  it("run-config pins the S2 story", () => {
    const rc = JSON.parse(readFileSync(join(repo, B, "driver-green.run.json"), "utf8"));
    expect(JSON.stringify(rc)).toMatch(/S2-drop-combined-code/);
  });
});

describe("LIVE dispatch (mock step executor): levers reach the driver turn", () => {
  it("the agent receives a prompt with the ctx sections, and runs in a workspace carrying the enforcement files", async () => {
    const consortDir = join(root, ".consort");
    mkdirSync(consortDir, { recursive: true });
    const featureId = "F6-x";
    const story = "S2-drop-combined-code";

    // Apply the enforce-all levers: writes .claude/settings.json (composed guard hook) + the ctx marker.
    const applied = applyDriverLevers(
      root,
      { guardSuite: true, guardScan: true, ctxPack: ["db-state", "failing-test"] },
      consortDir,
    );
    // Enforcement artifacts are present in the workspace the agent will run in.
    expect(existsSync(applied.hookPath!)).toBe(true);
    const hook = readFileSync(applied.hookPath!, "utf8");
    expect(hook).toMatch(/SUITE = True/);
    expect(hook).toMatch(/SCAN = True/);

    // The prompt the orchestrator sources for the driver turn – the context pack, with the marker
    // (written by applyDriverLevers) turning the ctx sections on, readers injected for hermeticity.
    const prompt = buildContextPack(consortDir, featureId, story, "", {
      dbStateReader: () => ({ current: "20260811000000", heads: "20260811000002" }),
      failingTestReader: () => "def test_column_dropped():\n    assert True\n",
    });
    expect(prompt).toMatch(/DB STATE/);
    expect(prompt).toMatch(/FAILING TEST/);

    // A mock StepAgent (the SAME seam ClaudeStepAgent implements): capture what the turn receives,
    // and materialize the driver-green outputs (app/ source + agent-log) so the step validates.
    let seen: AgentInvocation | undefined;
    const agent: StepAgent = {
      async invoke(inv) {
        seen = inv;
        mkdirSync(join(inv.workspaceDir, "app"), { recursive: true });
        writeFileSync(join(inv.workspaceDir, "app", "main.py"), "def x():\n    return 1\n");
        writeFileSync(
          join(inv.workspaceDir, "agent-log.jsonl"),
          JSON.stringify({ timestamp: "2026-08-17T00:00:00Z", level: "info", role: "driver", event: "artifact.written", message: "wrote app" }) + "\n",
        );
      },
    };

    const action: WorkflowAction = { kind: "invoke-role", role: "driver", story } as WorkflowAction;
    const manifest = manifestForAction(action);
    expect(manifest).toBeTruthy();
    const step = new Step(manifest!, agent);

    const ctx: StepCtx = {
      action,
      cfg: { projectDir: root, consortDir, featureId } as StepCtx["cfg"],
      state: { phase: "feature" } as unknown as DriveState,
      validateBoundDeps: {
        allowed: () => ({ kind: "state-derived" }) as unknown as WorkflowAction,
        reviseBudgetAvailable: () => true,
        recordRetry: () => ({ sanctioned: true }),
      },
    };
    const deps: StepExecutorDeps = {
      resolveInputs: () => ({ "test-list": JSON.stringify({ tests: [] }) }),
      provisionWorkspace: () => ({ workspaceDir: root }),
      instructionsFor: () => ({ prompt }),
    };

    const result = await execute(step, ctx, deps);

    // The turn dispatched with the levered prompt, and produced without violations.
    expect(seen).toBeTruthy();
    expect(seen!.instructions.prompt).toBe(prompt);
    expect(seen!.instructions.prompt).toMatch(/DB STATE/);
    expect(seen!.instructions.prompt).toMatch(/FAILING TEST/);
    expect(seen!.workspaceDir).toBe(root);
    expect(existsSync(join(seen!.workspaceDir, ".claude", "settings.json"))).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
