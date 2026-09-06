// Guard against a stale-cache substrate mismatch at create time.
//
// The failure this catches (observed in the field): `npx github:consort` can
// update the top-level kit while REUSING a cached nested `@databricks-solutions/
// lakebase-scm-utils` at an older version – npx does not re-resolve transitive git
// deps when it reuses a cached package. create-project then runs the new kit's
// logic but scaffolds from the OLD substrate (wrong launcher name, mismatched
// `scm-utils-ref`), silently producing a broken project. We detect the mismatch
// and STOP before provisioning anything, with an actionable remediation.

export interface SubstrateCheckInput {
  /** The substrate version THIS kit declares (from consort's package.json dep). */
  declared: string | undefined;
  /** The substrate version actually installed/resolved (nested package.json). */
  installed: string | undefined;
  /** Env, to honor deliberate dev/capture overrides. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns a remediation message when the resolved substrate does NOT match what
 * the kit declares, or `null` when it's fine (match, undeterminable, or an
 * explicit override is in play). Pure – the caller does the fs/require + I/O.
 */
export function substrateMismatchMessage(input: SubstrateCheckInput): string | null {
  const env = input.env ?? {};
  // A deliberate substrate pin/dir override means the operator chose it (dev,
  // capture) – never second-guess it.
  if ((env.LAKEBASE_SCM_UTILS_REF && env.LAKEBASE_SCM_UTILS_REF.trim()) ||
      (env.LAKEBASE_SCM_UTILS_DIR && env.LAKEBASE_SCM_UTILS_DIR.trim())) {
    return null;
  }
  const { declared, installed } = input;
  // Can't determine one side (unpinned dep, unresolvable install) – don't block;
  // the scaffold/verify steps still guard downstream.
  if (!declared || !installed) return null;
  if (declared === installed) return null;

  return (
    `Substrate mismatch: this kit declares @databricks-solutions/lakebase-scm-utils ` +
    `v${declared}, but the resolved install is v${installed}.\n` +
    `Your npx/npm cache served a STALE substrate – npx can update the top-level kit ` +
    `while reusing a cached nested dependency, which would scaffold a broken project ` +
    `(wrong launcher, mismatched .lakebase refs). Refusing to create from it.\n\n` +
    `Fix: clear the npx cache and retry the version-pinned create from /consort:start:\n` +
    `  rm -rf "$(npm config get cache)/_npx"   # or: npx clear-npx-cache\n` +
    `(Set LAKEBASE_SCM_UTILS_REF to override deliberately for dev.)`
  );
}
