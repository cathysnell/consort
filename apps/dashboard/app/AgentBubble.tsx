"use client";

import type { AgentState, AgentStatus } from "@/lib/types";
import { radius } from "@/lib/theme";

// Status → color/icon, adapted from pipeline-app's StepNode STATUS_CONFIG.
const CFG: Record<AgentStatus, { bg: string; border: string; text: string; label: string }> = {
  working: { bg: "var(--status-accent-tint-soft)", border: "var(--status-accent)", text: "var(--status-accent)", label: "working" },
  "on-deck": { bg: "var(--status-on-deck-tint)", border: "var(--status-on-deck)", text: "var(--status-on-deck)", label: "on deck" },
  issue: { bg: "var(--status-critical-tint-soft)", border: "var(--status-critical)", text: "var(--status-critical)", label: "issue" },
  waiting: { bg: "var(--status-gate-tint-soft)", border: "var(--status-gate)", text: "var(--status-gate)", label: "waiting on you" },
  idle: { bg: "var(--surface-muted)", border: "var(--border-default)", text: "var(--text-faint)", label: "idle" },
};

const ICON: Record<AgentStatus, string> = {
  working: "●", // a static dot , the "working" spinner cycle was removed (its animation never ran)
  "on-deck": "→",
  issue: "⚠",
  waiting: "⏸",
  idle: "·",
};

// "3m", "45s" — how long the current open turn has been running.
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 >= 30 && m < 10 ? `${m}m${s % 60}s` : `${m}m`;
}

export function AgentBubble({ agent, showCost, onOpen }: { agent: AgentState; showCost: boolean; onOpen?: () => void }) {
  const cfg = CFG[agent.status];
  const active = agent.status === "working";
  const pulse = agent.status === "waiting" || agent.status === "issue";
  const clickable = !!onOpen;

  // Consort only logs at turn boundaries, so a long open turn looks frozen. Show how long the
  // turn's been running + a liveness dot: green "live" = a session is writing (working, just a
  // long turn); amber "quiet" = no recent transcript write (may be stalled — worth a look).
  const startMs = agent.turnStartTs ? Date.parse(agent.turnStartTs) : NaN;
  const elapsed = active && !Number.isNaN(startMs) ? fmtElapsed(Math.max(0, Date.now() - startMs)) : null;
  const live = agent.sessionActive;

  return (
    <div
      onClick={onOpen}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen!(); } } : undefined}
      title={clickable ? `Open ${agent.role}'s most recent turn` : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "16px 18px",
        borderRadius: radius.card,
        background: cfg.bg,
        border: `2px solid ${cfg.border}`,
        boxShadow: active ? `0 0 22px ${cfg.border}33` : "none",
        transition: "all 0.4s ease",
        minHeight: 118,
        animation: pulse ? "softpulse 1.8s ease-in-out infinite" : undefined,
        cursor: clickable ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: `2px solid ${cfg.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.1rem",
            fontWeight: 700,
            color: cfg.text,
            flexShrink: 0,
          }}
        >
          {ICON[agent.status]}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text-strong)", textTransform: "uppercase", letterSpacing: "0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {agent.role}
          </div>
          <div style={{ fontSize: "0.7rem", fontWeight: 600, color: cfg.text, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {cfg.label}
            {agent.model ? <span style={{ color: "var(--text-faint)", fontWeight: 500 }}> · {agent.model}</span> : null}
            {/* Elapsed sits on the model row when working, coloured by liveness (green live / amber
                quiet), so the turn's duration reads alongside its model instead of a separate line. */}
            {active && elapsed ? (
              <span style={{ color: live === false ? "var(--status-warning-text)" : "var(--status-good-text)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                {" "}· {elapsed}{live === false ? " quiet" : live === true ? " live" : ""}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div style={{ fontSize: "0.78rem", color: "var(--text-body)", lineHeight: 1.35, minHeight: 32 }}>
        {agent.status !== "idle" && agent.work ? agent.work : agent.status === "idle" ? <span style={{ color: "var(--text-faint)" }}>—</span> : null}
        {agent.story ? <div style={{ color: "var(--text-faint)", fontSize: "0.68rem", marginTop: 2 }}>{agent.story}</div> : null}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: "var(--text-faint)", marginTop: "auto" }}>
        <span>{agent.turns} turn{agent.turns === 1 ? "" : "s"}</span>
        {showCost && agent.cost > 0 ? <span style={{ fontVariantNumeric: "tabular-nums" }}>${agent.cost.toFixed(2)}</span> : null}
      </div>
    </div>
  );
}
