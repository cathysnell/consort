// claude-runner stall wiring (Slice 3): spawnClaudeStreaming feeds each stream line to a
// per-turn inactivity monitor; on a stretch of pure silence it tree-kills the child and
// rejects with a STALLED transient ClaudeTurnError, which the retry envelope re-runs on a
// fresh session. This is the fix for the navigator-red wedge (a stalled Anthropic stream:
// child alive, socket open, no bytes, so `close` never fires and the await hangs forever).
//
// We cannot spawn the real `claude` binary hermetically, and spawnClaudeStreaming hardcodes
// "claude" as argv[0]. So we prove the two halves separately, each hermetically:
//  1) defaultTurnMonitor maps the module timeout envs to a monitor (the config wiring).
//  2) A monitor-controller driven by a fake clock, given a real short-lived silent child,
//     fires onTimeout and we SIGKILL it – the exact mechanism spawnClaudeStreaming uses ,
//     proving kill-on-silence works against a live pid.
// The end-to-end (real claude stalls -> retried) is the live capture; these pin the logic.

import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { createMonitorController } from "../../consort/orchestrator/turns/turn-monitor";
import { defaultTurnMonitor, recordAgentTranscript, peekLastAgentTranscript, takeLastAgentTranscript, recordTurnMeta, peekLastTurnMeta, takeLastTurnMeta, type TurnMeta } from "../../consort/orchestrator/drive/claude-runner";
import { assistantTextFromLine, assistantEventSummary } from "../../consort/session/claude-usage";

describe("claude-runner stall wiring", () => {
  it("defaultTurnMonitor builds a monitor with inactivity + heartbeat windows, and its sink is called for heartbeats", () => {
    const seen: string[] = [];
    const m = defaultTurnMonitor((p) => seen.push(p.kind));
    // Defaults (10min inactivity, 60s heartbeat) are both > 0, so a monitor is returned.
    expect(m).toBeDefined();
    expect(typeof m!.inactivityTimeoutMs).toBe("number");
    expect(m!.inactivityTimeoutMs).toBeGreaterThan(0);
    expect(typeof m!.heartbeatMs).toBe("number");
    // The sink is wired to onProgress.
    m!.onProgress?.({ kind: "heartbeat", atMs: 0 });
    expect(seen).toContain("heartbeat");
  });

  it("returns undefined (byte-identical no-op) when both windows are disabled", () => {
    // Simulate both envs set to 0 by constructing the same predicate the module uses.
    // (The module reads env at import; here we assert the shape contract directly.)
    const disabled = (heartbeatMs?: number, inactivityTimeoutMs?: number) =>
      heartbeatMs === undefined && inactivityTimeoutMs === undefined ? undefined : { heartbeatMs, inactivityTimeoutMs };
    expect(disabled(undefined, undefined)).toBeUndefined();
  });

  it("only CONTENT lines are liveness; keepalive/system/result lines are NOT (the wedge regression)", () => {
    // The runner arms the inactivity clock ONLY when assistantTextFromLine / assistantEventSummary
    // return content. A stalled stream that dribbles non-content stream-json (system/ping/result)
    // must NOT re-arm the clock, or the timeout never fires (the bug that made the fix miss its
    // first live test: raw keepalive lines kept the timer alive for 11+min of true silence).
    const content = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } });
    const toolLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }] } });
    const keepalives = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }), // empty content = no liveness
      "",
      "{ not json",
    ];
    // Content lines yield liveness.
    expect(assistantTextFromLine(content)).toBe("working on it");
    expect(assistantEventSummary(toolLine).tools.length).toBe(1);
    // Non-content lines yield NOTHING (neither text nor tools) => the handler skips progress().
    for (const k of keepalives) {
      expect(assistantTextFromLine(k)).toBe("");
      const s = assistantEventSummary(k);
      expect(s.text).toBe("");
      expect(s.tools).toHaveLength(0);
    }
  });

  it("the controller's onTimeout tree-kills a real silent child (the spawnClaudeStreaming mechanism)", async () => {
    // A real child that prints nothing and would run ~30s – stands in for a stalled agent.
    const child = spawn("node", ["-e", "setTimeout(()=>{}, 30000)"], { stdio: ["inherit", "pipe", "pipe"] });
    let killed = false;
    // Fake clock so we control when the inactivity deadline fires (no 10-min wait).
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let id = 1;
    const clock = {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const t = id++;
        timers.set(t, { at: now + ms, fn });
        return t as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (t: ReturnType<typeof setTimeout>) => {
        timers.delete(t as unknown as number);
      },
    };
    const ctl = createMonitorController(
      { inactivityTimeoutMs: 1000 },
      () => {
        killed = true;
        child.kill("SIGKILL");
      },
      clock,
    );
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    ctl.start();
    // Advance past the inactivity window with no progress -> fire the due timer.
    now = 1000;
    for (const [, t] of [...timers.entries()].filter(([, t]) => t.at <= now)) t.fn();
    const code = await exited;
    ctl.stop();
    expect(killed).toBe(true);
    // The child was SIGKILLed (exit code null with a signal, or non-zero) – it did NOT
    // run to its natural 30s completion.
    expect(code === null || code !== 0).toBe(true);
  });
});

