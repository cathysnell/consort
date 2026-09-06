#!/usr/bin/env node
// consort-optimize-apply: persist an APPROVED winning candidate's levers
// into the kit, so the NEXT invocation of that role uses them.
//
//   consort-optimize-apply --project-dir <dir> --handoff <id> --candidate <id>
//                                 [--kit-dir <dir>] [--dry-run]
//
// It reads the candidate from the sweep's audit trail
// (<project>/experiments/<handoff>/<candidate>/trial-*/candidate.json), builds the
// apply plan, APPLIES the agent-.md levers directly to
// skills/consort/agents/<role>.md in the kit, and PRINTS the typed-source edit
// proposals (model/effort/scope/loop defaults) for a reviewed change – it never
// regex-rewrites TS source. --dry-run prints the plan without writing.
//
// The kit edits are LOCAL working-tree changes; pushing/releasing them to
// consumers is a separate, explicitly gated step.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

import type { Candidate } from "../../consort/optimize/optimize-candidates.js";
import { buildApplyPlan, applyAgentMdLevers, formatApplyPlan } from "../../consort/optimize/optimize-apply.js";

export interface ApplyCliArgs {
  projectDir?: string;
  handoff?: string;
  candidate?: string;
  /** The kit checkout to edit (defaults to this kit – resolved from the module). */
  kitDir?: string;
  dryRun?: boolean;
}

export function parseApplyArgs(argv: string[]): ApplyCliArgs {
  const out: ApplyCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i];
    switch (argv[i]) {
      case "--project-dir": out.projectDir = next(); break;
      case "--handoff": out.handoff = next(); break;
      case "--candidate": out.candidate = next(); break;
      case "--kit-dir": out.kitDir = next(); break;
      case "--dry-run": out.dryRun = true; break;
    }
  }
  return out;
}

/** Read a candidate's recorded object from the sweep audit trail. The candidate is
 *  identical across its trials, so the first trial's candidate.json is canonical. */
export function readRecordedCandidate(experimentsDir: string, handoff: string, candidateId: string): Candidate {
  const candDir = join(experimentsDir, handoff, candidateId);
  if (!existsSync(candDir)) throw new Error(`optimize-apply: no recorded candidate at ${candDir} (run the sweep first)`);
  const trials = readdirSync(candDir).filter((d) => d.startsWith("trial-")).sort();
  if (trials.length === 0) throw new Error(`optimize-apply: no trials recorded under ${candDir}`);
  const file = join(candDir, trials[0], "candidate.json");
  if (!existsSync(file)) throw new Error(`optimize-apply: missing ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as Candidate;
}

/** The role a handoff id targets (the id is "<story>-<role>[-<mode>]" or "<role>"). */
export function roleFromHandoffId(handoffId: string): string {
  // The recorded candidate does not carry the role, but the handoff id does. Roles
  // are known; match the longest known role that appears as a segment.
  const KNOWN = ["spec-author", "architect-reviewer", "test-strategist", "ux-designer", "product-owner", "navigator", "driver", "dba"];
  for (const r of KNOWN) {
    if (handoffId === r || handoffId.endsWith(`-${r}`) || handoffId.includes(`-${r}-`)) return r;
  }
  // Fallback: last hyphen-delimited token that is not a build mode.
  const parts = handoffId.split("-");
  return parts[parts.length - 1];
}

function defaultKitDir(): string {
  // bin/consort/optimize-apply.cli.ts -> kit root is two dirs up from bin/consort.
  return resolve(new URL("../..", import.meta.url).pathname);
}

async function main(): Promise<number> {
  const args = parseApplyArgs(process.argv.slice(2));
  if (!args.projectDir || !args.handoff || !args.candidate) {
    process.stderr.write("usage: consort-optimize-apply --project-dir <dir> --handoff <id> --candidate <id> [--kit-dir <dir>] [--dry-run]\n");
    return 2;
  }
  const projectDir = resolve(args.projectDir);
  const kitDir = args.kitDir ? resolve(args.kitDir) : defaultKitDir();
  const experimentsDir = join(projectDir, "experiments");
  const role = roleFromHandoffId(args.handoff);

  const candidate = readRecordedCandidate(experimentsDir, args.handoff, args.candidate);
  const plan = buildApplyPlan(role, candidate);

  process.stdout.write(formatApplyPlan(plan));

  if (args.dryRun) {
    process.stderr.write("[optimize-apply] --dry-run: no files written.\n");
    return 0;
  }
  const changed = applyAgentMdLevers(kitDir, plan);
  if (changed.length) {
    process.stderr.write(`[optimize-apply] applied agent-.md levers to: ${changed.join(", ")} (in ${kitDir}). Review + commit locally.\n`);
  } else {
    process.stderr.write("[optimize-apply] no direct agent-.md levers to apply.\n");
  }
  if (plan.sourceEdits.length) {
    process.stderr.write(
      `[optimize-apply] ${plan.sourceEdits.length} typed-source default(s) to change (model/effort/scope/loop) – these are printed above for a REVIEWED edit, not auto-written. Make them + their regression test, then commit.\n`,
    );
  }
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
