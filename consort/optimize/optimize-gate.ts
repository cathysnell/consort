// optimize-gate: the DESIGN-handoff gate evaluator for the optimize harness. The
// per-turn quality bar for a design handoff is the role SELF-CHECK
// (response-formatter formatRoleResponse) – the SAME precheck the drive's
// verify-artifact step enforces after every design turn. A candidate can never
// pass a weaker check than baseline: its artifact must clear the identical
// self-check. Pure (reads the .consort), hermetic.
//
// The feature-scope design GATE (gate-conformance-guard resolveArtifactInputs) is
// a MILESTONE approval over the whole feature-spec, not a per-turn bar, so it is
// applied only when a handoff mapping opts into it (requireGate). For the common
// per-turn walk the self-check is the honest, matching bar.
//
// Build-turn (navigator/driver) gating is NOT here: it is the honest-GREEN cycle
// outcome (greenOpenCycle's real alembic+pytest) + a conformant review verdict,
// which the trial runner produces directly. gateForDesignHandoff returns null for
// build turns so the harness knows to use the cycle result instead.

import { formatRoleResponse } from "../../consort/session/response-formatter.js";
import { resolveArtifactInputs, featureDir } from "../../consort/gates/gate-conformance-guard.js";
import type { GateName } from "../../consort/gates/gates.js";

/** A handoff descriptor sufficient to resolve its gate. */
export interface DesignHandoff {
  role: string;
  story?: string;
  buildMode?: string;
}

/** The gate mapping for a design role: which self-check role runs its per-turn
 *  bar, and (optionally) the feature-scope milestone gate to ALSO resolve when the
 *  caller wants the stricter check. */
export interface DesignGateMapping {
  selfCheckRole: string;
  /** The feature-scope milestone gate this role's artifact ultimately feeds, or
   *  undefined for roles with only a self-check (ux-designer, dba). */
  gate?: GateName;
}

/** Map a design handoff to its self-check role (+ the milestone gate it feeds).
 *  Returns null for build turns (navigator/driver with a buildMode), whose bar is
 *  the honest-GREEN cycle result, not a design artifact check. */
export function gateForDesignHandoff(handoff: DesignHandoff): DesignGateMapping | null {
  // A navigator/driver turn carrying a build mode is a BUILD turn, not a design
  // gate. (The navigator's design-lane reflect is handled as its own turn.)
  if ((handoff.role === "driver" || handoff.role === "navigator") && handoff.buildMode) return null;

  switch (handoff.role) {
    case "spec-author":
      return { selfCheckRole: "spec-author", gate: "spec" };
    case "architect-reviewer":
      return { selfCheckRole: "architect-reviewer", gate: "spec" };
    case "test-strategist":
      return { selfCheckRole: "test-strategist", gate: "test_list" };
    case "dba":
      // The DBA feeds the spec gate but has no standalone gate; self-check is its bar.
      return { selfCheckRole: "dba" };
    case "ux-designer":
      // The ux-designer's design-guide has a self-check but no standalone gate.
      return { selfCheckRole: "ux-designer" };
    default:
      return null;
  }
}

export interface GateOutcome {
  passed: boolean;
  reason?: string;
}

/** Evaluate a design handoff's artifacts against the SAME per-turn bar the drive
 *  runs: the role self-check. Set `requireGate` to ALSO resolve the feature-scope
 *  milestone gate (the stricter, whole-feature conformance the Human Proxy gate
 *  approval uses); default false, since the per-turn walk's bar is the self-check. */
export function evaluateDesignGate(args: {
  consortDir: string;
  featureId: string;
  handoff: DesignHandoff;
  requireGate?: boolean;
}): GateOutcome {
  const { consortDir, featureId, handoff, requireGate } = args;
  const mapping = gateForDesignHandoff(handoff);
  if (!mapping) {
    return { passed: false, reason: `not a design handoff (role=${handoff.role}, buildMode=${handoff.buildMode ?? "none"})` };
  }

  // The per-turn bar: the role self-check (the same precheck verify-artifact runs).
  const self = formatRoleResponse({ role: mapping.selfCheckRole, consortDir, featureId, story: handoff.story });
  if (!self.ok) {
    const first = self.violations[0];
    return { passed: false, reason: `self-check: ${first.artifact}: ${first.problem}` };
  }

  // Optionally also resolve the feature-scope milestone gate (stricter).
  if (requireGate && mapping.gate) {
    const fdir = featureDir(consortDir, featureId);
    const resolved = resolveArtifactInputs(mapping.gate, fdir, undefined, consortDir, featureId);
    if ("reason" in resolved) {
      return { passed: false, reason: `gate ${mapping.gate}: ${resolved.reason}` };
    }
  }

  return { passed: true };
}