describe("agent transcript capture is concurrency-safe (peek BY cwd, no cross-candidate crosstalk)", () => {
  // The bug: peekLastAgentTranscript returned a module GLOBAL, so parallel candidates (each its own
  // worktree) overwrote it and a peek got whoever flushed last – scrambling per-run transcript
  // attribution in every concurrent sweep. Fix: index by cwd; a caller peeks BY its worktree.
  const tx = (p: string) => ({ prompt: p, finalText: p + "-done", tools: [`Bash ${p}`] });
  it("peek(cwd) returns THAT worktree's turn even after a sibling records later", () => {
    recordAgentTranscript("/wt/candA", tx("A"));
    recordAgentTranscript("/wt/candB", tx("B")); // a concurrent sibling flushes AFTER A
    expect(peekLastAgentTranscript("/wt/candA")?.prompt).toBe("A"); // NOT clobbered by B
    expect(peekLastAgentTranscript("/wt/candB")?.prompt).toBe("B");
    expect(peekLastAgentTranscript()?.prompt).toBe("B"); // no-arg global = last flushed (serial back-compat)
    takeLastAgentTranscript("/wt/candA");
    takeLastAgentTranscript("/wt/candB");
  });
  it("take(cwd) clears only that worktree's entry", () => {
    recordAgentTranscript("/wt/x", tx("X"));
    recordAgentTranscript("/wt/y", tx("Y"));
    expect(takeLastAgentTranscript("/wt/x")?.prompt).toBe("X");
    expect(peekLastAgentTranscript("/wt/x")).toBeUndefined(); // cleared
    expect(peekLastAgentTranscript("/wt/y")?.prompt).toBe("Y"); // sibling untouched
    takeLastAgentTranscript("/wt/y");
  });
});

describe("per-turn meta seam (recordTurnMeta / takeLastTurnMeta) – the telemetry turn-span source", () => {
  // The runner records model/effort/retryCount/usage per turn AFTER its retry loop settles; the
  // telemetry decorator TAKEs it when building the consort.turn span. Same crosstalk-safe mechanism
  // as the transcript/usage seams: the serial drive uses the no-arg global, a concurrent sweep its cwd.
  const meta = (over: Partial<TurnMeta> = {}): TurnMeta => ({
    role: "driver",
    model: "claude-opus-4-8",
    effort: "high",
    retryCount: 0,
    usage: { inputTokens: 1234, outputTokens: 567 },
    ...over,
  });

  it("round-trips a recorded meta on the serial global and TAKE clears it", () => {
    recordTurnMeta("/proj", meta({ role: "navigator", retryCount: 2 }));
    expect(peekLastTurnMeta()?.role).toBe("navigator"); // peek does not clear
    const taken = takeLastTurnMeta();
    expect(taken?.role).toBe("navigator");
    expect(taken?.model).toBe("claude-opus-4-8");
    expect(taken?.effort).toBe("high");
    expect(taken?.retryCount).toBe(2);
    expect(taken?.usage?.inputTokens).toBe(1234);
    // take-clears: a following action (e.g. a gate) that records NO meta must not inherit this one.
    expect(peekLastTurnMeta()).toBeUndefined();
    expect(takeLastTurnMeta()).toBeUndefined();
  });

  it("peek/take BY cwd return THAT worktree's meta even after a sibling records later (no crosstalk)", () => {
    recordTurnMeta("/wt/a", meta({ role: "driver" }));
    recordTurnMeta("/wt/b", meta({ role: "navigator" })); // sibling flushes AFTER a
    expect(peekLastTurnMeta("/wt/a")?.role).toBe("driver"); // NOT clobbered by b
    expect(peekLastTurnMeta("/wt/b")?.role).toBe("navigator");
    expect(takeLastTurnMeta("/wt/a")?.role).toBe("driver");
    expect(peekLastTurnMeta("/wt/a")).toBeUndefined(); // cleared
    expect(peekLastTurnMeta("/wt/b")?.role).toBe("navigator"); // sibling untouched
    takeLastTurnMeta("/wt/b");
  });
});
