// Single-source guard: the step-manifest `agentOptions` IS the per-turn config home, so for every
// shipped manifest, agentOptions.{model,effort} must equal what resolveConsortSettings() resolves for
// the same action at the DEFAULT precedence (no project consort-config.json). defaultConsortConfig no
// longer bakes per-turn model/effort and there is no overlay file, so the resolver reads the manifest
// directly – this guard therefore also proves nothing has re-introduced a file-layer copy that would
// shadow the manifest. If it goes RED, either a manifest drifted or a per-turn default crept back into
// defaultConsortConfig; fix the manifest (the one home), not this test.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_MANIFESTS } from "../../consort/orchestrator/steps/manifest";
import { resolveConsortSettings, defaultConsortConfig, writeConsortConfig } from "../../consort/orchestrator/settings/project-settings";
import { turnKeyForAction } from "../../consort/orchestrator/drive/orchestrator-effects";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";

// Reconstruct a representative action from a manifest's `match`: drop the null sentinels (they mean
// "this field must be ABSENT"), and add a story for the story-scoped roles so turnKeyForAction
// resolves to the per-story step (architect notes / dba / test-list / acs / green) rather than
// undefined.
const STORY = "S1-file-stock";
const STORY_SCOPED = new Set(["dba", "test-strategist", "driver"]);
function actionFromMatch(match: Record<string, unknown>, role: string, hasMode: boolean): WorkflowAction {
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(match)) {
    if (v === null) continue; // sentinel: field must be absent
    a[k] = v;
  }
  // Story-scoped design/build steps need a story on the action to key correctly. A role invoked
  // with a `mode` (breakdown/propose/estimate) is NOT story-scoped; the rest are.
  if ((STORY_SCOPED.has(role) || role === "spec-author" || role === "architect-reviewer") && !hasMode) {
    a.story = STORY;
  }
  return a as unknown as WorkflowAction;
}

describe("step-manifest agentOptions ≡ resolveConsortSettings (per-step config parity)", () => {
  // Resolve against what a REAL scaffolded project runs: project setup writes defaultConsortConfig()
  // (now PROJECT settings only – no per-turn model/effort) to the project consort-config.json, and the
  // drive reads THAT file, falling through to the manifest agentOptions for per-turn model/effort. So
  // seed the config exactly as scaffolding does, then resolve – the manifest agentOptions must equal
  // what the resolver returns (which, with no file-layer per-turn copy, IS the manifest).
  const proj = mkdtempSync(join(tmpdir(), "parity-scaffolded-"));
  writeConsortConfig(proj, defaultConsortConfig(), { force: true });
  const settings = resolveConsortSettings({ projectDir: proj });

  it.each(SHIPPED_MANIFESTS.map((m) => [m.id, m] as const))(
    "%s: agentOptions.{model,effort} equals the resolver's output for its action",
    (_id, manifest) => {
      const hasMode = "mode" in manifest.match && manifest.match.mode !== null;
      const action = actionFromMatch(manifest.match, manifest.role, hasMode);
      const key = turnKeyForAction(action);
      const ao = manifest.agentOptions;

      // Model: the manifest's declared model must equal what the resolver would spawn.
      expect(ao.model, `${manifest.id}: agentOptions.model vs resolver modelFor(${manifest.role}, ${key})`).toBe(
        settings.modelFor(manifest.role, key),
      );
      // Effort: same, treating an omitted agentOptions.effort as "default".
      expect(ao.effort ?? "default", `${manifest.id}: agentOptions.effort vs resolver effortFor(${manifest.role}, ${key})`).toBe(
        settings.effortFor(manifest.role, key),
      );
    },
  );
});
