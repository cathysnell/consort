import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hermetic coverage for bootstrap.sh's prerequisite gate.
 *
 * Every case runs the real script with `--check-only` (so it installs nothing)
 * against a directory of shims prepended to PATH. That is the only way to reach
 * these branches without mutating the developer's machine: the bug class this
 * guards against is "a tool is present but unusable", which cannot be provoked
 * by inspecting the host's real toolchain.
 */

const BOOTSTRAP = resolve(__dirname, "../../bootstrap.sh");

/** Tools every run needs green so a case can isolate the one under test. */
interface Shims {
  node?: string;
  python3?: string;
  java?: string;
}

function shimDir(shims: Shims): string {
  const dir = mkdtempSync(join(tmpdir(), "consort-bootstrap-"));

  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  };

  // Defaults are all-green so each test varies exactly one dimension.
  write("node", `[ "$1" = "-v" ] && echo "v${shims.node ?? "20.11.0"}" || exit 0`);
  write("npm", `echo "10.2.4"`);
  write(
    "python3",
    `if [ "$1" = "-c" ]; then
       printf '%s\\n' "${shims.python3 ?? "3.11"}"
     else
       echo "Python ${shims.python3 ?? "3.11"}.0"
     fi`,
  );
  // A java shim: empty string means "no runtime", mimicking the macOS stub that
  // exists on PATH but exits non-zero.
  if (shims.java === "") {
    write("java", `echo "The operation couldn't be completed. Unable to locate a Java Runtime." >&2\nexit 1`);
  } else {
    write("java", `echo '${shims.java ?? 'openjdk version "17.0.20.1" 2026-08-18'}' >&2`);
  }
  write("gh", `[ "$1" = "auth" ] && exit 0 || echo "gh version 2.89.0"`);
  write("databricks", `[ "$1" = "auth" ] && exit 0 || echo "Databricks CLI v1.12.1"`);
  write("brew", `[ "$1" = "--prefix" ] && echo "${dir}/nonexistent-prefix" || exit 0`);

  return dir;
}

function run(shims: Shims): { stdout: string; status: number } {
  const dir = shimDir(shims);
  try {
    const stdout = execFileSync("bash", [BOOTSTRAP, "--check-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHELL: "/bin/bash" },
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("bootstrap.sh prerequisite floors", () => {
  it("accepts a python3 at the documented 3.10 floor", () => {
    const { stdout } = run({ python3: "3.11" });
    expect(stdout).toContain("Python 3.11");
    expect(stdout).not.toContain("3.10+ is required");
  });

  it("rejects a python3 below the floor and fails the run", () => {
    // macOS's /usr/bin/python3. Previously this reported green because the check
    // only tested that python3 existed, never its version.
    const { stdout, status } = run({ python3: "3.9" });
    expect(stdout).toContain("Python 3.9 found, but 3.10+ is required");
    expect(status).toBe(1);
  });

  it("treats 3.10 itself as satisfying the floor (boundary)", () => {
    const { stdout } = run({ python3: "3.10" });
    expect(stdout).toContain("Python 3.10");
    expect(stdout).not.toContain("3.10+ is required");
  });

  it("rejects a node below 20 and fails the run", () => {
    const { stdout, status } = run({ node: "18.19.0" });
    expect(stdout).toContain("Consort needs 20+");
    expect(status).toBe(1);
  });
});

describe("bootstrap.sh JDK handling", () => {
  it("accepts a JDK at or above 17", () => {
    const { stdout } = run({ java: 'openjdk version "17.0.20.1" 2026-08-18' });
    expect(stdout).toContain("JDK 17");
    expect(stdout).not.toContain("Advisories");
  });

  it("does not false-negative when the JVM prints a JAVA_TOOL_OPTIONS preamble", () => {
    // A `head -1` probe reads the preamble instead of the version line and
    // reports a working JDK as missing.
    const { stdout } = run({
      java: 'Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8\nopenjdk version "17.0.20.1" 2026-08-18',
    });
    expect(stdout).toContain("JDK 17");
    expect(stdout).not.toContain("JDK not found on PATH");
  });

  it("flags a below-floor JDK as an advisory without failing the run", () => {
    // create-doctor-gate.ts: the JDK blocks only java/kotlin projects, and
    // bootstrap has no --language, so it must not gate every user on it.
    const { stdout, status } = run({ java: 'java version "1.8.0_402"' });
    expect(stdout).toContain("17+ is needed for the Flyway live path");
    expect(stdout).toContain("Advisories (not blocking)");
    expect(status).toBe(0);
  });

  it("reports a missing JDK as an advisory, never as a silent green", () => {
    const { stdout, status } = run({ java: "" });
    expect(stdout).toContain("JDK not found on PATH");
    expect(stdout).toContain("Advisories (not blocking)");
    // Green summary is still printed (nothing REQUIRED is missing) but it can no
    // longer hide the broken JDK.
    expect(stdout).toContain("All required tools are present");
    expect(status).toBe(0);
  });
});
