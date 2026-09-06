// The corpus expression audit is the engine of the audit -> fix -> re-record loop. These guards
// build synthetic corpora (a clean one + one carrying each discrepancy) and assert auditCorpus
// reports exactly the right findings – so the loop can trust a CLEAN verdict and act on each code.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCorpus, renderAuditReport } from "../../consort/logging/audit-corpus";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-corpus-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a turn dir with a manifest, a delta file, and optionally a transcript + green-failure. */
function writeTurn(
  ordinal: number,
  o: { label: string; kind: string; role?: string; mode?: string; transcript?: boolean; greenFailure?: boolean; emptyDelta?: boolean; noManifest?: boolean },
): { ordinal: number; label: string; kind: string; role?: string; mode?: string; dir: string; producedCount: number; hasTranscript?: boolean } {
  const dirName = `${String(ordinal).padStart(4, "0")}-${o.label}`;
  const turnDir = join(dir, "turns", dirName);
  mkdirSync(join(turnDir, "files", "app"), { recursive: true });
  if (!o.emptyDelta) writeFileSync(join(turnDir, "files", "app", "models.py"), "class X: pass\n");
  if (o.greenFailure) writeFileSync(join(turnDir, "files", "green-failure.json"), '{"assessed":false}');
  if (!o.noManifest) writeFileSync(join(turnDir, "turn.json"), JSON.stringify({ ordinal, label: o.label, kind: o.kind }));
  if (o.transcript) writeFileSync(join(turnDir, "transcript.md"), "# turn\n");
  return { ordinal, label: o.label, kind: o.kind, role: o.role, mode: o.mode, dir: dirName, producedCount: 1, hasTranscript: o.transcript };
}

function writeIndex(entries: unknown[]): void {
  mkdirSync(join(dir, "turns"), { recursive: true });
  writeFileSync(join(dir, "turns", "index.json"), JSON.stringify({ turns: entries }));
}

function writeRouting(count: number, opts: { emptyBagAt?: number[] } = {}): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const emptyBag = opts.emptyBagAt?.includes(i);
    lines.push(JSON.stringify({ iteration: i, source: "nextTransition", action: { kind: "invoke-role" }, stateBag: emptyBag ? {} : { phase: "feature", reviewStoryPending: true }, at: "t" }));
  }
  writeFileSync(join(dir, "routing-decisions.jsonl"), lines.join("\n") + "\n");
}

describe("auditCorpus: a fully-expressed corpus is CLEAN", () => {
  it("clean: every turn has manifest + delta, agent turns have transcripts, routing matches", () => {
    const t0 = writeTurn(0, { label: "spec-author-breakdown", kind: "invoke-role", role: "spec-author", transcript: true });
    const t1 = writeTurn(1, { label: "gate-spec", kind: "approve-gate" }); // non-agent: no transcript needed
    writeIndex([t0, t1]);
    writeRouting(2);
    const r = auditCorpus(dir);
    expect(r.clean).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.turnCount).toBe(2);
    expect(r.routingCount).toBe(2);
  });
});

describe("auditCorpus: each discrepancy is reported with its code", () => {
  it("no-index / no-turns when nothing recorded", () => {
    const r = auditCorpus(dir);
    expect(r.findings.map((f) => f.code)).toContain("no-index");
    expect(r.findings.map((f) => f.code)).toContain("no-turns");
  });

  it("agent-turn-missing-transcript when an invoke-role turn lacks transcript.md", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: false });
    writeIndex([t0]);
    writeRouting(1);
    const codes = auditCorpus(dir).findings.map((f) => f.code);
    expect(codes).toContain("agent-turn-missing-transcript");
  });

  it("turn-missing-delta when a turn recorded an empty files/ delta", () => {
    const t0 = writeTurn(0, { label: "gate-spec", kind: "approve-gate", emptyDelta: true });
    writeIndex([t0]);
    writeRouting(1);
    expect(auditCorpus(dir).findings.map((f) => f.code)).toContain("turn-missing-delta");
  });

  it("turn-missing-manifest when turn.json is absent", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: true, noManifest: true });
    writeIndex([t0]);
    writeRouting(1);
    expect(auditCorpus(dir).findings.map((f) => f.code)).toContain("turn-missing-manifest");
  });

  it("no-routing-log when routing-decisions.jsonl is absent (the instrumentation gap)", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: true });
    writeIndex([t0]);
    // no writeRouting
    expect(auditCorpus(dir).findings.map((f) => f.code)).toContain("no-routing-log");
  });

  it("routing-count-mismatch when decisions != turns", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: true });
    const t1 = writeTurn(1, { label: "gate-spec", kind: "approve-gate" });
    writeIndex([t0, t1]);
    writeRouting(1); // 2 turns, 1 decision
    expect(auditCorpus(dir).findings.map((f) => f.code)).toContain("routing-count-mismatch");
  });

  it("routing-empty-bag when a decision carries a blank state bag", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: true });
    writeIndex([t0]);
    writeRouting(1, { emptyBagAt: [0] });
    expect(auditCorpus(dir).findings.map((f) => f.code)).toContain("routing-empty-bag");
  });
});

describe("auditCorpus: requireAssess proves the failing-green path was captured", () => {
  it("no-assess-turn when requireAssess but no assess turn exists", () => {
    const t0 = writeTurn(0, { label: "navigator-review", kind: "invoke-role", role: "navigator", mode: "review", transcript: true });
    writeIndex([t0]);
    writeRouting(1);
    expect(auditCorpus(dir, { requireAssess: true }).findings.map((f) => f.code)).toContain("no-assess-turn");
  });

  it("assess-missing-green-failure when an assess turn exists but its delta lacks the marker", () => {
    const t0 = writeTurn(0, { label: "navigator-assess", kind: "invoke-role", role: "navigator", mode: "assess", transcript: true, greenFailure: false });
    writeIndex([t0]);
    writeRouting(1);
    expect(auditCorpus(dir, { requireAssess: true }).findings.map((f) => f.code)).toContain("assess-missing-green-failure");
  });

  it("CLEAN with requireAssess when an assess turn recorded its green-failure.json", () => {
    const t0 = writeTurn(0, { label: "navigator-assess", kind: "invoke-role", role: "navigator", mode: "assess", transcript: true, greenFailure: true });
    writeIndex([t0]);
    writeRouting(1);
    const r = auditCorpus(dir, { requireAssess: true });
    expect(r.clean).toBe(true);
  });
});

describe("renderAuditReport", () => {
  it("renders CLEAN headline when no findings", () => {
    const t0 = writeTurn(0, { label: "driver", kind: "invoke-role", role: "driver", transcript: true });
    writeIndex([t0]);
    writeRouting(1);
    expect(renderAuditReport(auditCorpus(dir))).toMatch(/CLEAN/);
  });
  it("renders each finding on its own line with its code", () => {
    writeIndex([]);
    const out = renderAuditReport(auditCorpus(dir));
    expect(out).toMatch(/no-turns/);
    expect(out.split("\n").length).toBeGreaterThan(1);
  });
});
