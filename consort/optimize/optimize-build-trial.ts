// optimize-build-trial: classify a BUILD trial's outcome per the user's rule – a build
// candidate is NOT scored on one isolated turn but on whether it SELF-HEALS to the
// story's terminal good state through the orchestrator's own raises/retries/route-backs
// (runDriver). This module holds the PURE decision (a RunDriverResult + any thrown
// error -> one of: self-healed / not-viable / systemic), so the classification is
// unit-tested with no cloud. The live wiring (actually running runDriver bounded to the
// story, then honest-GREEN + functional gates) composes this classifier.
//
// The three outcomes:
//   - self-healed  : the loop reached terminal-good (story built + accepted, NO
//                    unresolved escalation). VALID lever – its wall-clock (the WHOLE
//                    loop, every heal turn included) is the measured cost-to-good.
//   - not-viable   : the loop raised-to-HIL after exhausting retries, or a route-back
//                    could not resolve (DriverStalled / ProtocolViolation). That model/
//                    lever cannot produce recoverable software – LOG + DQ + next trial.
//                    NOT fatal to the sweep.
//   - systemic     : an infra fault (auth expiry, Lakebase fork collision, runner
//                    death) – NOT the candidate's fault. HALT the unattended run.

/** The terminal signals a build-trial's runDriver produced, plus any thrown error. */
export interface BuildTrialSignals {
  /** runDriver returned normally (no throw). Its RunDriverResult fields we care about. */
  result?: {
    /** The run raised a blocking problem to the HIL after retries – did NOT self-heal. */
    escalated?: boolean;
    /** Stopped at the story/lane bound (a clean bounded completion). */
    stoppedAtBound?: boolean;
    /** The raise-to-hil action, when escalated (its reason + source, for the log). */
    escalation?: { reason?: string; source?: string };
  };
  /** An error runDriver (or the substrate) THREW. Classified by name/shape:
   *  DriverStalledError / ProtocolViolationError = the candidate could not converge
   *  (not-viable); anything else (auth / branch fork / runner / spawn infra) = systemic. */
  error?: { name?: string; message?: string } | null;
  /** Honest-GREEN gate outcome read AFTER the loop settled (unresolved escalations for
   *  the story). passed:false means the story did not reach clean terminal-good even if
   *  the loop returned without escalating (belt-and-suspenders). */
  honestGreen?: { passed: boolean; reason?: string };
}

export type BuildTrialVerdict =
  | { outcome: "self-healed" }
  | { outcome: "not-viable"; reason: string }
  | { outcome: "systemic"; reason: string };

/** Error names that mean "the candidate's build could not converge" – a normal DQ, not
 *  a systemic halt. These are the orchestrator's own bounded-retry / protocol failures. */
const NON_VIABLE_ERRORS = new Set(["DriverStalledError", "ProtocolViolationError", "UnexpectedCallbackError"]);

/** Classify a build trial. Pure. */
export function classifyBuildTrial(sig: BuildTrialSignals): BuildTrialVerdict {
  // 1. A thrown error: non-viable (candidate could not converge) vs systemic (infra).
  if (sig.error) {
    const name = sig.error.name ?? "";
    const msg = sig.error.message ?? name ?? "error";
    if (NON_VIABLE_ERRORS.has(name)) {
      return { outcome: "not-viable", reason: `did not converge: ${msg}` };
    }
    return { outcome: "systemic", reason: `infra fault: ${msg}` };
  }

  // 2. The loop returned. escalated => raised to HIL after retries => not-viable.
  const r = sig.result;
  if (!r) return { outcome: "systemic", reason: "no runDriver result and no error (unknown state)" };
  if (r.escalated) {
    const e = r.escalation;
    return { outcome: "not-viable", reason: `raised-to-HIL (not self-healed): ${e?.reason ?? "unresolved"}${e?.source ? ` [${e.source}]` : ""}` };
  }

  // 3. Belt-and-suspenders: an unresolved honest-GREEN escalation even without the
  //    loop flagging escalated (a story that stalled short of clean terminal-good).
  if (sig.honestGreen && !sig.honestGreen.passed) {
    return { outcome: "not-viable", reason: sig.honestGreen.reason ?? "honest-GREEN not reached" };
  }

  // 4. Reached terminal-good (or a clean bound) with no unresolved escalation.
  return { outcome: "self-healed" };
}

/** Whether a verdict is a valid lever measurement (only self-healed counts toward the
 *  champion walk; not-viable is a DQ; systemic halts the run before we get here). */
export function isViableBuildTrial(v: BuildTrialVerdict): boolean {
  return v.outcome === "self-healed";
}
