// The drive spawns role agents headless (claude -p). A scaffolded project ships NO
// .claude/settings.json, so without an explicit permission mode the subagent
// DEFAULTS TO PROMPTING – and headless there is nothing to answer the prompt. A
// headless SFTDD role agent must both WRITE its artifact (feature-spec.json, story
// stubs, code) AND RUN kit CLIs (its self-check `consort-response-formatter`,
// the cycle stamps, ls/cat).
//
// The mode is acceptEdits, NOT bypassPermissions. An enterprise managed-settings
// policy (/Library/Application Support/ClaudeCode/managed-settings.json) sets
// `permissions.disableBypassPermissionsMode: "disable"`; where that policy is present
// a spawned `claude -p --permission-mode bypassPermissions` is SILENTLY DOWNGRADED to
// `default` (verified: the child session's init event reports permissionMode
// "default"), which then auto-DENIES every headless prompt. acceptEdits is honored by
// the policy and auto-accepts BOTH Write-tool and Bash writes headlessly (verified:
// permission_denials empty, is_error false, both a probe.txt Write and a `printf >`
// Bash write landed). So acceptEdits is the strongest mode that actually works here;
// bypassPermissions is not a stronger acceptEdits, it is broken. Regression guard: a
// prior change to bypassPermissions blocked every write in a live sweep.

import { describe, expect, it } from "vitest";

import { claudeBaseArgs } from "../../consort/orchestrator/drive/claude-runner.js";

describe("claudeBaseArgs: headless permission mode", () => {
  it("uses --permission-mode acceptEdits (bypassPermissions is disabled by managed-settings policy and downgrades to default)", () => {
    const args = claudeBaseArgs({ kind: "claude", role: "spec-author", model: "opus", task: "draft the spec" });
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("acceptEdits");
    // Never bypassPermissions: the policy silently downgrades it to `default`, which
    // auto-denies headless – the exact regression this guards against.
    expect(args).not.toContain("bypassPermissions");
  });

  it("still carries the core headless flags (-p, --agent, --model, stream-json)", () => {
    const args = claudeBaseArgs({ kind: "claude", role: "driver", model: "sonnet", task: "t" });
    expect(args[0]).toBe("-p");
    expect(args).toContain("--agent");
    expect(args).toContain("driver");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("sources PROJECT settings so `--agent <role>` resolves the kit's .claude/agents/ defs", () => {
    // Headless `claude -p` does not load a directory's project settings (incl. its
    // .claude/agents/*.md role defs) unless explicitly told to. Without this flag,
    // `--agent spec-author` fails with "agent not found" in any workspace.
    const args = claudeBaseArgs({ kind: "claude", role: "ux-designer", model: "sonnet", task: "t" });
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("project");
  });
});
