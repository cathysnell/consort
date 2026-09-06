// lifecycle-types: the shared contract between a RUN-SCOPED lifecycle op's PRODUCER (the lifecycle
// catalogue: scaffold-project / remove-project / inject-escalation) and its CONSUMER (the
// orchestration-runner's setup/teardown bracket). Kept dependency-light in the provisioning family so
// both sides import the same types without dragging in the runner or the catalogue's cloud calls.
//
// The run bracket itself (OrchestrationRunConfig / OrchestrationResult) lives with the runner in
// runner/orchestration-runner.ts – it composes these ops with a WorkflowAction + the chain turns.

/** A lifecycle op declaration – WHICH op (kind) + its config (both DATA), mirroring the
 *  agent spec. `scaffold-project` / `remove-project` are the catalogued kinds. */
export interface LifecycleOp {
  kind: string;
  config: Record<string, unknown>;
}

/** The result of running one lifecycle op. `ok:false` aborts the chain (setup) but never
 *  skips teardown. */
export interface LifecycleResult {
  ok: boolean;
  error?: string;
  /** Opaque handle a setup op returns for teardown to consume (e.g. the created projectDir /
   *  Lakebase id / repo url). The runner threads it from setup into teardown's context. */
  handle?: Record<string, unknown>;
}

/** The injected lifecycle executor – runs an op by kind. The real impl dispatches to the
 *  lifecycle catalogue (scaffold-project/remove-project); tests pass a mock. */
export interface LifecycleDeps {
  run(op: LifecycleOp, context: LifecycleRunContext): Promise<LifecycleResult>;
}

/** What a lifecycle op is handed: the run's workspace + the setup handle (for teardown). */
export interface LifecycleRunContext {
  workspaceDir: string;
  /** Present for teardown: the handle the setup op returned. */
  setupHandle?: Record<string, unknown>;
}
