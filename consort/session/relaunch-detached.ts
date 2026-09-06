// Re-launch the current Node CLI in its OWN session so a long run survives (a) the
// launching turn/shell ending and (b) the harness's ~2min bash timeout. A foreground
// call is killed at the timeout; a plain `&` background is reaped when the tool call's
// process group is SIGTERMed at turn-end. `spawn(detached:true)` calls setsid(2) ,
// a NEW session + process group the SIGTERM never reaches – and `.unref()` frees the
// parent's event loop so it can exit at once. macOS has no `setsid` binary, so this
// node-level detach is the portable way. Shared by consort-drive and
// lakebase-create-project (both expose `--detach`); each caller prints its own relay
// guidance and, when needed, arranges a progress log (a detached child's stdio is
// discarded, so its narration must go to a file the caller can poll).

import { spawn } from "node:child_process";

/**
 * Spawn `node <this-script> <childArgs…>` detached into a new session and return the
 * child pid (or null if the spawn failed, so the caller can fall back to running
 * in-process rather than losing the work). `childArgs` MUST already have `--detach`
 * removed by the caller, or the child would recurse. `stdio` defaults to "ignore";
 * pass a file descriptor array to capture the child's output to a log.
 */
export function relaunchDetached(
  childArgs: string[],
  opts: { stdio?: "ignore" | Array<"ignore" | number>; env?: NodeJS.ProcessEnv } = {},
): number | null {
  try {
    const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
      detached: true, // setsid(2): new session + process group, escapes the caller's group-SIGTERM
      stdio: opts.stdio ?? "ignore",
      env: opts.env ?? process.env,
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
