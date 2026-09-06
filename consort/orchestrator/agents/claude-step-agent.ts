// ClaudeStepAgent: the REAL StepAgent that backs a StepContract with a live
// `claude -p --agent <role>` spawn.
//
// A StepContract's agent is INJECTED (SpecAuthorBreakdownStep(agent, scope)). This is the
// production implementation: it is constructed from the LEVERS that start + manage the
// agent, assembles the `claude` DriveCommand from them + the orchestrator's passed-through
// instruction bundle, and spawns it with the kit's own guarded flag set (claudeBaseArgs +
// claudeToolArgs + the effort/fallback/budget knobs + session/resume management). The
// agent's job is to PRODUCE the step's output artifact on disk; the StepContract's run()
// then maps that on-disk output back to the contract's outputs()/route() for the
// orchestrator. So the agent's result IS the artifact on disk, and the turn's usage
// (tokens) is surfaced for observability.
//
// The levers (>= the four asked for), all optional with production defaults:
//   - model        : which model backs the turn (e.g. "haiku" | "sonnet" | "opus").
//   - effort       : reasoning effort ("low" | "medium" | default) – the fast/deep knob.
//   - session      : "resume" reuses a warm claude session (context kept) across turns;
//                    "fresh" starts a NEW session (context CLEARED) – the compaction/clear
//                    lever. A resumeKey names the session to resume.
//   - toolScope    : allow/deny tool lists (restrict what the agent may call).
//   - fallbackModel: auto-failover model when the primary is overloaded.
//   - maxBudgetUsd : per-invocation dollar cap.
// permission-mode is fixed to acceptEdits (claudeBaseArgs), the only mode the enterprise
// managed-settings policy honors headlessly (see claude-runner claudeBaseArgs docs).

import { randomUUID } from "node:crypto";
import { claudeBaseArgs, claudeToolArgs, spawnClaudeStreaming, peekLastAgentTranscript } from "../drive/claude-runner.js";
import type { TurnUsage } from "../../session/claude-usage.js";
import type { DriveCommand } from "../drive/orchestrator-effects.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
import type { StepAgent, AgentInvocation } from "./agent-types.js";

/** The knobs that start + manage the agent. All optional; production defaults applied. */
export interface AgentLevers {
  /** The role the `--agent <role>` turn runs as (spec-author, architect-reviewer, ...). */
  role: string;
  /** Which model backs the turn. Default "sonnet". */
  model?: string;
  /** Reasoning effort ("low" | "medium" | default). Omit for the model default. */
  effort?: string;
  /** Session management: reuse a warm session (context kept) or start fresh (context
   *  CLEARED). Default "fresh" – each isolated step starts clean unless told to resume. */
  session?: "fresh" | "resume";
  /** The session key to resume when session === "resume". A stable id per (role, scope). */
  resumeKey?: string;
  /** An explicit session id to resume (overrides resumeKey bookkeeping). */
  resumeSessionId?: string;
  /** Restrict the agent's tools (Family-2 scope lever). */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Auto-failover model when the primary is overloaded. */
  fallbackModel?: string;
  /** Per-invocation dollar cap. */
  maxBudgetUsd?: number;
}

/** The seam that actually spawns the turn – injectable so the agent is unit-testable. */
export type SpawnFn = (args: string[], cwd: string) => Promise<TurnUsage | undefined>;

/**
 * The UNCONTAINED production dispatch seam (the LIVE drive). When present, invoke() delegates the
 * turn to this fn INSTEAD OF the contained raw spawn: the seam builds + dispatches the turn through
 * the production runner (execRunner) – so the agent inherits, for free, everything execRunner owns
 * (per-role session warmth, the context-budget guard, mid-turn overflow + transient-blip retries,
 * the per-turn build-replay overlay, set-phase/sync-backlog) that the contained raw spawn lacks. It
 * is the ONE axis on which the live drive differs from a contained test run: cwd = the real project
 * (the runner owns it), inputs are read from the tree (not embedded in the prompt), and session/
 * retry/replay are the runner's. The seam does the DISPATCH ONLY; invoke() reads the turn transcript
 * afterward (ONE place), so this stays free of a claude-runner import at its construction site.
 * Absent => the CONTAINED path (raw spawnClaudeStreaming, cwd=workspace, args from the levers). This
 * is what dissolves the two-agent split: one ClaudeStepAgent, parameterized by whether a production
 * dispatch seam is supplied (the live executor-dispatch supplies one; every contained caller does not).
 */
export type LiveDispatchFn = (invocation: AgentInvocation) => Promise<void>;

/** The usage the last invocation reported (tokens), surfaced for observability. */
export interface AgentTurnResult {
  usage?: TurnUsage;
  /** The turn's FINAL assistant text (stdout). The orchestrator reads a fenced
   *  ```agent-report block from this – the containment-proof log channel (no file path the
   *  agent can misplace). Undefined when the spawn captured no final text. */
  finalText?: string;
}

/**
 * The real StepAgent: build the `claude` command from the levers + the orchestrator's
 * passed-through instructions, then spawn it. Maps NOTHING itself – the artifact the
 * agent writes on disk IS the output the StepContract's run() validates + maps to
 * outputs()/route(). Exposes lastResult for the tokens/usage of the most recent turn.
 */
export class ClaudeStepAgent implements StepAgent {
  private readonly spawn: SpawnFn;
  private readonly liveDispatch: LiveDispatchFn | undefined;
  private sessionId: string | undefined;
  lastResult: AgentTurnResult | undefined;

