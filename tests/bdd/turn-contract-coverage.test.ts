// The route→contract COVERAGE guard: the manifests are the single source of the per-turn event
// contract (raises / requiresEvents), so this guard holds them honest as a set:
//   1. every declared raises/requiresEvents value is a real TurnEventKind (no typo silently ignored);
//   2. producer/consumer CLOSURE – every event some turn REQUIRES is RAISED by some turn (a required
//      event with no producer is a dead route that can never be satisfied);
//   3. every raised/required kind has a spec in TURN_EVENTS (the scope-truth), so the pre-dispatch
//      check can always resolve a path.
// This is the runtime stand-in for a compile-time exhaustiveness pin (JSON manifests cannot be
// `satisfies`-pinned). It iterates SHIPPED_MANIFESTS – the same set the loader dispatches – so a new
// build manifest that declares an event is covered automatically.

import { describe, it, expect } from "vitest";
import { SHIPPED_MANIFESTS } from "../../consort/orchestrator/steps/manifest.js";
import { TURN_EVENTS, type TurnEventKind } from "../../consort/orchestrator/steps/turn-events.js";

const EVENT_KINDS = new Set(Object.keys(TURN_EVENTS));

describe("turn-contract coverage: manifests are the honest single source", () => {
  it("every declared raises/requiresEvents value is a real TurnEventKind (no typos)", () => {
    for (const m of SHIPPED_MANIFESTS) {
      for (const e of m.raises ?? []) {
        expect(EVENT_KINDS.has(e), `${m.id} raises unknown event "${e}"`).toBe(true);
      }
      for (const e of m.requiresEvents ?? []) {
        expect(EVENT_KINDS.has(e), `${m.id} requiresEvents unknown event "${e}"`).toBe(true);
      }
    }
  });

  it("producer/consumer closure: every REQUIRED event is RAISED by some turn", () => {
    const raised = new Set<TurnEventKind>();
    for (const m of SHIPPED_MANIFESTS) for (const e of m.raises ?? []) raised.add(e);
    const requiredWithoutProducer: string[] = [];
    for (const m of SHIPPED_MANIFESTS) {
      for (const e of m.requiresEvents ?? []) {
        if (!raised.has(e)) requiredWithoutProducer.push(`${m.id} requires "${e}" but no turn raises it`);
      }
    }
    expect(requiredWithoutProducer, requiredWithoutProducer.join("; ")).toEqual([]);
  });

  it("every raised/required kind has a TURN_EVENTS spec (scope resolvable)", () => {
    for (const m of SHIPPED_MANIFESTS) {
      for (const e of [...(m.raises ?? []), ...(m.requiresEvents ?? [])]) {
        expect(TURN_EVENTS[e], `${m.id}: no TURN_EVENTS spec for "${e}"`).toBeDefined();
      }
    }
  });

  // Anti-recurrence (class-m route-satisfiability halt): the per-story test list
  // is written by the test-strategist to test-list-per-story.json (storyTestListJson).
  // driver-green-superseded.json declared `story:test-list.json` — a file no writer
  // produces — so on the rare assess->green-superseded route the pre-dispatch
  // route-satisfiability check failed loud ("missing input test-list") and halted
  // the sprint. Every manifest input that consumes the story test list MUST name the
  // one canonical file, so a new/edited manifest cannot reintroduce a phantom source.
  it("every `test-list` input names the canonical story:test-list-per-story.json", () => {
    const wrong: string[] = [];
    for (const m of SHIPPED_MANIFESTS) {
      for (const inp of m.inputs ?? []) {
        if (inp.id === "test-list" && inp.source.startsWith("story:") && inp.source !== "story:test-list-per-story.json") {
          wrong.push(`${m.id}: test-list source is "${inp.source}", expected "story:test-list-per-story.json"`);
        }
      }
    }
    expect(wrong, wrong.join("; ")).toEqual([]);
  });

  it("the known producer/consumer pairs are wired (green→assess→repair, review→refactor)", () => {
    const byId = Object.fromEntries(SHIPPED_MANIFESTS.map((m) => [m.id, m]));
    // green raises green-failure; assess requires it.
    expect(byId["driver-green"]?.raises).toContain("green-failure");
    expect(byId["navigator-assess"]?.requiresEvents).toContain("green-failure");
    // assess raises regression-assessment; repair requires it.
    expect(byId["navigator-assess"]?.raises).toContain("regression-assessment");
    expect(byId["driver-repair"]?.requiresEvents).toContain("regression-assessment");
    // review raises review-verdict; refactor requires it.
    expect(byId["navigator-review"]?.raises).toContain("review-verdict");
    expect(byId["driver-refactor"]?.requiresEvents).toContain("review-verdict");
  });
});
