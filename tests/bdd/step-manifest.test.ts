// step-manifest: a per-step JSON manifest is the DATA face of a step – its logical
// inputs, its outputs (+ validator NAMES), its routing map, its agent levers, and any
// post-turn CLIs. The Template Method (StepExecutor) reads the manifest to drive the
// fixed phases; only validator fn bodies + the agent spawn stay code. This slice pins the
// schema (shape) + the loader (indexing an action -> its single manifest, rejecting an
// ambiguous overlap). Resolving a validator NAME to its fn is the registry's job (Slice 1),
// so an unknown validator name is validated THERE, not here.

import { describe, it, expect } from "vitest";
import {
  validateStepManifest,
  SHIPPED_MANIFESTS,
  manifestForAction,
  matchesAction,
  agentOptionsForStep,
} from "../../consort/orchestrator/steps/manifest";
import type { StepManifest } from "../../consort/orchestrator/steps/manifest";
import type { WorkflowAction } from "../../consort/orchestrator/drive/orchestrator-drive";
import { turnKeyForAction } from "../../consort/orchestrator/drive/turn-key";

/** A minimal, shape-conformant manifest builder for negative tests. */
function manifest(over: Partial<StepManifest> = {}): StepManifest {
  return {
    id: "spec-author-breakdown",
    role: "spec-author",
    match: { kind: "invoke-role", role: "spec-author", mode: "breakdown" },
    inputs: [
      { id: "product-overview", source: "feature:product-overview.md", description: "PO product overview" },
      { id: "nfrs", source: "feature:nfrs.md", description: "PO NFRs" },
      { id: "feature-request", source: "feature:feature-request.md", description: "PO feature request" },
    ],
    outputs: [
      { id: "feature-spec", filename: "feature-spec.json", validator: "featureSpecNonEmptyStories" },
      { id: "agent-log", filename: "agent-log.jsonl", validator: "agentLogHasRoleEvent" },
    ],
    routing: { produced: { next: { kind: "design-complete" } } },
    agentOptions: { model: "sonnet", effort: "low", session: "fresh", resumeKeyFrom: "role" },
    ...over,
  } as StepManifest;
}

const BREAKDOWN: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "breakdown" };

describe("step-manifest schema (shape)", () => {
  it("accepts a fully-formed breakdown manifest", () => {
    const r = validateStepManifest(manifest());
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it("rejects a manifest missing a required top-level field (bad shape)", () => {
    const { role: _omit, ...noRole } = manifest();
    const r = validateStepManifest(noRole as unknown as StepManifest);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/role/i);
  });

  it("rejects an output missing its validator name (every output ships a validator)", () => {
    const bad = manifest({
      outputs: [{ id: "feature-spec", filename: "feature-spec.json" } as never],
    });
    const r = validateStepManifest(bad);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/validator/i);
  });

  it("rejects an input missing its .sftdd source", () => {
    const bad = manifest({
      inputs: [{ id: "product-overview", description: "x" } as never],
    });
    const r = validateStepManifest(bad);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/source/i);
  });

  it("rejects an unknown extra top-level field (additionalProperties:false)", () => {
    const r = validateStepManifest(manifest({ bogus: 1 } as never));
    expect(r.ok).toBe(false);
  });
});

describe("step-manifest loader: the shipped manifests are inlined + validate", () => {
  it("every SHIPPED manifest (inlined via JSON import) conforms to the schema", () => {
    expect(SHIPPED_MANIFESTS.length).toBeGreaterThanOrEqual(1);
    for (const m of SHIPPED_MANIFESTS) {
      expect(validateStepManifest(m)).toEqual({ ok: true, violations: [] });
    }
  });

  it("ships the spec-author-breakdown manifest", () => {
    const ids = SHIPPED_MANIFESTS.map((m) => m.id);
    expect(ids).toContain("spec-author-breakdown");
  });
});

describe("step-manifest matchesAction (strict subset-match)", () => {
  it("matches when every match field equals the action's field", () => {
    expect(matchesAction(manifest().match, BREAKDOWN)).toBe(true);
  });

  it("does NOT match when a match field differs", () => {
    const propose: WorkflowAction = { kind: "invoke-role", role: "spec-author", mode: "propose" };
    expect(matchesAction(manifest().match, propose)).toBe(false);
  });

  it("does NOT match a different action kind", () => {
    expect(matchesAction(manifest().match, { kind: "planning-complete" } as WorkflowAction)).toBe(false);
  });

  it("a coarser match (kind only) matches any action of that kind", () => {
    const coarse = { kind: "invoke-role" };
    const anyInvoke: WorkflowAction = { kind: "invoke-role", role: "driver", story: "S1" } as WorkflowAction;
    expect(matchesAction(coarse, anyInvoke)).toBe(true);
  });
});

