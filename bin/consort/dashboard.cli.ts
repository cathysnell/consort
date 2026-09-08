#!/usr/bin/env node
// consort-dashboard: launch the Consort dashboard against a LOCAL project's .consort/,
// using whatever kit is deployed locally (no git, no remote). The dashboard's live source
// reads the project's .consort/ straight off disk, so this just points a server at it.
//
// Prefers the PREBUILT bundle the kit ships (dist/dashboard/server.js — a Next standalone
// server, no install needed). Falls back to `apps/dashboard/run.sh` (next dev) when the
// deployed kit is a dev clone with source but no build. The scaffolded run-dashboard.sh is a
// thin wrapper that calls this via `lk` (so lk's kit resolution is reused, not duplicated).
//
//   consort-dashboard [--project-dir <p>] [--port <n>] [--record-dir <p>] [--host <h>] [--no-open]
//
// --project-dir defaults to cwd; --record-dir is optional (the dashboard auto-detects the
// project's own record lane otherwise); --port auto-picks a free port when omitted. The server
// runs in the foreground (Ctrl-C stops it).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

import { kitRoot } from "../../consort/config/kit-bin.js";

interface Args {
  projectDir: string;
  port?: number;
  recordDir?: string;
  host: string;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { projectDir: process.cwd(), host: "localhost", open: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--port": out.port = Number(argv[++i]); break;
      case "--record-dir": out.recordDir = argv[++i]; break;
      case "--host": out.host = argv[++i]; break;
      case "--no-open": out.open = false; break;
      case "-h": case "--help":
        console.log(
          "consort-dashboard [--project-dir <p>] [--port <n>] [--record-dir <p>] [--host <h>] [--no-open]\n" +
            "Launch the dashboard on a local project's .consort/ (prebuilt bundle, or next dev in a dev clone).",
        );
        process.exit(0);
        break;
      default: break;
    }
  }
  return out;
}

/** A free TCP port (OS-assigned when we bind :0), so the launcher never collides with a
 *  deploy server, a stale dashboard, or another listener. The scaffolded wrapper may pass
 *  --port (resolved via port-utils.sh); this is the fallback when it doesn't. */
function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** The prebuilt standalone server the kit ships, or null. Assembled into dist/dashboard/ by
 *  `build:dashboard`; server.js sits at the root, but Next's standalone layout can nest it one
 *  level under the app path, so accept either. */
function prebuiltServer(kit: string): string | null {
  const root = path.join(kit, "dist", "dashboard");
  const candidates = [path.join(root, "server.js"), path.join(root, "apps", "dashboard", "server.js")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir);
  const kit = kitRoot();
  const port = args.port && Number.isFinite(args.port) ? args.port : await freePort(args.host);

  // Companion record lane (turn transcripts / correspondence): only forward an EXPLICIT
  // --record-dir. With just CONSORT_PROJECT_DIR set, the dashboard already auto-detects the
  // project's own record lane, so the bin doesn't second-guess the artifact-root layout.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: args.host,
    CONSORT_PROJECT_DIR: projectDir,
    ...(args.recordDir ? { CONSORT_RECORD_DIR: args.recordDir } : {}),
  };

  const url = `http://${args.host}:${port}/`;
  const server = prebuiltServer(kit);
  const runSh = path.join(kit, "apps", "dashboard", "run.sh");

  let child;
  if (server) {
    console.log(`Consort dashboard (prebuilt) → ${url}\n  project: ${projectDir}${args.recordDir ? `\n  record:  ${args.recordDir}` : ""}\n  Ctrl-C to stop.`);
    child = spawn("node", [server], { cwd: path.dirname(server), env, stdio: "inherit" });
  } else if (fs.existsSync(runSh)) {
    // Dev-clone kit: no prebuilt bundle, but the dashboard source is here. run.sh sets
    // CONSORT_PROJECT_DIR/PORT itself from its args + env and runs `next dev`.
    console.log(`Consort dashboard (dev) → ${url}\n  project: ${projectDir}\n  Ctrl-C to stop.`);
    child = spawn("bash", [runSh, projectDir], { cwd: path.join(kit, "apps", "dashboard"), env, stdio: "inherit" });
  } else {
    console.error(
      `consort-dashboard: no dashboard found in the deployed kit (${kit}).\n` +
        `  Expected a prebuilt bundle at dist/dashboard/server.js (installed kit) or apps/dashboard/ (dev clone).\n` +
        `  An installed kit older than the prebuilt-dashboard release won't have it; upgrade the kit, or point LAKEBASE_KIT_DIR at a dev clone.`,
    );
    process.exit(1);
    return;
  }

  if (args.open) openBrowser(url);
  child.on("exit", (code) => process.exit(code ?? 0));
}

/** Best-effort browser open; never fatal (headless boxes just use the printed URL). */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed URL is the fallback */
  }
}

main().catch((err) => {
  console.error(`consort-dashboard: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
