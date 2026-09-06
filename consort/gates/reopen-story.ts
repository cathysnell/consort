// Reopen a story for genuine RE-DESIGN (hardening #4, recovery). The kit had no clean way
// to send a story back to the design lane: withdraw-gate reverts the gate + drops the story
// from the build queue, and revise resets build state, but BOTH leave the story's design
// artifacts (ACs, test-list, reflect-verdict) on disk – so the drive sees the story as
// already-designed (hasAcs=true) and merely wants to RE-APPROVE the same, still-conflicting
// spec. To make the roles genuinely re-author, those artifacts must be cleared. This does
// that, with a backup (the .consort artifacts are untracked, so a copy is the only safety
// net) – the primitive the stockflow recovery had to improvise by hand.
//
// hasAcs = storyAcIds().length > 0, and storyAcIds reads BOTH story.json.acs[] AND the acs/
// dir, so clearing the dir alone can leave hasAcs=true; we also empty story.json.acs[]. The
// story shell (id/title/asA/iWantTo/soThat) is preserved so the story still exists – only
// its design output is reverted. Filesystem-only + deterministic (injectable clock) => the
// gate/experiment teardown stay their own existing primitives (withdraw-gate, discard).

import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  acsDir,
  storyTestListJson,
  reflectVerdictJson,
  storyPlanJson,
  storyJson,
  storyResolved,
  featureDeployEvidenceJson,
  workflowStateJson,
} from "../config/consort-paths.js";
import { readPipeline, writePipeline } from "../pipeline/story-pipeline.js";
import { PHASE_OWNER_KEY } from "./workflow-phase.js";

export interface ReopenResult {
  /** Where the cleared artifacts were copied before removal. */
  backupDir: string;
  /** The story-relative paths that were cleared/reverted. */
  cleared: string[];
}

/** Back up + clear a story's design artifacts so the drive re-dispatches the Spec Author
 *  (hasAcs=false) instead of re-approving a stale spec. Never throws on a missing artifact
 *  (each is optional); returns what it did. */
