// Anti-recurrence guard: no tracked package-lock.json may pin the Databricks npm proxy.
//
// consort ships as a `claude`/`cursor` plugin (a shallow git clone) and pulls
// lakebase-scm-utils as a `github:` dependency. When npm installs a github dependency it runs
// `npm install` against THAT package's own package-lock.json; if any lockfile's "resolved" URLs
// point at npm-proxy.cloud.databricks.com, a cold install on a machine outside the Databricks
// network hangs indefinitely (the proxy host resolves but never accepts a TCP connection). Every
// resolved URL must come from the public registry (registry.npmjs.org).
//
// The fix, when this guard fails, is a pure host-swap of the "resolved" lines
// (npm-proxy.cloud.databricks.com -> registry.npmjs.org); integrity hashes are unchanged because the
// proxy is a passthrough mirror of the same tarballs. (The scm-utils lockfile carries its own copy
// of this guard so its own cold install stays clean too.)

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const PROXY_HOST = "npm-proxy.cloud.databricks.com";

/** Every tracked package-lock.json (git-tracked, so node_modules is excluded by construction). */
function trackedLockfiles(): string[] {
  return execFileSync("git", ["ls-files", "*package-lock.json"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("lockfiles resolve from the public npm registry (no Databricks proxy pins)", () => {
  const lockfiles = trackedLockfiles();

  it("tracks at least one package-lock.json (guard is actually covering something)", () => {
    expect(lockfiles.length).toBeGreaterThan(0);
  });

  it.each(lockfiles)("%s pins no %s resolved hosts", (lf) => {
    const content = readFileSync(join(REPO_ROOT, lf), "utf8");
    const hits = content.split("\n").filter((l) => l.includes(PROXY_HOST)).length;
    expect(
      hits,
      `${lf} has ${hits} ${PROXY_HOST} reference(s); a github:/plugin cold install would hang off ` +
        `the Databricks network. Host-swap the "resolved" lines to https://registry.npmjs.org/ ` +
        `(integrity unchanged).`,
    ).toBe(0);
  });
});
