// Auto-apply: the unattended champion walk bakes a winning candidate's per-turn CONFIG levers
// (model/effort) into the ONE per-turn config home – the step-manifest `agentOptions`. No overlay
// file, no TS source rewrite: the manifest the resolver + lean/replay harness already read IS the
// single source, so a win lands in exactly the manifest(s) whose (role, turnKey) it names. These
// tests cover the writer (applyWinnerToManifests) against a temp kit manifest tree, incl. that it
// preserves the hand-authored formatting (patches values in place, never reserialises).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWinnerToManifests } from "../../consort/optimize/optimize-apply";
import type { Candidate } from "../../consort/optimize/optimize-candidates";

let kitDir: string;
let manifestsDir: string;

/** Seed a compact-formatted step-manifest (role + match + agentOptions) into the temp kit. */
function seedManifest(file: string, role: string, match: Record<string, unknown>, agentOptions: Record<string, string>): void {
  const body = {
    id: file.replace(/\.json$/, ""),
    role,
    agent: { kind: "claude", config: { role } },
    match,
    agentOptions,
  };
  // Compact: single-line agent/match, agentOptions expanded one key per line (mirrors shipped style).
  const raw =
    `{\n  "id": ${JSON.stringify(body.id)},\n  "role": ${JSON.stringify(role)},\n` +
    `  "agent": { "kind": "claude", "config": { "role": ${JSON.stringify(role)} } },\n` +
    `  "match": ${JSON.stringify(match)},\n` +
    `  "agentOptions": {\n` +
    Object.entries(agentOptions).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
    `\n  }\n}\n`;
  writeFileSync(join(manifestsDir, file), raw);
}

const read = (file: string) => readFileSync(join(manifestsDir, file), "utf8");

beforeEach(() => {
  kitDir = mkdtempSync(join(tmpdir(), "auto-apply-kit-"));
  manifestsDir = join(kitDir, "consort", "orchestrator", "steps", "manifests");
  mkdirSync(manifestsDir, { recursive: true });
});
afterEach(() => rmSync(kitDir, { recursive: true, force: true }));

