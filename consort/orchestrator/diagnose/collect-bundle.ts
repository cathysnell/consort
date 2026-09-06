// Resolve the LOCAL forensic artifacts worth collecting when a run fails – the
// bundle that actually troubleshoots (or is shared for) an error. Telemetry is
// deliberately content-free (allowlisted enums/counts/durations); THIS is where the
// error text, failing assertion, and reason live, and it is captured on disk at any
// telemetry level. `consort-diagnose` copies these into `.consort/diagnostics/<ts>/`.
//
// Pure + I/O-light: `collectDiagnosticSources` returns the candidate sources and
// whether each EXISTS, so the bin copies only what is present and the selection is
// unit-testable off a fixture dir.

import * as fs from "node:fs";
import * as path from "node:path";
import { escalationsDir, cyclesRootDir } from "../../config/consort-paths.js";

export type DiagnosticKind =
  | "escalation" // escalations/<id>.json – the raise-to-HIL reason + source
  | "green-failure" // cycles/**/green-failure.json – the verify-failure pre-localization
  | "workflow-state" // workflow-state.json – where the run was
  | "agent-log" // agent-log.jsonl – the structured event trail (tailed)
  | "drive-live"; // drive-live.log – the live narration (tailed)

export interface DiagnosticSource {
  kind: DiagnosticKind;
  /** Absolute source path. */
  path: string;
  /** Does it exist on disk right now? (Only existing sources are collected.) */
  exists: boolean;
  /** When set, copy only the last N lines (large append-only logs). */
  tailLines?: number;
}

/** Recursively find files named `name` under `root` (bounded, skips dotdirs deeper
 *  than the root). Returns [] when `root` is absent. */
function findByName(root: string, name: string): string[] {
  const out: string[] = [];
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
      else if (e.isFile() && e.name === name) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The forensic sources to collect for a run's diagnostic bundle, most-specific
 * first. `escalations/*.json` and every `cycles/**​/green-failure.json` are
 * enumerated from disk; the fixed logs/state are included with an `exists` flag.
 */
export function collectDiagnosticSources(consortDir: string): DiagnosticSource[] {
  const sources: DiagnosticSource[] = [];

  // Every recorded escalation (the raise-to-HIL reason + source).
  try {
    for (const f of fs.readdirSync(escalationsDir(consortDir)).filter((n) => n.endsWith(".json")).sort()) {
      sources.push({ kind: "escalation", path: path.join(escalationsDir(consortDir), f), exists: true });
    }
  } catch {
    /* no escalations dir */
  }

  // Every verify-failure pre-localization across cycles.
  for (const gf of findByName(cyclesRootDir(consortDir), "green-failure.json")) {
    sources.push({ kind: "green-failure", path: gf, exists: true });
  }

  // The fixed run-context files (included with an exists flag; the two big logs are tailed).
  const fixed: Array<[DiagnosticKind, string, number?]> = [
    ["workflow-state", path.join(consortDir, "workflow-state.json")],
    ["agent-log", path.join(consortDir, "agent-log.jsonl"), 300],
    ["drive-live", path.join(consortDir, "drive-live.log"), 500],
  ];
  for (const [kind, p, tail] of fixed) {
    sources.push({ kind, path: p, exists: fs.existsSync(p), ...(tail ? { tailLines: tail } : {}) });
  }

  return sources;
}
