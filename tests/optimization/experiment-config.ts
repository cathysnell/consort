// experiment-config: an optimization experiment is DECLARATIVE data, not hardcoded TS. A config file
// names the corpus TURN whose recorded preconditions are replayed (held constant) and the CANDIDATES ,
// each a set of LEVERS that perturb that baseline. The run picks up the config and executes it; nothing
// about which turn or which levers is baked into the harness. See
// [[feedback_experiments_replay_corpus_preconditions]]. Dependency-light (fs) + unit-testable.
import { readFileSync } from "fs";
import type { RoleCandidate, RoleLeverPatch } from "./role-levers.js";

/** A candidate's CONTEXT lever, expressed declaratively. `append` LEVERAGES the recorded prompt and adds
 *  the named context blocks after it (the default, faithful mode); `replace` swaps the whole context
 *  bundle (a distinct lever). Additive-vs-replacement is itself the lever the user calls out. */
export interface ContextLeverSpec {
  mode: "append" | "replace";
  /** For append: the context blocks to add (currently "failing-test"; "scope-note"/"db-state" wired via ctxPack). */
  include?: ("failing-test" | "scope-note" | "db-state" | "migration")[];
  /** For replace: the named alternative context bundle (future; validated but not yet dispatchable). */
  bundle?: string;
}

/** The lever patch a candidate applies, as written in the config JSON. Mirrors RoleLeverPatch's swept
 *  fields plus the declarative `context` (normalized to ctxPack for append). */
export interface ExperimentLeverSpec {
  model?: string;
  effort?: string;
  uiTrack?: boolean;
  loopGranularity?: "story" | "ac" | "hybrid-a";
  deployTarget?: "local" | "workspace";
  buildSessionScope?: "cycle" | "story";
  batchCap?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  guardSuite?: boolean;
  guardScan?: boolean;
  context?: ContextLeverSpec;
}

/** One candidate in the experiment: a stable id + its lever patch. */
export interface ExperimentCandidateSpec {
  id: string;
  levers: ExperimentLeverSpec;
}

/** A full experiment: the corpus turn (fixed preconditions) + the candidates (the only perturbations).
 *  ONE config shape for EVERY turn – driver or navigator or a design role. The turn label determines the
 *  role, and the role determines the SUBSTRATE (driver => cloud/Lakebase honest-GREEN; everything else =>
 *  lean/no-cloud) – so a single externally-configured harness runs them all off the recorded replay-set. */
export interface ExperimentConfig {
  name: string;
  /** Corpus turn label whose replay-set + recorded-artifacts are the preconditions (e.g. "0156-driver",
   *  "0006-ux-designer", "0037-navigator-assess"). */
  turn: string;
  /** The story AC the turn targets (identifies the artifact copy). Required for AC-scoped turns
   *  (assess/green/repair); OPTIONAL (and unused) for the story-scoped RED turn, which authors the whole
   *  story's tests, not one AC's. */
  ac?: string;
  /** The driver turn kind. Derived from the turn label when omitted (…-repair / …-refactor / else green). */
  driverTurn?: "green" | "repair" | "refactor";
  /** The DISCRIMINATOR (judge evaluator) for this turn – named + externalized, not code-selected. "assess"
   *  = compare the produced assess marker (superseded/regression) to the recorded one; "review" = compare
   *  the produced review-verdict to the recorded one; "red" = functional coverage of the produced tests vs
   *  the tests the recorded turn authored. Derived from the turn when omitted (…-refactor / …-review =>
   *  review; a plain navigator/red build turn => red; else assess). The judge scores the candidate vs the
   *  REPLAYED turn's recorded output using this evaluator. */
  discriminator?: "assess" | "review" | "red";
  concurrency?: number;
  replicas?: number;
  candidates: ExperimentCandidateSpec[];
}

/** The spawnable roles (longest-first so multi-segment roles match before a bare prefix). The turn
 *  label is "<ordinal>-<role>[-<mode>]"; the role is the longest known role that follows the ordinal. */
const KNOWN_ROLES = [
  "architect-reviewer",
  "test-strategist",
  "spec-author",
  "ux-designer",
  "product-owner",
  "navigator",
  "driver",
  "dba",
] as const;

/** The role a corpus turn label names (e.g. "0037-navigator-assess" -> "navigator", "0156-driver" ->
 *  "driver", "0006-ux-designer" -> "ux-designer"). Throws on an unrecognized label. */
export function roleFromLabel(turn: string): string {
  const afterOrdinal = turn.replace(/^\d+-/, "");
  const role = KNOWN_ROLES.find((r) => afterOrdinal === r || afterOrdinal.startsWith(r + "-"));
  if (!role) throw new Error(`turn label "${turn}": no known role (roles: ${KNOWN_ROLES.join(", ")})`);
  return role;
}

/** The SUBSTRATE a role's turn runs on: the DRIVER needs a live Lakebase branch + the honest-GREEN
 *  verify (cloud); every other role (navigator + the design roles) runs lean (no cloud). One switch that
 *  the unified harness reads to pick the substrate – not two separate harnesses. */
export function substrateForRole(role: string): "cloud" | "lean" {
  return role === "driver" ? "cloud" : "lean";
}