describe("applyWinnerToManifests: bake a per-turn config winner into the manifest agentOptions", () => {
  it("patches model+effort for the manifest whose (role, turnKey) the winner names", () => {
    seedManifest("driver-refactor.json", "driver", { kind: "invoke-role", role: "driver", buildMode: "refactor" }, { model: "opus", effort: "default", session: "resume" });
    const winner: Candidate = { id: "w", configOverrides: { roles: { driver: { model: { refactor: "haiku" }, effort: { refactor: "low" } } } } };
    expect(applyWinnerToManifests(kitDir, winner)).toBe(true);
    const m = JSON.parse(read("driver-refactor.json"));
    expect(m.agentOptions.model).toBe("haiku");
    expect(m.agentOptions.effort).toBe("low");
    expect(m.agentOptions.session).toBe("resume"); // untouched keys survive
  });

  it("patches ALL manifests sharing a collapsed turnKey (the three assess* -> assess)", () => {
    seedManifest("navigator-assess.json", "navigator", { kind: "invoke-role", role: "navigator", buildMode: "assess" }, { model: "sonnet", effort: "default" });
    seedManifest("navigator-assess-deploy.json", "navigator", { kind: "invoke-role", role: "navigator", buildMode: "assess-deploy" }, { model: "sonnet", effort: "default" });
    seedManifest("navigator-assess-refactor.json", "navigator", { kind: "invoke-role", role: "navigator", buildMode: "assess-refactor" }, { model: "sonnet", effort: "default" });
    expect(applyWinnerToManifests(kitDir, { id: "w", configOverrides: { roles: { navigator: { model: { assess: "opus" } } } } })).toBe(true);
    for (const f of ["navigator-assess.json", "navigator-assess-deploy.json", "navigator-assess-refactor.json"]) {
      expect(JSON.parse(read(f)).agentOptions.model).toBe("opus");
    }
  });

  it("a SCALAR role model applies to every manifest of that role", () => {
    seedManifest("ux-designer.json", "ux-designer", { kind: "invoke-role", role: "ux-designer" }, { model: "sonnet", effort: "default" });
    expect(applyWinnerToManifests(kitDir, { id: "w", configOverrides: { roles: { "ux-designer": { model: "opus" } } } })).toBe(true);
    expect(JSON.parse(read("ux-designer.json")).agentOptions.model).toBe("opus");
  });

  it("PRESERVES the manifest's hand-authored formatting (patches in place, no reserialise)", () => {
    seedManifest("driver-refactor.json", "driver", { kind: "invoke-role", role: "driver", buildMode: "refactor" }, { model: "opus", effort: "default" });
    const before = read("driver-refactor.json");
    applyWinnerToManifests(kitDir, { id: "w", configOverrides: { roles: { driver: { model: { refactor: "haiku" } } } } });
    const after = read("driver-refactor.json");
    // Only the model value line changed; the single-line agent/match blocks are untouched.
    expect(after).toContain(`"agent": { "kind": "claude", "config": { "role": "driver" } },`);
    expect(after).toContain(`"match": {"kind":"invoke-role","role":"driver","buildMode":"refactor"}`);
    expect(after.replace(`"model": "haiku"`, `"model": "opus"`)).toBe(before);
  });

  it("is a NO-OP for a baseline (no config overrides) winner", () => {
    seedManifest("driver-refactor.json", "driver", { kind: "invoke-role", role: "driver", buildMode: "refactor" }, { model: "opus" });
    const before = read("driver-refactor.json");
    expect(applyWinnerToManifests(kitDir, { id: "baseline", configOverrides: {} })).toBe(false);
    expect(read("driver-refactor.json")).toBe(before);
  });

  it("is IDEMPOTENT – re-applying the same winner does not rewrite the file", () => {
    seedManifest("driver-refactor.json", "driver", { kind: "invoke-role", role: "driver", buildMode: "refactor" }, { model: "opus", effort: "default" });
    const winner: Candidate = { id: "w", configOverrides: { roles: { driver: { model: { refactor: "haiku" } } } } };
    expect(applyWinnerToManifests(kitDir, winner)).toBe(true);
    const after1 = read("driver-refactor.json");
    expect(applyWinnerToManifests(kitDir, winner)).toBe(false); // no change
    expect(read("driver-refactor.json")).toBe(after1);
  });

  it("does NOT persist content-only levers (those are agent-.md, applied separately)", () => {
    seedManifest("driver-refactor.json", "driver", { kind: "invoke-role", role: "driver", buildMode: "refactor" }, { model: "opus" });
    const before = read("driver-refactor.json");
    const winner: Candidate = { id: "scan", configOverrides: {}, content: { disallowedTools: ["Grep", "Glob"], taskSuffix: "be terse" } };
    expect(applyWinnerToManifests(kitDir, winner)).toBe(false);
    expect(read("driver-refactor.json")).toBe(before);
  });
});

describe("resolveConsortSettings reads the manifest as the single per-turn source (spec-author breakdown)", () => {
  it("modelFor(spec-author, breakdown) === haiku with no project override – from the manifest, not an overlay", async () => {
    // defaultConsortConfig no longer bakes per-turn model/effort; the resolver reads the shipped
    // manifest agentOptions. This asserts the single-source wiring end-to-end on the real kit config.
    const { resolveConsortSettings, defaultConsortConfig, writeConsortConfig } = await import("../../consort/orchestrator/settings/project-settings");
    const proj = mkdtempSync(join(tmpdir(), "single-source-"));
    writeConsortConfig(proj, defaultConsortConfig(), { force: true });
    const s = resolveConsortSettings({ projectDir: proj });
    expect(s.modelFor("spec-author", "breakdown")).toBe("haiku");
    expect(s.effortFor("spec-author", "breakdown")).toBe("low");
    rmSync(proj, { recursive: true, force: true });
  });
});
