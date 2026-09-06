// P2c/P2d optimize-live: the factory that assembles the REAL champion-walk deps
// (snapshot + runTrial + recordWinner) over the drive, with only the cloud/model
// LEAVES injected (spawnTurn spawns a role subprocess; forkBranch re-forks a paired
// branch). Everything else – config write, agent overlay, gate evaluation, state
// restore – is real, so this validates the full composition HERMETICALLY: a design
// handoff needs no cloud, so with a fake spawnTurn that seeds the artifact + a fake
// clock, we prove the walk applies each candidate, gates it, keeps the fastest, and
// restores byte-identically between candidates.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeChampionWalkDeps, makeLiveSpawnTurn, type OptimizeLiveCtx, type SpawnTurn } from "../../consort/optimize/optimize-live";
import { runChampionWalk } from "../../consort/optimize/optimize-harness";
import { generateCandidates } from "../../consort/optimize/optimize-candidates";
import { writeConsortConfig, defaultConsortConfig, loadConsortConfig } from "../../consort/orchestrator/settings/project-settings";

let projectDir: string;
let consortDir: string;
const featureId = "F1";

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "optimize-live-"));
  consortDir = join(projectDir, ".sftdd");
  mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
  writeConsortConfig(projectDir, defaultConsortConfig(), { force: true });
  // Pre-seed a spec-author story so the design gate can be reached; the fake spawn
  // will fill in the artifacts that make it pass.
  mkdirSync(join(consortDir, "features", featureId, "stories", "S1", "acs"), { recursive: true });
  writeFileSync(join(consortDir, "features", featureId, "agent-log.jsonl"), "");
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A fake spawn for a spec-author design handoff: writes conformant artifacts so
 *  evaluateDesignGate passes. Records how long each candidate "took" via a clock. */
function fakeSpecAuthorSpawn(durationByCandidate: Record<string, number>, clock: { now: number }): SpawnTurn {
  return async ({ candidate }) => {
    const candidateId = candidate.id;
    // Write a minimal conformant spec so both the self-check + the spec gate pass.
    const fdir = join(consortDir, "features", featureId);
    writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }));
    writeFileSync(join(fdir, "feature-spec.md"), "# spec\n");
    const acDir = join(fdir, "stories", "S1", "acs");
    mkdirSync(acDir, { recursive: true });
    writeFileSync(
      join(acDir, "AC1.json"),
      JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
    );
    // Advance the fake clock by this candidate's duration.
    clock.now += durationByCandidate[candidateId] ?? 1000;
  };
}

function ctx(spawnTurn: SpawnTurn, clock: { now: number }): OptimizeLiveCtx {
  return {
    projectDir,
    consortDir,
    featureId,
    experimentsDir: join(projectDir, "experiments"),
    spawnTurn,
    now: () => clock.now,
  };
}

