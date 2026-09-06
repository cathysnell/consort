// L2 cost split: a turn's tokens bucketed by input (context read) / output (generation) /
// cache-read (reuse), each a coarse TOKEN_BUCKET band. Shows WHY a turn is expensive
// (read-heavy vs write-heavy) – the data is already on TurnMeta.usage.

import { describe, it, expect } from "vitest";
import { turnSpanFieldsFromMeta, bucketCount } from "../../consort/telemetry/turn-meta";
import { TURN_SPAN_FIELDS } from "../../consort/telemetry/allowlist";
import type { TurnMeta } from "../../consort/orchestrator/drive/claude-runner";

describe("token cost split (L2)", () => {
  it("bucketCount bands one count; undefined for absent/non-positive", () => {
    expect(bucketCount(undefined)).toBeUndefined();
    expect(bucketCount(0)).toBeUndefined();
    expect(bucketCount(10_000)).toBe("xs"); // < 25k
    expect(bucketCount(50_000)).toBe("s"); // < 75k
    expect(bucketCount(150_000)).toBe("m"); // < 200k
    expect(bucketCount(400_000)).toBe("l"); // < 500k
    expect(bucketCount(900_000)).toBe("xl");
  });

  it("turnSpanFieldsFromMeta splits input / output / cache-read (+ keeps the combined bucket)", () => {
    const out = turnSpanFieldsFromMeta({
      role: "driver",
      usage: { inputTokens: 150_000, outputTokens: 10_000, cacheReadTokens: 400_000 },
    } as TurnMeta);
    expect(out.token_bucket_input).toBe("m"); // 150k
    expect(out.token_bucket_output).toBe("xs"); // 10k
    expect(out.token_bucket_cache_read).toBe("l"); // 400k
    expect(out.token_bucket).toBe("m"); // combined input+output = 160k -> m
  });

  it("omits a component with no usage (null column, not a false xs)", () => {
    const out = turnSpanFieldsFromMeta({ role: "driver", usage: { inputTokens: 5_000 } } as TurnMeta);
    expect(out.token_bucket_input).toBe("xs");
    expect(out.token_bucket_output).toBeUndefined();
    expect(out.token_bucket_cache_read).toBeUndefined();
  });

  it("the split fields are on the turn-span allowlist", () => {
    for (const f of ["token_bucket_input", "token_bucket_output", "token_bucket_cache_read"]) {
      expect(TURN_SPAN_FIELDS).toContain(f);
    }
  });
});
