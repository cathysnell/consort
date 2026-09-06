// mock-replay-agent: a role-agnostic REPLAY mock – a StepAgent (no cloud/model) that, instead
// of inventing content, copies a role's RECORDED authoring from a scenario corpus into the
// provided workspace. Its canonical use is the PO Human Mock (the recorded product-overview.md /
// nfrs.md / design-brief.md become the turn-1 outputs the spec-author then consumes), but the
// `role` option makes it faithfully re-materialize ANY role's recorded artifacts offline – the
// catalogue's `replay` kind (agent-catalogue.ts) is a thin wrapper over this.
//
// It is a StepAgent (same seam as ClaudeStepAgent + the test mock), so Step + the
// StepExecutor drive it identically – the Template Method does not know or care that this
// step is a deterministic replay rather than a live model turn. That is the point of the
// contract: a step is a step.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { codeTreeFilter, replayBuildTurn } from "../../logging/replay-build.js";
import { ARTIFACT_ROOT, LEGACY_ARTIFACT_ROOTS } from "../../config/consort-paths.js";
import type { StepAgent, AgentInvocation } from "./agent-types.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";

/** One recorded artifact to materialize into the workspace under `outputId`.
 *  kind "file" (default) copies a single recorded file corpus `from` -> workspace `to`.
 *  kind "tree" overlays a recorded CODE TREE (a recorded-build turn's code/ dir) into the
 *  workspace, filtered by codeTreeFilter (excludes scaffold-owned dirs + junk – the SAME filter
 *  replayBuildTurn uses), so a build-turn chain can seed a turn's pre-state working tree. */
export interface RecordedSeed {
  /** The manifest output id this seed satisfies (for diagnostics + mapping). */
  outputId: string;
  /** "file" (single file, default) or "tree" (a recorded code tree, codeTreeFilter-filtered). */
  kind?: "file" | "tree";
  /** Path (relative to the corpus root) of the recorded artifact (a file, or a tree dir). */
  from: string;
  /** Path (relative to the workspace) the artifact lands at (the filename, or "." for a tree). */
  to: string;
}

/** What the PO mock is told to replay: the corpus root + the recorded seed files, plus the
 *  role it stamps its authoring log under (so productOwnerLoggedAuthoring passes). */
export interface MockReplayAgentOptions {
  /** Absolute path to the scenario corpus root the recorded files live under. */
  corpusRoot: string;
  /** The recorded seeds to copy into the workspace. */
  seeds: RecordedSeed[];
  /** The role stamped on the authoring log event (default "product-owner"). */
  role?: string;
}

/**
 * Build a PO Human Mock replay agent. On invoke it copies each recorded seed from the corpus
 * into the provided workspace (fail loud if a recorded file is missing – a replay must never
 * silently produce nothing), then appends ONE authoring event to the workspace agent-log so
 * the manifest's log checker passes. Contained: it reads only the corpus + writes only the
 * workspace it was handed.
 */
export function makeMockReplayAgent(opts: MockReplayAgentOptions): StepAgent {
  const role = opts.role ?? "product-owner";
  return {
    async invoke(invocation: AgentInvocation): Promise<void> {
      const materialized: string[] = [];
      for (const seed of opts.seeds) {
        const src = join(opts.corpusRoot, seed.from);
        if (!existsSync(src)) {
          throw new Error(
            `ReplayPoMockAgent: recorded seed for "${seed.outputId}" not found at ${src} – a replay cannot fabricate it. Check the corpus root + recorded path.`,
          );
        }
        const dst = join(invocation.workspaceDir, seed.to);
        if (seed.kind === "tree") {
          // Overlay a recorded CODE TREE into the workspace, filtered by codeTreeFilter (the same
          // filter replayBuildTurn uses: excludes scaffold-owned dirs like .git/.consort/scripts +
          // junk like __pycache__). The dst is the overlay root (usually the workspace itself).
          mkdirSync(dst, { recursive: true });
          cpSync(src, dst, { recursive: true, force: true, filter: codeTreeFilter(src) });
        } else {
          // A single file. Seeds may land at a NESTED path (e.g. stories/<S>/acs/<AC>.json);
          // writeFileSync does not create intermediate dirs, so mkdir the parent first.
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, readFileSync(src, "utf8"));
        }
        materialized.push(seed.to);
      }
      // Log what the PO "authored" (the shared agent-log line the manifest's log checker
      // requires), appended so a re-run does not clobber a prior turn's log.
      const event = {
        timestamp: new Date().toISOString(),
        level: "info",
        role,
        event: "artifact.written",
        message: `replayed PO authoring: ${materialized.join(", ")}`,
      };
      const logPath = join(invocation.workspaceDir, "agent-log.jsonl");
      const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      writeFileSync(logPath, prior + JSON.stringify(event) + "\n");
    },
  };
}

