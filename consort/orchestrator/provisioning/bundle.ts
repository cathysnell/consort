// bundle: the environment overlay primitives – lay recorded/seed assets onto a provisioned workspace.
// Prep routines (the integration chain, the gated driver-green harness) seed a scaffolded or throwaway
// workspace with agent definitions + pre-turn code/design trees before a run drives. Those overlays
// were open-coded per caller (each with its own cpSync/mkdirSync); this is the ONE home for the
// primitive so a seed is expressed declaratively (which trees, which files, where) instead of retyped.

import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** Copy the kit's role agent definitions (skills/consort/agents/*.md) into
 *  <workspaceDir>/.claude/agents/ so a spawned `claude --agent <role>` resolves them. The kit's
 *  agents live in the repo (NOT in the scm-utils package's deployClaudeAgents), so this copies
 *  from there directly. A plain file copy – the load-bearing bit a live agent needs from the
 *  workspace, with no cloud project. */
export function layDownKitAgents(workspaceDir: string, kitDir: string = process.cwd()): void {
  const src = join(kitDir, "skills", "consort", "agents");
  if (!existsSync(src)) throw new Error(`layDownKitAgents: kit agents dir not found at ${src}`);
  const dest = join(workspaceDir, ".claude", "agents");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/** A declarative overlay: directory trees + individual files to copy onto a destination workspace.
 *  Paths in `to` are relative to the overlay's destination root; `from` is an absolute source path. */
export interface BundleOverlay {
  /** Directory trees copied recursively (from -> to, both resolved against their roots). */
  trees?: Array<{ from: string; to: string }>;
  /** Individual files copied (from -> to); parent dirs are created as needed. */
  files?: Array<{ from: string; to: string }>;
}

/** Overlay a bundle onto `destRoot`: copy each declared tree (recursive) then each file (creating
 *  parent dirs). The ONE overlay primitive callers express a seed with, instead of open-coding cpSync
 *  loops. `to` paths are joined under destRoot; `from` paths are used as given (absolute). */
export function overlayBundle(destRoot: string, overlay: BundleOverlay): void {
  for (const t of overlay.trees ?? []) {
    cpSync(t.from, join(destRoot, t.to), { recursive: true });
  }
  for (const f of overlay.files ?? []) {
    const dst = join(destRoot, f.to);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(f.from, dst);
  }
}
