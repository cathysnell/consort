# Give the UX Designer real eyes: browser access to named reference sites

## Context

The kit's UX Designer is told to build an app's look from a **design brief** in which "the human points at reference sites and says what to take from each" (`skills/consort/agents/ux-designer.md:32`), and its procedure says it "**MAY** use the browser/devtools tools to read real fonts/colors/spacing" (`:96`). But it structurally cannot:

- Its agent frontmatter allow-list is `tools: Read, Write, Edit, Bash` (`skills/consort/agents/ux-designer.md:8`) — no `WebFetch`, no browser.
- The runner spawns every role agent with `--strict-mcp-config` and **no** `--mcp-config` (`orchestrator/drive/claude-runner.ts:575–586`, `claudeBaseArgs`), so no browser/devtools MCP is loaded either. The only MCP the repo defines is `consort`, and strict mode wouldn't pass even that.

**Consequence:** the UX Designer extracts the look only from the *prose* of `design-brief.md`. A brief that just names URLs ("make it look like X, Y, Z") gives it no visual signal, so it silently falls back to `skills/consort/references/default-design-guide.md` — the Databricks-brand baseline (DM Sans, navy + warm neutrals). That baseline is the "StockFlow look," which is why **every generated app looks the same** regardless of the reference sites in the brief. The `:96` instruction is a promise the runtime can't keep.

**Goal (chosen direction: "give it real eyes"):** wire a headless browser MCP into the UX Designer's turn — and only that turn — so it actually navigates each named reference site, reads its real computed fonts/colors/spacing, and derives the design-guide tokens from what it sees, citing each token to the reference it came from. Every other role's spawn stays byte-for-byte unchanged.

## Design

**One per-role knob, mirroring the existing ones.** `effort` / `fallbackModel` / `maxBudgetUsd` already flow per-role from `consort-config.json` → settings → a `DriveEffectsConfig` callback → the claude `DriveCommand` → a spawn flag. Add a `mcpConfig` knob on the exact same seam (map confirmed by exploration):

| Layer | File | Change |
|---|---|---|
| Config file schema | `consort/config/consort-config-file.ts` (`RoleSettingsFile`, ~:43) | add `mcpConfig?: string` |
| Resolved settings | `consort/orchestrator/settings/project-settings.ts` (`ResolvedSettings` ~:58; `resolveConsortSettings` loop ~:95) | add `mcpConfigs: Record<string,string|undefined>`, fill from `rc?.mcpConfig` |
| Effects callback | `consort/orchestrator/drive/orchestrator-effects.ts` (`DriveEffectsConfig` ~:161) | add `mcpConfigForRole?(role): string \| undefined` |
| Command builder | `orchestrator-effects.ts` (`buildClaudeCommandWithBody` ~:1256) | resolve `const mcpConfig = cfg.mcpConfigForRole?.(action.role)`; spread `...(mcpConfig ? { mcpConfig } : {})` |
| Command type | `orchestrator-effects.ts` (`DriveCommand` `kind:"claude"` ~:52) | add `mcpConfig?: string` |
| Spawn wiring | `orchestrator/drive/claude-runner.ts` (~:726, after the `maxBudgetUsd` push) | `if (cmd.mcpConfig) baseArgs.push("--mcp-config", cmd.mcpConfig);` |
| Config→callback | `claude-runner.ts` (buildCfg, ~:1021) | `mcpConfigForRole: (role) => settings.mcpConfigs?.[role]` |

A normal run that sets no `mcpConfig` pushes no flag — **identical to today** for every role.

**The browser MCP + its config file.** Ship a small MCP-config JSON in the kit (e.g. `skills/consort/config/ux-browser-mcp.json`) defining a single **Playwright MCP** server (`npx @playwright/mcp@latest`, headless). Playwright manages its own Chromium, so it's more CI-portable than `chrome-devtools-mcp` (which needs a system Chrome). `mcpConfigForRole("ux-designer")` returns the absolute path to this file; with `--strict-mcp-config` only that server loads, for the ux turn only. Server name `playwright` ⇒ tools namespaced `mcp__playwright__*`. (Decision 1 below: Playwright vs chrome-devtools.)

