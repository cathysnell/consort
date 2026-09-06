// P2c optimize-report: the per-handoff before/after report over a champion-walk
// result. Pure: it turns the ChampionWalkResult (+ the candidate objects, for the
// winning lever description) into a structured summary + a markdown table – the
// "same-quality artifacts, less wall-clock" evidence. No I/O.

import { describe, expect, it } from "vitest";

import {
  buildChampionWalkReport,
  formatChampionWalkReport,
  describeCandidateLevers,
} from "../../consort/optimize/optimize-report";
import type { ChampionWalkResult } from "../../consort/optimize/optimize-harness";
import type { Candidate } from "../../consort/optimize/optimize-candidates";

const candidates: Candidate[] = [
  { id: "baseline", configOverrides: {} },
  {
    id: "driver-green-m-haiku",
    configOverrides: { roles: { driver: { model: { green: "haiku" } } } },
  },
  {
    id: "content-1",
    configOverrides: {},
    content: { taskSuffix: " Prefer edits.", allowedTools: ["Read", "Edit"] },
  },
];

const result: ChampionWalkResult = {
  walk: [
    {
      handoffId: "S1-green",
      baselineMs: 120000,
      candidates: [
        { candidateId: "baseline", medianMs: 120000, medianCostUsd: 1.2, trials: [], disqualified: false },
        { candidateId: "driver-green-m-haiku", medianMs: 60000, medianCostUsd: 0.3, trials: [], disqualified: false },
      ],
      winner: { candidateId: "driver-green-m-haiku", medianMs: 60000, medianCostUsd: 0.3 },
    },
    {
      handoffId: "S1-review",
      baselineMs: 30000,
      candidates: [
        { candidateId: "baseline", medianMs: 30000, medianCostUsd: 0.2, trials: [], disqualified: false },
      ],
      winner: { candidateId: "baseline", medianMs: 30000, medianCostUsd: 0.2 },
    },
  ],
};

describe("buildChampionWalkReport: prompt-weight signal (two-pass trim targeting)", () => {
  it("reports TOTAL prompt weight + flags a large-prompt + slow handoff as prompt-bound", () => {
    const promptHeavy: ChampionWalkResult = {
      walk: [
        {
          handoffId: "S1-navigator-red",
          baselineMs: 200000, // slow
          candidates: [
            // large TOTAL prompt (mostly cache-served, as live data showed) + slow -> prompt-bound
            { candidateId: "baseline", medianMs: 200000, medianCostUsd: 2, medianInputTokens: 40, medianCacheReadTokens: 300000, trials: [], disqualified: false },
          ],
          winner: { candidateId: "baseline", medianMs: 200000, medianCostUsd: 2 },
        },
        {
          handoffId: "S1-dba",
          baselineMs: 20000, // fast turn -> NOT prompt-bound even with a big prompt
          candidates: [
            { candidateId: "baseline", medianMs: 20000, medianCostUsd: 0.3, medianInputTokens: 30, medianCacheReadTokens: 250000, trials: [], disqualified: false },
          ],
          winner: { candidateId: "baseline", medianMs: 20000, medianCostUsd: 0.3 },
        },
      ],
    };
    const report = buildChampionWalkReport(promptHeavy, [{ id: "baseline", configOverrides: {} }]);
    const nav = report.handoffs.find((h) => h.handoffId === "S1-navigator-red")!;
    const dba = report.handoffs.find((h) => h.handoffId === "S1-dba")!;
    expect(nav.baselineInputTokens).toBe(300040); // TOTAL = fresh + cache-read
    expect(nav.promptBound).toBe(true); // large prompt + slow
    expect(dba.promptBound).toBe(false); // large prompt but fast turn
  });

  it("promptBound is false/undefined when tokens were not measured", () => {
    const report = buildChampionWalkReport(result, candidates); // no token fields
    expect(report.handoffs.every((h) => !h.promptBound)).toBe(true);
  });
});

describe("buildChampionWalkReport", () => {
  it("computes per-handoff before/after + savings", () => {
    const report = buildChampionWalkReport(result, candidates);
    const green = report.handoffs.find((h) => h.handoffId === "S1-green")!;
    expect(green.baselineMs).toBe(120000);
    expect(green.winnerMs).toBe(60000);
    expect(green.savedMs).toBe(60000);
    expect(green.savedPct).toBe(50);
    expect(green.winnerId).toBe("driver-green-m-haiku");
  });

  it("marks a handoff where baseline won as no-change (0 saved)", () => {
    const report = buildChampionWalkReport(result, candidates);
    const review = report.handoffs.find((h) => h.handoffId === "S1-review")!;
    expect(review.winnerId).toBe("baseline");
    expect(review.savedMs).toBe(0);
    expect(review.savedPct).toBe(0);
  });

  it("totals baseline vs optimized across all handoffs", () => {
    const report = buildChampionWalkReport(result, candidates);
    expect(report.totalBaselineMs).toBe(150000);
    expect(report.totalOptimizedMs).toBe(90000);
    expect(report.totalSavedMs).toBe(60000);
    expect(report.totalSavedPct).toBe(40);
  });

  it("attaches the winning candidate's lever description", () => {
    const report = buildChampionWalkReport(result, candidates);
    const green = report.handoffs.find((h) => h.handoffId === "S1-green")!;
    expect(green.winnerLevers).toMatch(/driver\.green model=haiku/);
  });
});

describe("describeCandidateLevers", () => {
  it("describes the baseline as no-op", () => {
    expect(describeCandidateLevers({ id: "baseline", configOverrides: {} })).toBe("baseline (no overrides)");
  });

  it("describes a per-turn model override", () => {
    expect(
      describeCandidateLevers({ id: "x", configOverrides: { roles: { driver: { model: { green: "haiku" } } } } }),
    ).toMatch(/driver\.green model=haiku/);
  });

  it("describes an effort override", () => {
    expect(
      describeCandidateLevers({ id: "x", configOverrides: { roles: { navigator: { effort: { review: "low" } } } } }),
    ).toMatch(/navigator\.review effort=low/);
  });

  it("describes build knobs + env + content levers", () => {
    const d = describeCandidateLevers({
      id: "x",
      configOverrides: { build: { sessionScope: "cycle", loopGranularity: "ac" } },
      env: { CONTEXT_FREE_FRACTION: "0.3" },
      content: { agentOverlay: { role: "driver", markdown: "..." }, taskSuffix: " x", allowedTools: ["Read"] },
    });
    expect(d).toMatch(/sessionScope=cycle/);
    expect(d).toMatch(/loop=ac/);
    expect(d).toMatch(/CONTEXT_FREE_FRACTION=0.3/);
    expect(d).toMatch(/agent-overlay:driver/);
    expect(d).toMatch(/taskSuffix/);
    expect(d).toMatch(/allowedTools/);
  });
});

describe("formatChampionWalkReport (markdown)", () => {
  it("renders a table with a totals row and every handoff", () => {
    const md = formatChampionWalkReport(buildChampionWalkReport(result, candidates));
    expect(md).toMatch(/S1-green/);
    expect(md).toMatch(/S1-review/);
    expect(md).toMatch(/TOTAL/);
    // savings percent appears
    expect(md).toMatch(/50%|40%/);
  });
});
