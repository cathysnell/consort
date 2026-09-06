// Emitter guarantees (AC3, AC4): never-throw / never-block under an injected
// sender failure, per-span overhead well under budget, a bounded drop-oldest
// queue, and the offline / no-op path being a true no-op (no output, no latency).

import { describe, it, expect } from "vitest";
import {
  TelemetryEmitter,
  DEFAULT_QUEUE_CAP,
  DEFAULT_ENDPOINT,
  endpointMode,
  httpSink,
  detachedHttpSink,
  memorySink,
  noopSink,
  resolveSink,
  type TelemetrySink,
} from "../../consort/telemetry/emitter";
import type { GateSpan, ResourceAttrs, RunSpan } from "../../consort/telemetry/spans";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESOURCE: ResourceAttrs = {
  schema: "consort/v1",
  install_id: "00000000-0000-4000-8000-000000000000",
  consort_version: "0.0.0-test",
  node_version: "20.0.0",
  os: "darwin",
  arch: "arm64",
  shell: "zsh",
  ci: false,
  tty: true,
  level: 1,
};

function gate(i: number): GateSpan {
  return {
    trace_id: "t",
    parent_span_id: "root",
    span_id: `s${i}`,
    name: "consort.gate",
    gate: "deploy",
    ordinal: i,
    start_ts: i,
    end_ts: i + 1,
    duration_ms: 1,
    outcome: "pass",
  };
}

function rootSpan(): RunSpan {
  return {
    trace_id: "t",
    span_id: "root",
    name: "consort.run",
    start_ts: 0,
    end_ts: 10,
    duration_ms: 10,
    command: "build",
    outcome: "completed",
    exit_code: 0,
    gates_total: 2,
  };
}

describe("telemetry emitter", () => {
  it("delivers a single batch (root + children) to the sink on flush", () => {
    const sink = memorySink();
    const e = new TelemetryEmitter({ sink, resource: RESOURCE });
    e.enqueue(gate(0));
    e.enqueue(gate(1));
    e.enqueue(rootSpan());
    e.flush();
    expect(sink.payloads).toHaveLength(1);
    expect(sink.payloads[0].spans).toHaveLength(3);
    expect(sink.payloads[0].resource).toEqual(RESOURCE);
  });

  it("bounds the queue at cap, dropping the OLDEST span", () => {
    const sink = memorySink();
    const e = new TelemetryEmitter({ sink, resource: RESOURCE, queueCap: 3 });
    for (let i = 0; i < 10; i++) e.enqueue(gate(i));
    expect(e.queued).toBe(3);
    e.flush();
    // The three most-recent survive (oldest dropped).
    expect(sink.spans().map((s) => (s as GateSpan).ordinal)).toEqual([7, 8, 9]);
  });

  it("default cap is 200", () => {
    const e = new TelemetryEmitter({ sink: memorySink(), resource: RESOURCE });
    for (let i = 0; i < 250; i++) e.enqueue(gate(i));
    expect(e.queued).toBe(DEFAULT_QUEUE_CAP);
  });

  it("NEVER throws when the sink throws synchronously", () => {
    const throwingSink: TelemetrySink = {
      deliver() {
        throw new Error("sink boom");
      },
    };
    const e = new TelemetryEmitter({ sink: throwingSink, resource: RESOURCE });
    e.enqueue(gate(0));
    expect(() => e.flush()).not.toThrow();
  });

  it("NEVER throws (and does not block) when the HTTP sender rejects/throws", async () => {
    const errors: unknown[] = [];
    // A fetch that rejects immediately (connection refused analog).
    const failingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const sink = httpSink({ endpoint: "http://127.0.0.1:1", fetchImpl: failingFetch, onError: (e) => errors.push(e) });
    const e = new TelemetryEmitter({ sink, resource: RESOURCE });
    e.enqueue(rootSpan());
    const start = performance.now();
    expect(() => e.flush()).not.toThrow();
    const elapsed = performance.now() - start;
    // Fire-and-forget: flush returns essentially immediately (does not await the POST).
    expect(elapsed).toBeLessThan(50);
    // The rejection is observed on a later tick, swallowed (never rethrown).
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
  });

  it("per-span enqueue overhead is well under 5ms/span", () => {
    const e = new TelemetryEmitter({ sink: noopSink, resource: RESOURCE });
    const n = 1000;
    const start = performance.now();
    for (let i = 0; i < n; i++) e.enqueue(gate(i));
    const perSpan = (performance.now() - start) / n;
    expect(perSpan).toBeLessThan(5);
  });

  it("offline / no-op sink is a true no-op (no throw, no output on flush)", () => {
    const e = new TelemetryEmitter({ sink: noopSink, resource: RESOURCE });
    e.enqueue(gate(0));
    e.enqueue(rootSpan());
    expect(() => e.flush()).not.toThrow();
  });
});

