// the kit is a Claude Code plugin. /consort:start launches
// the workflow. The plugin ships the command + skills + MCP server; the role
// agents are NOT shipped as plugin agents – the driver invokes them as
// `claude --agent <role>` against the agents scaffolded into each project's
// .claude/agents/, so the manifest declares no `agents` field. Hermetic JSON/file checks.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_AGENT_ROLES } from "../../consort/config/agent-models";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");

function readJson(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

describe("plugin manifest (.claude-plugin/plugin.json)", () => {
  const manifest = readJson(".claude-plugin/plugin.json");

  it("keeps the broad kit name (not rebranded to TDD)", () => {
    expect(manifest.name).toBe("consort");
  });

  it("exposes skills and declares NO agents field (agents come from the scaffolded project)", () => {
    expect(manifest.skills).toBe("./skills/");
    // The `agents` field is intentionally omitted: a dir string is rejected by
    // the manifest validator, and the driver uses project-scope agents anyway.
    expect(manifest.agents).toBeUndefined();
    // The canonical role-agent source (what create-project scaffolds into a
    // project's .claude/agents/) still resolves to exactly the AgentRole defs.
    const agentSourceDir = path.join(REPO_ROOT, "skills", "consort", "agents");
    expect(fs.existsSync(agentSourceDir)).toBe(true);
    const onDisk = fs
      .readdirSync(agentSourceDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(onDisk).toEqual([...ALL_AGENT_ROLES].sort());
  });

  // The plugin version MUST track package.json. `claude plugin update` compares
  // versions to decide whether to refresh the cache; a frozen plugin version
  // means content moves (e.g. an agent-def bugfix) but the updater sees no
  // version change and refuses to refresh. Enforce the sync so every release
  // that bumps package.json also bumps the plugin manifests.
  it("version matches package.json (so `claude plugin update` refreshes on release)", () => {
    const pkgVersion = readJson("package.json").version;
    expect(manifest.version).toBe(pkgVersion);
    const cursor = readJson(".cursor-plugin/plugin.json");
    expect(cursor.version).toBe(pkgVersion);
  });
});

describe("marketplace catalog (.claude-plugin/marketplace.json)", () => {
  const market = readJson(".claude-plugin/marketplace.json");

  it("lists the kit plugin from this repo", () => {
    expect(Array.isArray(market.plugins)).toBe(true);
    const entry = market.plugins.find((p: any) => p.name === "consort");
    expect(entry, "marketplace should list consort").toBeTruthy();
    // Relative-path plugin sources must start with "./" (a bare "." is rejected
    // as an unsupported source type by `claude plugin install`).
    expect(entry.source).toBe("./");
  });
});

describe("/consort:start launcher command (commands/start.md)", () => {
  const tdd = fs.readFileSync(path.join(REPO_ROOT, "commands", "start.md"), "utf8");

  it("has a frontmatter description", () => {
    expect(tdd).toMatch(/^---\n[\s\S]*?\bdescription:/);
  });

  it("branches on .consort/: resume an existing project, or guide creation", () => {
    expect(tdd).toMatch(/\.consort\//);
    expect(tdd).toMatch(/lakebase-create-project/); // create path
    expect(tdd).toMatch(/\/plan\b/); // resume path drives the loop
    expect(tdd).toMatch(/\/deploy\b/);
  });

  it("drives via the deterministic orchestrator + the scaffolded role agents, coordinates only", () => {
    expect(tdd).toMatch(/consort-drive|deterministic orchestrator/); // the driver, not an LLM scrum-master
    expect(tdd).not.toMatch(/scrum-master/);
    expect(tdd).toMatch(/claude --agent <role>/); // documents how the driver spawns roles
    expect(tdd).toMatch(/coordinate only/i);
    for (const role of ["product-owner", "spec-author", "release-engineer"]) {
      expect(tdd, `role ${role} should be named`).toContain(role);
    }
  });
});
