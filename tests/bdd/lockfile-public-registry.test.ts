// GUARD: every committed npm lockfile must resolve to the PUBLIC registry.
//
// The Databricks npm proxy (npm-proxy.cloud.databricks.com) is a faithful npmjs MIRROR, but when deps
// are locked on a Databricks machine npm bakes the proxy HOST into each `resolved` URL. `npm ci` then
// fetches those verbatim, which HANGS for anyone off the Databricks network (the proxy host is
// unreachable) – the exact failure an external consumer hit on `/consort:start`. Public `resolved`
// URLs install for everyone (external directly; internal via their HTTP_PROXY) with identical tarballs
// (integrity hashes hash the bytes, not the URL). This guard fails if any committed lockfile carries a
// `resolved` host other than registry.npmjs.org – so the proxy host can never leak back in.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const RESOLVED = /"resolved":\s*"https?:\/\/([^/"]+)\//g;

/** Git-TRACKED lockfiles only – the invariant is about what ships, not untracked capture staging. */
function trackedLockfiles(): string[] {
  const out = execFileSync("git", ["ls-files", "*package-lock.json"], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean).map((rel) => join(REPO, rel));
}

describe("committed npm lockfiles resolve to the PUBLIC registry (installable off the Databricks network)", () => {
  it("no package-lock.json has a `resolved` host other than registry.npmjs.org", () => {
    const locks = trackedLockfiles();
    expect(locks.length, "expected to find committed package-lock.json files").toBeGreaterThan(0);
    const offenders = new Set<string>();
    for (const f of locks) {
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(RESOLVED)) {
        if (m[1] !== "registry.npmjs.org") offenders.add(`${f.replace(REPO + "/", "")} -> ${m[1]}`);
      }
    }
    expect(
      [...offenders],
      `internal/private registry host in a committed lockfile (external installs hang on it):\n${[...offenders].slice(0, 15).join("\n")}`,
    ).toEqual([]);
  });
});
