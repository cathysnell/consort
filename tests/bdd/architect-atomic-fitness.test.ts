// Proactive fix for the layering-NFR reflect<->revise thrash seen live (portfolio-manager19):
// a COMPOUND fitness_function (all four directional layering checks packed into one prose
// string) forces the Test Strategist to infer N tests from one string and makes the navigator's
// reflect surface the uncovered sub-clauses ONE-PER-LAP — a full-design revise each lap that
// burns the reflect budget (3 reflect cycles + 3 re-designs before it converged). The architect
// must instead emit ATOMIC per-clause NFRs (one fitness obligation per nfrs[] entry) so coverage
// is 1:1 and the design converges in a single reflect pass. This guards that instruction stays in
// the architect prompt.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ARCHITECT = path.resolve(__dirname, "..", "..", "skills", "consort", "agents", "architect-reviewer.md");

describe("architect emits ATOMIC per-clause fitness NFRs (anti reflect-thrash)", () => {
  const md = readFileSync(ARCHITECT, "utf8");

  it("requires one atomic obligation per nfrs[] entry, never a compound fitness_function", () => {
    expect(md).toMatch(/atomic/i);
    expect(md, "must warn against a compound fitness_function").toMatch(/compound[^\n]*fitness_function/i);
    expect(md, "must say to emit separate nfrs[] entries per sub-clause").toMatch(/separate[^\n]*nfrs\[\][^\n]*entr/i);
  });

  it("names layering's directional decomposition as the canonical multi-part case", () => {
    expect(md).toMatch(/dependencies point inward/i);
    // the payoff the rule exists for: 1:1 coverage converging in one reflect pass
    expect(md).toMatch(/single reflect pass|converge[^\n]*reflect/i);
  });
});
