// Guard: environment PREPARATION lives in ONE family – consort/orchestrator/provisioning/. Both
// tests and interactive runs defer to it for setting up environments (workspaces / Lakebase projects
// via the lifecycle catalogue, host+auth via the credential seam, product/artifact/meta output roots
// via the channel model, and workspace seeding via the bundle primitive). This is the anti-recurrence
// gate: it fails if any of those prep primitives gets DEFINED outside the family again, or if the
// two load-bearing prep rules (host-from-profile via `databricks auth describe`, the channel-root
// ternary) get re-implemented elsewhere – exactly the scatter this consolidation removed.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const FAMILY = "consort/orchestrator/provisioning/";
/** This guard's own path – it names the auth-describe literal in a grep pattern, so exclude it. */
const SELF = "tests/bdd/provisioning-family-single-home.test.ts";

/** git grep -l for a fixed string across the tracked tree; [] when there are zero matches. */
function grepFiles(pattern: string): string[] {
  try {
    const out = execFileSync("git", ["grep", "-lF", pattern], { encoding: "utf-8", cwd: process.cwd() });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return []; // grep exit 1 = no matches
    throw e;
  }
}

// Each prep primitive, keyed by the DEFINITION token that should appear ONLY under the family. The
// value is the exact string git-grepped; a match outside FAMILY (excluding the built dist/) fails.
const DEFINITIONS: Record<string, string> = {
  "lifecycle catalogue": "export const LIFECYCLE_CATALOGUE",
  "lifecycle deps singleton": "export const catalogueLifecycleDeps",
  "scaffold-project op": "function scaffoldProject",
  "remove-project op": "export async function removeProject",
  "host-from-profile": "export function resolveHostFromProfile",
  "drive auth preflight": "export async function driveAuthPreflight",
  "channel-root resolver": "export function resolveChannelRoot",
  "kit-agents overlay": "export function layDownKitAgents",
  "bundle overlay": "export function overlayBundle",
};

describe("provisioning family: environment-prep primitives live in ONE home", () => {
  for (const [name, token] of Object.entries(DEFINITIONS)) {
    it(`${name} is defined only under ${FAMILY}`, () => {
      const offenders = grepFiles(token).filter((f) => !f.startsWith(FAMILY) && !f.startsWith("dist/") && f !== SELF);
      expect(
        offenders,
        `"${token}" is defined outside the provisioning family – move it under ${FAMILY}:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("the databricks-auth-describe host call is not re-implemented outside the credential seam", () => {
    // The ONE place that shells out to `databricks auth describe` to resolve a host is
    // provisioning/credentials.ts (resolveHostFromProfile). A second copy is the scatter #595 + this
    // consolidation removed. (The runner shell scripts + docs may reference the CLI as prose; this
    // guards TS source only.)
    const offenders = grepFiles('"auth", "describe"').filter(
      (f) => f.endsWith(".ts") && !f.startsWith(FAMILY) && !f.startsWith("dist/") && f !== SELF,
    );
    expect(
      offenders,
      `The 'databricks auth describe' host resolution is re-implemented outside ${FAMILY}credentials.ts:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
