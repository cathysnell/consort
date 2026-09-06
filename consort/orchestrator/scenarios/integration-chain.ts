// integration-chain: a folder-discovery runner – point it at a manifest directory + a start
// action, and it loads EVERY manifest in that folder and drives runManifestChain from the start,
// following each turn's routing to the next matching manifest until the chain leaves the set.
// "Anything in the manifest folder participates" – dropping a new manifest whose `match` is
// reached by the chain's routing pulls it in automatically. LEAN: runs in a throwaway `.consort`
// workspace, no cloud project (a chain with one live agent still only needs a temp dir + the
// agent-report channel).

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runManifestChain, type ManifestRunnerDeps, type ManifestTurn } from "../runners/manifest-runner.js";
import { loadStepManifests, type StepManifest } from "../steps/manifest.js";
import { ARTIFACT_ROOT } from "../../config/consort-paths.js";
import type { StepInstructions } from "../agents/agent-types.js";
import type { WorkflowAction } from "../workflow/workflow-vocabulary.js";
import type { DriveEffectsConfig } from "../drive/orchestrator-effects.js";
import { buildAgent, type AgentBuildContext } from "../agents/agent-catalogue.js";
// The workspace-seed primitive lives in the provisioning family (the ONE overlay home); re-export
// layDownKitAgents so this module's long-standing importers keep working unchanged.
import { layDownKitAgents } from "../provisioning/bundle.js";
export { layDownKitAgents } from "../provisioning/bundle.js";

/** What the caller supplies to run an integration chain from a manifest folder. */
export interface IntegrationChainConfig {
  /** Directory of manifests to load (ALL .json in it participate). */
  manifestDir: string;
  /** The recorded intake the replay agents copy from. */
  intakeDir: string;
  /** The feature id the chain designs. */
  feature: string;
  /** The action the chain starts from. */
  start: WorkflowAction;
  /** Per-role output-path remap (a live agent writes to a baked cwd-relative path, e.g.
   *  ux-designer -> .consort/design/design-guide.json). Keyed by role. */
  outputPathsByRole?: Record<string, Record<string, string>>;
  /** Per-role instruction bundle (the live agent's prompt). Receives the run's workspace dir so
   *  a build chain can compute the real buildContextPack against the SEEDED workspace .consort. */
  instructionsFor?(manifest: StepManifest, workspaceDir: string): StepInstructions;
  /** OPTIONAL agent override – build the StepAgent for a manifest imperatively instead of
   *  resolving manifest.agent via the catalogue. This is the LEVER-INJECTION seam the per-role
   *  optimize sweep uses: return a ClaudeStepAgent built from patched levers (model/effort/tool
   *  scope) for the live role's manifest, and undefined for the others (so they fall through to
   *  the catalogue = the replay seed). When absent, every manifest resolves via the catalogue
   *  (the default live run). */
  agentFor?(manifest: StepManifest): import("../agents/agent-types.js").StepAgent | undefined;
  /** OPTIONAL extra workspace-relative roots (besides `.consort`) to include in the preserved
   *  producedArtifacts snapshot. A BUILD-turn chain's navigator/driver writes CODE at the
   *  workspace root (tests/, app/), which the default `.consort`-only snapshot would drop – naming
   *  those roots here preserves them. Default empty ⇒ design chains snapshot only `.consort`
   *  (byte-identical to before). */
  extraSnapshotRoots?: string[];
  /** OPTIONAL per-precondition-kind options merged into that preparer's projection (parallel-safe,
   *  per-run). The test-strategist sweep passes `{ "test-analyst-roster": { analystOverrides } }` so
   *  the supervisor spawns each analyst Task with the swept per-analyst levers. Absent ⇒ unchanged. */
  preconditionOptions?: Record<string, Record<string, unknown>>;
  /** OPTIONAL seed hook: run AFTER the throwaway workspace + kit agents are laid down and BEFORE the
   *  chain runs, to populate the workspace with pre-turn state directly (instead of via seed-replay
   *  manifests). The REPLAY experiment path uses this to lay a corpus turn's recorded preconditions
   *  (layReplayPreconditions + recorded inputs) so the lean lane replays the SAME recorded state as the
   *  cloud lane. Receives the workspace dir. Absent ⇒ seeding is manifest-driven (the default). */
  seedWorkspace?(workspaceDir: string): void;
  /** OPTIONAL replay prompt: the corpus turn's recorded prompt.txt, rehydrated to THIS run's workspace
   *  (the closure receives the workspace dir so the caller can swap the <PROJECT_ROOT> token). When set,
   *  it becomes the turn's base body verbatim (via instructionsFor) AND gates the executor's phase-2.5
   *  precondition prep (via cfg.instructionsOverride) – so the lean lane replays the recorded prompt with
   *  no regenerated context or re-injection, exactly like the cloud lane. Absent ⇒ the normal
   *  instructionsFor/manifest path. */
  recordedPromptFor?(workspaceDir: string): string;
}