describe("makeChampionWalkDeps: hermetic DESIGN handoff", () => {
  it("runs a 2-candidate design walk, gates each, keeps the faster, restores between", async () => {
    const clock = { now: 0 };
    const candidates = [
      { id: "baseline", configOverrides: {} },
      { id: "content-1", configOverrides: {}, content: { taskSuffix: " terse." } },
    ];
    const deps = makeChampionWalkDeps(
      ctx(fakeSpecAuthorSpawn({ baseline: 2000, "content-1": 800 }, clock), clock),
    );
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };

    const result = await runChampionWalk({ handoffs: [handoff], candidates, trials: 1 }, deps);

    expect(result.walk[0].winner.candidateId).toBe("content-1");
    expect(result.walk[0].baselineMs).toBe(2000);
    expect(result.walk[0].winner.medianMs).toBe(800);
    // Both candidates were gated + qualified.
    expect(result.walk[0].candidates.every((c) => !c.disqualified)).toBe(true);
  });

  it("CHAIN: each handoff's winner artifacts are preserved as the input to the NEXT handoff", async () => {
    // The load-bearing invariant: role A's winning output must be on disk when role B
    // runs, and survive B's own winner-restore. Two sequential handoffs, each with a
    // winner that APPENDS a distinct artifact building on what's already there; after
    // the walk BOTH winners' artifacts must coexist (A's fed B AND survived).
    const clock = { now: 0 };
    const fdir = join(consortDir, "features", featureId);
    const acDir = join(fdir, "stories", "S1", "acs");
    const seedSpec = () => {
      mkdirSync(acDir, { recursive: true });
      writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }));
      writeFileSync(join(fdir, "feature-spec.md"), "# spec\n");
      writeFileSync(join(acDir, "AC1.json"), JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }));
    };
    // spawn writes a marker file named for the handoff+candidate, ON TOP of whatever
    // is already on disk (never wipes) – so a surviving marker proves that winner's
    // artifacts persisted. Faster candidate ("fast") wins each handoff.
    const spawn: SpawnTurn = async ({ handoff, candidate }) => {
      seedSpec(); // keep the spec conformant so evaluateDesignGate passes each turn
      writeFileSync(join(fdir, `mark-${handoff.id}-${candidate.id}.txt`), "x");
      clock.now += candidate.id === "fast" ? 300 : 900;
    };
    const deps = makeChampionWalkDeps(ctx(spawn, clock));
    const cands = [{ id: "baseline", configOverrides: {} }, { id: "fast", configOverrides: {} }];
    // Two sequential handoffs (same role/gate; the point is the chain, not the role).
    const h1 = { id: "H1-spec-author", role: "spec-author", story: "S1" };
    const h2 = { id: "H2-spec-author", role: "spec-author", story: "S1" };

    await runChampionWalk({ handoffs: [h1, h2], candidates: cands, trials: 1, alwaysAdvance: true }, deps);

    // H1's WINNER (fast) marker survived through H2's sweep + its winner-restore...
    expect(existsSync(join(fdir, "mark-H1-spec-author-fast.txt"))).toBe(true);
    // ...and H2's winner (fast) marker is present too – the chain preserved BOTH.
    expect(existsSync(join(fdir, "mark-H2-spec-author-fast.txt"))).toBe(true);
    // The LOSER's marker (baseline) must NOT survive as the winner state (it was a
    // discarded trial, restored away).
    expect(existsSync(join(fdir, "mark-H2-spec-author-baseline.txt"))).toBe(false);
  });

  it("advances with the WINNER's ACTUAL artifacts (restores the winning trial, does not re-run)", async () => {
    // Each candidate writes DISTINGUISHABLE spec content; after the walk, the winner's
    // content must be what's on disk (so the next role sees the winner's real output),
    // and the winner must NOT have been re-spawned (spawn count == trials only).
    const clock = { now: 0 };
    let spawnCount = 0;
    const candidates = [
      { id: "baseline", configOverrides: {} },
      { id: "fast", configOverrides: {} },
    ];
    const spawn: SpawnTurn = async ({ candidate }) => {
      spawnCount++;
      const fdir = join(consortDir, "features", featureId);
      mkdirSync(join(fdir, "stories", "S1", "acs"), { recursive: true });
      // Tag the spec with WHICH candidate wrote it, so we can see whose survived.
      writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"], by: candidate.id }));
      writeFileSync(join(fdir, "feature-spec.md"), `# spec by ${candidate.id}\n`);
      writeFileSync(
        join(fdir, "stories", "S1", "acs", "AC1.json"),
        JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
      );
      clock.now += candidate.id === "fast" ? 400 : 1000; // fast wins
    };
    const deps = makeChampionWalkDeps(ctx(spawn, clock));
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };

    const result = await runChampionWalk({ handoffs: [handoff], candidates, trials: 1, alwaysAdvance: true }, deps);
    expect(result.walk[0].winner.candidateId).toBe("fast");
    // The WINNER's artifacts are on disk – restored from the winning trial, NOT a re-run.
    const spec = JSON.parse(readFileSync(join(consortDir, "features", featureId, "feature-spec.json"), "utf8"));
    expect(spec.by).toBe("fast");
    // Exactly ONE spawn per candidate (2 total) – recordWinner restored, did NOT re-spawn.
    expect(spawnCount).toBe(2);
  });

  it("disqualifies a structurally-PASSING candidate when the SEMANTIC gate rejects it (judge after timing)", async () => {
    // The semantic bar sits ON TOP of the structural self-check: a candidate whose
    // artifact is well-formed (structural pass) but semantically thin vs the recorded
    // reference must be disqualified regardless of speed. The semanticGate seam runs
    // after the clock stops, so it never inflates durationMs.
    const clock = { now: 0 };
    const candidates = [
      { id: "baseline", configOverrides: {} },
      { id: "thin", configOverrides: {} },
    ];
    // Both write a structurally-conformant spec (structural gate passes for both).
    const spawn: SpawnTurn = async () => {
      const fdir = join(consortDir, "features", featureId);
      writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }));
      writeFileSync(join(fdir, "feature-spec.md"), "# spec\n");
      writeFileSync(
        join(fdir, "stories", "S1", "acs", "AC1.json"),
        JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
      );
      clock.now += 500;
    };
    const base = ctx(spawn, clock);
    // Semantic gate: baseline is comparable; "thin" drops material intent.
    const semanticCtx: OptimizeLiveCtx = {
      ...base,
      semanticGate: async () => ({ passed: true }), // set per-candidate below via closure swap
    };
    // Route the verdict by which candidate applied its config last (the spec is the
    // same, so key off a module-level flag the spawn sets). Simpler: judge by call order.
    let call = 0;
    semanticCtx.semanticGate = async () => {
      call++;
      // first candidate (baseline) passes; second ("thin") fails semantic.
      return call === 1 ? { passed: true, score: 0.95 } : { passed: false, score: 0.3, reason: "semantic: score 0.30 < 0.85 vs stockflow ... missing: refile behavior" };
    };
    const deps = makeChampionWalkDeps(semanticCtx);
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };
    const result = await runChampionWalk({ handoffs: [handoff], candidates, trials: 1 }, deps);
    const thin = result.walk[0].candidates.find((c) => c.candidateId === "thin");
    expect(thin?.disqualified).toBe(true);
    expect(result.walk[0].winner.candidateId).toBe("baseline");
  });

  it("disqualifies a candidate whose turn does NOT satisfy the gate", async () => {
    const clock = { now: 0 };
    const candidates = [
      { id: "baseline", configOverrides: {} },
      { id: "broken", configOverrides: {} },
    ];
    // baseline writes conformant artifacts; broken writes nothing (gate fails).
    const spawn: SpawnTurn = async ({ candidate }) => {
      if (candidate.id === "baseline") {
        const fdir = join(consortDir, "features", featureId);
        writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }));
        writeFileSync(join(fdir, "feature-spec.md"), "# spec\n");
        writeFileSync(
          join(fdir, "stories", "S1", "acs", "AC1.json"),
          JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
        );
      }
      clock.now += 500;
    };
    const deps = makeChampionWalkDeps(ctx(spawn, clock));
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };

    const result = await runChampionWalk({ handoffs: [handoff], candidates, trials: 1 }, deps);
    const broken = result.walk[0].candidates.find((c) => c.candidateId === "broken");
    expect(broken?.disqualified).toBe(true);
    expect(result.walk[0].winner.candidateId).toBe("baseline");
  });

  it("applies the candidate's config override for the turn and restores the baseline config after", async () => {
    const clock = { now: 0 };
    const seenConfigs: Array<string | undefined> = [];
    const spawn: SpawnTurn = async () => {
      // Capture the driver.green model the config had DURING this turn.
      const cfg = loadConsortConfig(projectDir);
      const model = cfg?.roles?.driver?.model;
      seenConfigs.push(typeof model === "object" ? (model as Record<string, string>).green : (model as string));
      const fdir = join(consortDir, "features", featureId);
      writeFileSync(join(fdir, "feature-spec.json"), JSON.stringify({ stories: ["S1"] }));
      writeFileSync(join(fdir, "feature-spec.md"), "# spec\n");
      writeFileSync(
        join(fdir, "stories", "S1", "acs", "AC1.json"),
        JSON.stringify({ id: "AC1", layer: "API", given: "g", when: "w", then: "t", status: "draft" }),
      );
      clock.now += 100;
    };
    const candidates = [
      { id: "baseline", configOverrides: {} },
      { id: "haiku-green", configOverrides: { roles: { driver: { model: { green: "haiku" } } } } },
    ];
    const deps = makeChampionWalkDeps(ctx(spawn, clock));
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };

    await runChampionWalk({ handoffs: [handoff], candidates, trials: 1 }, deps);

    // The override was live during the haiku-green turn...
    expect(seenConfigs).toContain("haiku");
    // ...and the on-disk config is back to the baseline after (no green=haiku override left – the
    // baseline carries no per-turn model map now, so driver.model is simply absent, which is correct).
    const finalCfg = loadConsortConfig(projectDir);
    const finalModel = finalCfg?.roles?.driver?.model as Record<string, string> | undefined;
    expect(finalModel?.green).not.toBe("haiku");
  });

  it("writes a champion-walk.json + per-candidate experiment records", async () => {
    const clock = { now: 0 };
    const candidates = generateCandidates({ contentVariants: [{ taskSuffix: " x." }] });
    const deps = makeChampionWalkDeps(ctx(fakeSpecAuthorSpawn({}, clock), clock));
    const handoff = { id: "S1-spec-author", role: "spec-author", story: "S1" };

    await runChampionWalk({ handoffs: [handoff], candidates, trials: 1 }, deps);

    const expDir = join(projectDir, "experiments", "S1-spec-author");
    expect(existsSync(expDir)).toBe(true);
    // one subdir per candidate
    expect(readdirSync(expDir).length).toBeGreaterThanOrEqual(candidates.length);
  });
});