describe("step-manifest manifestForAction (single-match, rejects ambiguity)", () => {
  it("returns the single manifest matching an action", () => {
    const m = manifestForAction(BREAKDOWN, [manifest()]);
    expect(m?.id).toBe("spec-author-breakdown");
  });

  it("returns undefined when no manifest matches", () => {
    const m = manifestForAction({ kind: "planning-complete" } as WorkflowAction, [manifest()]);
    expect(m).toBeUndefined();
  });

  it("THROWS loud when two manifests match the same action (ambiguous overlap)", () => {
    const a = manifest({ id: "a" });
    const b = manifest({ id: "b" }); // same match => both hit BREAKDOWN
    expect(() => manifestForAction(BREAKDOWN, [a, b])).toThrow(/ambiguous|multiple|a.*b|b.*a/i);
  });

  it("uses the shipped manifests when no explicit list is passed", () => {
    const m = manifestForAction(BREAKDOWN);
    expect(m?.id).toBe("spec-author-breakdown");
  });
});

describe("agentOptionsForStep (per-step config-directory layer for the resolver)", () => {
  it("returns the declared model/effort for a (role, turnKey) from the shipped manifests", () => {
    // spec-author breakdown = sonnet+low (haiku was the optimize sweep's speed winner, but it
    // malformed the story schema — jamming the As-a/I-want/So-that narrative into a single asA and
    // leaving the gate-required iWantTo/soThat empty — so the shipped model is sonnet).
    expect(agentOptionsForStep("spec-author", "breakdown", turnKeyForAction)).toEqual({ model: "sonnet", effort: "low" });
    // navigator review = sonnet+low (the former defaultEffort entry, now declared).
    expect(agentOptionsForStep("navigator", "review", turnKeyForAction)).toEqual({ model: "sonnet", effort: "low" });
    // driver refactor = opus (the driver-refactor tuning winner: fastest 2/3 clean-holder), default effort.
    expect(agentOptionsForStep("driver", "refactor", turnKeyForAction)).toEqual({ model: "opus", effort: "default" });
  });

  it("returns undefined for a (role, turnKey) no shipped manifest declares", () => {
    expect(agentOptionsForStep("navigator", "red", turnKeyForAction)).toBeDefined(); // navigator-red exists
    expect(agentOptionsForStep("product-owner", "breakdown", turnKeyForAction)).toBeUndefined();
    expect(agentOptionsForStep("spec-author", undefined, turnKeyForAction)).toBeUndefined();
  });

  it("collapsed buildModes resolve ONE lever set (the three assess* share the assess key)", () => {
    // assess / assess-deploy / assess-refactor all map to turnKey "assess"; their manifests must
    // agree, so the lookup returns a single {model,effort} without throwing. All three carry the
    // applied optimize winner (opus – the regression-fidelity panel: opus holds the assessment and is
    // ~18% faster than the sonnet default on the heavy regression-assess variant).
    expect(agentOptionsForStep("navigator", "assess", turnKeyForAction)).toEqual({ model: "opus", effort: "default" });
    // driver refactor / refactor-deploy / refactor-superseded all carry the tuning winner (opus) – they must
    // agree so the collapsed lookup returns one lever set without throwing.
    expect(agentOptionsForStep("driver", "refactor", turnKeyForAction)).toEqual({ model: "opus", effort: "default" });
  });

  it("THROWS when two manifests for the same resolved (role, turnKey) declare different levers", () => {
    // Two navigator "review" manifests disagreeing on effort – a manifest-authoring bug the
    // resolver must not silently paper over.
    const a = { role: "navigator", match: { kind: "invoke-role", role: "navigator", buildMode: "review" }, agentOptions: { model: "sonnet", effort: "low" } } as unknown as StepManifest;
    const b = { role: "navigator", match: { kind: "invoke-role", role: "navigator", buildMode: "review" }, agentOptions: { model: "sonnet", effort: "high" } } as unknown as StepManifest;
    expect(() => agentOptionsForStep("navigator", "review", turnKeyForAction, [a, b])).toThrow(/conflicting agentOptions/i);
  });
});