/** What one integration-chain run reports. */
export interface IntegrationChainResult {
  turns: ManifestTurn[];
  /** The workspace the chain ran in (already removed by the time this returns). */
  workspaceDir: string;
  /** ALWAYS-ON artifact preservation: a snapshot of the produced `.consort` tree ({workspace-
   *  relative path -> file contents}), read BEFORE the workspace is torn down. Every run keeps
   *  its produced outputs – telemetry alone cannot reproduce or re-judge a result, so this is
   *  not optional (see the preserve-experiment-artifacts rule). A caller (the sweep) persists
   *  this to a durable per-experiment dir + can score any file in it. */
  producedArtifacts: Record<string, string>;
}

/**
 * Run an integration chain end to end in a throwaway `.consort` workspace, following the loaded
 * manifests' routing from `start`. The live agent (if any) authors an agent-report the
 * orchestrator formats into a conformant agent-log (formatAgentReports on). Removes the
 * workspace in a finally. No cloud – the whole chain is a temp dir.
 */
export async function runIntegrationChain(config: IntegrationChainConfig): Promise<IntegrationChainResult> {
  const manifests = loadStepManifests(config.manifestDir);
  const workspaceDir = mkdtempSync(join(tmpdir(), "integration-chain-"));
  mkdirSync(join(workspaceDir, ARTIFACT_ROOT), { recursive: true });
  // Lay the kit's role agent definitions into <workspaceDir>/.claude/agents/ so a LIVE claude
  // step can resolve `--agent <role>` (spec-author / ux-designer / ...). This is the ONE thing a
  // live agent needs from the workspace that a bare temp dir lacks – a plain file copy from the
  // kit's own agent defs, NOT a cloud project. (claudeBaseArgs passes --setting-sources project
  // so the CLI loads these project-local agents.)
  layDownKitAgents(workspaceDir);

  // REPLAY seed: populate the workspace with the recorded pre-turn state (preconditions + inputs) before
  // the chain runs, so a turn can be replayed from a corpus turn's recorded state rather than seed-replay
  // manifests. Runs once, after the workspace exists, before any turn.
  config.seedWorkspace?.(workspaceDir);

  const agentContext: Omit<AgentBuildContext, "workspaceDir"> = {
    corpusRoot: config.intakeDir,
    kitDir: process.cwd(),
  };

  // REPLAY: the recorded prompt, rehydrated to this workspace. When set, it is the turn's base body AND
  // gates phase-2.5 (cfg.instructionsOverride) so no regenerated context / re-injection – the lean lane
  // behaves exactly like the cloud lane's instructionsOverride path.
  const recordedPrompt = config.recordedPromptFor?.(workspaceDir);
  const runnerDeps: ManifestRunnerDeps = {
    workspaceDir,
    cfg: {
      projectDir: workspaceDir,
      consortDir: join(workspaceDir, ARTIFACT_ROOT),
      featureId: config.feature,
      ...(recordedPrompt !== undefined ? { instructionsOverride: () => recordedPrompt } : {}),
    } as DriveEffectsConfig,
    agentContext,
    formatAgentReports: true,
    ...(recordedPrompt !== undefined
      ? {
          // The recorded prompt is the base body; the agent-report guideline is REQUIRED so the turn ends
          // with the structured report the orchestrator formats into agent-log.jsonl (the manifest's
          // navigatorLoggedAuthoring / *LoggedAuthoring output validator). Without it the turn produces its
          // artifact but the log-authoring output fails to validate and the step emits "blocked".
          instructionsFor: (_m: StepManifest, _a: WorkflowAction, _ws: string) => ({
            prompt: recordedPrompt,
            // NO added guideline: the recorded prompt is the turn's real instruction – it already tells the
            // agent how to log (via `scripts/lk consort-log`), which the lean workspace now provides
            // (scripts/lk shim + Bash restored). Adding a guideline that forbids commands or prescribes a
            // different channel would contradict the recording; the whole point is to replay it faithfully.
            // (formatAgentReports stays on as a harmless fallback if the agent also emits a report block.)
            guidelines: [],
          }),
        }
      : config.instructionsFor
        ? { instructionsFor: (m: StepManifest, _a: WorkflowAction, ws: string) => config.instructionsFor!(m, ws) }
        : {}),
    // Lever-injection seam: when a config.agentFor returns an override for a manifest, use it;
    // otherwise fall back to the catalogue (manifest.agent) so the seed/other steps are unchanged.
    // Only wired when config.agentFor is set, so the default run is byte-identical.
    ...(config.agentFor
      ? {
          agentFor: (m: StepManifest) => {
            const override = config.agentFor!(m);
            return override ?? buildAgent(m.agent!, { workspaceDir, ...agentContext });
          },
        }
      : {}),
    provisionWorkspace: (m: StepManifest) => {
      const outputPaths = config.outputPathsByRole?.[m.role];
      return outputPaths ? { workspaceDir, outputPaths } : { workspaceDir };
    },
    // Surface a turn's output-VALIDATION violations (the reason a step emits "blocked" + re-issues).
    // Previously computed but never shown, so a blocked lean turn aborted with only "blocked" and no
    // cause. Log them so the failing validator is visible (observability, not load-bearing).
    onRecord: (rec: { action: WorkflowAction; violations: string[] }) => {
      if (rec.violations.length) {
        process.stderr.write(`[integration-chain] step ${JSON.stringify(rec.action)} VIOLATIONS: ${rec.violations.join(" ; ")}\n`);
      }
    },
    ...(config.preconditionOptions ? { preconditionOptions: config.preconditionOptions } : {}),
  };
  // A live claude agent resolves the kit for its self-check/log; point at the kit root.
  process.env.LAKEBASE_KIT_DIR = process.cwd();

  try {
    const turns = await runManifestChain(config.start, manifests, runnerDeps);
    // ALWAYS preserve the produced outputs BEFORE teardown: snapshot the whole `.consort` tree
    // (every file the run wrote) into a {relpath -> contents} map. A run's produced artifacts
    // must survive the throwaway workspace – telemetry alone cannot reproduce or re-judge a
    // result (see the preserve-experiment-artifacts rule). A caller persists this to a durable
    // per-experiment dir. Never optional.
    const producedArtifacts = snapshotTree(join(workspaceDir, ARTIFACT_ROOT), workspaceDir);
    // A BUILD chain's navigator/driver writes CODE at the workspace root (tests/, app/); the
    // default `.consort`-only snapshot drops it. Merge in any declared extra roots so the produced
    // code survives teardown too. Design chains pass none => this is a no-op (byte-identical).
    for (const root of config.extraSnapshotRoots ?? []) {
      Object.assign(producedArtifacts, snapshotTree(join(workspaceDir, root), workspaceDir));
    }
    return { turns, workspaceDir, producedArtifacts };
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

/** Snapshot every file under `root` into a { path-relative-to-`relTo` : contents } map. Used to
 *  preserve a run's produced artifacts before the workspace is torn down. Absent root -> {}. */
export function snapshotTree(root: string, relTo: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out[relative(relTo, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}
