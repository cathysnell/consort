// #7 guard: a failed CLI effect must carry its output into the escalation, so a human (or a
// resuming session) sees WHY it failed without manually re-running the command. spawnCmd tees the
// child's stdout/stderr back to the parent (liveness preserved) AND captures it onto CliEffectError.

import { describe, it, expect } from "vitest";
import { spawnCmd, CliEffectError } from "../../consort/orchestrator/drive/claude-runner.js";

const node = process.execPath;

describe("spawnCmd captures the failing command's output (#7)", () => {
  it("a non-zero exit rejects with CliEffectError carrying the stderr/stdout tail", async () => {
    let err: CliEffectError | undefined;
    try {
      await spawnCmd(
        node,
        ["-e", "process.stdout.write('ctx-out\\n'); process.stderr.write('BOOM-stderr\\n'); process.exit(2)"],
        process.cwd(),
      );
    } catch (e) {
      err = e as CliEffectError;
    }
    expect(err?.name).toBe("CliEffectError");
    expect(err?.code).toBe(2);
    expect(err?.capturedOutput ?? "").toContain("BOOM-stderr");
    expect(err?.capturedOutput ?? "").toContain("ctx-out");
  });

  it("a clean exit resolves with no error (no false capture)", async () => {
    await expect(spawnCmd(node, ["-e", "process.exit(0)"], process.cwd())).resolves.toBeUndefined();
  });
});