// ─── Step-aware corpus replay ────────────────────────────────────────────────
//
// makeStepReplayAgent is the SEEDLESS, action-driven replay agent: instead of a
// hand-authored seed list, it consumes a WHOLE recorded corpus (a scenario's
// `turns/NNNN-<label>/` timeline, each with a `turn.json` carrying {action, produced[]}
// and a `files/` snapshot of exactly what that turn produced). On each invoke it finds
// the recorded turn that matches the invocation's action, materializes that turn's
// `files/` into the workspace (the design/build DELTA the recorded agent wrote), and
// appends the recorded authoring log line. This is what lets the SAME shipped manifest
// resolve to a corpus-replaying agent (kind "replay" with no seeds) so a whole run
// replays through the ordinary executor with no model spawn.
//
// AMBIGUITY: a corpus is NOT one-action-per-turn – the same action recurs (both sprints
// re-run product-owner/gate/breakdown; a design revise loop re-runs a story's spec-author;
// an assess retry loop re-runs the same assess action). So matching on the action alone is
// ambiguous. The orchestrator replays actions in the SAME order they were recorded, so the
// agent walks a per-corpus ORDINAL CURSOR: for a given action it returns the NEXT
// not-yet-consumed recorded turn whose action matches, in corpus order. The cursor is
// module-scoped keyed by corpusRoot because buildAgent reconstructs the agent every turn
// (the executor builds a fresh Step per action), so an instance field would reset each turn.

/** One recorded turn discovered under a corpus `turns/` dir. */
interface CorpusTurn {
  dir: string;
  action: WorkflowAction;
}

/** A monotonic cursor over a corpus's recorded turns, shared across the per-turn agent
 *  rebuilds for one corpusRoot. `consumed` counts how many turns of each action signature
 *  have already been replayed, so a recurring action resolves to the next recorded instance. */
interface CorpusCursor {
  turns: CorpusTurn[];
  consumed: Map<string, number>;
}

const CORPUS_CURSORS = new Map<string, CorpusCursor>();

/** Per-story BUILD-turn ordinals for one replay run, keyed `<corpusRoot>::<story>`. A build turn
 *  (navigator/driver) SYNCS the story's Kth recorded-build snapshot (replayBuildTurn), so the Kth
 *  build invocation for a story maps to its Kth recorded turn – the same monotonic per-story counter
 *  the runner short-circuit keeps (claude-runner's `buildTurns`). Module-scoped because the executor
 *  rebuilds the agent every turn (an instance field would reset). */
const BUILD_TURN_CURSORS = new Map<string, number>();

/** A stable signature for an action – the discriminators a corpus turn is keyed on. */
function actionSignature(a: WorkflowAction): string {
  return JSON.stringify(a);
}

/** Resolve the recorded `turns/` timeline from a corpus root. The scenario layout is
 *  `<scenario>/turns/` alongside `<scenario>/recorded-artifacts/` + `<scenario>/recorded-build/`.
 *  Callers point us at different roots: a test at the scenario root, but the live replay engine at
 *  `<scenario>/recorded-artifacts` (its LAKEBASE_CONSORT_REPLAY_DIR = the DESIGN corpus subdir). So
 *  look for `turns/` under the given root FIRST, then its PARENT (the scenario root when the root is
 *  the recorded-artifacts subdir). Returns the resolved turns dir, or undefined if neither has one. */
