// The UX Designer builds an app's look from the reference sites the design brief names
// ("make it look like X, Y, Z"). For that to be more than a promise it needs a real
// browser: a headless browser MCP loaded for its turn (under the base --strict-mcp-config)
// AND the matching tool grant in its agent frontmatter. This guards the three
// load-bearing, regressable facts of that wiring:
//   1. ux-designer defaults ON to the kit-shipped browser MCP (one source of truth for
//      the default path); no OTHER role gets an MCP by default.
//   2. the kit ships that config as valid JSON declaring the Playwright server.
//   3. the agent's frontmatter actually grants the browser tools (without the grant the
//      loaded MCP tools are forbidden, and the feature silently does nothing).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultMcpConfigForRole, UX_BROWSER_MCP_CONFIG } from "../../consort/orchestrator/drive/claude-runner.js";

const KIT_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(KIT_ROOT, UX_BROWSER_MCP_CONFIG);
const UX_AGENT = path.join(KIT_ROOT, "skills", "consort", "agents", "ux-designer.md");

describe("ux-designer browser MCP: default-on wiring", () => {
  it("defaults the ux-designer role to the kit-shipped browser MCP (absolute path)", () => {
    const p = defaultMcpConfigForRole("ux-designer");
    expect(p, "ux-designer should default to a browser MCP config").toBeTruthy();
    expect(path.isAbsolute(p!), "the default path must be absolute (resolves in dev + installed layouts)").toBe(true);
    expect(p!.endsWith(UX_BROWSER_MCP_CONFIG), `expected ${p} to end with ${UX_BROWSER_MCP_CONFIG}`).toBe(true);
  });

  it("gives NO other role an MCP by default (every other spawn is unchanged)", () => {
    for (const role of ["driver", "navigator", "spec-author", "architect", "product-owner", "dba"]) {
      expect(defaultMcpConfigForRole(role), `${role} must not get a default MCP`).toBeUndefined();
    }
  });
});

describe("ux-designer browser MCP: the shipped config file", () => {
  it("is valid JSON declaring a single browser server the ux turn loads", () => {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const servers = cfg.mcpServers ?? {};
    expect(Object.keys(servers), "exactly one MCP server (--strict-mcp-config loads only this file)").toHaveLength(1);
    const playwright = servers.playwright;
    expect(playwright, "server must be named 'playwright' (tools namespace as mcp__playwright__*)").toBeTruthy();
    expect(playwright!.command).toBe("npx");
    // Playwright manages its own Chromium and runs headless in the drive.
    expect(playwright!.args?.some((a) => a.includes("@playwright/mcp"))).toBe(true);
    expect(playwright!.args).toContain("--headless");
  });
});

describe("ux-designer agent: frontmatter grants the browser tools", () => {
  it("allow-lists mcp__playwright and WebFetch (else the loaded MCP is forbidden)", () => {
    const content = readFileSync(UX_AGENT, "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(content);
    expect(m, "ux-designer.md must have frontmatter").toBeTruthy();
    const toolsLine = m![1].split("\n").find((l) => l.startsWith("tools:")) ?? "";
    expect(toolsLine, "frontmatter must have a tools: line").toContain("tools:");
    expect(toolsLine).toContain("mcp__playwright");
    expect(toolsLine).toContain("WebFetch");
    // WebSearch: find representative reference sites when the brief names none.
    expect(toolsLine).toContain("WebSearch");
    // The pre-existing text-only tools stay granted.
    for (const t of ["Read", "Write", "Edit", "Bash"]) expect(toolsLine).toContain(t);
  });
});
