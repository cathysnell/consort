// Guards two start-flow features:
//   A. run-dashboard — the kit ships a launchable dashboard and scaffolds a run-dashboard.sh
//      that opens it on the local project (see docs/design/dashboard-launch-and-wizard-intake.md).
//   B. wizard intake — the interview canon exists, is domain-first + one-question-at-a-time, and
//      start.md routes to it (the orchestrator interviews; the PO only drafts).
// These are content/registration guards, not a live boot — the standalone build is a release step.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const KIT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(KIT, rel), "utf8");

describe("Part A — run-dashboard is shipped + registered", () => {
  it("apps/dashboard builds a self-contained standalone server", () => {
    const cfg = read("apps/dashboard/next.config.ts");
    expect(cfg).toContain('output: "standalone"');
    expect(cfg, "standalone must be rooted at the app dir so server.js lands at the bundle root").toContain(
      "outputFileTracingRoot",
    );
  });

  it("registers consort-dashboard as a bin (map + tsup entry) and ships the source", () => {
    const pkg = JSON.parse(read("package.json")) as { bin: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.bin["consort-dashboard"]).toBe("./dist/bin/consort/dashboard.cli.js");
    expect(pkg.scripts["build:dashboard"], "a build:dashboard script assembles the prebuilt bundle").toBeTruthy();
    expect(read("tsup.config.ts")).toContain("bin/consort/dashboard.cli");
    expect(existsSync(path.join(KIT, "bin/consort/dashboard.cli.ts"))).toBe(true);
    expect(existsSync(path.join(KIT, "scripts/build-dashboard.mjs"))).toBe(true);
  });

  it("scaffolds an executable run-dashboard.sh that reads the LOCAL project via lk (no git)", () => {
    const rel = "templates/project/common/scripts/run-dashboard.sh";
    expect(existsSync(path.join(KIT, rel))).toBe(true);
    // Executable (0o111 bits), like its sibling run-dev.sh, so the scaffolded `./scripts/run-dashboard.sh` runs.
    expect(statSync(path.join(KIT, rel)).mode & 0o111).toBeGreaterThan(0);
    const sh = read(rel);
    expect(sh, "must go through the lk kit resolver, not re-implement it").toContain("scripts/lk");
    expect(sh).toContain("consort-dashboard");
    expect(sh).toContain("--project-dir");
  });

  it("retires the dashboard's separate semver (no version field)", () => {
    const dpkg = JSON.parse(read("apps/dashboard/package.json")) as { version?: string; private?: boolean };
    expect(dpkg.version, "the dashboard ships as a build artifact, not an independently-versioned package").toBeUndefined();
    expect(dpkg.private).toBe(true);
  });
});

describe("Part B — wizard-style intake canon", () => {
  it("hil-interview.md is domain-first, one-question-at-a-time, and orchestrator-run", () => {
    const iv = read("skills/consort/references/hil-interview.md");
    expect(iv).toMatch(/domain \+ project name/i);
    expect(iv).toMatch(/one question at a time/i);
    // The orchestrator interviews; the PO only drafts from answers.md.
    expect(iv).toMatch(/product-owner.*intake.*turn.*draft/is);
  });

  it("ships a BLANK answers template with the canonical section headers", () => {
    const t = read("skills/consort/references/intake-answers-template.md");
    for (const header of ["## Domain and name", "## Product overview", "## Non-functional requirements", "## Design brief"]) {
      expect(t, `template missing ${header}`).toContain(header);
    }
  });

  it("start.md routes the interview to the canon (not an improvised aside) and offers the dashboard + VS Code", () => {
    const start = read("commands/start.md");
    expect(start).toContain("hil-interview.md");
    expect(start).toMatch(/one question at a time/i);
    // The dashboard is launched via the consort-dashboard bin (run-dashboard.sh is the human wrapper),
    // detached in a macOS-safe way (tmux new-window / nohup — setsid does not exist on macOS).
    expect(start).toContain("consort-dashboard");
    expect(start).toMatch(/tmux new-window|nohup/);
    expect(start).toMatch(/VS Code|code "\$PWD"/);
    // The reference-sites ask must be EXPLICIT in start.md (the followed path), not only in
    // the referenced canon — it's what feeds the ux-designer's browser modelling.
    expect(start).toMatch(/which real websites or apps should this look like/i);
  });
});