**Provisioning.** `layDownKitAgents` (`orchestrator/provisioning/bundle.ts:15`) already copies `skills/consort/agents/` into the workspace's `.claude/agents/`. The mcp-config path passed to `--mcp-config` should resolve to the kit dir (it's read at spawn time, not from the workspace), so no new overlay is required; confirm the path the runner passes is the kit-resolved one, not a workspace-relative one.

**Agent file (authoritative copy = `skills/consort/agents/ux-designer.md`; keep repo `.claude/agents/ux-designer.md` in sync — check for a sync/guard test):**
- Frontmatter `tools:` (`:8`) → add browser access + `WebFetch`: `Read, Write, Edit, Bash, WebFetch, mcp__playwright`.
- Procedure (`:96`) → turn the permissive "MAY use the browser/devtools tools" into the real, expected flow: for each reference the brief names, **navigate to it, read the actual computed fonts/colors/spacing/radius/shadows** (via the browser MCP), and derive tokens from what's observed, **citing each token decision to its reference** (the doc already asks for citations at `:99`, `:140`).
- **Kill the silent fallback (the actual bug):** when a brief names references but the agent could not consult them (browser unavailable / site unreachable) AND the brief carries no describable look, it must NOT quietly emit the Databricks baseline — it logs the gap and surfaces "the referenced look could not be captured; describe it in the brief or fix browser access" rather than shipping a look nobody asked for.

**Graceful degrade.** An MCP server that fails to start is non-fatal to the turn (the agent simply lacks those tools) — so a box with no browser still completes text-only. The agent instructions above make that path *visible* (log + surface) instead of a silent baseline default. No hard dependency on Chromium for the turn to run.

## Open decisions (confirm before build)

1. **Which browser MCP** — recommend **Playwright MCP** (bundled Chromium, `browser_navigate` + `browser_evaluate` to read `getComputedStyle`, portable). Alternative: `chrome-devtools-mcp` (needs system Chrome). 
2. **Effort / cost for the ux turn** — browser navigation over several sites adds latency + tokens; the manifest currently sets `effort: low` (`steps/manifests/ux-designer.json`). Recommend raising to `medium` for this turn and/or setting a `maxBudgetUsd` cap. You own the numbers.
3. **Config location** — per-role `mcpConfig` in `consort-config.json` (operator-tunable, nothing on by default) vs. a kit default that wires the browser MCP for `ux-designer` out of the box. Recommend: kit ships the config file, and the `ux-designer` role points at it by default (so the feature works without operator setup), overridable via `consort-config.json`.
4. **WebFetch too?** — recommend yes as a cheap complement (raw HTML / inline CSS / OG image), with the Playwright MCP as the authoritative computed-style reader.

## Verification

- **Hermetic:** unit-test the new seam is a pure pass-through — `mcpConfigForRole("ux-designer")` returns the path and `--mcp-config <path>` is pushed for the ux command only; every other role pushes nothing (byte-identical spawn). Add a guard test that the `skills/consort/agents/ux-designer.md` frontmatter grants the browser tools and that its two copies stay in sync. Full suite stays green.
- **Live (required per "nothing done until live-tested e2e"):** run a real design phase with a brief that names 1–2 concrete reference sites; confirm from the ux turn's transcript that it navigated each site, read real computed styles, and the resulting `design-guide.json` tokens (palette/type/spacing) match the sites and are cited to them — i.e. the app no longer defaults to the StockFlow/Databricks baseline. Then a negative run (brief names a site, browser disabled) confirms it surfaces the gap instead of silently defaulting.

## Explicitly NOT in scope

- No browser access for any role other than `ux-designer`.
- No change to `--strict-mcp-config` globally, or to any other role's spawn.
- No redesign of the design-brief format or the intake step (the brief stays the contract; this only lets the ux turn honor the references it names).