export function reopenStoryForRedesign(
  consortDir: string,
  feature: string,
  story: string,
  opts: { now?: () => Date } = {},
): ReopenResult {
  const now = opts.now ?? (() => new Date());
  const storyRoot = storyResolved(consortDir, feature, story);
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(consortDir, `.backup-${basename(storyRoot)}-redesign-${stamp}`);
  const cleared: string[] = [];

  const rel = (p: string): string => p.slice(storyRoot.length).replace(/^[/\\]/, "") || basename(p);
  const backup = (p: string): void => {
    const dest = join(backupDir, rel(p));
    fs.mkdirSync(dirname(dest), { recursive: true });
    fs.cpSync(p, dest, { recursive: true });
  };

  // 1. Remove the design artifacts (backed up) so the story reverts to "needs design".
  for (const p of [
    acsDir(consortDir, feature, story),
    storyTestListJson(consortDir, feature, story),
    reflectVerdictJson(consortDir, feature, story),
    storyPlanJson(consortDir, feature, story),
  ]) {
    if (!fs.existsSync(p)) continue;
    backup(p);
    fs.rmSync(p, { recursive: true, force: true });
    cleared.push(rel(p));
  }

  // 2. hasAcs also counts story.json.acs[]; empty it (backed up), preserving every other
  //    field, so hasAcs is DEFINITIVELY false and the drive re-dispatches the Spec Author.
  const sj = storyJson(consortDir, feature, story);
  if (fs.existsSync(sj)) {
    try {
      const obj = JSON.parse(fs.readFileSync(sj, "utf8")) as Record<string, unknown>;
      if (Array.isArray(obj.acs) && obj.acs.length > 0) {
        backup(sj);
        fs.writeFileSync(sj, JSON.stringify({ ...obj, acs: [] }, null, 2) + "\n");
        cleared.push(rel(sj) + " (acs[] emptied)");
      }
    } catch {
      /* leave a malformed story.json untouched */
    }
  }

  // 3. The FEATURE-level deploy gate. Reopening ANY story makes the feature no-longer-complete,
  //    so its `deploy-evidence.json` (the deploy gate's artifact) is STALE – yet the feature
  //    deploy gate is derived from it and would stay OPEN over a mid-redesign story (you cannot
  //    re-approve a deploy for a feature being re-designed; reopening a story otherwise stranded
  //    the gate, forcing a hand-clear). Back it up + clear it so the gate evaporates and the
  //    feature re-deploy-verifies after the rebuild. It is feature-level (outside storyRoot), so
  //    it is backed up under an explicit name rather than the story-relative `backup()`.
  const fde = featureDeployEvidenceJson(consortDir, feature);
  if (fs.existsSync(fde)) {
    const dest = join(backupDir, "feature-deploy-evidence.json");
    fs.mkdirSync(dirname(dest), { recursive: true });
    fs.cpSync(fde, dest);
    fs.rmSync(fde, { force: true });
    cleared.push("../deploy-evidence.json (feature deploy gate)");
  }

  // 4. Reset the PIPELINE entry so the derivation re-enters the DESIGN lane for this story. This
  //    is the piece that makes reopening a DONE + merged + ACCEPTED story actually work: the
  //    feature phase is derived from each entry's status + acceptance (deriveFeaturePhase), so a
  //    still-`accepted` entry keeps the feature reading complete and the engine routes to DEPLOY ,
  //    never re-dispatching the Spec Author. reopen-story previously left the entry untouched, so
  //    reopening an accepted story stranded the deploy gate and forced hand-surgery across
  //    reopen-story + set-status + rebuild-story + withdraw-gate (which lands inconsistent). Clear
  //    the entry to a bare `designing` – dropping the spec gate, experiment, AND acceptance in one
  //    write – and pull it off the build lane. Idempotent + safe for a not-yet-accepted story
  //    (its acceptance/experiment are already absent). Best-effort: a missing/malformed pipeline
  //    still leaves the artifacts above reverted.
  try {
    const pipeline = readPipeline(consortDir, feature);
    if (pipeline.stories[story]) {
      pipeline.stories[story] = { status: "designing" };
      pipeline.build_queue = pipeline.build_queue.filter((s) => s !== story);
      if (pipeline.build_active === story) pipeline.build_active = null;
      writePipeline(consortDir, pipeline);
      cleared.push("pipeline entry -> designing (spec gate + experiment + acceptance cleared)");
    }
  } catch {
    /* no/ malformed pipeline: the artifact clear above already reverts the design output */
  }

  // 5. Reset the COARSE driver phase so the drive re-enters design/build for this feature. The
  //    drive routes on the per-PROJECT coarse `phase` (workflow-state.json), a STORED slot that
  //    advanced to "deploy" when the feature completed – it is NOT derived, so the pipeline reset
  //    above does not move it and the drive would keep routing to DEPLOY. Clearing the phase + its
  //    owner makes the probe RE-DERIVE the true phase from this feature's (now-reset) artifacts ,
  //    the FEIP-8022 un-owned re-derive path (deploy-evidence + gates + pipeline). Backed up.
  try {
    const wsFile = workflowStateJson(consortDir);
    if (fs.existsSync(wsFile)) {
      const ws = JSON.parse(fs.readFileSync(wsFile, "utf8")) as Record<string, unknown>;
      if (ws.phase !== undefined || ws[PHASE_OWNER_KEY] !== undefined) {
        const dest = join(backupDir, "workflow-state.json");
        fs.mkdirSync(dirname(dest), { recursive: true });
        fs.cpSync(wsFile, dest);
        delete ws.phase;
        delete ws[PHASE_OWNER_KEY];
        fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2) + "\n");
        cleared.push("coarse phase cleared (drive re-derives design/build from artifacts)");
      }
    }
  } catch {
    /* best-effort: the derivation still re-reads the reset pipeline + deploy-evidence */
  }

  return { backupDir, cleared };
}
