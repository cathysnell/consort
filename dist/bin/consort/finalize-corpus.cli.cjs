#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// bin/consort/finalize-corpus.cli.ts
var finalize_corpus_cli_exports = {};
__export(finalize_corpus_cli_exports, {
  runFinalizeCorpusCli: () => runFinalizeCorpusCli
});
module.exports = __toCommonJS(finalize_corpus_cli_exports);

// node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// bin/consort/finalize-corpus.cli.ts
var import_util = require("@databricks-solutions/lakebase-scm-utils/util");

// consort/logging/finalize-corpus.ts
var import_node_fs2 = require("fs");
var import_node_path3 = require("path");

// consort/logging/turn-recorder.ts
var import_node_crypto = require("crypto");
var import_node_fs = require("fs");
var import_node_path2 = require("path");

// consort/config/consort-paths.ts
var fs = __toESM(require("fs"), 1);
var import_node_path = require("path");
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
  if (!(0, import_node_fs2.existsSync)(root)) return [];
  const out = [];
  for (const entry of (0, import_node_fs2.readdirSync)(root)) {
    const abs = (0, import_node_path3.join)(root, entry);
    const st = (0, import_node_fs2.statSync)(abs);
    if (st.isDirectory()) out.push(...listFiles(abs).map((r) => (0, import_node_path3.join)(entry, r)));
    else if (st.isFile()) out.push(entry);
  }
  return out;
}
function buildConsortMirror(recordDir) {
  const producedDir = (0, import_node_path3.join)(recordDir, "recorded-artifacts");
  const intakeDir = (0, import_node_path3.join)(recordDir, "intake");
  const mirrorDir = (0, import_node_path3.join)(recordDir, ARTIFACT_ROOT);
  const report = { fromProduced: 0, fromIntake: 0, collisions: [] };
  const copy = (srcRoot, rel) => {
    const src = (0, import_node_path3.join)(srcRoot, rel);
    const dst = (0, import_node_path3.join)(mirrorDir, rel);
    (0, import_node_fs2.mkdirSync)((0, import_node_path3.dirname)(dst), { recursive: true });
    (0, import_node_fs2.copyFileSync)(src, dst);
  };
  for (const rel of listFiles(producedDir)) {
    copy(producedDir, rel);
    report.fromProduced += 1;
  }
  for (const rel of listFiles(intakeDir)) {
    const dst = (0, import_node_path3.join)(mirrorDir, rel);
    if ((0, import_node_fs2.existsSync)(dst)) {
      const a = (0, import_node_fs2.readFileSync)(dst);
      const b = (0, import_node_fs2.readFileSync)((0, import_node_path3.join)(intakeDir, rel));
      if (!a.equals(b)) report.collisions.push(rel);
      continue;
    }
    copy(intakeDir, rel);
    report.fromIntake += 1;
  }
  (0, import_node_fs2.writeFileSync)((0, import_node_path3.join)(recordDir, "mirror-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
function sweepTargets(recordDir) {
  const targets = [];
  const turnsDir = (0, import_node_path3.join)(recordDir, "turns");
  if ((0, import_node_fs2.existsSync)(turnsDir)) {
    for (const turn of (0, import_node_fs2.readdirSync)(turnsDir)) {
      const td = (0, import_node_path3.join)(turnsDir, turn);
      if (!(0, import_node_fs2.statSync)(td).isDirectory()) continue;
      for (const rel of ["replay-set/prompt.txt", "transcript.md"]) {
        const f = (0, import_node_path3.join)(td, rel);
        if ((0, import_node_fs2.existsSync)(f)) targets.push(f);
      }
    }
  }
  const corr = (0, import_node_path3.join)(recordDir, "correspondence.jsonl");
  if ((0, import_node_fs2.existsSync)(corr)) targets.push(corr);
  return targets;
}
function sweepRecordedPaths(recordDir, liveProjectRoot) {
  const mirrorDir = (0, import_node_path3.join)(recordDir, ARTIFACT_ROOT);
  const report = { filesScanned: 0, rewrittenToConsort: 0, leftAsToken: 0 };
  const roots = [PROJECT_ROOT_TOKEN, ...liveProjectRoot ? [liveProjectRoot.replace(/\/+$/, "")] : []];
  for (const file of sweepTargets(recordDir)) {
    report.filesScanned += 1;
    let text = (0, import_node_fs2.readFileSync)(file, "utf8");
    let changed = false;
    for (const root of roots) {
      const re = new RegExp(escapeRegExp(root) + "/" + escapeRegExp(ARTIFACT_ROOT) + "/([^\\s\"'`)\\]]+)", "g");
      text = text.replace(re, (whole, rawTail) => {
        let tail = rawTail;
        let trailer = "";
        for (; ; ) {
          if ((0, import_node_fs2.existsSync)((0, import_node_path3.join)(mirrorDir, tail))) {
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
    if (changed) (0, import_node_fs2.writeFileSync)(file, text);
  }
  (0, import_node_fs2.writeFileSync)((0, import_node_path3.join)(recordDir, "path-sweep-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function finalizeCorpus(recordDir, liveProjectRoot) {
  if (!(0, import_node_fs2.existsSync)(recordDir)) throw new Error(`finalizeCorpus: record dir not found: ${recordDir}`);
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
if ((0, import_util.isCliEntry)(importMetaUrl)) {
  process.exit(runFinalizeCorpusCli(process.argv.slice(2)));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runFinalizeCorpusCli
});