  constructor(
    private readonly levers: AgentLevers,
    spawn?: SpawnFn,
    /** The UNCONTAINED production dispatch seam. When supplied (the live executor-dispatch path),
     *  invoke() delegates to it instead of the contained raw spawn – see LiveDispatchFn. When
     *  omitted (every contained caller: the integration chains, the per-role sweep, the unit
     *  tests), invoke() takes the contained raw-spawn path, byte-identical to before. */
    liveDispatch?: LiveDispatchFn,
  ) {
    this.spawn = spawn ?? spawnClaudeStreaming;
    this.liveDispatch = liveDispatch;
    this.sessionId = levers.resumeSessionId;
  }

  /**
   * The `claude` DriveCommand this agent will spawn for an invocation. Pure + exported
   * for guarding: the task is the orchestrator's passed-through prompt + guidelines + the
   * PROVIDED input contents (embedded so the agent needs no .consort access), and every
   * model-side lever is threaded onto the command (which claudeBaseArgs/claudeToolArgs
   * then translate to flags). CONTAINED: the task references only provided inputs + the
   * workspace it will be spawned in; it never points the agent at .consort.
   */
  buildCommand(invocation: AgentInvocation): Extract<DriveCommand, { kind: "claude" }> {
    const { instructions, action, inputs } = invocation;
    // Assemble the task from the passed-through bundle: the prompt, then the provided
    // input contents (so the agent reads them from the prompt, not the filesystem), then
    // any guidelines as a trailing directive block. The orchestrator sourced all of this.
    const inputBlock = Object.keys(inputs).length
      ? `\n\nProvided inputs (read these; do NOT look elsewhere):\n${Object.entries(inputs)
          .map(([id, content]) => `<<INPUT id="${id}">>\n${content}\n<<END INPUT ${id}>>`)
          .join("\n\n")}`
      : "";
    const guidelines = instructions.guidelines?.length
      ? `\n\nGuidelines (follow all):\n${instructions.guidelines.map((g) => `- ${g}`).join("\n")}`
      : "";
    return {
      kind: "claude",
      role: this.levers.role,
      model: this.levers.model ?? "sonnet",
      task: instructions.prompt + inputBlock + guidelines,
      ...(this.levers.effort ? { effort: this.levers.effort } : {}),
      ...(this.levers.fallbackModel ? { fallbackModel: this.levers.fallbackModel } : {}),
      ...(typeof this.levers.maxBudgetUsd === "number" ? { maxBudgetUsd: this.levers.maxBudgetUsd } : {}),
      ...(this.levers.allowedTools?.length ? { allowedTools: this.levers.allowedTools } : {}),
      ...(this.levers.disallowedTools?.length ? { disallowedTools: this.levers.disallowedTools } : {}),
      replay: { mode: "mode" in action ? (action as { mode?: string }).mode : undefined },
    };
  }

  /** Session flags: resume a warm session (context kept) or start fresh (context cleared). */
  private sessionArgs(): string[] {
    if (this.levers.session === "resume") {
      const id = this.sessionId ?? this.levers.resumeKey;
      if (id) return ["--resume", id];
      // Asked to resume but no id yet – mint one so the NEXT turn can resume it.
      this.sessionId = randomUUID();
      return ["--session-id", this.sessionId];
    }
    // Fresh (default): a new session every invocation – context CLEARED. Artifact-as-API
    // makes a cold turn correct (it reloads its inputs from disk).
    this.sessionId = randomUUID();
    return ["--session-id", this.sessionId];
  }

  /** The full spawn arg vector for an invocation (exported for guarding via buildCommand). */
  spawnArgs(invocation: AgentInvocation): string[] {
    const cmd = this.buildCommand(invocation);
    const args = claudeBaseArgs(cmd);
    if (cmd.effort) args.push("--effort", cmd.effort);
    if (cmd.fallbackModel) args.push("--fallback-model", cmd.fallbackModel);
    if (typeof cmd.maxBudgetUsd === "number") args.push("--max-budget-usd", String(cmd.maxBudgetUsd));
    args.push(...claudeToolArgs(cmd));
    args.push(...this.sessionArgs());
    return args;
  }

  async invoke(invocation: AgentInvocation): Promise<void> {
    // UNCONTAINED (live drive): a production dispatch seam was supplied – delegate the turn to it
    // (execRunner owns cwd=project, session warmth, context-budget, overflow/blip retry, replay
    // overlay, set-phase/sync-backlog). The seam does the dispatch only; we still read the turn's
    // transcript HERE (the one place), so lastResult is surfaced identically on both paths and no
    // caller of this seam needs to import the runner's transcript machinery.
    if (this.liveDispatch) {
      await this.liveDispatch(invocation);
      // PEEK, do not take: the record wrapper (when a RECORD capture is active) is the sole
      // take()-clearer at end of turn. Taking here robbed it => transcript.md was never written for
      // executor-dispatched turns (the double-consume race). Peeking leaves the transcript for it.
      const finalText = peekLastAgentTranscript()?.finalText;
      // The uncontained runner logs usage/tokens itself; the transcript carries the final text only.
      this.lastResult = finalText ? { finalText } : {};
      return;
    }
    const args = this.spawnArgs(invocation);
    // CONTAINED: spawn with the PROVIDED workspace as cwd, so the agent's Write/Bash tools
    // land inside the workspace the orchestrator gave it – never elsewhere.
    const usage = await this.spawn(args, invocation.workspaceDir);
    // Capture the turn's final assistant text (the report channel). PEEK (not take) for the same
    // reason as the live path: the record wrapper is the sole clearer. Undefined under a test spawn.
    const finalText = peekLastAgentTranscript()?.finalText;
    this.lastResult = { usage, finalText };
  }
}

/** Helper: which WorkflowAction to use as the routing `completed` after this agent's turn. */
export function completedActionFor(role: string, action: WorkflowAction): WorkflowAction {
  // The action the orchestrator pinned IS the completed action for routing; kept as a
  // seam in case a future agent needs to normalize it.
  void role;
  return action;
}
