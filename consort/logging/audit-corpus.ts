// Corpus expression audit: given a recorded corpus dir (LAKEBASE_CONSORT_RECORD_DIR output),
// check that EVERY turn is fully expressed and the routing "why" was captured. This is the engine
// of the audit -> fix-expression -> re-record loop: it turns "is this recording complete" into a
// deterministic, itemized report, so a discrepancy is a named finding to fix, never a hunch.
//
// It audits ONLY what the recorder is supposed to have written (turn-recorder.ts): turns/index.json,
// each turns/<NNNN>-<label>/turn.json + files/ delta + (for agent turns) transcript.md, and the
// routing-decisions.jsonl diagnostic stream. Pure fs reads; no cloud, no model.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One audit finding: a specific, actionable expression gap in the recorded corpus. */
export interface AuditFinding {
  /** Stable code so the loop can branch on a finding type. */
  code:
    | "no-index"
    | "no-turns"
    | "turn-missing-manifest"
    | "turn-missing-delta"
    | "agent-turn-missing-transcript"
    | "no-routing-log"
    | "routing-count-mismatch"
    | "routing-empty-bag"
    | "no-assess-turn"
    | "assess-missing-green-failure";
  /** Human-readable, points at the exact turn/file. */
  message: string;
  /** The turn dir or file the finding is about, when applicable. */
  where?: string;
}

export interface AuditReport {
  recordDir: string;
  turnCount: number;
  routingCount: number;
  findings: AuditFinding[];
  /** True when findings is empty – the corpus is fully expressed. */
  clean: boolean;
}

interface IndexEntry {
  ordinal: number;
  label: string;
  kind: string;
  role?: string;
  mode?: string;
  dir: string;
  producedCount: number;
  hasTranscript?: boolean;
}

function readIndex(recordDir: string): IndexEntry[] {
  const f = join(recordDir, "turns", "index.json");
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, "utf8")) as { turns?: IndexEntry[] };
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

function readRoutingDecisions(recordDir: string): Array<{ stateBag?: Record<string, unknown> }> {
  const f = join(recordDir, "routing-decisions.jsonl");
  if (!existsSync(f)) return [];
  const out: Array<{ stateBag?: Record<string, unknown> }> = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as { stateBag?: Record<string, unknown> });
    } catch {
      // a malformed line is itself a discrepancy, surfaced as a count mismatch downstream.
    }
  }
  return out;
}

/** True when a turn dir's files/ delta contains at least one file (the turn expressed a change).
 *  A turn that legitimately produces nothing is rare in this corpus; we flag empties for review
 *  rather than assume, so "fully expressed" is proven per turn, not presumed. */
function deltaFileCount(turnDir: string): number {
  const filesDir = join(turnDir, "files");
  if (!existsSync(filesDir)) return 0;
  let n = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) n++;
    }
  };
  walk(filesDir);
  return n;
}

/** Does this turn dir's delta contain a green-failure.json (the assess-path marker)? */
function deltaHasGreenFailure(turnDir: string): boolean {
  const filesDir = join(turnDir, "files");
  if (!existsSync(filesDir)) return false;
  let found = false;
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (found) return;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e === "green-failure.json") found = true;
    }
  };
  walk(filesDir);
  return found;
}

/**
 * Audit a recorded corpus for full expression. Options let the loop scope which invariants apply
 * (a design-only capture has no assess turn, so requireAssess defaults off; a build capture that
 * must prove the assess path sets it on).
 */
export function auditCorpus(
  recordDir: string,
  opts: { requireAssess?: boolean } = {},
): AuditReport {
  const findings: AuditFinding[] = [];
  const index = readIndex(recordDir);
  const routing = readRoutingDecisions(recordDir);

  if (!existsSync(join(recordDir, "turns", "index.json"))) {
    findings.push({ code: "no-index", message: `no turns/index.json under ${recordDir} – nothing was recorded` });
  }
  if (index.length === 0) {
    findings.push({ code: "no-turns", message: "index.json lists zero turns" });
  }

  // Per-turn expression: manifest present, a non-empty delta, and (agent turns) a transcript.
  for (const t of index) {
    const turnDir = join(recordDir, "turns", t.dir);
    if (!existsSync(join(turnDir, "turn.json"))) {
      findings.push({ code: "turn-missing-manifest", message: `turn ${t.ordinal} (${t.dir}) has no turn.json`, where: t.dir });
    }
    if (deltaFileCount(turnDir) === 0) {
      findings.push({ code: "turn-missing-delta", message: `turn ${t.ordinal} (${t.dir}) recorded an EMPTY files/ delta – it expressed no artifact`, where: t.dir });
    }
    if (t.kind === "invoke-role" && !existsSync(join(turnDir, "transcript.md"))) {
      findings.push({ code: "agent-turn-missing-transcript", message: `agent turn ${t.ordinal} (${t.dir}, role=${t.role ?? "?"}) has no transcript.md`, where: t.dir });
    }
  }

  // Routing "why": the diagnostic stream must exist, have one record per turn, and carry a
  // non-empty state bag on each (the review-vs-assess evidence).
  if (routing.length === 0) {
    findings.push({ code: "no-routing-log", message: "no routing-decisions.jsonl – the routing 'why' was not captured (instrumentation off or not wired)" });
  } else {
    if (index.length > 0 && routing.length !== index.length) {
      findings.push({
        code: "routing-count-mismatch",
        message: `routing-decisions count (${routing.length}) != recorded turn count (${index.length}) – not one decision per turn`,
      });
    }
    const emptyBags = routing.filter((r) => !r.stateBag || Object.keys(r.stateBag).length === 0).length;
    if (emptyBags > 0) {
      findings.push({ code: "routing-empty-bag", message: `${emptyBags} routing decision(s) carry an EMPTY state bag – the 'why' is blank` });
    }
  }

  // Assess-path proof (opt-in): the capture must contain at least one assess turn whose delta
  // includes the green-failure.json that triggered it (the failing-green evidence).
  if (opts.requireAssess) {
    const assessTurns = index.filter((t) => t.mode === "assess");
    if (assessTurns.length === 0) {
      findings.push({ code: "no-assess-turn", message: "requireAssess: no navigator assess turn was recorded – the failing-green path was not exercised" });
    } else {
      const withMarker = assessTurns.some((t) => deltaHasGreenFailure(join(recordDir, "turns", t.dir)));
      if (!withMarker) {
        findings.push({ code: "assess-missing-green-failure", message: "requireAssess: an assess turn exists but none recorded a green-failure.json in its delta" });
      }
    }
  }

  return { recordDir, turnCount: index.length, routingCount: routing.length, findings, clean: findings.length === 0 };
}

/** Render an audit report as a concise, itemized string for the loop's log. */
export function renderAuditReport(r: AuditReport): string {
  const head = `[audit] ${r.recordDir}: ${r.turnCount} turns, ${r.routingCount} routing decisions – ${r.clean ? "CLEAN" : `${r.findings.length} finding(s)`}`;
  if (r.clean) return head;
  return [head, ...r.findings.map((f) => `  - [${f.code}] ${f.message}`)].join("\n");
}
