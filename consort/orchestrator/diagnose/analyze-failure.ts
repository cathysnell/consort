// Analyze a failed run from its LOCAL forensics – the deterministic half of
// `consort-diagnose`. It reads the escalation(s) + every cycle's green-failure.json
// and classifies the failure, extracts the real reason/assertion, and suggests a
// remediation the driving session can ATTEMPT (troubleshoot). The session does the
// reasoning/acting + the share prompt; this gives it a structured starting point
// instead of re-scanning the tree. Pure + I/O-light => unit-testable off a fixture.

import * as fs from "node:fs";
import * as path from "node:path";
import { cyclesRootDir } from "../../config/consort-paths.js";
import { readEscalations, type Escalation } from "../../gates/escalation.js";

export type FailureClass = "deploy-verify" | "driver-green" | "smell" | "protocol" | "unknown";

export interface GreenFailureFinding {
  /** cycle-relative location, e.g. F1-.../S1-.../AC1-... */
  location: string;
  summary: string;
  /** Tail of the verify's own failure output (failing node-ids + top error). */
  failureOutput?: string;
}

export interface FailureAnalysis {
  hasFailure: boolean;
  /** Unresolved explicit escalations (the HIL halts). */
  escalations: Array<Pick<Escalation, "id" | "source" | "reason" | "feature_id" | "story_id" | "ac_id">>;
  greenFailures: GreenFailureFinding[];
  /** The dominant failure class, derived from the escalation source / presence of green-failures. */
  class: FailureClass;
  /** A human-readable remediation to ATTEMPT for this class (heuristic; the agent acts on it). */
  suggestedRemediation: string;
  /** feature/story location, if a single one dominates. */
  location?: string;
}

/** Classify from an escalation's `source` ("deploy-verify" | "driver-green" |
 *  "smell:<name>" | a role name / protocol). */
function classify(source: string | undefined, hasGreenFailure: boolean): FailureClass {
  if (!source) return hasGreenFailure ? "driver-green" : "unknown";
  if (source === "deploy-verify") return "deploy-verify";
  if (source === "driver-green") return "driver-green";
  if (source.startsWith("smell:")) return "smell";
  if (/protocol/i.test(source)) return "protocol";
  return hasGreenFailure ? "driver-green" : "unknown";
}

function remediationFor(cls: FailureClass, source?: string): string {
  switch (cls) {
    case "deploy-verify":
      return (
        "The deploy gate's verify failed serving the app. Most common cause: the served branch DB was not " +
        "migrated – DB-backed routes 500 with `relation \"...\" does not exist` even though honest-GREEN verify " +
        "(which migrates a disposable child) passed. Check that `deploy-targets.yaml` `local` has a `migrate:` " +
        "command, and that the served branch is on head; also check for a port conflict on the deploy port. " +
        "See the green-failure output below for the exact error."
      );
    case "driver-green":
      return (
        "Honest-GREEN verify failed after the change. Start from the failing test node-ids + top error in the " +
        "green-failure output below; the fix is in the product code or the test per the Navigator's assessment " +
        "(never weaken the assertion). Re-run the build to retry once the cause is addressed."
      );
    case "smell":
      return (
        `A blocking bad-smell was flagged (${source ?? "smell"}). If it is a build smell (layering / ux-adherence / ` +
        "import-time coupling), the remediation is the Navigator-prescribed refactor; if it is a spec-level smell, " +
        "re-running routes a revise. Resolve the smell, then re-run."
      );
    case "protocol":
      return (
        "A protocol violation – a malformed or missing artifact the driver expected. Check the named artifact " +
        "(often an AC or test-list JSON) is well-formed, then re-run."
      );
    default:
      return "Review the escalation reason and the green-failure output below to localize the cause, then re-run.";
  }
}

/** Walk cycles/** for green-failure.json and parse each into a finding. */
function readGreenFailures(consortDir: string): GreenFailureFinding[] {
  const root = cyclesRootDir(consortDir);
  const out: GreenFailureFinding[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "green-failure.json") {
        try {
          const gf = JSON.parse(fs.readFileSync(p, "utf8")) as { summary?: string; failureOutput?: string };
          out.push({
            location: path.relative(root, path.dirname(p)),
            summary: gf.summary ?? "",
            ...(gf.failureOutput ? { failureOutput: gf.failureOutput } : {}),
          });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.location < b.location ? -1 : 1));
}

/** Build the structured failure analysis from a project's `.consort`. */
export function analyzeFailure(consortDir: string): FailureAnalysis {
  const escalations = readEscalations(consortDir)
    .filter((e) => !e.resolved_at)
    .map((e) => ({
      id: e.id,
      source: e.source,
      reason: e.reason,
      ...(e.feature_id ? { feature_id: e.feature_id } : {}),
      ...(e.story_id ? { story_id: e.story_id } : {}),
      ...(e.ac_id ? { ac_id: e.ac_id } : {}),
    }));
  const greenFailures = readGreenFailures(consortDir);
  const hasFailure = escalations.length > 0 || greenFailures.length > 0;

  const primarySource = escalations[0]?.source;
  const cls = classify(primarySource, greenFailures.length > 0);
  const location =
    escalations[0]?.feature_id || greenFailures[0]?.location
      ? [escalations[0]?.feature_id, escalations[0]?.story_id].filter(Boolean).join("/") || greenFailures[0]?.location
      : undefined;

  return {
    hasFailure,
    escalations,
    greenFailures,
    class: cls,
    suggestedRemediation: remediationFor(cls, primarySource),
    ...(location ? { location } : {}),
  };
}
