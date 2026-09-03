#!/usr/bin/env node

// bin/consort/finalize-corpus.cli.ts
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

// consort/logging/finalize-corpus.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync3,
  statSync as statSync3,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync3,
  copyFileSync
} from "fs";
import { join as join3, dirname as dirname2, relative as relative2 } from "path";

// consort/logging/turn-recorder.ts
import { createHash } from "crypto";
import {
  appendFileSync,
  cpSync,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  rmSync,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname, join as join2, relative } from "path";

// consort/config/consort-paths.ts
import * as fs from "fs";
import { join } from "path";
var ARTIFACT_ROOT = ".consort";
var LEGACY_ARTIFACT_ROOTS = [".sftdd", ".tdd"];
var ALL_ARTIFACT_ROOTS = [ARTIFACT_ROOT, ...LEGACY_ARTIFACT_ROOTS];

// consort/logging/replay-build.ts
var SCAFFOLD_OWNED = /* @__PURE__ */ new Set([
  ".git",
  ...ALL_ARTIFACT_ROOTS,
  ".lakebase",
  "scripts",
  ".claude",
  ".github",
  "node_modules"
]);

// consort/logging/turn-recorder.ts
var PROJECT_ROOT_TOKEN = "<PROJECT_ROOT>";

// consort/logging/finalize-corpus.ts
function listFiles(root) {
  if (!existsSync3(root)) return [];
  const out = [];
  for (const entry of readdirSync3(root)) {
    const abs = join3(root, entry);
    const st = statSync3(abs);
    if (st.isDirectory()) out.push(...listFiles(abs).map((r) => join3(entry, r)));
    else if (st.isFile()) out.push(entry);
  }
  return out;
}
function buildConsortMirror(recordDir) {
  const producedDir = join3(recordDir, "recorded-artifacts");
  const intakeDir = join3(recordDir, "intake");
  const mirrorDir = join3(recordDir, ARTIFACT_ROOT);
  const report = { fromProduced: 0, fromIntake: 0, collisions: [] };
  const copy = (srcRoot, rel) => {
    const src = join3(srcRoot, rel);
    const dst = join3(mirrorDir, rel);
    mkdirSync3(dirname2(dst), { recursive: true });
    copyFileSync(src, dst);
  };
  for (const rel of listFiles(producedDir)) {
    copy(producedDir, rel);
    report.fromProduced += 1;
  }
  for (const rel of listFiles(intakeDir)) {
    const dst = join3(mirrorDir, rel);
    if (existsSync3(dst)) {
      const a = readFileSync3(dst);
      const b = readFileSync3(join3(intakeDir, rel));
      if (!a.equals(b)) report.collisions.push(rel);
      continue;
    }
    copy(intakeDir, rel);
    report.fromIntake += 1;
  }
  writeFileSync3(join3(recordDir, "mirror-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
function sweepTargets(recordDir) {
  const targets = [];
  const turnsDir = join3(recordDir, "turns");
  if (existsSync3(turnsDir)) {
    for (const turn of readdirSync3(turnsDir)) {
      const td = join3(turnsDir, turn);
      if (!statSync3(td).isDirectory()) continue;
      for (const rel of ["replay-set/prompt.txt", "transcript.md"]) {
        const f = join3(td, rel);
        if (existsSync3(f)) targets.push(f);
      }
    }
  }
  const corr = join3(recordDir, "correspondence.jsonl");
  if (existsSync3(corr)) targets.push(corr);
  return targets;
}
function sweepRecordedPaths(recordDir, liveProjectRoot) {
  const mirrorDir = join3(recordDir, ARTIFACT_ROOT);
  const report = { filesScanned: 0, rewrittenToConsort: 0, leftAsToken: 0 };
  const roots = [PROJECT_ROOT_TOKEN, ...liveProjectRoot ? [liveProjectRoot.replace(/\/+$/, "")] : []];
  for (const file of sweepTargets(recordDir)) {
    report.filesScanned += 1;
    let text = readFileSync3(file, "utf8");
    let changed = false;
    for (const root of roots) {
      const re = new RegExp(escapeRegExp(root) + "/" + escapeRegExp(ARTIFACT_ROOT) + "/([^\\s\"'`)\\]]+)", "g");
      text = text.replace(re, (whole, rawTail) => {
        let tail = rawTail;
        let trailer = "";
        for (; ; ) {
          if (existsSync3(join3(mirrorDir, tail))) {
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
        return whole;
      });
      if (root !== PROJECT_ROOT_TOKEN) {
        const before = text;
        text = text.split(root + "/").join(PROJECT_ROOT_TOKEN + "/").split(root).join(PROJECT_ROOT_TOKEN);
        if (text !== before) changed = true;
      }
    }
    if (changed) writeFileSync3(file, text);
  }
  writeFileSync3(join3(recordDir, "path-sweep-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function finalizeCorpus(recordDir, liveProjectRoot) {
  if (!existsSync3(recordDir)) throw new Error(`finalizeCorpus: record dir not found: ${recordDir}`);
  const mirror = buildConsortMirror(recordDir);
  const sweep = sweepRecordedPaths(recordDir, liveProjectRoot);
  return { mirror, sweep };
}

// bin/consort/finalize-corpus.cli.ts
function runFinalizeCorpusCli(argv) {
  const args = [...argv];
  let recordDir;
  let liveRoot;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--live-root") liveRoot = args[++i];
    else if (!a.startsWith("--") && !recordDir) recordDir = a;
    else if (a === "-h" || a === "--help") {
      printUsage();
      return 0;
    }
  }
  if (!recordDir) {
    printUsage();
    return 2;
  }
  try {
    const { mirror, sweep } = finalizeCorpus(recordDir, liveRoot);
    process.stderr.write(
      `[finalize-corpus] .consort mirror: ${mirror.fromProduced} produced + ${mirror.fromIntake} intake${mirror.collisions.length ? `, ${mirror.collisions.length} COLLISION(S) skipped: ${mirror.collisions.join(", ")}` : ""}
[finalize-corpus] path sweep: ${sweep.rewrittenToConsort} -> ./.consort (browsable), ${sweep.leftAsToken} left as <PROJECT_ROOT> (no mirror file), ${sweep.filesScanned} files scanned
`
    );
    return 0;
  } catch (e) {
    process.stderr.write(`[finalize-corpus] FAILED: ${e.message}
`);
    return 3;
  }
}
function printUsage() {
  process.stderr.write(
    "usage: consort-finalize-corpus <recordDir> [--live-root <absProjectRoot>]\n  Builds <recordDir>/.consort mirror + rewrites recorded paths to ./.consort/... (browsable).\n"
  );
}
if (isCliEntry(import.meta.url)) {
  process.exit(runFinalizeCorpusCli(process.argv.slice(2)));
}
export {
  runFinalizeCorpusCli
};