describe("makeLiveSpawnTurn: recording is gated on the `record` flag (only winners record)", () => {
  // The corpus-pollution bug: a live sweep runs N candidates x M trials; only the
  // WINNER should record into the recorded corpus (recorded-artifacts/ + turns/).
  // Recording is driven by LAKEBASE_CONSORT_RECORD_DIR, which the agent subprocess
  // (and the drive's recorder wrapper) reads. So the spawn must set that env ONLY
  // when record:true, and leave it unset for trials. We capture the env visible at
  // the moment the runner runs a command.
  const RECORD_ENV = "LAKEBASE_CONSORT_RECORD_DIR";

  // The pinned handoff carries its action; the spawn dispatches it through the executor
  // (eff.performViaExecutor), which reads RECORD_DIR from the env to decide whether to wrap
  // the agent with the recorder decorator. So we capture the env visible at the moment
  // performViaExecutor runs. It returns a truthy BoundedRoute, so perform is not called.
  const specAuthorAction = { kind: "invoke-role", role: "spec-author", story: "S1" } as never;
  const pinnedHandoff = { id: "S1-spec-author", role: "spec-author", action: specAuthorAction };
  function seams(recordDir: string, seenEnv: (v: string | undefined) => void) {
    return {
      recordDir,
      buildCfg: () => ({ projectDir, consortDir, featureId }) as never,
      buildEffects: () => ({
        async readState() {
          return {} as never;
        },
        async performViaExecutor() {
          seenEnv(process.env[RECORD_ENV]);
          return { route: { kind: "done" } } as never; // truthy => perform not called
        },
        async perform() {
          throw new Error("perform must not run when performViaExecutor dispatched the turn");
        },
      }),
    };
  }

  const priorEnv = process.env[RECORD_ENV];
  afterEach(() => {
    if (priorEnv === undefined) delete process.env[RECORD_ENV];
    else process.env[RECORD_ENV] = priorEnv;
  });

  it("does NOT set RECORD_DIR during a trial (record:false) – trials never touch the corpus", async () => {
    delete process.env[RECORD_ENV];
    let seen: string | undefined = "unset-sentinel";
    const spawn = makeLiveSpawnTurn(featureId, seams("/corpus/dir", (v) => (seen = v)) as never);
    await spawn({ handoff: pinnedHandoff, candidate: { id: "baseline", configOverrides: {} }, record: false });
    expect(seen).toBeUndefined(); // no record dir visible to the turn
  });

  it("DOES set RECORD_DIR for the winner capture (record:true) – only winners record", async () => {
    delete process.env[RECORD_ENV];
    let seen: string | undefined;
    const spawn = makeLiveSpawnTurn(featureId, seams("/corpus/dir", (v) => (seen = v)) as never);
    await spawn({ handoff: pinnedHandoff, candidate: { id: "baseline", configOverrides: {} }, record: true });
    expect(seen).toBe("/corpus/dir");
  });

  it("restores the ambient RECORD_DIR after a winner capture (no leak to later trials)", async () => {
    delete process.env[RECORD_ENV];
    const spawn = makeLiveSpawnTurn(featureId, seams("/corpus/dir", () => {}) as never);
    await spawn({ handoff: pinnedHandoff, candidate: { id: "baseline", configOverrides: {} }, record: true });
    expect(process.env[RECORD_ENV]).toBeUndefined(); // restored after the spawn
  });
});