/** The turn label's kind: "…-driver-repair" -> repair, "…-driver-refactor" -> refactor, else green. */
export function driverTurnFromLabel(turn: string): "green" | "repair" | "refactor" {
  if (/-repair\b/.test(turn) || turn.endsWith("-repair")) return "repair";
  if (/-refactor\b/.test(turn) || turn.endsWith("-refactor")) return "refactor";
  return "green";
}

/** The discriminator (judge evaluator) a turn label implies: a REFACTOR/REVIEW turn is judged on its
 *  review-verdict ("review"); a plain navigator BUILD turn (label ends "-navigator", no build-mode
 *  suffix – the story-level RED turn that authors the failing tests) on functional test coverage
 *  ("red"); everything else (green/repair/assess) on its assess marker ("assess"). */
export function discriminatorFromLabel(turn: string): "assess" | "review" | "red" {
  if (/-refactor\b|-refactor$|-review\b|-review$/.test(turn)) return "review";
  if (/-navigator$/.test(turn)) return "red";
  return "assess";
}

/** Normalize a declarative lever spec to the harness RoleLeverPatch. `context.append` -> ctxPack (the
 *  context blocks the driver cfg appends to the recorded prompt via contextPackSuffix); `context.replace`
 *  is accepted + validated but not yet dispatchable (throws at load so it fails loud, not silently). */
function toLeverPatch(spec: ExperimentLeverSpec, candidateId: string): RoleLeverPatch {
  const patch: RoleLeverPatch = {};
  if (spec.model !== undefined) patch.model = spec.model;
  if (spec.effort !== undefined) patch.effort = spec.effort;
  if (spec.uiTrack !== undefined) patch.uiTrack = spec.uiTrack;
  if (spec.loopGranularity !== undefined) patch.loopGranularity = spec.loopGranularity;
  if (spec.deployTarget !== undefined) patch.deployTarget = spec.deployTarget;
  if (spec.buildSessionScope !== undefined) patch.buildSessionScope = spec.buildSessionScope;
  if (spec.batchCap !== undefined) patch.batchCap = spec.batchCap;
  if (spec.allowedTools !== undefined) patch.allowedTools = spec.allowedTools;
  if (spec.disallowedTools !== undefined) patch.disallowedTools = spec.disallowedTools;
  if (spec.guardSuite !== undefined) patch.guardSuite = spec.guardSuite;
  if (spec.guardScan !== undefined) patch.guardScan = spec.guardScan;
  if (spec.context) {
    if (spec.context.mode === "append") {
      patch.ctxPack = spec.context.include ?? ["failing-test"];
    } else if (spec.context.mode === "replace") {
      throw new Error(`candidate "${candidateId}": context.mode "replace" is not yet dispatchable (append only for now)`);
    } else {
      throw new Error(`candidate "${candidateId}": context.mode must be "append" or "replace"`);
    }
  }
  return patch;
}

/** Load + validate an experiment config, returning it with candidates normalized to RoleCandidate[] +
 *  the DERIVED role + substrate (the unified harness reads `substrate` to pick cloud vs lean). */
export function loadExperimentConfig(
  path: string,
): Omit<ExperimentConfig, "ac"> & { ac: string; roleCandidates: RoleCandidate[]; role: string; substrate: "cloud" | "lean" } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ExperimentConfig>;
  if (!raw.name || typeof raw.name !== "string") throw new Error(`experiment config ${path}: missing "name"`);
  if (!raw.turn || typeof raw.turn !== "string") throw new Error(`experiment config ${path}: missing "turn" (the corpus turn label)`);
  const discriminator = raw.discriminator ?? discriminatorFromLabel(raw.turn);
  const driverTurn = raw.driverTurn ?? driverTurnFromLabel(raw.turn);
  // ac is REQUIRED for AC-scoped turns (assess/green/repair identify one AC's artifact). STORY-scoped turns
  // are exempt – ac is optional + unused (the harness derives the story cycle dir): the RED turn (authors the
  // whole story's tests) and the REFACTOR turn (story-level review + refactor of the whole story).
  const storyScoped = discriminator === "red" || driverTurn === "refactor";
  if (!storyScoped && (!raw.ac || typeof raw.ac !== "string")) throw new Error(`experiment config ${path}: missing "ac" (required for a "${discriminator}" turn)`);
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) throw new Error(`experiment config ${path}: "candidates" must be a non-empty array`);
  const seen = new Set<string>();
  const roleCandidates: RoleCandidate[] = raw.candidates.map((c) => {
    if (!c.id || typeof c.id !== "string") throw new Error(`experiment config ${path}: a candidate is missing "id"`);
    if (seen.has(c.id)) throw new Error(`experiment config ${path}: duplicate candidate id "${c.id}"`);
    seen.add(c.id);
    return { id: c.id, levers: toLeverPatch(c.levers ?? {}, c.id) };
  });
  return {
    name: raw.name,
    turn: raw.turn,
    ac: raw.ac ?? "",
    driverTurn,
    discriminator,
    ...(raw.concurrency !== undefined ? { concurrency: raw.concurrency } : {}),
    ...(raw.replicas !== undefined ? { replicas: raw.replicas } : {}),
    candidates: raw.candidates,
    roleCandidates,
    role: roleFromLabel(raw.turn),
    substrate: substrateForRole(roleFromLabel(raw.turn)),
  };
}
