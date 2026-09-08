#!/usr/bin/env node
// build:dashboard — build the Next dashboard as a self-contained standalone server and
// assemble it into dist/dashboard/, so the kit SHIPS a prebuilt dashboard that runs with
// `node dist/dashboard/server.js` and no install. Rides the kit's committed-dist release
// ritual (built here, then `git add -f dist` at publish). `consort-dashboard` runs the result.
//
// Next's standalone output does NOT copy the static assets or public/ into the bundle — that
// last step is on the builder — so we do it here, then copy the whole standalone tree to dist/.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> kit root
const appDir = join(kitRoot, "apps", "dashboard");
const standalone = join(appDir, ".next", "standalone");
const out = join(kitRoot, "dist", "dashboard");

if (!existsSync(join(appDir, "node_modules"))) {
  console.error(`build:dashboard: apps/dashboard/node_modules missing — run \`npm install\` in ${appDir} first.`);
  process.exit(1);
}

console.log("build:dashboard: next build (standalone)…");
execFileSync("npx", ["next", "build"], { cwd: appDir, stdio: "inherit" });

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    `build:dashboard: expected a standalone server at ${join(standalone, "server.js")}.\n` +
      "  Check apps/dashboard/next.config.ts sets output:\"standalone\" + outputFileTracingRoot to the app dir.",
  );
  process.exit(1);
}

// Static assets + public/ are NOT auto-included in standalone — copy them where the
// standalone server serves them from.
cpSync(join(appDir, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
if (existsSync(join(appDir, "public"))) {
  cpSync(join(appDir, "public"), join(standalone, "public"), { recursive: true });
}

// Assemble into dist/dashboard/ (server.js at the root).
rmSync(out, { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
cpSync(standalone, out, { recursive: true });

console.log(`build:dashboard: assembled → ${join("dist", "dashboard", "server.js")}`);
