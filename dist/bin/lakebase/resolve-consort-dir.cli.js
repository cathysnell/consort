#!/usr/bin/env node

// consort/config/consort-paths.ts
import * as fs from "fs";
import { join } from "path";
var ARTIFACT_ROOT = ".consort";
var LEGACY_ARTIFACT_ROOTS = [".sftdd", ".tdd"];
var ALL_ARTIFACT_ROOTS = [ARTIFACT_ROOT, ...LEGACY_ARTIFACT_ROOTS];
function resolveConsortDir(projectDir2 = process.cwd()) {
  const next = join(projectDir2, ARTIFACT_ROOT);
  if (fs.existsSync(next)) return next;
  for (const legacyName of LEGACY_ARTIFACT_ROOTS) {
    const legacy = join(projectDir2, legacyName);
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
