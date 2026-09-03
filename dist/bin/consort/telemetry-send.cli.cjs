"use strict";

// bin/consort/telemetry-send.cli.ts
var import_node_fs = require("fs");
async function main() {
  const [, , file, url, token] = process.argv;
  if (!file || !url) return;
  let body;
  try {
    body = (0, import_node_fs.readFileSync)(file, "utf8");
  } catch {
    return;
  }
  const headers = { "content-type": "application/x-ndjson" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  try {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(1e4) : void 0;
    await fetch(url, { method: "POST", headers, body, ...signal ? { signal } : {} });
  } catch {
  } finally {
    try {
      (0, import_node_fs.unlinkSync)(file);
    } catch {
    }
  }
}
void main().finally(() => process.exit(0));
