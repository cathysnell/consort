// The scaffolded kit-ref pin: default LAKEBASE_KIT_REF to this kit's version so a
// created project resolves an immutable, version-keyed kit cache instead of a
// mutable `main` that silently goes stale.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kitRefPin, readConsortVersion, declaredSubstrateVersion } from "../../consort/lakebase/kit-ref-pin.js";

describe("kitRefPin", () => {
  it("pins to v<version> when LAKEBASE_KIT_REF is unset", () => {
    expect(kitRefPin({}, "0.3.16")).toBe("v0.3.16");
  });

  it("leaves the ref alone (undefined) when LAKEBASE_KIT_REF is already set – explicit wins", () => {
    expect(kitRefPin({ LAKEBASE_KIT_REF: "feature-x" }, "0.3.16")).toBeUndefined();
    expect(kitRefPin({ LAKEBASE_KIT_REF: "v0.3.10" }, "0.3.16")).toBeUndefined();
  });

  it("treats a blank explicit ref as unset (still pins)", () => {
    expect(kitRefPin({ LAKEBASE_KIT_REF: "   " }, "0.3.16")).toBe("v0.3.16");
  });

  it("does NOT pin to a bare 'v' when the version is missing/blank", () => {
    expect(kitRefPin({}, undefined)).toBeUndefined();
    expect(kitRefPin({}, "")).toBeUndefined();
    expect(kitRefPin({}, "   ")).toBeUndefined();
  });
});

describe("readConsortVersion", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-ref-pin-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the consort version by walking up to the matching package.json", () => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@databricks-solutions/consort", version: "0.3.16" }),
    );
    const deep = path.join(root, "dist", "bin", "lakebase");
    fs.mkdirSync(deep, { recursive: true });
    expect(readConsortVersion(deep)).toBe("0.3.16");
  });

  it("ignores non-consort package.json files while walking up", () => {
    // a nested node_modules package.json (wrong name) must be skipped
    const nm = path.join(root, "dist", "node_modules", "some-dep");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: "some-dep", version: "9.9.9" }));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@databricks-solutions/consort", version: "0.3.16" }),
    );
    expect(readConsortVersion(nm)).toBe("0.3.16");
  });

  it("returns undefined when no matching package.json exists", () => {
    const deep = path.join(root, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    expect(readConsortVersion(deep)).toBeUndefined();
  });
});

describe("declaredSubstrateVersion", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-ref-pin-sub-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeConsort = (dep: string | undefined) =>
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@databricks-solutions/consort",
        version: "0.3.17",
        ...(dep ? { dependencies: { "@databricks-solutions/lakebase-scm-utils": dep } } : {}),
      }),
    );

  it("extracts the vX.Y.Z from a github tag spec", () => {
    writeConsort("github:databricks-solutions/lakebase-scm-utils#v0.2.3");
    expect(declaredSubstrateVersion(root)).toBe("0.2.3");
  });

  it("returns undefined for an unpinned (branch/main) spec", () => {
    writeConsort("github:databricks-solutions/lakebase-scm-utils#main");
    expect(declaredSubstrateVersion(root)).toBeUndefined();
  });

  it("returns undefined when the substrate dep is absent", () => {
    writeConsort(undefined);
    expect(declaredSubstrateVersion(root)).toBeUndefined();
  });
});
