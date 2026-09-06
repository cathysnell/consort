// Open the Consort roles' reviewable artifacts in the user's editor at a gate – so
// they review the spec/architecture/test-list/ACs in Cursor/Code instead of hunting
// for files. Shared by BOTH triggers the user named: the drive (or a session) via
// the `consort-open` bin, and the log narrator (`consort-watch`) when it stops at a
// gate. Opens ONLY when the session is actually inside Cursor/Code (its integrated
// terminal), so we never launch an editor window uninvited; otherwise it reports the
// paths for the caller to surface. The `spawn` seam keeps it unit-testable.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { reviewArtifacts, roleArtifacts } from "./resolve-review-artifacts.js";

/** macOS app-bundle CLIs, the fallback when the editor's `code`/`cursor` shim was
 *  never installed on PATH (users skip that step). Mirrors start.md's find_editor. */
const APP_BUNDLE_CLIS = [
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
  `${process.env.HOME}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  `${process.env.HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
];

/** Find a usable editor CLI: PATH `cursor`/`code` first, then an installed .app's CLI. */
export function findEditorCmd(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of ["cursor", "code"]) {
    for (const dir of pathDirs) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return name; // on PATH => bare name
      } catch {
        /* ignore */
      }
    }
  }
  for (const p of APP_BUNDLE_CLIS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** True when the process runs INSIDE Cursor/Code's integrated terminal – the signal
 *  that the user is actually viewing this project in the editor. Both Cursor and VS
 *  Code set TERM_PROGRAM=vscode; a Cursor-specific marker also counts. */
export function isInsideEditor(env: NodeJS.ProcessEnv = process.env): boolean {
  return /vscode|cursor/i.test(env.TERM_PROGRAM ?? "") || Boolean(env.CURSOR_TRACE_ID) || Boolean(env.VSCODE_PID);
}

export interface OpenResult {
  files: string[];
  opened: boolean;
  editor?: string;
  /** Why it did not open (when opened=false): "no-artifacts" | "no-editor" | "not-in-editor". */
  reason?: "no-artifacts" | "no-editor" | "not-in-editor";
}

export interface OpenOpts {
  feature?: string;
  story?: string;
  /** Open even when not inside the editor's terminal (an explicit --force). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injectable spawner (tests). Defaults to opening the files in the editor. */
  spawn?: (cmd: string, files: string[]) => void;
  /** PER-TURN delta: when set, open ONLY the reviewable artifacts modified at/after this
   *  epoch-ms – i.e. the files the just-finished role actually produced/updated this turn,
   *  not the whole review set. Left unset (consort-open, manual) opens the full set. */
  changedSinceMs?: number;
}

/** Resolve the reviewable artifacts and open them in the editor when appropriate.
 *  Never throws; returns what it did (or why not). */
export function openArtifactsInEditor(consortDir: string, opts: OpenOpts = {}): OpenResult {
  const env = opts.env ?? process.env;
  const all = reviewArtifacts(consortDir, { feature: opts.feature, story: opts.story });
  // Per-turn open narrows to what THIS turn touched (mtime >= the previous turn boundary),
  // so the human sees only what the role just produced, not the whole set re-opened.
  const files =
    opts.changedSinceMs === undefined
      ? all
      : all.filter((f) => {
          try {
            return fs.statSync(f).mtimeMs >= (opts.changedSinceMs as number);
          } catch {
            return false;
          }
        });
  if (!files.length) return { files, opened: false, reason: "no-artifacts" };

  const cmd = findEditorCmd(env);
  if (!cmd) return { files, opened: false, reason: "no-editor" };
  if (!isInsideEditor(env) && !opts.force) return { files, opened: false, editor: cmd, reason: "not-in-editor" };

  const spawn = opts.spawn ?? ((c, fs2) => { spawnSync(c, fs2, { stdio: "ignore" }); });
  try {
    spawn(cmd, files);
  } catch {
    return { files, opened: false, editor: cmd, reason: "no-editor" };
  }
  return { files, opened: true, editor: cmd };
}

/** Per-turn open: reveal exactly what the role that just finished its turn produced (from
 *  roleArtifacts), opening in the editor when inside its terminal. Same guards + result shape
 *  as openArtifactsInEditor, but role-scoped instead of the whole review set – so each turn
 *  shows only its own output. Never throws. */
export function openRoleArtifacts(consortDir: string, role: string, opts: OpenOpts = {}): OpenResult {
  const env = opts.env ?? process.env;
  const files = roleArtifacts(consortDir, role, { feature: opts.feature, story: opts.story });
  if (!files.length) return { files, opened: false, reason: "no-artifacts" };

  const cmd = findEditorCmd(env);
  if (!cmd) return { files, opened: false, reason: "no-editor" };
  if (!isInsideEditor(env) && !opts.force) return { files, opened: false, editor: cmd, reason: "not-in-editor" };

  const spawn = opts.spawn ?? ((c, fs2) => { spawnSync(c, fs2, { stdio: "ignore" }); });
  try {
    spawn(cmd, files);
  } catch {
    return { files, opened: false, editor: cmd, reason: "no-editor" };
  }
  return { files, opened: true, editor: cmd };
}
