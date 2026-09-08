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

// bin/consort/dashboard.cli.ts
var import_node_child_process2 = require("child_process");
var import_node_net = require("net");
var fs2 = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);

// consort/config/kit-bin.ts
var import_node_child_process = require("child_process");
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var kitRootCache;
function resolveKitRoot() {
  if (kitRootCache !== void 0) return kitRootCache;
  const env = process.env.LAKEBASE_KIT_DIR?.trim();
  kitRootCache = env && fs.existsSync(path.join(env, "package.json")) ? env : path.resolve(__dirname, "..", "..", "..");
  return kitRootCache;
}
function kitRoot() {
  return resolveKitRoot();
}

// bin/consort/dashboard.cli.ts
function parseArgs(argv) {
  const out = { projectDir: process.cwd(), host: "localhost", open: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project-dir":
        out.projectDir = argv[++i];
        break;
      case "--port":
        out.port = Number(argv[++i]);
        break;
      case "--record-dir":
        out.recordDir = argv[++i];
        break;
      case "--host":
        out.host = argv[++i];
        break;
      case "--no-open":
        out.open = false;
        break;
      case "-h":
      case "--help":
        console.log(
          "consort-dashboard [--project-dir <p>] [--port <n>] [--record-dir <p>] [--host <h>] [--no-open]\nLaunch the dashboard on a local project's .consort/ (prebuilt bundle, or next dev in a dev clone)."
        );
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return out;
}
function freePort(host) {
  return new Promise((resolve3, reject) => {
    const srv = (0, import_node_net.createServer)();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve3(port));
    });
  });
}
function prebuiltServer(kit) {
  const root = path2.join(kit, "dist", "dashboard");
  const candidates = [path2.join(root, "server.js"), path2.join(root, "apps", "dashboard", "server.js")];
  return candidates.find((p) => fs2.existsSync(p)) ?? null;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = path2.resolve(args.projectDir);
  const kit = kitRoot();
  const port = args.port && Number.isFinite(args.port) ? args.port : await freePort(args.host);
  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: args.host,
    CONSORT_PROJECT_DIR: projectDir,
    ...args.recordDir ? { CONSORT_RECORD_DIR: args.recordDir } : {}
  };
  const url = `http://${args.host}:${port}/`;
  const server = prebuiltServer(kit);
  const runSh = path2.join(kit, "apps", "dashboard", "run.sh");
  let child;
  if (server) {
    console.log(`Consort dashboard (prebuilt) \u2192 ${url}
  project: ${projectDir}${args.recordDir ? `
  record:  ${args.recordDir}` : ""}
  Ctrl-C to stop.`);
    child = (0, import_node_child_process2.spawn)("node", [server], { cwd: path2.dirname(server), env, stdio: "inherit" });
  } else if (fs2.existsSync(runSh)) {
    console.log(`Consort dashboard (dev) \u2192 ${url}
  project: ${projectDir}
  Ctrl-C to stop.`);
    child = (0, import_node_child_process2.spawn)("bash", [runSh, projectDir], { cwd: path2.join(kit, "apps", "dashboard"), env, stdio: "inherit" });
  } else {
    console.error(
      `consort-dashboard: no dashboard found in the deployed kit (${kit}).
  Expected a prebuilt bundle at dist/dashboard/server.js (installed kit) or apps/dashboard/ (dev clone).
  An installed kit older than the prebuilt-dashboard release won't have it; upgrade the kit, or point LAKEBASE_KIT_DIR at a dev clone.`
    );
    process.exit(1);
    return;
  }
  if (args.open) openBrowser(url);
  child.on("exit", (code) => process.exit(code ?? 0));
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    (0, import_node_child_process2.spawn)(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
  }
}
main().catch((err) => {
  console.error(`consort-dashboard: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
