// run-config loader: reads an orchestration run-config JSON and resolves ${ENV:-default}
// markers against process.env, so the shipped config carries DEFAULTS anyone can override by
// setting the named env var. Types are coerced (tiers -> number, "true"/"false" -> boolean)
// so the resolved config is a real OrchestrationRunConfig + lifecycle configs. Secrets are
// NEVER in the file , they arrive via env (DATABRICKS_HOST, tokens) at run time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveEnvTemplate, loadRunConfig } from "../../consort/orchestrator/runners/run-config-loader";

let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
});

describe("resolveEnvTemplate", () => {
  it("returns the default when the env var is unset", () => {
    setEnv("DEMO_X", undefined);
    expect(resolveEnvTemplate("${DEMO_X:-fallback}")).toBe("fallback");
  });
  it("returns the env value when set (override)", () => {
    setEnv("DEMO_X", "override");
    expect(resolveEnvTemplate("${DEMO_X:-fallback}")).toBe("override");
  });
  it("leaves a plain string untouched", () => {
    expect(resolveEnvTemplate("plain")).toBe("plain");
  });
  it("throws loud on ${VAR} with no default when VAR is unset", () => {
    setEnv("DEMO_REQ", undefined);
    expect(() => resolveEnvTemplate("${DEMO_REQ}")).toThrow(/DEMO_REQ|required|unset/i);
  });
});

describe("loadRunConfig: resolves markers + coerces types", () => {
  it("resolves ${ENV:-default} throughout + coerces tiers to number and booleans", () => {
    setEnv("DATABRICKS_HOST", undefined);
    setEnv("STOCKFLOW_DEMO_GH_OWNER", "someone-else");
    setEnv("STOCKFLOW_DEMO_TIERS", undefined);
    writeFileSync(
      join(dir, "demo.run.json"),
      JSON.stringify({
        id: "demo",
        setup: {
          kind: "scaffold-project",
          config: {
            projectName: "${STOCKFLOW_DEMO_PROJECT:-stockflow-demo}",
            databricksHost: "${DATABRICKS_HOST:-https://default.cloud.databricks.com}",
            githubOwner: "${STOCKFLOW_DEMO_GH_OWNER:-kevin-hartman}",
            tiers: "${STOCKFLOW_DEMO_TIERS:-1}",
            uiTrack: "${STOCKFLOW_DEMO_UI:-true}",
          },
        },
        start: { kind: "invoke-role", role: "product-owner", mode: "author-requests" },
        teardown: { kind: "remove-project", config: {} },
      }),
    );

    const cfg = loadRunConfig(join(dir, "demo.run.json"));
    expect(cfg.id).toBe("demo");
    const c = cfg.setup!.config as Record<string, unknown>;
    expect(c.projectName).toBe("stockflow-demo"); // default (env unset)
    expect(c.databricksHost).toBe("https://default.cloud.databricks.com"); // default
    expect(c.githubOwner).toBe("someone-else"); // env override
    expect(c.tiers).toBe(1); // coerced number, not "1"
    expect(c.uiTrack).toBe(true); // coerced boolean, not "true"
    expect(cfg.teardown?.kind).toBe("remove-project");
    expect(cfg.start).toEqual({ kind: "invoke-role", role: "product-owner", mode: "author-requests" });
  });

  // (The "loads the shipped stockflow-demo.run.json" guard moved to consort-examples
  //  with the corpus run.json it loads.)

  it("expands the {{TS}} token to a compact timestamp (collision-free default names)", () => {
    setEnv("DEMO_NAME", undefined);
    const r = String(resolveEnvTemplate("${DEMO_NAME:-proj-{{TS}}}"));
    // resolveEnvTemplate returns the raw default; loadRunConfig's coercion expands {{TS}}.
    expect(r).toBe("proj-{{TS}}");
    // via the loader (which coerces + expands):
    writeFileSync(join(dir, "ts.run.json"), JSON.stringify({ id: "t", start: { kind: "done" }, setup: { kind: "scaffold-project", config: { projectName: "${DEMO_NAME:-proj-{{TS}}}" } } }));
    const cfg = loadRunConfig(join(dir, "ts.run.json"));
    expect(String((cfg.setup!.config as Record<string, unknown>).projectName)).toMatch(/^proj-\d{8}-\d{6}$/);
  });
});
