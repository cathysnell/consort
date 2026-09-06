// Shared support for the per-role LIVE design + plan-lane chains. Each per-role test file
// (architect-reviewer-live.test.ts, spec-author-story-live.test.ts, dba-live.test.ts, ...) is a
// thin wrapper that names its role and calls runRoleChain(ROLE_CHAINS[<name>]) so the file stays
// a few lines. This is the ISOLATION substrate the whole manifest/chain refactor exists for:
// exercise ONE role's turn on its own (recorded inputs replayed in, the real agent authoring its
// artifact), with no full-project scaffold, so each role can be instrumented + lever-swept
// independently. NOT a .test.ts itself (no vitest include match), so importing it adds no suite.
//
// The chain CATALOGUE + runner live in the optimize family (consort/optimize/
// role-chains.ts), shared by these live tests AND the per-role sweep. This file adds only the
// TEST-side concerns: the conformance assertions + surviving/printing the turn's telemetry.
//
// LEAN – NO cloud project. Every live role is tool-scoped out of Bash (never runs ./scripts/lk)
// and reports via the agent-report channel; the chain runs in a throwaway `.sftdd` temp dir.

import { expect } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROLE_CHAINS, runRoleChainLive, MANIFESTS_REL, type RoleChain } from "../../../consort/optimize/role-chains.js";
import { loadStepManifests, type StepManifest } from "../../../consort/orchestrator/steps/manifest.js";
import { formatRoleTelemetry, writeRoleTelemetry, type RoleLevers, type RoleTelemetry } from "../../../consort/optimize/role-telemetry.js";
import type { ManifestTurn } from "../../../consort/orchestrator/runners/manifest-runner.js";

export const KIT = process.cwd();
export const MANIFESTS = join(KIT, MANIFESTS_REL);
/** Where per-role telemetry records survive the (thrown-away) workspace. Overridable via
 *  LAKEBASE_ROLE_TELEMETRY_DIR so a sweep points it at its own run dir. */
export const TELEMETRY_DIR = process.env.LAKEBASE_ROLE_TELEMETRY_DIR ?? join(KIT, ".role-telemetry");

// Re-export the shared catalogue + type so the per-role test files import them from here.
export { ROLE_CHAINS, type RoleChain };

/**
 * Run ONE role's isolated seed -> live chain end to end and assert it produced a conformant
 * artifact + terminated cleanly, then survive + print its telemetry. The chain itself is the
 * shared runRoleChainLive (default levers from the manifest, no override); this wrapper adds the
 * live test's assertions + the telemetry emit.
 */
export async function runRoleChain(chain: RoleChain): Promise<void> {
  const seedId = `${chain.dir}-seed`;
  const liveId = `${chain.dir}-live`;

  const { turns } = await runRoleChainLive(chain);

  // Both turns ran in order (seed replay, then the live role), each clean.
  expect(turns.map((t) => t.manifestId)).toEqual([seedId, liveId]);
  for (const t of turns) {
    expect(t.result.violations, `${t.manifestId}: ${t.result.violations.join("; ")}`).toEqual([]);
  }

  // The live role produced its (schema-gated) artifact at the declared path, and the chain
  // terminated cleanly (design-complete has no matching manifest in the chain).
  const liveTurn = turns[turns.length - 1];
  expect(liveTurn.manifestId).toBe(liveId);
  expect(
    liveTurn.result.producedPaths.some((p) => p.endsWith(chain.outputFile)),
    `${chain.name} produced: ${liveTurn.result.producedPaths.join(", ")}`,
  ).toBe(true);
  expect(liveTurn.result.bounded.action).toEqual({ kind: "design-complete" });

  // SURVIVE + PRINT the live turn's telemetry (the point of the isolation substrate): the
  // agent-reported num_turns/cost/tokens (why a role was slow) + the outer wall-clock + which
  // levers were in effect, from the live manifest. Best-effort – telemetry is observability,
  // never gates the assertion above.
  emitRoleTelemetry(chain, liveTurn.telemetry);
}

/** Read the live manifest's agentOptions/agent config as the levers in effect for the record. */
function leversFor(chain: RoleChain): RoleLevers & { model?: string } {
  try {
    const manifests = loadStepManifests(join(MANIFESTS, chain.dir));
    const live = manifests.find((m) => m.id === `${chain.dir}-live`);
    const cfg = (live?.agent?.config ?? {}) as Record<string, unknown>;
    const opts = live?.agentOptions ?? ({} as StepManifest["agentOptions"]);
    return {
      model: (cfg.model as string) ?? opts.model,
      effort: opts.effort,
      session: opts.session,
      resumeKeyFrom: opts.resumeKeyFrom,
      allowedTools: cfg.allowedTools as string[] | undefined,
      disallowedTools: cfg.disallowedTools as string[] | undefined,
    };
  } catch {
    return {};
  }
}

/** Build the RoleTelemetry from the live turn + persist + print it. */
function emitRoleTelemetry(chain: RoleChain, telemetry: ManifestTurn["telemetry"]): void {
  const levers = leversFor(chain);
  const usage = telemetry?.agentResult?.usage;
  const rec: RoleTelemetry = {
    role: telemetry?.role ?? chain.name,
    chain: chain.dir,
    model: levers.model,
    levers,
    outerDurationMs: telemetry?.outerDurationMs ?? 0,
    ...(usage
      ? {
          agent: {
            ...(usage.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
            ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
          },
        }
      : {}),
    outcome: "produced",
    producedFile: chain.outputFile,
    ...(telemetry?.agentResult?.finalText ? { transcript: { prompt: chain.prompt, finalText: telemetry.agentResult.finalText, tools: [] } } : {}),
  };
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    const path = writeRoleTelemetry(TELEMETRY_DIR, rec);
    // eslint-disable-next-line no-console
    console.log(formatRoleTelemetry(rec) + ` | -> ${path}`);
  } catch {
    // eslint-disable-next-line no-console
    console.log(formatRoleTelemetry(rec));
  }
}
