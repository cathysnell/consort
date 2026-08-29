// exportConsortVersionEnv stamps CONSORT_VERSION so the substrate labels the Postgres
// connections a Consort run opens as `consort/<version>` (scm-utils reads this env in
// connectionApplicationName; without it a connection is `scm-utils/<version>`). Consort
// entry points (drive, create-project, adopt) call it before any substrate connection.
// The version is injected here so the test does not depend on resolveKitRoot (which is
// dist-calibrated and reads "unknown" under tsx-from-source).

import { describe, it, expect, afterEach } from "vitest";
import { exportConsortVersionEnv } from "../../consort/config/kit-bin.js";

describe("exportConsortVersionEnv", () => {
  const prev = process.env.CONSORT_VERSION;
  afterEach(() => {
    if (prev === undefined) delete process.env.CONSORT_VERSION;
    else process.env.CONSORT_VERSION = prev;
  });

  it("sets CONSORT_VERSION to the kit version when unset", () => {
    delete process.env.CONSORT_VERSION;
    exportConsortVersionEnv("0.3.59");
    expect(process.env.CONSORT_VERSION).toBe("0.3.59");
  });

  it("does NOT overwrite an already-set CONSORT_VERSION (an outer run's version wins)", () => {
    process.env.CONSORT_VERSION = "9.9.9-outer";
    exportConsortVersionEnv("0.3.59");
    expect(process.env.CONSORT_VERSION).toBe("9.9.9-outer");
  });

  it("does NOT set CONSORT_VERSION when the version is unresolved ('unknown')", () => {
    delete process.env.CONSORT_VERSION;
    exportConsortVersionEnv("unknown");
    expect(process.env.CONSORT_VERSION).toBeUndefined();
  });
});
