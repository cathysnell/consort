// Correspondence observability: the run-level transcript of the orchestrator<->HIL exchange the turn
// recorder otherwise lacks – the orchestrator's REQUEST paired with the proxy's ANSWER/SUBMISSION +
// outcome, WITH the rich presentation (formatting/highlighting) of what was shown. recordCorrespondence
// must append one well-formed JSONL line per exchange, preserving presentation. These pin the writer +
// the entry shape (the projection from a live HIL touchpoint is proven by the capture run).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordCorrespondence, type CorrespondenceEntry } from "../../consort/logging/turn-recorder";

describe("recordCorrespondence: append the orchestrator<->HIL exchange to correspondence.jsonl", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "corr-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const kickoff: CorrespondenceEntry = {
    seq: 0,
    iteration: -1,
    at: new Date().toISOString(),
    request: {
      kind: "kickoff",
      prompt: "/sprint stockflow-rerecord-s1 --gates proxy",
      presentation: { format: "markdown", rendered: "`/sprint stockflow-rerecord-s1 --gates proxy`" },
    },
    response: { by: "human-proxy" },
    outcome: { validated: true },
  };

  it("writes one JSONL line carrying request + response + outcome + presentation", () => {
    recordCorrespondence(dir, kickoff);
    const f = join(dir, "correspondence.jsonl");
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as CorrespondenceEntry;
    expect(rec.seq).toBe(0);
    expect(rec.request.kind).toBe("kickoff");
    // The kickoff command's formatting is preserved (the user's "capture formatting" requirement).
    expect(rec.request.presentation?.format).toBe("markdown");
    expect(rec.request.presentation?.rendered).toContain("/sprint");
    expect(rec.outcome.validated).toBe(true);
  });

  it("preserves an intake-interview's questions + the proxy's paired answers + submission + presentation", () => {
    const interview: CorrespondenceEntry = {
      seq: 1,
      iteration: 0,
      at: new Date().toISOString(),
      phase: "planning",
      step: "product-overview",
      request: {
        kind: "intake-interview",
        prompt: "PO interview → product-overview.md",
        questions: ["What is the product, in a sentence?", "Who uses it?"],
        presentation: { format: "markdown", rendered: "## PO interview\n1. **What is the product?**\n2. **Who uses it?**" },
      },
      response: {
        by: "human-proxy",
        answers: [
          { question: "What is the product, in a sentence?", answer: "A stock-visibility tool." },
          { question: "Who uses it?", answer: "Warehouse operators." },
        ],
        submitted: [{ artifact: "product-overview.md", from: "intake/product-overview.md", contentRef: "product-overview.md" }],
        presentation: { format: "markdown", rendered: "# Product Overview\n\nA **stock-visibility** tool for warehouse operators." },
      },
      outcome: { validated: true },
    };
    recordCorrespondence(dir, interview);
    const rec = JSON.parse(readFileSync(join(dir, "correspondence.jsonl"), "utf8").trim()) as CorrespondenceEntry;
    expect(rec.request.questions).toHaveLength(2);
    expect(rec.response.answers?.[0].answer).toBe("A stock-visibility tool.");
    expect(rec.response.submitted?.[0].artifact).toBe("product-overview.md");
    // Both sides' formatting is captured (headings/bold preserved for a faithful re-render).
    expect(rec.request.presentation?.rendered).toContain("**What is the product?**");
    expect(rec.response.presentation?.rendered).toContain("**stock-visibility**");
  });

  it("records a gate exchange: decision + outcome.approved + violations on a reject", () => {
    const gateReject: CorrespondenceEntry = {
      seq: 2,
      iteration: 4,
      at: new Date().toISOString(),
      phase: "feature",
      request: { kind: "gate", prompt: "approve spec gate for F1", presentation: { format: "markdown", rendered: "**Gate: spec** for F1" } },
      response: { by: "human-proxy", decision: "rejected", presentation: { format: "markdown", rendered: "- product-owner rejected gate spec: 2 violations" } },
      outcome: { validated: false, approved: false, violations: ["missing acceptance criteria", "no error states"] },
    };
    recordCorrespondence(dir, gateReject);
    const rec = JSON.parse(readFileSync(join(dir, "correspondence.jsonl"), "utf8").trim()) as CorrespondenceEntry;
    expect(rec.response.decision).toBe("rejected");
    expect(rec.outcome.approved).toBe(false);
    expect(rec.outcome.violations).toEqual(["missing acceptance criteria", "no error states"]);
  });

  it("APPENDS one line per exchange, accumulating a whole session's transcript in order", () => {
    recordCorrespondence(dir, kickoff);
    recordCorrespondence(dir, { ...kickoff, seq: 1, request: { ...kickoff.request, kind: "author-requests", prompt: "author feature-requests" } });
    const lines = readFileSync(join(dir, "correspondence.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as CorrespondenceEntry).seq).toBe(0);
    expect((JSON.parse(lines[1]) as CorrespondenceEntry).request.kind).toBe("author-requests");
  });
});