function resolveTurnsDir(corpusRoot: string): string | undefined {
  const here = join(corpusRoot, "turns");
  if (existsSync(here)) return here;
  const parent = join(dirname(corpusRoot), "turns");
  if (existsSync(parent)) return parent;
  return undefined;
}

/** Load (once per corpusRoot) the ordered list of recorded turns from `turns/`. Sorted by the
 *  NNNN ordinal prefix so the cursor walks them in recorded order. */
function loadCursor(corpusRoot: string): CorpusCursor {
  const existing = CORPUS_CURSORS.get(corpusRoot);
  if (existing) return existing;
  const turnsDir = resolveTurnsDir(corpusRoot);
  if (!turnsDir) {
    throw new Error(
      `makeStepReplayAgent: no turns/ timeline under corpus root ${corpusRoot} (nor its parent) – a step-aware replay needs the recorded turns/ dir (each turns/NNNN-<label>/turn.json + files/).`,
    );
  }
  const turns: CorpusTurn[] = [];
  for (const name of readdirSync(turnsDir).sort()) {
    const dir = join(turnsDir, name);
    const tj = join(dir, "turn.json");
    if (!existsSync(tj) || !statSync(dir).isDirectory()) continue;
    try {
      const parsed = JSON.parse(readFileSync(tj, "utf8")) as { action?: WorkflowAction };
      if (parsed.action) turns.push({ dir, action: parsed.action });
    } catch {
      /* a turn without a parseable action is not replayable by action-match; skip it */
    }
  }
  const cursor: CorpusCursor = { turns, consumed: new Map() };
  CORPUS_CURSORS.set(corpusRoot, cursor);
  return cursor;
}

/** Reset the corpus cursor for a root (call at the start of a fresh replay run so a re-run in
 *  the same process starts from turn 0 rather than continuing a prior run's cursor). Also clears
 *  the per-story build-turn ordinals rooted at this corpus. */
export function resetStepReplayCursor(corpusRoot: string): void {
  CORPUS_CURSORS.delete(corpusRoot);
  for (const key of [...BUILD_TURN_CURSORS.keys()]) {
    if (key.startsWith(`${corpusRoot}::`)) BUILD_TURN_CURSORS.delete(key);
  }
}

/** The build-turn ordinal the step-replay agent LAST synced for a story (the Kth recorded-build turn),
 *  so a post-verify divergence guard can read the SAME index the agent used without re-deriving the
 *  cursor. Returns 0 if no build turn has been synced for this corpus+story yet. */
export function lastSyncedBuildTurnIndex(corpusRoot: string, story: string): number {
  return BUILD_TURN_CURSORS.get(`${corpusRoot}::${story}`) ?? 0;
}

/** A code-bearing BUILD turn: a navigator/driver turn scoped to a story, EXCEPT reflect (a design
 *  gate that runs in the build lane, verdict-only, no code – it stays on the delta path so its
 *  reflect-verdict materializes). These SYNC the story's Kth recorded-build snapshot instead of a
 *  per-turn delta, so the tree is byte-identical to record-time and the live verify is honest. */
export function isBuildTurn(a: WorkflowAction): a is WorkflowAction & { role: string; story: string } {
  return (
    a.kind === "invoke-role" &&
    (a.role === "navigator" || a.role === "driver") &&
    "story" in a &&
    typeof a.story === "string" &&
    !!a.story &&
    !("buildMode" in a && a.buildMode === "reflect")
  );
}

/** Rewrite a recorded corpus-relative path onto the LIVE artifact root: the corpus was recorded
 *  under a legacy `.sftdd`/`.tdd` root, but the live tree uses `.consort` (ARTIFACT_ROOT). A
 *  product-channel path (app/, tests/, client/, alembic/) has no artifact-root prefix and is
 *  returned unchanged. */
function remapArtifactRoot(rel: string): string {
  const parts = rel.split(sep);
  if (parts.length > 0 && (LEGACY_ARTIFACT_ROOTS as readonly string[]).includes(parts[0])) {
    parts[0] = ARTIFACT_ROOT;
    return parts.join(sep);
  }
  return rel;
}

/** Recursively copy a recorded turn's `files/` delta into the workspace, remapping the artifact
 *  root and creating intermediate dirs. Returns the workspace-relative paths materialized. */
