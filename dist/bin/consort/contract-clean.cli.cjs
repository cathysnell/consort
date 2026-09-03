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

// consort/architecture/contract-clean.ts
var import_node_fs = require("fs");
var import_node_path2 = require("path");

// consort/config/consort-paths.ts
var fs = __toESM(require("fs"), 1);
var import_node_path = require("path");
var ARTIFACT_ROOT = ".consort";
var LEGACY_ARTIFACT_ROOTS = [".sftdd", ".tdd"];
var ALL_ARTIFACT_ROOTS = [ARTIFACT_ROOT, ...LEGACY_ARTIFACT_ROOTS];
var artifactRootsRegexAlternation = () => ALL_ARTIFACT_ROOTS.map((r2) => r2.replace(/[.]/g, "\\.")).join("|");

// consort/architecture/contract-clean.ts
var ARTIFACT_ROOTS_RE = artifactRootsRegexAlternation();
var DEFAULT_MIGRATION_DIRS = ["alembic/versions", "migrations", "db/migrations", "src/migrations"];
var DEFAULT_CODE_DIRS = ["app", "src", "lib", "templates"];
var CODE_EXTS = /* @__PURE__ */ new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".html", ".jinja", ".jinja2", ".sql"]);
var EXCLUDE_DIR = new RegExp(
  `(^|/)(node_modules|\\.git|\\.venv|venv|__pycache__|${ARTIFACT_ROOTS_RE}|\\.lakebase|dist|build|tests?|alembic|migrations)(/|$)`
);
var EXCLUDE_DIR_JUNK = new RegExp(
  `(^|/)(node_modules|\\.git|\\.venv|venv|__pycache__|${ARTIFACT_ROOTS_RE}|\\.lakebase|dist|build)(/|$)`
);
var DROP_COLUMN_PY = /op\.drop_column\(\s*['"][^'"]+['"]\s*,\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
var ADD_COLUMN_PY = /op\.add_column\(\s*['"][^'"]+['"]\s*,\s*sa\.Column\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
var DROP_COLUMN_SQL = /drop\s+column\s+(?:if\s+exists\s+)?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi;
var ADD_COLUMN_SQL = /add\s+column\s+(?:if\s+not\s+exists\s+)?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi;
function walk(dir, keep, out = [], excludeDir = EXCLUDE_DIR) {
  let entries;
  try {
    entries = (0, import_node_fs.readdirSync)(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = (0, import_node_path2.join)(dir, e);
    let st;
    try {
      st = (0, import_node_fs.statSync)(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!excludeDir.test(abs)) walk(abs, keep, out, excludeDir);
    } else if (st.isFile() && keep(abs)) {
      out.push(abs);
    }
  }
  return out;
}
function collectAll(re, text) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}
function forwardMigrationBody(src, ext) {
  if (ext === ".py") {
    const m = /def\s+upgrade\s*\(/.exec(src);
    if (!m) return src;
    const bodyStart = m.index + m[0].length;
    const rel = src.slice(bodyStart).search(/\ndef\s+downgrade\s*\(/);
    return rel === -1 ? src.slice(bodyStart) : src.slice(bodyStart, bodyStart + rel);
  }
  if (ext === ".js" || ext === ".ts") {
    const up = /(exports\.up\b|async\s+function\s+up\b|\bup\s*[:=])/.exec(src);
    if (!up) return src;
    const after = src.slice(up.index + up[0].length);
    const rel = after.search(/(exports\.down\b|async\s+function\s+down\b|\bdown\s*[:=])/);
    return rel === -1 ? after : after.slice(0, rel);
  }
  return src;
}
function netDroppedSymbols(projectDir, migrationDirs = DEFAULT_MIGRATION_DIRS) {
  const files = [];
  for (const md of migrationDirs) {
    const abs = (0, import_node_path2.join)(projectDir, md);
    if ((0, import_node_fs.existsSync)(abs)) {
      for (const f of walk(abs, (p2) => /\.(py|sql|js|ts)$/.test(p2))) files.push(f);
    }
  }
  files.sort();
  const lastAction = /* @__PURE__ */ new Map();
  for (const f of files) {
    let src;
    try {
      src = (0, import_node_fs.readFileSync)(f, "utf8");
    } catch {
      continue;
    }
    const ext = (0, import_node_path2.extname)(f);
    const isPy = ext === ".py";
    const body = forwardMigrationBody(src, ext);
    const drops = isPy ? collectAll(DROP_COLUMN_PY, body) : collectAll(DROP_COLUMN_SQL, body);
    const adds = isPy ? collectAll(ADD_COLUMN_PY, body) : collectAll(ADD_COLUMN_SQL, body);
    for (const a of adds) lastAction.set(a, "add");
    for (const d of drops) lastAction.set(d, "drop");
  }
  return [...lastAction.entries()].filter(([, act]) => act === "drop").map(([sym]) => sym);
}
function symbolRefRegex(symbol) {
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}
function scanSymbolRefs(projectDir, dirs, dropped, excludeDir = EXCLUDE_DIR) {
  const matchers = dropped.map((s) => ({ symbol: s, re: symbolRefRegex(s) }));
  const hits = [];
  for (const cd of dirs) {
    const abs = (0, import_node_path2.join)(projectDir, cd);
    if (!(0, import_node_fs.existsSync)(abs)) continue;
    for (const file of walk(abs, (p2) => CODE_EXTS.has((0, import_node_path2.extname)(p2)), [], excludeDir)) {
      let lines;
      try {
        lines = (0, import_node_fs.readFileSync)(file, "utf8").split("\n");
      } catch {
        continue;
      }
      lines.forEach((text, i) => {
        for (const { symbol, re } of matchers) {
          if (re.test(text)) {
            hits.push({ file: (0, import_node_path2.relative)(projectDir, file), line: i + 1, symbol, text: text.trim().slice(0, 200) });
          }
        }
      });
    }
  }
  return hits;
}
function checkContractClean(args) {
  const { projectDir } = args;
  const dropped = netDroppedSymbols(projectDir, args.migrationDirs);
  if (dropped.length === 0) return { clean: true, droppedSymbols: [], violations: [] };
  const violations = scanSymbolRefs(projectDir, args.codeDirs ?? DEFAULT_CODE_DIRS, dropped);
  if (violations.length === 0) return { clean: true, droppedSymbols: dropped, violations: [] };
  const list = violations.map((v) => `  ${v.file}:${v.line}  [${v.symbol}]  ${v.text}`).join("\n");
  const syms = [...new Set(violations.map((v) => v.symbol))].join(", ");
  const remediation = `CONTRACT-INCOMPLETENESS (software-design-principles hard rule 9): a migration DROPPED ${syms}, but the running code still references it, so the app emits SQL for a column the database no longer has and crashes ("${syms} does not exist") even though the migration succeeded. Remove or replace EVERY reference below in the SAME change , the ORM model field, every query/repository, every serializer/DTO, and every template/view , so the code matches the migrated schema. Do NOT edit the migration or any test to hide this; fix the production code:
${list}`;
  return { clean: false, droppedSymbols: dropped, violations, remediation };
}

// bin/consort/contract-clean.cli.ts
function parse(argv) {
  const out = { projectDir: process.cwd(), migrations: [], code: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-dir" && i + 1 < argv.length) out.projectDir = argv[++i];
    else if (a === "--migrations" && i + 1 < argv.length) out.migrations.push(argv[++i]);
    else if (a === "--code" && i + 1 < argv.length) out.code.push(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") help();
  }
  return out;
}
function help() {
  process.stdout.write(
    `consort-contract-clean , prove no code references a column a migration dropped

Usage:
  consort-contract-clean [--project-dir <path>] [--migrations <rel> ...] [--code <rel> ...] [--json]

Exit 0 = clean (no drops, or all dropped symbols gone from code); exit 1 = residual references (hard rule 9).
`
  );
  process.exit(0);
}
var p = parse(process.argv.slice(2));
var callArgs = { projectDir: p.projectDir };
if (p.migrations.length > 0) callArgs.migrationDirs = p.migrations;
if (p.code.length > 0) callArgs.codeDirs = p.code;
var r = checkContractClean(callArgs);
if (p.json) {
  process.stdout.write(`${JSON.stringify(r)}
`);
} else if (r.clean) {
  const what = r.droppedSymbols.length ? `dropped [${r.droppedSymbols.join(", ")}] no longer referenced in code` : "no migration column drops to check";
  process.stdout.write(`contract-clean: OK , ${what}
`);
} else {
  process.stderr.write(`contract-clean: FAILED , ${r.violations.length} residual reference(s).

${r.remediation}
`);
}
process.exit(r.clean ? 0 : 1);
