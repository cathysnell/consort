// resolveEscalations – the supported "clear a HIL halt after fixing its root cause"
// path (consort-resolve-escalation), replacing a hand `rm` of the record. It stamps
// resolved_at (+ optional note) and KEEPS the file; firstPendingEscalation ignores
// resolved records, so the drive stops pre-empting and retries.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync as fsWrite } from "fs";
import {
  writeEscalation,
  readEscalations,
  resolveEscalations,
  firstPendingEscalation,
  escalationsFromSmells,
} from "../../consort/gates/escalation";
import { resolveOpenSmells } from "../../consort/smells/smells";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "resolve-esc-"));
});
afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

describe("resolveEscalations", () => {
  it("stamps resolved_at (keeping the record) so the escalation is no longer pending", () => {
    const e = writeEscalation(tdd, { source: "deploy-verify", reason: "port 8000 busy", feature_id: "F1" });
    expect(firstPendingEscalation(tdd)).not.toBeNull();

    const ids = resolveEscalations(tdd, { resolution: "freed port 8000" });
    expect(ids).toEqual([e.id]);
    // Record is KEPT (not deleted) – audit trail.
    expect(existsSync(join(tdd, "escalations", `${e.id}.json`))).toBe(true);
    const after = readEscalations(tdd).find((x) => x.id === e.id)!;
    expect(after.resolved_at).toBeTruthy();
    expect(after.resolution).toBe("freed port 8000");
    // No longer blocking.
    expect(firstPendingEscalation(tdd)).toBeNull();
  });

  it("scopes by id / feature / story; leaves non-matching escalations pending", () => {
    const a = writeEscalation(tdd, { source: "deploy-verify", reason: "a", feature_id: "F1", story_id: "S1" });
    const b = writeEscalation(tdd, { source: "driver-green", reason: "b", feature_id: "F2", story_id: "S9" });
    const ids = resolveEscalations(tdd, { id: a.id });
    expect(ids).toEqual([a.id]);
    // b is untouched / still pending.
    const remaining = readEscalations(tdd).filter((x) => !x.resolved_at).map((x) => x.id);
    expect(remaining).toEqual([b.id]);
  });

  it("no scope resolves ALL pending explicit escalations", () => {
    writeEscalation(tdd, { source: "deploy-verify", reason: "a", feature_id: "F1" });
    writeEscalation(tdd, { source: "driver-green", reason: "b", feature_id: "F2" });
    const ids = resolveEscalations(tdd, {});
    expect(ids).toHaveLength(2);
    expect(readEscalations(tdd).every((x) => x.resolved_at)).toBe(true);
  });

  it("is a no-op on an already-resolved escalation", () => {
    const e = writeEscalation(tdd, { source: "deploy-verify", reason: "a", feature_id: "F1" });
    resolveEscalations(tdd, { id: e.id });
    expect(resolveEscalations(tdd, { id: e.id })).toEqual([]); // nothing left pending
  });
});

describe("blocking-smell blockers (the dual-source rule – T27's kind)", () => {
  it("a blocking smell surfaces as a pending escalation and clears via resolveOpenSmells", () => {
    // A blocking reflect-gate smell (no escalation FILE) – the T27 case.
    fsWrite(
      join(tdd, "smells.json"),
      JSON.stringify({
        detected: [{ smell: "reflect-testlist-defect", story_id: "S2", ac_id: "AC1", detail: "T27 mis-anchored", detected_at: "2026-01-01T00:00:00Z" }],
      }),
    );
    // It is a pending blocker (what `consort-resolve-escalation --list` shows).
    const pending = escalationsFromSmells(tdd, "F1");
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("smell:reflect-testlist-defect");

    // Clearing it (kind:"cleared", the CLI's smell path) resolves the open entry and
    // it is no longer a pending blocker.
    expect(resolveOpenSmells(tdd, "reflect-testlist-defect", { story_id: "S2", kind: "cleared" })).toBe(1);
    expect(escalationsFromSmells(tdd, "F1")).toHaveLength(0);
  });
});

describe("writeEscalation: the record self-documents its resolve path (so a session never hand-edits it)", () => {
  it("stamps how_to_resolve pointing at consort-resolve-escalation --id <id>, and warns off hand-editing", () => {
    const e = writeEscalation(tdd, { source: "deploy-verify", reason: "port 8000 busy", feature_id: "F1" });
    expect(e.how_to_resolve).toContain("consort-resolve-escalation");
    expect(e.how_to_resolve).toContain(`--id ${e.id}`);
    expect(e.how_to_resolve ?? "").toMatch(/do NOT hand-edit/i);
    expect(e.how_to_resolve ?? "").toMatch(/smells\.json/i);
    // Persisted to disk (what a session opening the file directly actually reads), not just returned.
    const onDisk = readEscalations(tdd).find((x) => x.id === e.id);
    expect(onDisk?.how_to_resolve).toBe(e.how_to_resolve);
  });
});
