// P2b optimize-gate: the design-handoff gate evaluator. It answers "did this
// candidate's artifact pass the SAME check the baseline passed?" by reusing the
// kit's own gates VERBATIM – the role self-check (formatRoleResponse) AND the
// design gate (resolveArtifactInputs). A candidate can never pass a weaker check
// than baseline: both must be clean for the trial to count. Pure (reads the
// .sftdd), hermetic. Build-turn gating is the honest-GREEN cycle result, produced
// by the trial runner, not this evaluator.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateDesignGate, gateForDesignHandoff } from "../../consort/optimize/optimize-gate";

let consortDir: string;
const featureId = "F1";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "optimize-gate-"));
  consortDir = join(root, ".sftdd");
  mkdirSync(consortDir, { recursive: true });
});
afterEach(() => {
  rmSync(join(consortDir, ".."), { recursive: true, force: true });
});

describe("gateForDesignHandoff: role -> (selfCheck role, gate name)", () => {
  it("maps the design roles to their gate", () => {
    expect(gateForDesignHandoff({ role: "spec-author", story: "S1" })?.gate).toBe("spec");
    expect(gateForDesignHandoff({ role: "test-strategist", story: "S1" })?.gate).toBe("test_list");
    // architect-reviewer feeds the spec gate's architecture conformance; it has a
    // self-check but resolves through the spec gate inputs.
    expect(gateForDesignHandoff({ role: "architect-reviewer", story: "S1" })?.selfCheckRole).toBe("architect-reviewer");
  });

  it("returns null for a build turn (navigator/driver) – not a design gate", () => {
    expect(gateForDesignHandoff({ role: "driver", story: "S1", buildMode: "green" })).toBeNull();
    expect(gateForDesignHandoff({ role: "navigator", story: "S1", buildMode: "review" })).toBeNull();
  });
});

describe("evaluateDesignGate", () => {
  it("FAILS when the role self-check finds violations (missing artifact)", () => {
    // No acs/ written => spec-author self-check fails.
    const r = evaluateDesignGate({ consortDir, featureId, handoff: { role: "spec-author", story: "S1" } });
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("PASSES the per-turn bar when the role self-check is clean (>=1 conformant AC)", () => {
    // A single conformant AC satisfies the per-story spec-author self-check – the
    // SAME bar the drive's verify-artifact step enforces after the turn.
    const acDir = join(consortDir, "features", featureId, "stories", "S1", "acs");
    mkdirSync(acDir, { recursive: true });
    writeFileSync(
      join(acDir, "AC1.json"),
      JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
    );
    const r = evaluateDesignGate({ consortDir, featureId, handoff: { role: "spec-author", story: "S1" } });
    expect(r.passed).toBe(true);
  });

  it("with requireGate, ALSO enforces the stricter feature-scope milestone gate", () => {
    // Self-check passes (one conformant AC) but the whole-feature spec gate needs
    // feature-spec.json/md, which are absent – so requireGate blocks it.
    const acDir = join(consortDir, "features", featureId, "stories", "S1", "acs");
    mkdirSync(acDir, { recursive: true });
    writeFileSync(
      join(acDir, "AC1.json"),
      JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
    );
    const r = evaluateDesignGate({ consortDir, featureId, handoff: { role: "spec-author", story: "S1" }, requireGate: true });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/gate spec/);
  });
});
