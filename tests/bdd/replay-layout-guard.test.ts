// Anti-drift guard for the replay dir consolidation: ONE machinery dir
// (examples/replay/) with the corpora nested under examples/replay/corpora/<name>/.
// Before this, the machinery (launchers + engine) was split across
// examples/replay-scenarios/ and examples/tdd-workflow-smoke/orchestrator/, with each
// tree's own corpus fused in. The shell + the TS test path constants resolve against
// this exact layout; if a future move re-scatters it, the corpus-resolution tests fail
// with an opaque ENOENT deep in a readFileSync. This guard fails FIRST, naming the
// canonical layout, so the drift is obvious at the source.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REPLAY_DIR = path.join(REPO_ROOT, "examples", "replay");

describe("replay layout: one machinery dir + corpora/ subdir (anti-drift)", () => {
  it("the machinery dir examples/replay/ exists with the shared engine + generic launchers", () => {
    expect(fs.existsSync(REPLAY_DIR), "examples/replay/ machinery dir present").toBe(true);
    for (const f of ["_replay-smoke.sh", "replay-scenario.sh", "capture-scenario.sh", "SCENARIOS.md"]) {
      expect(fs.existsSync(path.join(REPLAY_DIR, f)), `examples/replay/${f} present`).toBe(true);
    }
  });

  // (The "corpora live under examples/replay/corpora/<name>/" nesting guard moved to
  //  consort-examples with the corpora; here corpora may be absent, fetched on demand.)

  it("the retired split trees are GONE (no examples/replay-scenarios, no examples/tdd-workflow-smoke)", () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, "examples", "replay-scenarios")),
      "examples/replay-scenarios/ was folded into examples/replay/ and must not return",
    ).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, "examples", "tdd-workflow-smoke")),
      "examples/tdd-workflow-smoke/ was folded into examples/replay/ and must not return",
    ).toBe(false);
  });
});
