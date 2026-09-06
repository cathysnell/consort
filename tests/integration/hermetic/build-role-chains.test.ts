// HERMETIC guard for the per-role BUILD-turn LIVE chains (runs under `npm test`, no live agent).
// The build-lane sibling of design-role-chains.test.ts: each chain dir under
// tests/integration/manifests/<role>-chain/ is a lean 2-turn pair – a REPLAY seed that overlays
// the recorded PRE-turn state (a CODE TREE via a "tree" seed, + any markers/design artifacts as
// "file" seeds) then routes to the LIVE build role (a `claude` navigator). This proves, WITHOUT
// spawning a model, that:
//   1. every chain manifest conforms to the step-manifest schema,
//   2. the seed is `replay` and the build step is `claude` + the declared build role,
//   3. the chain holds (the seed's produced files satisfy the live role's declared inputs),
//   4. the seed routes from the PO seed action to the live BUILD action,
//   5. every declared seed source (file OR tree) exists in the recorded corpus on disk, and
//   6. every output validator resolves in the registry.
// The live execution is exercised by ../live/navigator-*-live.test.ts (gated on RUN_LIVE_STEP).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadStepManifests, manifestForAction, validateStepManifest } from "../../../consort/orchestrator/steps/manifest";
import { resolveValidator } from "../../../consort/orchestrator/validators/conformance/validator-registry";
import { BUILD_ROLE_CHAINS, BUILD_PO_SEED, BUILD_CORPUS_REL } from "../../../consort/optimize/build-role-chains";
import type { WorkflowAction } from "../../../consort/orchestrator/drive/orchestrator-drive";

const KIT = process.cwd();
const MANIFESTS = join(KIT, "tests/integration/manifests");
const CORPUS = join(KIT, BUILD_CORPUS_REL);

// Each build chain: its dir + the live build role it exercises. Ids are <dir>-seed / <dir>-live.
const CHAINS = Object.values(BUILD_ROLE_CHAINS).map((c) => ({ dir: c.dir, liveRole: "navigator", start: c.start }));

describe.each(CHAINS)("build-role LIVE chain: $dir", ({ dir, liveRole, start }) => {
  const seedId = `${dir}-seed`;
  const liveId = `${dir}-live`;
  const manifests = loadStepManifests(join(MANIFESTS, dir));
  const seed = manifests.find((m) => m.id === seedId)!;
  const live = manifests.find((m) => m.id === liveId)!;

  it("loads exactly the seed + live-role pair", () => {
    expect(manifests.map((m) => m.id).sort()).toEqual([seedId, liveId].sort());
  });

  it("every manifest conforms to the step-manifest schema", () => {
    for (const m of manifests) expect(validateStepManifest(m)).toEqual({ ok: true, violations: [] });
  });

  it("the seed is a `replay` agent; the build step is a `claude` (live) agent of the build role", () => {
    expect(seed.agent?.kind).toBe("replay");
    expect(live.agent?.kind).toBe("claude");
    expect(live.role).toBe(liveRole);
  });

  it("the seed routes from the PO seed action to the live BUILD action (the 2-turn chain)", () => {
    const first = manifestForAction(BUILD_PO_SEED, manifests);
    expect(first?.id).toBe(seedId);
    const second = manifestForAction(start, manifests);
    expect(second?.id).toBe(liveId);
  });

  it("the seed produces every file the live role declares as an input (the chain holds)", () => {
    const produced = new Set(seed.outputs.map((o) => o.filename));
    for (const input of live.inputs) {
      const file = input.source.replace(/^feature:/, "");
      expect(produced.has(file), `live input "${input.id}" (${file}) is not produced by the seed`).toBe(true);
    }
  });

  it("every replay seed source (file OR tree) exists in the recorded corpus on disk", () => {
    const seeds = (seed.agent!.config.seeds as { from: string; kind?: string }[]) ?? [];
    expect(seeds.length).toBeGreaterThan(0);
    // At least one TREE seed (the pre-turn code overlay) – the build-lane distinction.
    expect(seeds.some((s) => s.kind === "tree")).toBe(true);
    for (const s of seeds) {
      expect(existsSync(join(CORPUS, s.from)), `recorded seed missing: ${s.from}`).toBe(true);
    }
  });

  it("every output validator resolves in the registry (no manifest typo)", () => {
    for (const m of [seed, live]) {
      for (const o of m.outputs) expect(typeof resolveValidator(o.validator)).toBe("function");
    }
  });
});

// Every BUILD chain must be able to reference a recorded-build code baseline for its story – the
// functional/discriminator gate scores against it. Assert the story's recorded-build turns dir is
// on disk, so a chain added without a baseline fails a test rather than scoring silently.
describe("per-build-role chain: the recorded-build story baseline exists", () => {
  it("F6/S3 recorded-build turns are present (the functional/discriminator reference)", () => {
    const turns = join(CORPUS, "recorded-build/features/F6-split-tracking-code/stories/S3-stock-shows-split-fields/turns");
    expect(existsSync(turns), `missing recorded-build baseline at ${turns}`).toBe(true);
  });
});

// FIDELITY: the assess chain must seed the DETERMINISTIC failed-GREEN marker (the orchestrator's
// pre-localized supersededTestRefs written BEFORE dispatch), NOT a later navigator-assessed marker
// (which adds diagnosis/fixDirective = the ANSWER). Seeding the answer would make the turn trivial +
// unfaithful; seeding the bare {assessed,summary} makes the navigator brute-force-scan (the slow
// assess-spin). Assert the seed's green-failure source is the deterministic marker: has
// supersededTestRefs, does NOT have fixDirective.
describe("navigator-assess seed uses the DETERMINISTIC green-failure (pre-localized, not the navigator's verdict)", () => {
  it("the seeded green-failure.json carries supersededTestRefs and NOT fixDirective/diagnosis", () => {
    const manifests = loadStepManifests(join(MANIFESTS, "navigator-assess-chain"));
    const seed = manifests.find((m) => m.id === "navigator-assess-chain-seed")!;
    const gfSeed = (seed.agent!.config.seeds as { outputId: string; from: string }[]).find((s) => s.outputId === "green-failure")!;
    const gf = JSON.parse(readFileSync(join(CORPUS, gfSeed.from), "utf8")) as Record<string, unknown>;
    expect(gf.assessed).toBe(false); // pre-navigator (a navigator-assessed marker sets assessed:true)
    expect(typeof gf.supersededTestRefs, "the deterministic gate's pre-localization must be present").toBe("string");
    expect("fixDirective" in gf, "must NOT seed the navigator's own verdict (fixDirective)").toBe(false);
    expect("diagnosis" in gf, "must NOT seed the navigator's own verdict (diagnosis)").toBe(false);
  });
});
