// step-run-types: the contained per-run I/O contract a RunnableStep's run() speaks – what the
// orchestrator PROVIDES to a step and what the step reports back. These are the load-bearing
// containment types: the orchestrator owns .consort, resolves + provides the input CONTENTS + the
// workspace + where each output lands; the step touches NONE of .consort itself. Step (the
// one step implementation) + the StepExecutor speak these. (Originally defined alongside the now-
// removed bespoke SpecAuthorBreakdownStep; lifted here so the types outlive that class.)

import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
import type { StepInstructions } from "../agents/agent-types.js";

/**
 * What the orchestrator PROVIDES to run a step – everything the step is allowed to touch. The
 * step reaches outside NONE of this.
 */
export interface ProvidedStepRun {
  action: WorkflowAction;
  /** The directory the step + its agent may read/write within. Provisioned by the
   *  orchestrator; the agent writes its output artifact HERE, never into .consort directly. */
  workspaceDir: string;
  /** The root for `artifact`-channel outputs (the .consort design documents), when the
   *  orchestrator provisions one. MAY be contained (design docs are small + per-feature).
   *  Absent => artifact falls back to workspaceDir. */
  artifactDir?: string;
  /** The CONTAINED zone for `meta`-channel outputs (orchestration bookkeeping – raw report /
   *  verdict / marker), when the orchestrator provisions one. Absent => meta falls back to
   *  workspaceDir. A `product` output always resolves under workspaceDir (the real code tree,
   *  uncontained). With neither artifactDir nor metaDir set, every channel resolves to
   *  workspaceDir – byte-identical to the pre-channel behavior. */
  metaDir?: string;
  /** The resolved input CONTENTS, keyed by input id. The orchestrator read these from .consort
   *  (interactive or filesystem) and hands them over; the step never fetches. */
  inputs: Record<string, string>;
  /** The instruction bundle (prompt + guidelines) the orchestrator sourced + passes to the
   *  agent. */
  instructions: StepInstructions;
  /** WHERE (workspace-relative) each declared output lands, keyed by output id. The
   *  ORCHESTRATOR declares this because it knows the step's on-disk layout (e.g. a design agent
   *  writes into `.consort/features/<F>/`, cwd-relative). Absent id -> the step falls back to the
   *  output's bare `filename` at the workspace root. This is why the step stays dumb: it does
   *  not know the feature id or the .consort shape; the orchestrator tells it exactly where the
   *  produced artifact will be. */
  outputPaths?: Record<string, string>;
}

/** The contained result a step returns to the orchestrator (no validation verdict). */
export interface ProvidedStepResult {
  /** True iff every declared input was provided AND the agent produced its output file in the
   *  workspace. NOT a conformance verdict – the orchestrator validates that. */
  produced: boolean;
  /** Missing provided-input id (when !produced because an input was not supplied). */
  missingInput?: string;
  /** Absolute path(s) to the produced artifact WITHIN the provided workspace, for the
   *  orchestrator to validate + persist to .consort. */
  producedPaths?: string[];
}

/** Existence check seam (over the provided workspace only); defaults to fs.existsSync. */
export type ExistsFn = (path: string) => boolean;
