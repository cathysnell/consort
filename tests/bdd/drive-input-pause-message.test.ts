// The planning `author-requests` pause message must reflect DISK STATE, not a
// fixed script. A staged first-project (and any prior propose turn) already has
// feature-request.md files, so telling the human to "author the sprint's
// feature-requests" there is the misread that makes /sprint look like the
// orchestrator is confused. composeInputPause branches: author-then-commit when
// nothing exists; COMMIT-only (naming the exact sync-backlog command, pre-filled
// from the Spec Author's proposals) when requests already exist.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { featureRequestMd, featureProposalsMd } from "../../consort/config/consort-paths.js";
import { composeInputPause } from "../../bin/consort/drive.cli.js";
import type { WorkflowAction } from "../../consort/orchestrator/workflow/workflow-vocabulary.js";

const ACTION: WorkflowAction = { kind: "invoke-role", role: "product-owner", mode: "author-requests" };
const AUTHOR_PHRASE = "author the sprint's feature-request(s)";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "inputpause-"));
});
afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});

function authorRequest(id: string): void {
  const f = featureRequestMd(tdd, id);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, `# ${id}\n\nAs a user I want ${id}.\n`);
}

function writeProposals(...ids: string[]): void {
  const p = featureProposalsMd(tdd);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `# candidates\n\n${ids.map((i) => `## ${i}\n`).join("\n")}`);
}

describe("composeInputPause – the planning author-requests pause", () => {
  it("never reads as approved/complete (nothing produced yet)", () => {
    expect(composeInputPause(ACTION, "s1", tdd)).toContain("PAUSED");
  });

  it("NO feature-request.md yet => tells the PO to AUTHOR, then commit", () => {
    const msg = composeInputPause(ACTION, "s1", tdd);
    expect(msg).toContain("No feature-request.md exists yet");
    expect(msg).toContain(AUTHOR_PHRASE);
    expect(msg).toContain("consort-sync-backlog --sprint s1");
  });

  it("requests already staged => a COMMIT decision, NOT an authoring task", () => {
    authorRequest("F1-stock-visibility");
    authorRequest("F2-stock-adjustment");
    const msg = composeInputPause(ACTION, "s1", tdd);
    expect(msg).toContain("DECISION, not an authoring task");
    expect(msg).toContain("already authored");
    expect(msg).toContain("F1-stock-visibility");
    expect(msg).toContain("F2-stock-adjustment");
    // The whole point: do NOT tell the human to author requests that exist.
    expect(msg).not.toContain(AUTHOR_PHRASE);
    // No proposal was written here, so it must NOT guess the backlog (pre-filling
    // ALL authored folders would be wrong); it names the commit command with the
    // placeholder so the human picks the sprint's features by folder id.
    expect(msg).toContain("consort-sync-backlog --sprint s1 --features <id[,id...]>");
  });

  it("pre-fills --features from the Spec Author's proposals, not all authored ids", () => {
    authorRequest("F1-stock-visibility");
    authorRequest("F2-stock-adjustment");
    authorRequest("F3-inbound-receipt"); // authored but NOT proposed for this sprint
    writeProposals("F1-stock-visibility", "F2-stock-adjustment");
    const msg = composeInputPause(ACTION, "s1", tdd);
    expect(msg).toContain("Planning proposed for this sprint: F1-stock-visibility, F2-stock-adjustment");
    expect(msg).toContain("--features F1-stock-visibility,F2-stock-adjustment");
    // F3 is authored but not proposed, so it must not be pre-filled into the commit.
    expect(msg).not.toContain("F2-stock-adjustment,F3-inbound-receipt");
  });

  it("does NOT pre-fill proposal labels that are not authored folder ids (positional-id proposal)", () => {
    // The authored folders use slug ids; the Spec Author's proposal uses its OWN
    // positional labels (## F1, ## F2, ...). Regression (v0.3.21): those labels were
    // lifted verbatim into `--features F1,F2,F3,F4,F5`, which sync-backlog can't
    // resolve (exact folder-id match) – an empty backlog – and which a prefix matcher
    // would mis-map (F5 -> the DEFERRED F5-cycle-count).
    for (const f of ["F1-stock-visibility", "F2-stock-adjustment", "F3-inbound-receipt", "F4-outbound-pick", "F5-cycle-count"]) {
      authorRequest(f);
    }
    writeProposals("F1", "F2", "F3", "F4", "F5"); // positional labels, NOT folder ids
    const msg = composeInputPause(ACTION, "s1", tdd);
    // The regression must not recur: raw positional labels are never pre-filled.
    expect(msg).not.toContain("--features F1,F2,F3,F4,F5");
    // Instead: the placeholder + a note naming the proposal's (non-folder) labels.
    expect(msg).toContain("--features <id[,id...]>");
    expect(msg).toContain("NOT the authored");
    expect(msg).toContain("F1, F2, F3, F4, F5");
    // The deferred cycle-count must never be silently pulled into a pre-fill.
    expect(msg).not.toContain("--features F5-cycle-count");
  });

  it("pre-fills only the proposal ids that ARE authored folders (partial match)", () => {
    authorRequest("F1-stock-visibility");
    authorRequest("F2-stock-adjustment");
    writeProposals("F1-stock-visibility", "F99-bogus"); // one real folder, one not
    const msg = composeInputPause(ACTION, "s1", tdd);
    expect(msg).toContain("--features F1-stock-visibility\n"); // only the valid one
    expect(msg).toContain("F99-bogus"); // flagged in the mismatch note
    expect(msg).toContain("NOT the authored");
  });

  it("no consortDir (single-feature driver path) => falls back to the author message", () => {
    const msg = composeInputPause(ACTION);
    expect(msg).toContain(AUTHOR_PHRASE);
  });
});
