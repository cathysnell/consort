// Guard for the language-aware build lane (#1 root-cause fix).
//
// create-project accepts `--language nodejs` and scaffolds an idiomatic node tree (src/ + client/,
// .ts/.tsx/.js), but the build-lane produced-path declaration + validators + candidate reader were
// hardwired to the python convention (app/ + .py) with no language branch, so the kit scaffolded a
// node project it could never GREEN (driver GREEN "wrote no app/ tree"; .js tests unrecognized).
//
// This guard pins the fix: with the project's persisted language = nodejs, the product dir resolves
// to src/ and .ts/.tsx/.js are recognized; python/java/kotlin keep app/ + .py (the java default),
// so existing projects are unchanged.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputPathsForAction } from "../../consort/orchestrator/drive/executor-dispatch.js";
import { driverCodePresent, navigatorTestsAuthored } from "../../consort/orchestrator/validators/conformance/validator-registry.js";
import { readCandidateBuildOutput } from "../../consort/evaluation/semantic-gate.js";
import { defaultConsortConfig, writeConsortConfig, type ProjectLanguage } from "../../consort/config/consort-config-file.js";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive.js";

const DRIVER: WorkflowAction = { kind: "invoke-role", role: "driver", story: "S1-x" };

let projectDir: string;
function scaffoldWithLanguage(language: ProjectLanguage): void {
  const cfg = defaultConsortConfig();
  cfg.project = { ...cfg.project!, language };
  writeConsortConfig(projectDir, cfg, { force: true });
}
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lang-build-lane-"));
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe("build lane is language-aware (nodejs -> src/ + .ts/.tsx/.js; else app/ + .py)", () => {
  it("driver GREEN produced dir follows the language: nodejs -> src, python -> app", () => {
    const consortDir = join(projectDir, ".lakebase");
    scaffoldWithLanguage("nodejs");
    expect(outputPathsForAction(DRIVER, consortDir, "F1-x", projectDir).code).toBe("src");
    scaffoldWithLanguage("python");
    expect(outputPathsForAction(DRIVER, consortDir, "F1-x", projectDir).code).toBe("app");
  });

  it("driver GREEN with no projectDir stays 'app' (legacy caller, unchanged)", () => {
    const consortDir = join(projectDir, ".lakebase");
    expect(outputPathsForAction(DRIVER, consortDir, "F1-x").code).toBe("app");
  });

  it("driverCodePresent passes on a nodejs src/ tree with a .ts source file", () => {
    scaffoldWithLanguage("nodejs");
    const src = join(projectDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "server.ts"), "export const x = 1;\n");
    expect(driverCodePresent(src).ok).toBe(true);
  });

  it("navigatorTestsAuthored recognizes a .js test file (nodejs scaffold)", () => {
    const tests = join(projectDir, "tests");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "stock.test.js"), "test('x', () => {});\n");
    expect(navigatorTestsAuthored(tests).ok).toBe(true);
  });

  it("readCandidateBuildOutput reads the nodejs product tree (src/, .ts)", () => {
    scaffoldWithLanguage("nodejs");
    const src = join(projectDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "domain.ts"), "export const q = 42;\n");
    expect(readCandidateBuildOutput({ projectDir, kind: "code" })).toContain("q = 42");
  });

  it("no regression: a python project keeps app/ + .py for product code", () => {
    scaffoldWithLanguage("python");
    const app = join(projectDir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "main.py"), "x = 1\n");
    expect(readCandidateBuildOutput({ projectDir, kind: "code" })).toContain("x = 1");
    expect(driverCodePresent(app).ok).toBe(true);
  });
});
