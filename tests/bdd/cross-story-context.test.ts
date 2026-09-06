// Cross-story review context (hardening #1): the design lane must review a story AGAINST
// its siblings, not in isolation. This is the S1/S3 regression from the stockflow run where
// S3's "reject a SKU not in stock_records" AC contradicted S1's already-gated "first receipt
// of a fresh SKU establishes stock" – invisible to a story-scoped review, so it only blew up
// in the build lane. The preparer is what makes the contradiction VISIBLE at design time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCrossStoryContext } from "../../consort/orchestrator/steps/cross-story-context";

let tdd: string;
beforeEach(() => {
  tdd = mkdtempSync(join(tmpdir(), "xstory-"));
});
afterEach(() => {
  rmSync(tdd, { recursive: true, force: true });
});
function write(rel: string, body: unknown): void {
  const p = join(tdd, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
}

const F = "F3-inbound-receipt";

describe("buildCrossStoryContext (cross-story review context)", () => {
  it("surfaces a gated sibling AC into the story under review (the S1/S3 regression)", () => {
    // S1 (already designed + gated): first receipt of a fresh SKU ESTABLISHES stock.
    write(`features/${F}/stories/S1-record-receipt/acs/AC2-record-establishes-stock.json`, {
      id: "AC2-record-establishes-stock",
      status: "gated",
      given: "a SKU that has no stock level yet at a location",
      when: "the operator records an inbound receipt of that SKU at that location",
      then: "a stock level is established at that location equal to the received quantity",
    });
    // S3 (under review): its own AC – the one that would contradict S1.
    write(`features/${F}/stories/S3-validate-receipt-form/acs/AC2-unknown-sku-inline-error.json`, {
      id: "AC2-unknown-sku-inline-error",
      status: "draft",
      given: "the operator has entered a SKU that is not known to the system",
      when: "the operator attempts to save the receipt",
      then: "an inline validation error appears next to the SKU field",
    });

    const ctx = buildCrossStoryContext(tdd, F, "S3-validate-receipt-form");

    // S1's establish-stock AC is now VISIBLE to S3's review – the contradiction is catchable.
    const s1 = ctx.sibling_stories.find((s) => s.story.startsWith("S1"));
    expect(s1, "S1 must appear as a sibling of S3").toBeDefined();
    const s1ac = s1!.acs.find((a) => a.ac_id === "AC2-record-establishes-stock");
    expect(s1ac?.then).toContain("stock level is established");
    expect(s1ac?.status).toBe("gated"); // status carried so the reviewer weighs it as a hard constraint
    // The story under review is NEVER folded into its own sibling context.
    expect(ctx.sibling_stories.some((s) => s.story.startsWith("S3"))).toBe(false);
    expect(ctx.current_story).toBe("S3-validate-receipt-form");
  });

  it("surfaces the architecture's open_decisions", () => {
    write(`features/${F}/stories/S1-record-receipt/acs/AC1-x.json`, { id: "AC1-x", given: "g", when: "w", then: "t" });
    write(`features/${F}/architecture.json`, {
      feature_id: F,
      service_backed: true,
      nfrs: [],
      open_decisions: [
        { id: "OD1-sku-catalog-authority", question: "Is stock_records the SKU authority?", decision_status: "open" },
      ],
    });
    const ctx = buildCrossStoryContext(tdd, F, "S3-validate-receipt-form");
    expect(ctx.open_decisions).toHaveLength(1);
    expect(ctx.open_decisions[0].id).toBe("OD1-sku-catalog-authority");
    expect(ctx.open_decisions[0].decision_status).toBe("open");
  });

  it("empty context for the feature's first designed story (no siblings, no architecture)", () => {
    write(`features/${F}/stories/S1-record-receipt/acs/AC1-x.json`, { id: "AC1-x", given: "g", when: "w", then: "t" });
    const ctx = buildCrossStoryContext(tdd, F, "S1-record-receipt");
    expect(ctx.sibling_stories).toHaveLength(0);
    expect(ctx.open_decisions).toHaveLength(0);
    expect(ctx.required_persistence_fields).toHaveLength(0);
  });

  it("surfaces the mandated fields (not_null invariants) so the field-contract gap is catchable", () => {
    // The actor-not-sent case: an audit story mandates `actor` NOT NULL, while the sibling
    // operator-submit story's submit AC never captures it – a missing-supply (field-contract)
    // gap the reviewer must see (required_persistence_fields), NOT a contradiction.
    write(`features/${F}/stories/S2-submit-valid-pick/acs/AC1-valid-pick-recorded.json`, {
      id: "AC1-valid-pick-recorded",
      status: "gated",
      layer: "API",
      given: "a valid SKU, location, and quantity",
      when: "the operator submits the pick",
      then: "the pick is recorded capturing the SKU, quantity, and location", // NOTE: no actor
    });
    write(`features/${F}/architecture.json`, {
      feature_id: F,
      service_backed: true,
      nfrs: [],
      persistence_invariants: [
        { id: "PI1-pick-fk", type: "foreign_key", table: "stock_picks", brief: "each pick references a stock record" },
        { id: "PI2-pick-actor-not-null", type: "not_null", table: "stock_picks", brief: "actor is NOT NULL: every pick records who made it" },
        { id: "PI3-pick-ts-not-null", type: "not_null", table: "stock_picks", brief: "created_at is NOT NULL" },
        { id: "PI4-qty-positive", type: "check", table: "stock_picks", brief: "CHECK quantity > 0" },
      ],
    });

    const ctx = buildCrossStoryContext(tdd, F, "S4-record-audit-metadata");

    // ONLY the not_null invariants are mandated fields (fk/check are a different class).
    const ids = ctx.required_persistence_fields.map((f) => f.invariant_id).sort();
    expect(ids).toEqual(["PI2-pick-actor-not-null", "PI3-pick-ts-not-null"]);
    const actor = ctx.required_persistence_fields.find((f) => f.invariant_id === "PI2-pick-actor-not-null");
    expect(actor?.table).toBe("stock_picks");
    expect(actor?.brief).toContain("actor is NOT NULL");
    // The sibling submit AC (which does NOT capture actor) is visible alongside – the reviewer
    // now has both halves to flag the gap.
    const s2 = ctx.sibling_stories.find((s) => s.story.startsWith("S2"));
    expect(s2?.acs.some((a) => (a.then ?? "").includes("actor"))).toBe(false);
  });
});
