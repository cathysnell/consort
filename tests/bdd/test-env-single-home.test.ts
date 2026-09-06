// Guard: the live-test workspace host is configured in ONE home (.env.local.test.config, read via
// consort/orchestrator/provisioning/test-env.ts). This test is the anti-recurrence gate for #595 – it fails if the
// private workspace host literal creeps back into TEST source or a test config as a hardcoded value,
// which is exactly the scatter the consolidation removed. Allowed occurrences (NOT test config):
//   - .env.local.test.config          the single home (gitignored; the real value lives here)
//   - .env.template.test.config       documents the knob (host shown only as a commented example)
//   - examples/**                     runnable DEMOS with self-contained ${:-default} recipes +
//                                     recorded corpus .env.example (captured app data, not config)
//   - consort/evaluation/reference-assets/stockflow/**  recorded fixture data
//   - tests/integration/live/driver-green-setup/code-assets/**  the bundle's recorded app .env
//   - docs/**                         prose documenting the validation target
//   - this file                       (names the literal to assert on)

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const HOST_LITERAL = "fevm-serverless-stable-ecparr";

/** Paths where the literal is legitimately allowed (recorded data, demos, docs, the config home). */
const ALLOWED = [
  ".env.local.test.config",
  ".env.template.test.config",
  "examples/",
  "consort/evaluation/reference-assets/stockflow/",
  // The recorded app .env bundles for the driver-green live harness + its repair-seed / refactor-seed
  // variants (all recorded app data, not kit config; same category as the base code-assets bundle).
  "tests/integration/live/driver-green-setup/",
  "tests/integration/live/driver-green-setup-s2/", // the S2 migration bundle (same recorded-app-data category)
  "docs/",
  "tests/bdd/test-env-single-home.test.ts",
  // Asserts the stockflow DEMO run.json's self-contained public default (a runnable example, not
  // test config – the demo deliberately ships a default so "anyone can run it"; see #595 boundary).
  "tests/bdd/run-config-loader.test.ts",
];

describe("#595 single test-env home: the workspace host is not re-hardcoded in test source", () => {
  it(`"${HOST_LITERAL}" appears only in the config home / recorded data / demos / docs, never in kit test source`, () => {
    // git grep the tracked tree (fast, ignores node_modules + gitignored files by default).
    let hits: string[] = [];
    try {
      const out = execFileSync("git", ["grep", "-Il", HOST_LITERAL], { encoding: "utf-8", cwd: process.cwd() });
      hits = out.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch (e) {
      // git grep exits 1 when there are ZERO matches – that's fine (nothing to check).
      const status = (e as { status?: number }).status;
      if (status === 1) return;
      throw e;
    }
    const offenders = hits.filter((f) => !ALLOWED.some((a) => f === a || f.startsWith(a)));
    expect(
      offenders,
      `The private workspace host is hardcoded in these TEST-source files – move it to the single ` +
        `home .env.local.test.config and read via consort/orchestrator/provisioning/test-env.ts (resolveTestEnv):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
