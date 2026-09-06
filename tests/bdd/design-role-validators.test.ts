// The design-role schema-conformance validators (validator-registry): each gates a role's
// primary artifact against its canonical kit schema via checkArtifactConformance – the SAME
// truth the design gate + response self-check use. Pinned against the RECORDED F1 intake
// (conformant by construction) + a bogus artifact (rejected). These back the design-role
// integration live chains, where a real agent's output must be schema-conformant, not merely
// present.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acConformant,
  architectureConformant,
  dbDesignConformant,
  testListConformant,
  resolveValidator,
} from "../../consort/orchestrator/validators/conformance/validator-registry";

const KIT = process.cwd();
const INTAKE = join(KIT, "tests/integration/intake");
const F = "features/F1-stock-visibility";

let dir: string;
function ws(): string {
  dir = mkdtempSync(join(tmpdir(), "design-validators-"));
  return dir;
}
function tmp(name: string, contents: string): string {
  const d = ws();
  const p = join(d, name);
  writeFileSync(p, contents);
  return p;
}

describe("design-role conformance validators accept the recorded (conformant) F1 artifacts", () => {
  it("architectureConformant accepts the recorded architecture.json", () => {
    expect(architectureConformant(join(INTAKE, F, "architecture.json"))).toEqual({ ok: true, violations: [] });
  });
  it("dbDesignConformant accepts the recorded db-design.json", () => {
    expect(dbDesignConformant(join(INTAKE, F, "db-design.json"))).toEqual({ ok: true, violations: [] });
  });
  it("testListConformant accepts the recorded feature test-list.json", () => {
    expect(testListConformant(join(INTAKE, F, "test-list.json"))).toEqual({ ok: true, violations: [] });
  });
  it("acConformant accepts a recorded story AC", () => {
    expect(acConformant(join(INTAKE, F, "stories/S1-file-stock/acs/AC1-file-stock-record.json"))).toEqual({ ok: true, violations: [] });
  });
});

describe("design-role conformance validators REJECT a non-conformant artifact", () => {
  it("architectureConformant rejects an empty JSON object (missing required keys)", () => {
    const r = architectureConformant(tmp("architecture.json", "{}"));
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });
  it("testListConformant rejects invalid JSON", () => {
    const r = testListConformant(tmp("test-list.json", "not json"));
    expect(r.ok).toBe(false);
  });
  it("reports not-readable when the path is missing", () => {
    const r = dbDesignConformant(join(ws(), "does-not-exist.json"));
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/not readable/i);
  });
});

describe("the new validators are in the registry (resolvable by name)", () => {
  it("resolveValidator returns each design-role conformance validator", () => {
    for (const name of ["acConformant", "architectureConformant", "dbDesignConformant", "testListConformant"]) {
      expect(typeof resolveValidator(name)).toBe("function");
    }
  });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
