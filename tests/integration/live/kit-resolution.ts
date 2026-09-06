// kit-resolution (TS): the ONE way a live test resolves "the kit" for a spawned `claude -p` agent.
//
// The split-brain trap, in TS form: setting process.env.LAKEBASE_KIT_DIR redirects ONLY the
// orchestrator process. The role agents spawn as separate `claude -p` processes that do NOT inherit
// that env; they resolve the kit from the ref-keyed cache (~/.cache/consort/<ref>/...), so with only
// LAKEBASE_KIT_DIR set the agents run a DIFFERENT (often stale `main`) kit than the driver. This
// mirrors the shell policy (examples/replay/lib/pin-local-kit.sh): pin a LOCAL ref whose cache slot
// symlinks THIS checkout AND write that ref into the scaffolded project, so orchestrator + agents
// resolve IDENTICAL bits. NEVER set LAKEBASE_KIT_DIR.
//
// The local ref here is DELIBERATELY DISTINCT from the shell's `sftdd-capture-local`: a live TS suite
// run must never repoint the capture's cache slot out from under a running capture. This is the single
// most important correctness call in this file.

import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** The local-only ref TS live tests pin. DISTINCT from the shell capture ref (sftdd-capture-local)
 *  so a TS run can never steal the live capture's cache symlink slot. */
export const LOCAL_KIT_REF_DEFAULT = "sftdd-livetest-local";

/** The cache slot (node_modules/<pkg> symlink target) for a local ref. Mirrors the shell
 *  local_kit_cache_link + the lk shim's cache root (XDG_CACHE_HOME or ~/.cache/consort). */
export function localKitCacheLink(ref: string = LOCAL_KIT_REF_DEFAULT): string {
  const cacheRoot = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "consort");
  return join(cacheRoot, ref, "node_modules", "@databricks-solutions", "consort");
}

/** Plant (idempotent) the cache symlink -> the kit working tree, so a `claude -p` bin run finds dist
 *  with no GitHub install. Throws if the kit has no built dist (the shell fails loud the same way). */
export function pinLocalKitCache(kitRoot: string, ref: string = LOCAL_KIT_REF_DEFAULT): void {
  if (!existsSync(join(kitRoot, "dist"))) {
    throw new Error(`kit-resolution: kit dist missing at ${kitRoot}/dist – run 'npm run build' in the kit first.`);
  }
  const link = localKitCacheLink(ref);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(kitRoot, link);
}

/** Write the ref + recovery hint into a scaffolded project: kit-ref so the env-less agents resolve
 *  the ref, kit-local-dir so lk can re-plant the cache symlink if it is ever lost. Idempotent. */
export function recordLocalKitHint(projectDir: string, kitRoot: string, ref: string = LOCAL_KIT_REF_DEFAULT): void {
  const dir = join(projectDir, ".lakebase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kit-ref"), `${ref}\n`);
  writeFileSync(join(dir, "kit-local-dir"), `${realpathSync(kitRoot)}\n`);
}

/** THE resolver a live test calls once (mirrors the shell resolve_kit_single_source): refuse a
 *  pre-set LAKEBASE_KIT_DIR (split-brain door), pin the local ref's cache slot to `kitRoot`, and
 *  export LAKEBASE_KIT_REF so the spawned agents resolve that ref. Returns the pinned ref. */
export function resolveKitSingleSource(kitRoot: string, ref: string = LOCAL_KIT_REF_DEFAULT): string {
  if (process.env.LAKEBASE_KIT_DIR) {
    throw new Error(
      `kit-resolution: LAKEBASE_KIT_DIR is set – it redirects ONLY the orchestrator and leaves the ` +
        `claude -p agents on the ref cache (split-brain). Unset it; this pins ref '${ref}' for everyone.`,
    );
  }
  pinLocalKitCache(kitRoot, ref);
  process.env.LAKEBASE_KIT_REF = ref;
  return ref;
}

/** Write the project hint + assert the shim resolves THIS working tree; throw on drift so a run can
 *  never silently execute a stale/other kit. Call once per scaffolded project (or worktree). */
export function assertKitSingleSource(projectDir: string, kitRoot: string, ref: string = LOCAL_KIT_REF_DEFAULT): void {
  recordLocalKitHint(projectDir, kitRoot, ref);
  const link = localKitCacheLink(ref);
  if (!existsSync(link)) return; // no cache slot (nothing pinned) => nothing to drift-check
  const want = realpathSync(kitRoot);
  const got = realpathSync(link);
  if (got !== want) {
    throw new Error(
      `kit-resolution: kit resolution drift – ref '${ref}' resolves to '${got}', expected '${want}'. ` +
        `Aborting so the run cannot use a stale/other kit.`,
    );
  }
}

/** Teardown: clear the exported ref (mirrors the shell's per-run scoping) so a later suite starts
 *  clean. Leaves the cache symlink in place (idempotent + reused across runs). */
export function clearKitSingleSource(): void {
  delete process.env.LAKEBASE_KIT_REF;
}
