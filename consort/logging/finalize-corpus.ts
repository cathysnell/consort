// Corpus finalizer: make a recorded capture PORTABLE + BROWSABLE after the run completes.
//
// Problem: recorded prompts/transcripts embed the ephemeral project root, and the referenced
// `.consort/...` files are split across two durable homes in the corpus (intake/ = the seed,
// recorded-artifacts/ = the produced final state). There is no single `.consort/` dir to open. So a
// reader examining the corpus later cannot follow the paths.
//
// This runs POST-recording, once the final `.consort` state exists:
//   buildConsortMirror(recordDir) – create <rec>/.consort/ = recorded-artifacts (produced, wins) UNION
//                                    intake (seed, fills gaps), so every referenced .consort/<x> is a
//                                    REAL file at <rec>/.consort/<x>.
//   sweepRecordedPaths(recordDir) – rewrite <PROJECT_ROOT>/.consort/<x> (or a raw abs project path) in
//                                    every prompt.txt + transcript.md + correspondence.jsonl to the
//                                    record-relative `.consort/<x>` – which now resolves to the mirror
//                                    (browser-openable). Code paths (app/tests/client/alembic) with no
//                                    single mirror are left as <PROJECT_ROOT>/... (honest fallback).
//
// Both are idempotent and operate ONLY on recorded text/dirs – never on live artifacts.

import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { PROJECT_ROOT_TOKEN } from "./turn-recorder.js";
import { ARTIFACT_ROOT } from "../config/consort-paths.js";

/** Recursively list files (relative to `root`). */
function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...listFiles(abs).map((r) => join(entry, r)));
    else if (st.isFile()) out.push(entry);
  }
  return out;
}

export interface MirrorReport {
  fromProduced: number; // files copied from recorded-artifacts/
  fromIntake: number;   // files copied from intake/ (gap-fill)
  collisions: string[]; // relpaths where intake would have overwritten a DIFFERENT produced file (skipped)
}

/**
 * Build `<recordDir>/.consort/` = the FINAL `.consort` state, so the paths recorded prompts reference
 * resolve to a real file. recorded-artifacts/ (produced) is copied first and WINS; intake/ (seed) fills
 * only the paths the produced state does not already have. A seed file whose path collides with a
 * DIFFERENT-content produced file is skipped + reported (never a silent clobber). Idempotent (re-copy
 * is byte-identical). Returns the report.
 */
