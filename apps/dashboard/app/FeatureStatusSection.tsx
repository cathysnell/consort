"use client";

import type { DashboardState, StoryProgress } from "@/lib/types";
import { font, radius } from "@/lib/theme";

// LEFT-pane status rollup: the run's features grouped with their stories, limited to features that
// are COMPLETE or CURRENTLY ACTIVE — the two an operator tracks (a started-but-idle feature that is
// neither is omitted, per the request). Unlike the planning sections above (a static snapshot of the
// run's start), this reads the FOLDED board state, so it rewinds with the transport.
//
// Its own module (not a local in page.tsx): a Next route file may only export the page defaults, so
// a named export there fails the page-type check — and it keeps the section unit-testable directly.
export function FeatureStatusSection({ state }: { state: DashboardState }) {
  const byFeature = new Map<string, StoryProgress[]>();
  for (const s of state.stories) {
    if (!s.feature) continue;
    const list = byFeature.get(s.feature);
    if (list) list.push(s);
    else byFeature.set(s.feature, [s]);
  }
  // done || active, in the state's first-seen feature order. done wins over active for the chip.
  const shown = state.features.filter((f) => f.done || f.active);
  const doneCount = shown.filter((f) => f.done).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Status{shown.length > 0 ? <span style={{ textTransform: "none", letterSpacing: 0 }}> · {doneCount} of {shown.length} complete</span> : null}
      </div>
      {shown.length === 0 ? (
        <div style={{ fontSize: "0.78rem", color: "var(--text-faint)" }}>No feature complete or underway yet.</div>
      ) : (
        shown.map((f) => {
          const stories = byFeature.get(f.id) ?? [];
          const storiesDone = stories.filter((s) => s.stage === "done").length;
          return (
            <div key={f.id} style={{ border: `1px solid var(--border-default)`, borderRadius: radius.panel, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-strong)", fontFamily: font.mono }}>{f.id}</span>
                <FeatureStateChip done={f.done} />
                {stories.length > 0 ? (
                  <span style={{ marginLeft: "auto", fontSize: "0.66rem", color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                    {storiesDone}/{stories.length} stories
                  </span>
                ) : null}
              </div>
              {stories.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {stories.map((s) => (
                    <FeatureStatusStoryRow key={`${f.id}:${s.id}`} s={s} />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>No stories yet.</div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function FeatureStateChip({ done }: { done: boolean }) {
  // A finished feature isn't "in progress", so done wins over active.
  const c = done
    ? { bg: "var(--status-good-tint-soft)", border: "var(--status-good)", fg: "var(--status-good)", label: "done" }
    : { bg: "var(--status-accent-tint)", border: "var(--status-accent)", fg: "var(--status-accent-text)", label: "active" };
  return (
    <span style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: c.fg, background: c.bg, border: `1px solid ${c.border}`, borderRadius: radius.chip, padding: "1px 6px" }}>
      {c.label}
    </span>
  );
}

// Compact per-story row for the left-pane rollup: id + one status chip (its raw Consort status),
// deliberately terser than the center column's full design→build→done mini-track (StoryRow).
function FeatureStatusStoryRow({ s }: { s: StoryProgress }) {
  const c =
    s.status === "discarded"
      ? { bg: "var(--status-discarded-tint)", border: "var(--status-discarded)", fg: "var(--status-discarded-text)" }
      : s.stage === "done"
      ? { bg: "var(--status-good-tint)", border: "var(--status-good)", fg: "var(--status-good-text)" }
      : s.active
      ? { bg: "var(--status-accent-tint)", border: "var(--status-accent)", fg: "var(--status-accent-text)" }
      : { bg: "var(--surface-inset)", border: "var(--border-default)", fg: "var(--text-muted)" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: "0.74rem", fontWeight: s.active ? 700 : 500, color: s.active ? "var(--text-strong)" : "var(--text-muted)", fontFamily: font.mono, whiteSpace: "nowrap" }}>
        {s.active ? "▸ " : ""}
        {s.id}
      </span>
      {/* Coarse status only. The design PHASE lives in the tooltip (and the center column's full
          design track) — appending it here read redundantly as "designing · design" whenever the
          story sat in the phase literally named "design". */}
      <span
        title={`${s.status}${s.designPhase ? ` · ${s.designPhase}` : ""}`}
        style={{ marginLeft: "auto", fontSize: "0.62rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", color: c.fg, background: c.bg, border: `1px solid ${c.border}`, borderRadius: radius.chip, padding: "1px 7px", whiteSpace: "nowrap" }}
      >
        {s.status}
      </span>
    </div>
  );
}
