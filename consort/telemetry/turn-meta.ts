// Map a runner-recorded per-turn TurnMeta to the OPTIONAL, content-free fields of
// a `consort.turn` span. The runner (claude-runner.recordTurnMeta) captures the
// concrete model id, effort lever, retry count, and usage of a turn; this module
// is the SINGLE place that coarsens those into the closed enums / buckets the
// allowlist permits (never the raw id, count, or any free text). Pure + tolerant:
// an absent/undefined field yields an OMITTED span field (a null column), which is
// distinct from an "unknown" bucket (a value we saw but could not classify).
//
// Grown one field per Phase-A step: A2 adds model + effort; A3 adds token_bucket;
// A4 adds retry_count. The `consort.turn` span already declares all four (optional)
// in spans.ts + TURN_SPAN_FIELDS, so this file never needs an allowlist change.

import type { TurnMeta } from "../orchestrator/drive/claude-runner.js";
import { EFFORT_VALUES, type EffortValue, type ModelValue, type TokenBucketValue } from "./allowlist.js";
import type { TurnSpan } from "./spans.js";

/** Coarsen a concrete model id into the MODEL_VALUES family bucket (never the exact
 *  id). Matches by family substring so it is robust to id decorations (date suffix,
 *  `system.ai.` prefix, `[1m]` window tag, etc.). An id we do not recognize buckets
 *  as "other"; an absent id yields undefined (the field is omitted from the span). */
export function bucketModel(modelId: string | undefined): ModelValue | undefined {
  if (!modelId || !modelId.trim()) return undefined;
  const m = modelId.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "other";
}

/** Normalize a reasoning-effort lever to the EFFORT_VALUES enum. An absent/empty
 *  lever yields undefined (no lever was set – the turn ran at the model default; the
 *  span omits the field, a null column). A lever we saw but cannot classify buckets
 *  as "unknown" – distinct from "no lever". */
export function normalizeEffort(effort: string | undefined): EffortValue | undefined {
  if (!effort || !effort.trim()) return undefined;
  const e = effort.trim().toLowerCase();
  return (EFFORT_VALUES as readonly string[]).includes(e) ? (e as EffortValue) : "unknown";
}

/** Coarse token bands for a turn's PROCESSED tokens (input + output). Cache-read
 *  tokens are reused context, not fresh work, so they are EXCLUDED – the bucket
 *  reflects "how big was this turn's actual processing", the tuning signal for
 *  who is expensive/slow (a later step may split input vs output). Ordered ascending
 *  by exclusive upper bound; `xl` is the open-ended top. Named consts so the bands
 *  are tunable + unit-tested, never magic numbers buried in a branch. */
export const TOKEN_BUCKET_THRESHOLDS: ReadonlyArray<{ bucket: TokenBucketValue; maxExclusive: number }> = [
  { bucket: "xs", maxExclusive: 25_000 },
  { bucket: "s", maxExclusive: 75_000 },
  { bucket: "m", maxExclusive: 200_000 },
  { bucket: "l", maxExclusive: 500_000 },
  { bucket: "xl", maxExclusive: Infinity },
];

/** Bucket a turn's usage into a TOKEN_BUCKET_VALUES band by its processed
 *  (input + output) tokens. Absent usage, or a non-positive/non-finite total,
 *  yields undefined (the span omits the field – a null column, distinct from `xs`
 *  which is a real, measured-small turn). */
/** Bucket ONE non-negative token count into a TOKEN_BUCKET_VALUES band; undefined for an
 *  absent / non-positive / non-finite value. Shared by the combined + the per-component
 *  (input / output / cache-read) buckets. */
export function bucketCount(n: number | undefined): TokenBucketValue | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  for (const t of TOKEN_BUCKET_THRESHOLDS) {
    if (n < t.maxExclusive) return t.bucket;
  }
  return "xl";
}

export function bucketTokens(usage: TurnMeta["usage"]): TokenBucketValue | undefined {
  if (!usage) return undefined;
  return bucketCount((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
}

/** Build the OPTIONAL enum/coarse fields of a `consort.turn` span from a recorded
 *  turn meta. Returns only the fields it can populate; an omitted field means the
 *  runner did not surface that datum (a null column downstream). */
export function turnSpanFieldsFromMeta(meta: TurnMeta | undefined): Partial<TurnSpan> {
  if (!meta) return {};
  const out: Partial<TurnSpan> = {};
  const model = bucketModel(meta.model);
  if (model) out.model = model;
  const effort = normalizeEffort(meta.effort);
  if (effort) out.effort = effort;
  const tokenBucket = bucketTokens(meta.usage);
  if (tokenBucket) out.token_bucket = tokenBucket;
  // L2 cost split: input (context read) vs output (generation) vs cache-read (reuse), each a
  // coarse band – shows whether a turn is expensive because it READS a lot or WRITES a lot.
  if (meta.usage) {
    const bi = bucketCount(meta.usage.inputTokens);
    if (bi) out.token_bucket_input = bi;
    const bo = bucketCount(meta.usage.outputTokens);
    if (bo) out.token_bucket_output = bo;
    const bc = bucketCount(meta.usage.cacheReadTokens);
    if (bc) out.token_bucket_cache_read = bc;
  }
  // retry_count is a plain count, not an enum: carry it whenever the runner recorded a
  // finite non-negative number, INCLUDING 0 (a measured clean turn – distinct from an
  // omitted/null column meaning the runner surfaced no meta at all). This is the "who is
  // flaky" signal: mostly 0, occasionally >0 when a turn hit the overflow/transient budgets.
  if (typeof meta.retryCount === "number" && Number.isFinite(meta.retryCount) && meta.retryCount >= 0) {
    out.retry_count = meta.retryCount;
  }
  return out;
}
