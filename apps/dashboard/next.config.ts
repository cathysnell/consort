import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // Self-contained production server: `next build` emits `.next/standalone/` with its
  // own server.js + a trimmed node_modules, so the kit can ship a PREBUILT dashboard
  // (assembled into dist/dashboard/ by `build:dashboard`) that runs with `node server.js`
  // and no install. Launched per project by `consort-dashboard` / the scaffolded run-dashboard.sh.
  output: "standalone",
  // Root the standalone at THIS app dir (not the kit repo root, which Next would otherwise
  // infer from the outer package.json and nest the app under). This keeps server.js at the
  // standalone root, so `build:dashboard` copies it straight to dist/dashboard/server.js.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
