// mock-replay-agent: a role-agnostic replay mock – copies a role's RECORDED corpus artifacts
// into the workspace + logs one authoring event. Pins the two behaviors the design-role
// integration manifests depend on: NESTED seed paths are mkdir'd (stories/<S>/acs/<AC>.json),
// and a missing recorded seed fails loud (a replay never fabricates).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeMockReplayAgent } from "../../consort/orchestrator/agents/mock-replay-agent";

let corpus: string;
let ws: string;
beforeEach(() => {
  corpus = mkdtempSync(join(tmpdir(), "mockreplay-corpus-"));
  ws = mkdtempSync(join(tmpdir(), "mockreplay-ws-"));
});
afterEach(() => {
  rmSync(corpus, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe("makeMockReplayAgent", () => {
  it("copies a NESTED seed into the workspace, creating intermediate dirs", async () => {
    // A recorded AC at a nested corpus path.
    mkdirSync(join(corpus, "stories", "S1", "acs"), { recursive: true });
    writeFileSync(join(corpus, "stories/S1/acs/AC1-x.json"), '{"id":"AC1-x"}');
    const agent = makeMockReplayAgent({
      corpusRoot: corpus,
      role: "spec-author",
      seeds: [{ outputId: "ac", from: "stories/S1/acs/AC1-x.json", to: "stories/S1/acs/AC1-x.json" }],
    });
    await agent.invoke({ action: { kind: "invoke-role", role: "spec-author", story: "S1" } as never, workspaceDir: ws, inputs: {}, instructions: { prompt: "p" } });
    // The nested path was created + the file copied.
    expect(existsSync(join(ws, "stories/S1/acs/AC1-x.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(ws, "stories/S1/acs/AC1-x.json"), "utf8")).id).toBe("AC1-x");
    // And it logged one authoring event under the given role.
    const log = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
    expect(log.role).toBe("spec-author");
  });

  it("fails loud when a recorded seed is missing (a replay never fabricates)", async () => {
    const agent = makeMockReplayAgent({ corpusRoot: corpus, seeds: [{ outputId: "x", from: "nope.json", to: "nope.json" }] });
    await expect(
      agent.invoke({ action: { kind: "invoke-role", role: "product-owner" } as never, workspaceDir: ws, inputs: {}, instructions: { prompt: "p" } }),
    ).rejects.toThrow(/not found|cannot fabricate/i);
  });

  it("kind:'tree' overlays a recorded CODE tree into the workspace, excluding scaffold-owned dirs", async () => {
    // A recorded turn's code/ tree: real source under app/ + a scaffold-owned dir (.git) + junk
    // (__pycache__) that codeTreeFilter must exclude (fresh scaffold owns those).
    mkdirSync(join(corpus, "003-driver", "code", "app"), { recursive: true });
    writeFileSync(join(corpus, "003-driver/code/app/models.py"), "class Stock: pass\n");
    mkdirSync(join(corpus, "003-driver", "code", ".git"), { recursive: true });
    writeFileSync(join(corpus, "003-driver/code/.git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(corpus, "003-driver", "code", "app", "__pycache__"), { recursive: true });
    writeFileSync(join(corpus, "003-driver/code/app/__pycache__/x.pyc"), "junk");

    const agent = makeMockReplayAgent({
      corpusRoot: corpus,
      role: "navigator",
      seeds: [{ outputId: "code", kind: "tree", from: "003-driver/code", to: "." }],
    });
    await agent.invoke({ action: { kind: "invoke-role", role: "navigator", story: "S3" } as never, workspaceDir: ws, inputs: {}, instructions: { prompt: "p" } });

    // Real source copied; scaffold-owned + junk excluded (codeTreeFilter).
    expect(existsSync(join(ws, "app/models.py"))).toBe(true);
    expect(readFileSync(join(ws, "app/models.py"), "utf8")).toMatch(/class Stock/);
    expect(existsSync(join(ws, ".git"))).toBe(false);
    expect(existsSync(join(ws, "app/__pycache__"))).toBe(false);
    // Still logs one authoring event.
    const log = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
    expect(log.role).toBe("navigator");
  });

  it("kind:'tree' fails loud when the recorded tree is missing", async () => {
    const agent = makeMockReplayAgent({ corpusRoot: corpus, role: "navigator", seeds: [{ outputId: "code", kind: "tree", from: "missing/code", to: "." }] });
    await expect(
      agent.invoke({ action: { kind: "invoke-role", role: "navigator" } as never, workspaceDir: ws, inputs: {}, instructions: { prompt: "p" } }),
    ).rejects.toThrow(/not found|cannot fabricate/i);
  });
});
