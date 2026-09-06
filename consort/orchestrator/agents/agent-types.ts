// Shared types for a contained step's agent seam. Kept in their own module so both the
// step and its agent implementations (ClaudeStepAgent, test doubles) import them without
// a cycle. Everything here is CONTAINED: an agent is handed a workspace + input contents +
// instructions and may touch nothing else.

import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";

/**
 * The instruction bundle the orchestrator sources (interactive or filesystem) and passes
 * THROUGH to the step's agent. The step never invents these.
 */
export interface StepInstructions {
  prompt: string;
  guidelines?: string[];
}

/**
 * One CONTAINED invocation of a step's agent. The agent may read the provided input
 * contents + write within workspaceDir – nothing else. It resolves no .consort, no global
 * paths.
 */
export interface AgentInvocation {
  action: WorkflowAction;
  /** The only directory the agent may read/write within. */
  workspaceDir: string;
  /** The input CONTENTS the orchestrator provided, keyed by logical input id. */
  inputs: Record<string, string>;
  /** The passed-through instruction bundle. */
  instructions: StepInstructions;
}

/**
 * The agent seam a step invokes. INJECTED so the step is unit-tested with no cloud/model.
 * The real implementation (ClaudeStepAgent) spawns `claude -p`; a test double writes
 * fixture artifacts into the provided workspace. The agent's job: produce the step's
 * output artifact inside workspaceDir from the provided inputs + instructions.
 */
export interface StepAgent {
  invoke(invocation: AgentInvocation): Promise<void>;
}