describe("makeLiveSpawnTurn: dispatches the PINNED turn THROUGH the executor, never re-plans", () => {
  // The wrong-role bug: the spawn used to call planNextAction, which reads CURRENT
  // disk state and, once the turn's artifact lands, returns the NEXT role – a
  // spec-author sweep then ran a ux-designer turn that flaked + crashed the sweep.
  // Fix (J4): the spawn dispatches handoff.action's OWN turn through the executor
  // (eff.performViaExecutor) – the SAME primitive the live drive + lean chains use ,
  // so the sweep survives J5's deletion of commandsForAction. It never re-plans, and
  // it IGNORES the returned BoundedRoute (it runs one turn, it does not route).
  const specAuthorAction = { kind: "invoke-role", role: "spec-author", story: "S1" } as never;

  function seams(
    dispatched: { action?: unknown; performed?: unknown },
    opts: { returnUndefined?: boolean } = {},
  ) {
    return {
      buildCfg: () => ({ projectDir, consortDir, featureId }) as never,
      buildEffects: () => ({
        async readState() {
          return {} as never;
        },
        async performViaExecutor(action: unknown) {
          dispatched.action = action;
          // undefined => the action is not executor-dispatched (no manifest); the sweep
          // must fall through to perform. Truthy => the executor ran the turn + bounded it.
          return opts.returnUndefined ? undefined : ({ route: { kind: "done" } } as never);
        },
        async perform(action: unknown) {
          dispatched.performed = action;
        },
      }),
    };
  }

  it("dispatches the PINNED action through performViaExecutor (never re-plans), ignoring the returned route", async () => {
    const dispatched: { action?: unknown; performed?: unknown } = {};
    const spawn = makeLiveSpawnTurn(featureId, seams(dispatched) as never);
    await spawn({
      handoff: { id: "S1-spec-author", role: "spec-author", action: specAuthorAction },
      candidate: { id: "baseline", configOverrides: {} },
      record: false,
    });
    // The executor was handed the PINNED action, not a re-planned "next" one.
    expect(dispatched.action).toBe(specAuthorAction);
    // Executor dispatched it (truthy route) => the deterministic perform fallback did NOT run.
    expect(dispatched.performed).toBeUndefined();
  });

  it("falls back to perform when the action is NOT executor-dispatched (performViaExecutor returns undefined)", async () => {
    const dispatched: { action?: unknown; performed?: unknown } = {};
    const spawn = makeLiveSpawnTurn(featureId, seams(dispatched, { returnUndefined: true }) as never);
    await spawn({
      handoff: { id: "S1-spec-author", role: "spec-author", action: specAuthorAction },
      candidate: { id: "baseline", configOverrides: {} },
      record: false,
    });
    // Not dispatched => the sweep performed the action via the deterministic substrate path.
    expect(dispatched.action).toBe(specAuthorAction);
    expect(dispatched.performed).toBe(specAuthorAction);
  });

  it("throws if the handoff carries no pinned action (never re-plans to recover it)", async () => {
    const dispatched: { action?: unknown; performed?: unknown } = {};
    const spawn = makeLiveSpawnTurn(featureId, seams(dispatched) as never);
    await expect(
      spawn({ handoff: { id: "S1-spec-author", role: "spec-author" }, candidate: { id: "baseline", configOverrides: {} }, record: false }),
    ).rejects.toThrow(/no pinned action|actionToHandoffPlan/);
    expect(dispatched.action).toBeUndefined(); // nothing dispatched
    expect(dispatched.performed).toBeUndefined();
  });
});
