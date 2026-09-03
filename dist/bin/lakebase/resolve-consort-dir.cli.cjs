#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// consort/config/consort-paths.ts
var fs = __toESM(require("fs"), 1);
var import_node_path = require("path");
var ARTIFACT_ROOT = ".consort";
var LEGACY_ARTIFACT_ROOTS = [".sftdd", ".tdd"];
var ALL_ARTIFACT_ROOTS = [ARTIFACT_ROOT, ...LEGACY_ARTIFACT_ROOTS];
function resolveConsortDir(projectDir2 = process.cwd()) {
  const next = (0, import_node_path.join)(projectDir2, ARTIFACT_ROOT);
  if (fs.existsSync(next)) return next;
  for (const legacyName of LEGACY_ARTIFACT_ROOTS) {
    const legacy = (0, import_node_path.join)(projectDir2, legacyName);
    if (fs.existsSync(legacy)) return legacy;
  }
  return next;
}

// bin/lakebase/resolve-consort-dir.cli.ts
function parseProjectDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project-dir" && i + 1 < argv.length) return argv[i + 1];
    if (argv[i] === "-h" || argv[i] === "--help") {
      process.stdout.write("Usage: lakebase-resolve-consort-dir [--project-dir <dir>]\n");
      process.exit(0);
    }
  }
  return void 0;
}
var projectDir = parseProjectDir(process.argv.slice(2));
process.stdout.write(resolveConsortDir(projectDir ?? process.cwd()) + "\n");
