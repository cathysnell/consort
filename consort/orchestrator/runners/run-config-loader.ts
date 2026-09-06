// run-config-loader: read an orchestration run-config JSON and resolve ${ENV:-default}
// markers against process.env, so the shipped config carries DEFAULTS anyone can override by
// setting the named env var. String leaves that look numeric/boolean are coerced (tiers -> 1,
// "true" -> true), so the resolved object is a real OrchestrationRunConfig with typed
// lifecycle configs. Secrets are NEVER in the file – tokens/hosts arrive via env at run time.
//
// This is what makes the demo "config-driven so anyone can put their own in and run it": the
// committed .run.json is the recipe + the maintainer's defaults; an operator overrides only
// what differs for their workspace/owner via the documented env vars.

import { readFileSync } from "node:fs";
import type { OrchestrationRunConfig } from "./orchestration-runner.js";

/**
 * Resolve one string against process.env:
 *   "${VAR:-default}"  -> process.env.VAR ?? "default"
 *   "${VAR}"           -> process.env.VAR, or THROW if unset (a required override)
 *   "plain"            -> unchanged
 * Only whole-string markers are supported (the config values are single markers, not
 * embedded), which keeps the contract obvious.
 */
export function resolveEnvTemplate(value: string): string {
  const withDefault = value.match(/^\$\{([A-Z0-9_]+):-(.*)\}$/s);
  if (withDefault) {
    const [, name, def] = withDefault;
    return process.env[name] ?? def;
  }
  const required = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (required) {
    const [, name] = required;
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`run-config: required env var ${name} is unset (marker "${value}" has no default).`);
    }
    return v;
  }
  return value;
}

/** A compact UTC timestamp (YYYYMMDD-HHMMSS) for the `{{TS}}` token – so a default project
 *  name is collision-free per run without the operator having to set anything. */
function compactTimestamp(): string {
  // "2026-08-03T23:07:19.123Z" -> "20260803-230719"
  const [date, time] = new Date().toISOString().split("T");
  return `${date.replace(/-/g, "")}-${time.slice(0, 8).replace(/:/g, "")}`;
}

/** Expand built-in tokens in a resolved string. Currently `{{TS}}` -> a compact timestamp,
 *  so e.g. "stockflow-demo-{{TS}}" becomes a unique name every run. */
function expandTokens(s: string): string {
  return s.includes("{{TS}}") ? s.replaceAll("{{TS}}", compactTimestamp()) : s;
}

/** Coerce a resolved string leaf to number/boolean when it clearly is one (so tiers is a
 *  number + uiTrack is a boolean in the typed config), else leave the (token-expanded) string. */
function coerceLeaf(s: string): string | number | boolean {
  const t = expandTokens(s);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

/** Recursively resolve every string leaf's env markers + coerce. Arrays/objects walked. */
function resolveDeep(node: unknown): unknown {
  if (typeof node === "string") return coerceLeaf(resolveEnvTemplate(node));
  if (Array.isArray(node)) return node.map(resolveDeep);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = resolveDeep(v);
    return out;
  }
  return node;
}

/**
 * Load + resolve an orchestration run-config from a JSON file. Reads the file, resolves every
 * ${ENV:-default} marker against process.env, coerces numeric/boolean leaves, and returns the
 * typed OrchestrationRunConfig. Does NOT touch the cloud – it only produces the config the
 * runner will act on.
 */
export function loadRunConfig(path: string): OrchestrationRunConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return resolveDeep(raw) as OrchestrationRunConfig;
}