describe("endpoint gate: armed by default (opt-out, always-on)", () => {
  it("empty env -> armed at the DEFAULT endpoint (real HTTP sink)", () => {
    expect(resolveSink({})).not.toBe(noopSink);
    const m = endpointMode({});
    expect(m.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(m.signedOff).toBe(true);
    expect(m.willPost).toBe(true);
  });

  it("CONSORT_TELEMETRY_SIGNOFF=0 explicitly un-arms -> no-op sink", () => {
    const env = { CONSORT_TELEMETRY_SIGNOFF: "0" };
    expect(resolveSink(env)).toBe(noopSink);
    expect(endpointMode(env).willPost).toBe(false);
  });

  it("CONSORT_TELEMETRY_ENDPOINT overrides the default; stays armed", () => {
    const env = { CONSORT_TELEMETRY_ENDPOINT: "http://127.0.0.1:4318" };
    expect(resolveSink(env)).not.toBe(noopSink);
    expect(endpointMode(env)).toEqual({ endpoint: "http://127.0.0.1:4318", signedOff: true, willPost: true });
  });
});

describe("shared bearer token (soft secret for a public ingest endpoint)", () => {
  /** Capture the last fetch init so we can inspect headers. Resolves the POST OK. */
  function capturingFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function headersOf(init: RequestInit): Record<string, string> {
    // The sink builds headers as a plain object, so read it back the same way.
    return (init.headers ?? {}) as Record<string, string>;
  }

  it("httpSink sends `Authorization: Bearer <token>` when a token is set", () => {
    const { calls, fetchImpl } = capturingFetch();
    const sink = httpSink({ endpoint: "http://ingest.example", token: "sekret-123", fetchImpl });
    sink.deliver({ schema: "consort/v1", resource: RESOURCE, spans: [rootSpan()] });
    expect(calls).toHaveLength(1);
    const h = headersOf(calls[0].init);
    expect(h["authorization"]).toBe("Bearer sekret-123");
    expect(h["content-type"]).toBe("application/x-ndjson");
    expect(calls[0].url).toBe("http://ingest.example/v1/traces");
  });

  it("httpSink sends NO authorization header when no token is set", () => {
    const { calls, fetchImpl } = capturingFetch();
    const sink = httpSink({ endpoint: "http://ingest.example", fetchImpl });
    sink.deliver({ schema: "consort/v1", resource: RESOURCE, spans: [rootSpan()] });
    expect(headersOf(calls[0].init)["authorization"]).toBeUndefined();
  });

  it("resolveSink threads CONSORT_TELEMETRY_TOKEN into the real HTTP sink", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const sink = resolveSink({
        CONSORT_TELEMETRY_ENDPOINT: "http://ingest.example",
        CONSORT_TELEMETRY_SIGNOFF: "1",
        CONSORT_TELEMETRY_TOKEN: "from-env-tok",
      });
      expect(sink).not.toBe(noopSink);
      sink.deliver({ schema: "consort/v1", resource: RESOURCE, spans: [rootSpan()] });
      expect(headersOf(calls[0].init)["authorization"]).toBe("Bearer from-env-tok");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("detachedHttpSink – delivery survives process.exit WITHOUT blocking the drive", () => {
  it("deliver() spawns a DETACHED, unref'd sender and returns synchronously (never awaited, never blocks)", () => {
    // The drive-exit-race fix: instead of an in-process fire-and-forget POST that the
    // CLI's process.exit() tears down (dropping EVERY run's telemetry), the batch is
    // spooled and handed to a detached background process that outlives the parent.
    const dir = mkdtempSync(join(tmpdir(), "det-sink-"));
    try {
      const calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = [];
      let unrefCalls = 0;
      const fakeSpawn = ((bin: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ bin, args, opts });
        return { unref: () => { unrefCalls += 1; } };
      }) as unknown as typeof import("node:child_process").spawn;
      const sink = detachedHttpSink({
        endpoint: "https://ingest.example/",
        token: "tok",
        senderJs: "/kit/dist/bin/consort/telemetry-send.cli.js",
        spawnFn: fakeSpawn,
        tmpDir: dir,
      });
      const ret = sink.deliver({ schema: "consort/v1", resource: RESOURCE, spans: [rootSpan()] });
      expect(ret).toBeUndefined(); // returns void immediately – no promise, no await, no block
      expect(calls).toHaveLength(1);
      expect(calls[0].bin).toBe(process.execPath); // node
      expect(calls[0].args[0]).toBe("/kit/dist/bin/consort/telemetry-send.cli.js");
      expect(calls[0].args[2]).toBe("https://ingest.example/v1/traces"); // trailing slash normalized
      expect(calls[0].args[3]).toBe("tok");
      expect(calls[0].opts).toMatchObject({ detached: true, stdio: "ignore" });
      expect(unrefCalls).toBe(1); // parent must not be kept alive by the child
      // the batch was spooled to the exact file the sender is told to read
      const spool = calls[0].args[1];
      expect(readdirSync(dir)).toContain(spool.split("/").pop());
      expect(readFileSync(spool, "utf8")).toContain("consort.run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws even if the spawn itself throws (a failed send is dropped, not surfaced)", () => {
    const boom = (() => {
      throw new Error("spawn EACCES");
    }) as unknown as typeof import("node:child_process").spawn;
    const sink = detachedHttpSink({ endpoint: "https://x", senderJs: "/s.js", spawnFn: boom });
    expect(() => sink.deliver({ schema: "consort/v1", resource: RESOURCE, spans: [rootSpan()] })).not.toThrow();
  });
});
