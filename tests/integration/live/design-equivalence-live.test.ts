// GATED LIVE (RUN_LIVE_STEP=1 + LAKEBASE_TEST_E2E=1): the DESIGN half of the shared regression
// comparison suite – the corpus-comparison the A-full executor-dispatch proofs left open.
//
//   RUN_LIVE_STEP=1 LAKEBASE_TEST_E2E=1 npx vitest run tests/integration/live/design-equivalence-live.test.ts
//
// The A-full dispatch proofs showed each design turn DISPATCHES through the shipped executor + lands a
// well-FORMED artifact, but never compared the output SEMANTICALLY to the recorded corpus. This suite
// closes that: it drives each design role's PRODUCTION-body turn (buildTaskBody -> roleTaskBody, no
// hand-written prompt) and judges the output against the SHARED reference-asset pin via the relocated
// consort/evaluation semantic judge (the SAME one the optimization sweep uses). Design bar: >= 0.85.
//
// WHY SCAFFOLDED / UNCONSTRAINED (not lean): the production roleTaskBody ends each design turn with a
// `./scripts/lk` self-check the agent must pass before returning, and `lk` runs only from the
// unconstrained channel (Bash + the workspace scripts/lk shim). A lean tool-scoped (Write/Read)
// throwaway .consort omits that self-correction step – it measured production-MINUS-self-check. So this
// tier scaffolds ONE real project (Databricks + Lakebase, like driver-green – a Lakebase project is
// created for consistency even though design roles never touch the DB), runs each role UNCONSTRAINED so
// the real self-check runs, and RESETS the built .sftdd between roles (filesystem-only for design; the
// build tier extends the reset with alembic downgrade + data purge). See design-equivalence-support.ts.
//
// DOUBLE-gated (needs the scaffold): RUN_LIVE_STEP=1 + LAKEBASE_TEST_E2E=1, and the config home must
// resolve a host (resolveTestEnv) – an unconfigured env skips. NEVER interrupt before teardown (the
// remove-project in afterAll deletes the Lakebase project; an interrupt leaks it).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  scaffoldDesignEquivProject,
  teardownDesignEquivProject,
  runDesignEquivStepsParallel,
  resolveDesignEquivRunConfig,
  DESIGN_LIVE_STEPS,
  type DesignEquivProject,
} from "./design-equivalence-support.js";

const cloudReady = !!process.env.RUN_LIVE_STEP && process.env.LAKEBASE_TEST_E2E === "1";
const hostResolvable = (() => {
  try {
    return !!resolveDesignEquivRunConfig().host;
  } catch {
    return false;
  }
})();

describe.skipIf(!cloudReady || !hostResolvable)("GATED LIVE: design artifacts are SEMANTICALLY equivalent to the pin (production-body turns on a scaffolded project)", () => {
  let project: DesignEquivProject;

  beforeAll(async () => {
    project = await scaffoldDesignEquivProject();
  }, 1_800_000);

  afterAll(async () => {
    if (project) await teardownDesignEquivProject(project);
  }, 600_000);

  // ONE scaffold, all design steps in PARALLEL (bounded), each in its OWN git worktree off the
  // committed HEAD (clean .consort by construction => no shared state, nothing to reset). Fanning out
  // ~4-wide keeps the whole run well under the ~55min background-task cap that 8 sequential ~15min
  // turns would blow. Each step's outcome is collected (not thrown) so one failure doesn't abort the
  // rest; the single assertion reports every failing step at once.
  // DESIGN_EQUIV_ONLY=<step>[,<step>...] narrows the run to named steps (a targeted diagnostic,
  // e.g. just "test-list"); unset runs all. The step key must be in DESIGN_LIVE_STEPS.
  const only = (process.env.DESIGN_EQUIV_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const steps = only.length ? DESIGN_LIVE_STEPS.filter((s) => only.includes(s)) : DESIGN_LIVE_STEPS;

  it(
    "every design step's production-body output is >= threshold semantic coverage of the pinned reference",
    async () => {
      const results = await runDesignEquivStepsParallel(project, steps, 4);
      const failed = results.filter((r) => !r.passed);
      expect(
        failed.length,
        `design steps below the pin threshold:\n${failed.map((f) => `  - ${f.step}: ${f.error ?? "failed"}`).join("\n")}`,
      ).toBe(0);
    },
    3_000_000,
  );
});