function materializeFiles(filesDir: string, workspaceDir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const src = join(abs, name);
      if (statSync(src).isDirectory()) {
        walk(src);
        continue;
      }
      const rel = remapArtifactRoot(relative(filesDir, src));
      const dst = join(workspaceDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
      out.push(rel);
    }
  };
  walk(filesDir);
  return out;
}

/** Build a STEP-AWARE corpus replay agent. Two lanes, both step-addressed:
 *   - DESIGN turns: resolve the recorded turn matching the invocation's action (next not-yet-consumed
 *     instance in corpus order, so a recurring action resolves deterministically), MATERIALIZE that
 *     turn's `files/` DELTA into the workspace (independent accumulating artifacts).
 *   - BUILD turns (navigator/driver, not reflect): SYNC the story's Kth recorded-build SNAPSHOT
 *     (replayBuildTurn – mirror + in-scope delete) so the tree is byte-identical to record-time and
 *     the live @build-cycle verify reproduces the recorded verdict. Needs buildCorpusRoot + featureId
 *     + consortDir in opts (the runner supplies them from env). The Kth build invocation of a story
 *     maps to its Kth recorded-build turn via a per-story ordinal cursor.
 *  A corpus MISS is a HARD failure either way (a replay must never silently fabricate a turn's output). */
export function makeStepReplayAgent(opts: {
  corpusRoot: string;
  buildCorpusRoot?: string;
  featureId?: string;
  consortDir?: string;
}): StepAgent {
  return {
    async invoke(invocation: AgentInvocation): Promise<void> {
      // BUILD lane – sync the cumulative recorded-build snapshot for the story's next build turn.
      if (isBuildTurn(invocation.action) && opts.buildCorpusRoot && opts.featureId && opts.consortDir) {
        const story = invocation.action.story;
        const key = `${opts.corpusRoot}::${story}`;
        const turnIndex = (BUILD_TURN_CURSORS.get(key) ?? 0) + 1;
        BUILD_TURN_CURSORS.set(key, turnIndex);
        const synced = replayBuildTurn({
          replayBuildDir: opts.buildCorpusRoot,
          projectDir: invocation.workspaceDir,
          consortDir: opts.consortDir,
          featureId: opts.featureId,
          story,
          turnIndex,
        });
        if (!synced) {
          throw new Error(
            `makeStepReplayAgent: no recorded-build turn ${turnIndex} for ${opts.featureId}/${story} under ${opts.buildCorpusRoot} – a replay cannot fabricate it (the drive dispatched more build turns than the corpus recorded).`,
          );
        }
        return;
      }

      const cursor = loadCursor(opts.corpusRoot);
      const sig = actionSignature(invocation.action);
      const already = cursor.consumed.get(sig) ?? 0;
      // The Nth occurrence (0-indexed = already) of this action in corpus order.
      const matches = cursor.turns.filter((t) => actionSignature(t.action) === sig);
      const turn = matches[already];
      if (!turn) {
        throw new Error(
          `makeStepReplayAgent: no recorded turn for action ${sig} (occurrence #${already + 1}) under ${opts.corpusRoot}/turns – a replay cannot fabricate it. Recorded ${matches.length} occurrence(s) of this action.`,
        );
      }
      cursor.consumed.set(sig, already + 1);

      const filesDir = join(turn.dir, "files");
      const materialized = existsSync(filesDir) ? materializeFiles(filesDir, invocation.workspaceDir) : [];

      // Append the authoring log line so the manifest's log validator passes (the corpus files/
      // carry the artifacts but not the agent-log line, which is meta). Stamp the action's role.
      const role = invocation.action.kind === "invoke-role" ? invocation.action.role : "orchestrator";
      const event = {
        timestamp: new Date().toISOString(),
        level: "info",
        role,
        event: "artifact.written",
        message: `replayed ${role} turn ${turn.dir.split(sep).pop()}: ${materialized.join(", ") || "(no files delta)"}`,
      };
      const logPath = join(invocation.workspaceDir, "agent-log.jsonl");
      const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      writeFileSync(logPath, prior + JSON.stringify(event) + "\n");
    },
  };
}
