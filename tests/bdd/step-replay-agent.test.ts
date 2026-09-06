// makeStepReplayAgent: the SEEDLESS, action-driven corpus replay agent (Stage D of unifying
// dispatch). Given a scenario corpus's `turns/NNNN-<label>/` timeline (each turn a turn.json with
// {action, ...} + a files/ delta), it resolves the recorded turn matching the invocation's action
// and materializes that turn's files/ into the workspace, appending the recorded authoring log line.
// This is what lets a shipped `claude` manifest replay a whole corpus by swapping only the kind.
//
// Proves: a design turn materializes its .consort files (remapping the recorded .sftdd root);
// a build turn materializes its product-channel code; a RECURRING action resolves to the next
// recorded occurrence in corpus order (the cursor); a corpus MISS is a hard throw.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStepReplayAgent, resetStepReplayCursor } from "../../consort/orchestrator/agents/mock-replay-agent";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary";
import type { AgentInvocation } from "../../consort/orchestrator/agents/agent-types";

let corpus: string;
let ws: string;

/** Write one recorded turn dir: turns/<label>/turn.json + files/<rel> tree. */
function recordTurn(label: string, action: WorkflowAction, files: Record<string, string>): void {
  const dir = join(corpus, "turns", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "turn.json"), JSON.stringify({ action, produced: Object.keys(files) }));
  for (const [rel, contents] of Object.entries(files)) {
    const p = join(dir, "files", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, contents);
  }
}

function invoke(action: WorkflowAction): AgentInvocation {
  return { action, workspaceDir: ws, inputs: {}, instructions: { prompt: "p" } };
}

