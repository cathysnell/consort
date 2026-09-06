// A deterministic CLI effect (an SCM bin – wait-ci / merge / prepare-pr) that exits
// non-zero must reject with a TYPED CliEffectError carrying the bin + exit code, so the
// drive's top-level catch can record a resumable escalation and emit a CLASSIFIED
// `RAISED TO HIL` halt line. Before this the reject was a bare Error whose message fell
// to an unprefixed stderr line that classifyDriveLine skipped – the CI-failure silent
// death a Monitor tailing drive-live.log never surfaced.

import { describe, it, expect } from "vitest";
import { spawnCmd, CliEffectError } from "../../consort/orchestrator/drive/claude-runner";

describe("spawnCmd – non-zero exit rejects with a typed CliEffectError", () => {
  it("carries the bin + exit code (not a bare Error)", async () => {
    const err = await spawnCmd("node", ["-e", "process.exit(3)"], process.cwd()).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliEffectError);
    expect(err).toMatchObject({ bin: "node", code: 3 });
    expect((err as CliEffectError).message).toContain("exited 3");
  });

  it("resolves (no throw) on a zero exit", async () => {
    await expect(spawnCmd("node", ["-e", "process.exit(0)"], process.cwd())).resolves.toBeUndefined();
  });
});