export function buildConsortMirror(recordDir: string): MirrorReport {
  const producedDir = join(recordDir, "recorded-artifacts");
  const intakeDir = join(recordDir, "intake");
  const mirrorDir = join(recordDir, ARTIFACT_ROOT);
  const report: MirrorReport = { fromProduced: 0, fromIntake: 0, collisions: [] };

  const copy = (srcRoot: string, rel: string): void => {
    const src = join(srcRoot, rel);
    const dst = join(mirrorDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  };

  // 1) produced state – the source of truth, copied first.
  for (const rel of listFiles(producedDir)) {
    copy(producedDir, rel);
    report.fromProduced += 1;
  }
  // 2) seed – fill only paths the produced state lacks; a same-path DIFFERENT-content file is a collision.
  for (const rel of listFiles(intakeDir)) {
    const dst = join(mirrorDir, rel);
    if (existsSync(dst)) {
      const a = readFileSync(dst);
      const b = readFileSync(join(intakeDir, rel));
      if (!a.equals(b)) report.collisions.push(rel); // produced wins; seed variant skipped, flagged loud
      continue;
    }
    copy(intakeDir, rel);
    report.fromIntake += 1;
  }

  writeFileSync(join(recordDir, "mirror-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export interface SweepReport {
  filesScanned: number;
  rewrittenToConsort: number; // <PROJECT_ROOT>/.consort/x -> ./.consort/x (resolves to the mirror)
  leftAsToken: number;        // <PROJECT_ROOT>/... with no mirror file (code paths etc.) – kept honest
}

/** Files the sweep rewrites: every recorded prompt + transcript + the correspondence log. */
function sweepTargets(recordDir: string): string[] {
  const targets: string[] = [];
  const turnsDir = join(recordDir, "turns");
  if (existsSync(turnsDir)) {
    for (const turn of readdirSync(turnsDir)) {
      const td = join(turnsDir, turn);
      if (!statSync(td).isDirectory()) continue;
      for (const rel of ["replay-set/prompt.txt", "transcript.md"]) {
        const f = join(td, rel);
        if (existsSync(f)) targets.push(f);
      }
    }
  }
  const corr = join(recordDir, "correspondence.jsonl");
  if (existsSync(corr)) targets.push(corr);
  return targets;
}

/**
 * Rewrite portable-but-unclickable `<PROJECT_ROOT>/.consort/<x>` references (and any residual absolute
 * project path — passed as `liveProjectRoot` when known, e.g. a legacy corpus recorded before Stage 1)
 * to the record-relative `.consort/<x>`, which now resolves to the mirror built by buildConsortMirror.
 * A `.consort/<x>` with NO file in the mirror, or a non-.consort path (code), is left as the token
 * (honest fallback — no dangling absolute path). Idempotent. Call AFTER buildConsortMirror.
 */
export function sweepRecordedPaths(recordDir: string, liveProjectRoot?: string): SweepReport {
  const mirrorDir = join(recordDir, ARTIFACT_ROOT);
  const report: SweepReport = { filesScanned: 0, rewrittenToConsort: 0, leftAsToken: 0 };

  // Normalize any residual absolute project root to the token first, so both forms are handled uniformly.
  const roots = [PROJECT_ROOT_TOKEN, ...(liveProjectRoot ? [liveProjectRoot.replace(/\/+$/, "")] : [])];

  for (const file of sweepTargets(recordDir)) {
    report.filesScanned += 1;
    let text = readFileSync(file, "utf8");
    let changed = false;

    for (const root of roots) {
      // Match `<root>/<ARTIFACT_ROOT>/<tail>` where <tail> is a path token (no whitespace/quote). Only
      // rewrite to a relative path when the mirror actually has the file; otherwise leave the token.
      const re = new RegExp(escapeRegExp(root) + "/" + escapeRegExp(ARTIFACT_ROOT) + "/([^\\s\"'`)\\]]+)", "g");
      text = text.replace(re, (whole, rawTail: string) => {
        // The matched tail can absorb TRAILING sentence punctuation (a path ending a sentence, e.g.
        // "...feature-proposals.md."). Try the tail as-is, then progressively trim trailing . – ; : )
        // characters until it resolves to a real mirror file. The trimmed suffix is preserved verbatim.
        let tail = rawTail;
        let trailer = "";
        for (;;) {
          if (existsSync(join(mirrorDir, tail))) {
            report.rewrittenToConsort += 1;
            changed = true;
            return "./" + ARTIFACT_ROOT + "/" + tail + trailer;
          }
          const m = /[.,;:)\]]$/.exec(tail);
          if (!m) break;
          trailer = tail.slice(-1) + trailer;
          tail = tail.slice(0, -1);
        }
        report.leftAsToken += 1;
        return whole; // no durable file – keep the portable token, do not fabricate a dead relative path
      });
      // A raw absolute root that is NOT a .consort path (code etc.) -> normalize to the token (portable),
      // never to a fake relative path.
      if (root !== PROJECT_ROOT_TOKEN) {
        const before = text;
        text = text.split(root + "/").join(PROJECT_ROOT_TOKEN + "/").split(root).join(PROJECT_ROOT_TOKEN);
        if (text !== before) changed = true;
      }
    }

    if (changed) writeFileSync(file, text);
  }

  writeFileSync(join(recordDir, "path-sweep-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finalize a completed corpus: build the browsable .consort mirror, then sweep recorded paths onto it. */
export function finalizeCorpus(recordDir: string, liveProjectRoot?: string): { mirror: MirrorReport; sweep: SweepReport } {
  if (!existsSync(recordDir)) throw new Error(`finalizeCorpus: record dir not found: ${recordDir}`);
  const mirror = buildConsortMirror(recordDir);
  const sweep = sweepRecordedPaths(recordDir, liveProjectRoot);
  return { mirror, sweep };
}

// Keep `relative` referenced for future path work without a lint error (used in tests + potential
// code-path mapping); no-op guard.
void relative;