beforeEach(() => {
  corpus = mkdtempSync(join(tmpdir(), "step-replay-corpus-"));
  ws = mkdtempSync(join(tmpdir(), "step-replay-ws-"));
});
afterEach(() => {
  resetStepReplayCursor(corpus);
  rmSync(corpus, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe("makeStepReplayAgent: materializes the recorded turn matching the action", () => {
  it("a design turn materializes its files/, remapping the recorded .sftdd root to .consort", async () => {
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", story: "S1-file-stock" };
    recordTurn("0006-spec-author", action, {
      ".sftdd/features/F1/stories/S1-file-stock/acs/AC1.json": '{"id":"AC1"}',
    });
    const agent = makeStepReplayAgent({ corpusRoot: corpus });
    await agent.invoke(invoke(action));
    // Recorded under .sftdd/ but materialized under the LIVE artifact root .consort/.
    expect(existsSync(join(ws, ".consort/features/F1/stories/S1-file-stock/acs/AC1.json"))).toBe(true);
    expect(readFileSync(join(ws, ".consort/features/F1/stories/S1-file-stock/acs/AC1.json"), "utf8")).toBe('{"id":"AC1"}');
    // and it logged an authoring event stamped with the action's role (so log validators pass).
    const log = readFileSync(join(ws, "agent-log.jsonl"), "utf8");
    expect(log).toMatch(/"role":"spec-author"/);
  });

  it("a build turn materializes its product-channel files at the project root (no artifact-root prefix)", async () => {
    const action: WorkflowAction = { kind: "invoke-role", role: "driver", story: "S1-file-stock" };
    recordTurn("0016-driver", action, {
      "app/main.py": "print('hi')\n",
      ".sftdd/cycles/F1/S1-file-stock/AC1/green-failure.json": "{}",
    });
    const agent = makeStepReplayAgent({ corpusRoot: corpus });
    await agent.invoke(invoke(action));
    expect(readFileSync(join(ws, "app/main.py"), "utf8")).toBe("print('hi')\n"); // product channel, root-relative
    expect(existsSync(join(ws, ".consort/cycles/F1/S1-file-stock/AC1/green-failure.json"))).toBe(true); // meta remapped
  });

  it("a RECURRING action resolves to the NEXT recorded occurrence in corpus order (the cursor)", async () => {
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", story: "S3-sku-detail-view" };
    recordTurn("0037-spec-author", action, { ".sftdd/marker.txt": "first" });
    recordTurn("0042-spec-author", action, { ".sftdd/marker.txt": "second" });
    const agent = makeStepReplayAgent({ corpusRoot: corpus });
    await agent.invoke(invoke(action));
    expect(readFileSync(join(ws, ".consort/marker.txt"), "utf8")).toBe("first");
    await agent.invoke(invoke(action));
    expect(readFileSync(join(ws, ".consort/marker.txt"), "utf8")).toBe("second"); // advanced to occurrence #2
  });

  it("a corpus MISS is a HARD throw (a replay must never fabricate a turn)", async () => {
    recordTurn("0006-spec-author", { kind: "invoke-role", role: "spec-author", story: "S1" }, { ".sftdd/x": "y" });
    const agent = makeStepReplayAgent({ corpusRoot: corpus });
    await expect(
      agent.invoke(invoke({ kind: "invoke-role", role: "dba", story: "S1" })),
    ).rejects.toThrow(/no recorded turn|cannot fabricate/i);
  });

  it("resolves turns/ from the PARENT when pointed at the recorded-artifacts subdir (the live engine's REPLAY_DIR)", async () => {
    // The live replay engine sets LAKEBASE_SFTDD_REPLAY_DIR = <scenario>/recorded-artifacts, but the
    // turns/ timeline lives at <scenario>/turns. The agent must find it via the parent.
    const action: WorkflowAction = { kind: "invoke-role", role: "spec-author", story: "S1" };
    recordTurn("0006-spec-author", action, { ".sftdd/x.json": "{}" }); // writes <corpus>/turns/...
    const subdir = join(corpus, "recorded-artifacts");
    mkdirSync(subdir, { recursive: true });
    const agent = makeStepReplayAgent({ corpusRoot: subdir }); // pointed at the SUBDIR, not the root
    try {
      await agent.invoke(invoke(action));
      expect(existsSync(join(ws, ".consort/x.json"))).toBe(true); // found turns/ at the parent + materialized
    } finally {
      resetStepReplayCursor(subdir);
    }
  });

  it("throws loud when the corpus has no turns/ timeline at all", async () => {
    rmSync(join(corpus, "turns"), { recursive: true, force: true });
    const agent = makeStepReplayAgent({ corpusRoot: corpus });
    await expect(agent.invoke(invoke({ kind: "invoke-role", role: "spec-author", story: "S1" }))).rejects.toThrow(/no turns\/ timeline/i);
  });

  // A navigator/driver BUILD turn is not a delta materialization – it SYNCS the cumulative recorded
  // -build snapshot for the story's Kth build turn (replayBuildTurn), so the working tree is
  // byte-identical to record-time and a repair-authored file lands AT its turn. Design turns keep
  // the delta path. This is the executor's build-lane replay (the live drive dispatches build turns
  // through here, not the runner short-circuit).
  it("a BUILD turn (navigator/driver) SYNCS the recorded-build snapshot via replayBuildTurn (cumulative, not delta)", async () => {
    const buildCorpus = mkdtempSync(join(tmpdir(), "step-replay-build-"));
    const feature = "F1";
    const story = "S1-file-stock";
    // recorded-build snapshots: RED lays the client test, GREEN lays backend only, the recorded
    // repair authors the frontend page.
    const bt = (slug: string, files: Record<string, string>): void => {
      for (const [rel, body] of Object.entries(files)) {
        const p = join(buildCorpus, "features", feature, "stories", story, "turns", slug, "code", rel);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, body);
      }
    };
    bt("001-navigator", { "client/tests/pages/Stock.test.tsx": "import '../../src/pages/StockPage';\n" });
    bt("002-driver", { "app/main.py": "# backend\n" });
    bt("003-driver-repair", { "app/main.py": "# backend\n", "client/src/pages/StockPage.tsx": "export default () => null;\n" });
    try {
      const agent = makeStepReplayAgent({ corpusRoot: corpus, buildCorpusRoot: buildCorpus, featureId: feature, consortDir: join(ws, ".consort") });
      const red: WorkflowAction = { kind: "invoke-role", role: "navigator", story };
      const green: WorkflowAction = { kind: "invoke-role", role: "driver", story };
      const repair = { kind: "invoke-role", role: "driver", story, buildMode: "repair", ac: "AC1" } as WorkflowAction;
      await agent.invoke(invoke(red));   // build turn 1 -> RED snapshot
      expect(existsSync(join(ws, "client/tests/pages/Stock.test.tsx"))).toBe(true);
      await agent.invoke(invoke(green)); // build turn 2 -> GREEN snapshot (backend only; frontend NOT yet)
      expect(existsSync(join(ws, "app/main.py"))).toBe(true);
      expect(existsSync(join(ws, "client/src/pages/StockPage.tsx"))).toBe(false);
      await agent.invoke(invoke(repair)); // build turn 3 -> repair snapshot lands the frontend AT this turn
      expect(existsSync(join(ws, "client/src/pages/StockPage.tsx"))).toBe(true);
    } finally {
      resetStepReplayCursor(corpus);
      rmSync(buildCorpus, { recursive: true, force: true });
    }
  });
});
