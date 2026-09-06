// optimize-apply: persist an APPROVED winning candidate's levers into the kit so
// the NEXT invocation of that role uses them. This is what makes the champion walk
// cumulative + durable: a win at one handoff becomes the standing default for that
// role everywhere.
//
// Two lever kinds, split by safety:
//   1. Agent-.md levers – prose/data that lives in skills/consort/agents/<role>.md:
//      a taskSuffix directive (append to the body), a tool scope (rewrite the
//      `tools:` frontmatter), or a whole agent-overlay (replace the file). These are
//      APPLIED DIRECTLY by applyAgentMdLevers (safe, deterministic file writes).
//   2. Config levers – model / effort / session-scope / loop live in TYPED SOURCE
//      (consort-config-file.ts defaultConsortConfig + agent-models.ts RECOMMENDED_MODELS +
//      the role .md frontmatter `model:`). We NEVER regex-rewrite TS source; instead
//      buildApplyPlan emits a precise SourceEditProposal (file + exact target + a
//      regression-test note) for a normal reviewed edit. contextPackSuffix is
//      dynamic injected context, not a fixed directive, so it is reported as a
//      manual proposal, not auto-frozen.
//
// buildApplyPlan is PURE; applyAgentMdLevers does the filesystem writes. Kit edits
// are LOCAL; pushing/releasing them to consumers stays a separate gated step.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Candidate } from "./optimize-candidates.js";
import { actionFromManifestMatch } from "../orchestrator/steps/manifest.js";
import { turnKeyForAction } from "../orchestrator/drive/turn-key.js";

/** Where the shipped step-manifests live under the kit dir – the ONE per-turn config home. */
const MANIFESTS_REL = join("consort", "orchestrator", "steps", "manifests");

/** A directly-appliable edit to a role's skills/consort/agents/<role>.md. */
export interface AgentMdEdit {
  role: string;
  kind: "append-directive" | "frontmatter-tools" | "replace-file";
  /** The directive text (append), the tools value (frontmatter), or the full file
   *  content (replace). */
  value: string;
}

/** A proposed edit to TYPED SOURCE, surfaced for a reviewed change (never auto-
 *  applied by regex). */
export interface SourceEditProposal {
  file: string;
  /** Human-readable target + intent (e.g. "defaultConsortConfig: driver.model.green -> haiku"). */
  rationale: string;
  /** A note describing the regression test that should accompany the edit. */
  regressionTest: string;
}

export interface ApplyPlan {
  role: string;
  agentMdEdits: AgentMdEdit[];
  sourceEdits: SourceEditProposal[];
  /** Free-text notes (e.g. levers that need a manual call, like contextPackSuffix). */
  notes: string[];
}

/** Build the apply plan for an approved winner. Pure: no filesystem access. */
export function buildApplyPlan(role: string, candidate: Candidate): ApplyPlan {
  const plan: ApplyPlan = { role, agentMdEdits: [], sourceEdits: [], notes: [] };

  // ---- Family 2 (content) levers: agent-.md, applied directly ----
  const content = candidate.content;
  if (content) {
    if (content.agentOverlay) {
      // A whole-file overlay replaces the role definition (the strongest prompt win).
      plan.agentMdEdits.push({ role, kind: "replace-file", value: content.agentOverlay.markdown });
    } else {
      // taskSuffix is a fixed directive -> append to the role's standing prompt body.
      if (content.taskSuffix && content.taskSuffix.trim()) {
        plan.agentMdEdits.push({ role, kind: "append-directive", value: content.taskSuffix.trim() });
      }
      // Tool scope -> the role's `tools:` frontmatter (what it may use every turn).
      if (content.allowedTools && content.allowedTools.length) {
        plan.agentMdEdits.push({ role, kind: "frontmatter-tools", value: content.allowedTools.join(", ") });
      }
    }
    // contextPackSuffix is DYNAMIC injected context, not a fixed directive: freezing
    // it verbatim into the prompt would bake a one-turn context blob into every turn.
    // Report it as a manual proposal (the human decides what, if anything, to distill
    // into the role's standing guidance).
    if (content.contextPackSuffix && content.contextPackSuffix.trim()) {
      plan.notes.push(
        `contextPackSuffix won but is dynamic injected context, not a fixed directive; ` +
          `review whether to distill it into ${role}.md's standing guidance: "${content.contextPackSuffix.trim()}"`,
      );
    }
    if (content.disallowedTools && content.disallowedTools.length) {
      plan.notes.push(
        `disallowedTools won ([${content.disallowedTools.join(", ")}]); the kit expresses tool scope as an ` +
          `ALLOW list in ${role}.md frontmatter, so translate this to the complementary allow-list before applying.`,
      );
    }
  }

  // ---- Family 1 (config) levers: typed source, proposed for review ----
  const roles = candidate.configOverrides.roles ?? {};
  for (const [r, settings] of Object.entries(roles)) {
    if (!settings) continue;
    const model = settings.model;
    if (typeof model === "string") {
      plan.sourceEdits.push(modelDefaultEdit(r, undefined, model));
    } else if (model && typeof model === "object") {
      for (const [turn, m] of Object.entries(model)) plan.sourceEdits.push(modelDefaultEdit(r, turn, String(m)));
    }
    const effort = settings.effort;
    if (typeof effort === "string") {
      plan.sourceEdits.push(effortDefaultEdit(r, undefined, effort));
    } else if (effort && typeof effort === "object") {
      for (const [turn, e] of Object.entries(effort)) plan.sourceEdits.push(effortDefaultEdit(r, turn, String(e)));
    }
  }
  const build = candidate.configOverrides.build ?? {};
  if (build.sessionScope) plan.sourceEdits.push(buildDefaultEdit("sessionScope", build.sessionScope));
  if (build.loopGranularity) plan.sourceEdits.push(buildDefaultEdit("loopGranularity", build.loopGranularity));
  if (typeof build.batchCap === "number") plan.sourceEdits.push(buildDefaultEdit("batchCap", String(build.batchCap)));

  for (const [k, v] of Object.entries(candidate.env ?? {})) {
    plan.notes.push(`env lever ${k}=${v} won; persist it as the default in the code path that reads ${k} (or the config default it backs).`);
  }

  return plan;
}

function modelDefaultEdit(role: string, turn: string | undefined, model: string): SourceEditProposal {
  const where = turn ? `(${role}, ${turn})` : `(${role}, every turn)`;
  return {
    file: `${MANIFESTS_REL}/*.json (agentOptions.model)`,
    rationale: `set agentOptions.model -> "${model}" in the step-manifest(s) whose (role, turnKey) is ${where} (mirror the role's frontmatter model: in skills/consort/agents/${role}.md + RECOMMENDED_MODELS in agent-models.ts if the BASE model changed). This is the ONE per-turn config home – applyWinnerToManifests writes it as data.`,
    regressionTest: `assert resolveConsortSettings().modelFor("${role}"${turn ? `, "${turn}"` : ""}) === "${model}" with no project override (resolver reads the manifest).`,
  };
}

function effortDefaultEdit(role: string, turn: string | undefined, effort: string): SourceEditProposal {
  const where = turn ? `(${role}, ${turn})` : `(${role}, every turn)`;
  return {
    file: `${MANIFESTS_REL}/*.json (agentOptions.effort)`,
    rationale: `set agentOptions.effort -> "${effort}" in the step-manifest(s) whose (role, turnKey) is ${where}. The manifest is the single per-turn config home.`,
    regressionTest: `assert resolveConsortSettings().effortFor("${role}"${turn ? `, "${turn}"` : ""}) === "${effort}" with no project override (resolver reads the manifest).`,
  };
}

function buildDefaultEdit(key: string, value: string): SourceEditProposal {
  return {
    file: "consort/orchestrator/settings/project-settings.ts",
    rationale: `defaultConsortConfig: set build.${key} -> ${JSON.stringify(value)}.`,
    regressionTest: `assert resolveConsortSettings().build.${key} === ${JSON.stringify(value)} with no project override.`,
  };
}

/** Split a role .md into [frontmatter, body]. Frontmatter is the leading
 *  `---\n...\n---\n` block; returns ["", md] when there is none. */
function splitFrontmatter(md: string): { fm: string; body: string } {
  const m = md.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: md };
}

/** Apply the plan's agent-.md edits to skills/consort/agents/<role>.md under the
 *  kit dir. Returns the list of files changed. Source-edit proposals are NOT
 *  touched (they are reviewed edits). Throws if a targeted role .md is missing. */
export function applyAgentMdLevers(kitDir: string, plan: ApplyPlan): string[] {
  const changed = new Set<string>();
  for (const edit of plan.agentMdEdits) {
    const rel = join("skills", "consort", "agents", `${edit.role}.md`);
    const path = join(kitDir, rel);
    if (edit.kind === "replace-file") {
      writeFileSync(path, edit.value);
      changed.add(`${edit.role}.md`);
      continue;
    }
    if (!existsSync(path)) throw new Error(`optimize-apply: cannot edit missing role definition ${rel}`);
    const md = readFileSync(path, "utf8");
    if (edit.kind === "append-directive") {
      // Append the directive as a new paragraph at the end of the body, preserving
      // frontmatter + existing content.
      const next = md.endsWith("\n") ? `${md}\n${edit.value}\n` : `${md}\n\n${edit.value}\n`;
      writeFileSync(path, next);
      changed.add(`${edit.role}.md`);
    } else if (edit.kind === "frontmatter-tools") {
      const { fm, body } = splitFrontmatter(md);
      if (!fm) throw new Error(`optimize-apply: ${rel} has no frontmatter to set tools: on`);
      const nextFm = /(^|\n)tools:.*(\n)/.test(fm)
        ? fm.replace(/(^|\n)tools:.*(\n)/, `$1tools: ${edit.value}$2`)
        : fm.replace(/\n---\n$/, `\ntools: ${edit.value}\n---\n`);
      writeFileSync(path, nextFm + body);
      changed.add(`${edit.role}.md`);
    }
  }
  return [...changed];
}

/** AUTO-APPLY a winning candidate's per-turn CONFIG levers (model/effort) into the kit's
 *  step-manifest `agentOptions` – the ONE per-turn config home the resolver + lean/replay harness
 *  read. This replaces the old optimized-defaults.json overlay (a SECOND copy that shadowed the
 *  manifest): a win now lands in exactly the manifest(s) whose (role, turnKey) it names, so there is
 *  a single place per turn. Collapsed keys (e.g. the three assess* buildModes share turnKey "assess")
 *  are all patched together, keeping the parity guard satisfied. It writes DATA (JSON), never a TS
 *  rewrite. A scalar role model/effort (no per-turn map) applies to EVERY manifest of that role.
 *  build-knob winners are NOT per-turn and are reported by buildApplyPlan for a reviewed edit, not
 *  written here. A BASELINE / content-only winner -> no-op (false). Idempotent. Returns true when any
 *  manifest changed. Kit edits are LOCAL; committing/pushing is the caller's job. */
export function applyWinnerToManifests(kitDir: string, candidate: Candidate): boolean {
  const roles = candidate.configOverrides.roles ?? {};
  if (!Object.keys(roles).length) return false; // baseline / content-only / build-only winner

  const manifestsDir = join(kitDir, MANIFESTS_REL);
  if (!existsSync(manifestsDir)) throw new Error(`optimize-apply: manifests dir missing at ${manifestsDir}`);
  const files = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));
  let changed = false;

  for (const file of files) {
    const path = join(manifestsDir, file);
    let raw = readFileSync(path, "utf8");
    const m = JSON.parse(raw) as { role?: string; match?: Record<string, unknown>; agentOptions?: { model?: string; effort?: string } };
    if (!m.role || !m.match || !m.agentOptions) continue;
    const settings = (roles as Record<string, { model?: unknown; effort?: unknown } | undefined>)[m.role];
    if (!settings) continue;
    const turnKey = turnKeyForAction(actionFromManifestMatch(m.match, m.role));
    // Pick the winning model/effort for THIS manifest's turn: a per-turn map hits by key; a scalar
    // applies to every turn of the role.
    const pick = (v: string | Record<string, string> | undefined): string | undefined =>
      typeof v === "string" ? v : v && turnKey && v[turnKey] ? v[turnKey] : undefined;
    const model = pick(settings.model as string | Record<string, string> | undefined);
    const effort = pick(settings.effort as string | Record<string, string> | undefined);
    let touched = false;
    if (model && m.agentOptions.model !== model) { raw = patchAgentOptionValue(raw, "model", model); touched = true; }
    if (effort && m.agentOptions.effort !== effort) { raw = patchAgentOptionValue(raw, "effort", effort); touched = true; }
    if (touched) {
      writeFileSync(path, raw);
      changed = true;
    }
  }
  return changed;
}

/** Format-preserving replace/insert of `agentOptions.<key>` in a manifest's raw JSON text. Scopes to
 *  the agentOptions object (so a model/effort key inside agent.config is never touched), replaces the
 *  value in place when the key is present, or inserts it right after the opening brace otherwise ,
 *  never reserialises the whole file, so the manifest's hand-authored compact formatting survives. */
function patchAgentOptionValue(raw: string, key: "model" | "effort", value: string): string {
  const anchor = raw.indexOf('"agentOptions"');
  if (anchor < 0) throw new Error(`optimize-apply: no agentOptions block to patch (${key})`);
  const open = raw.indexOf("{", anchor);
  let depth = 0;
  let close = -1;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (open < 0 || close < 0) throw new Error(`optimize-apply: malformed agentOptions block (${key})`);
  const block = raw.slice(open, close + 1);
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (re.test(block)) {
    return raw.slice(0, open) + block.replace(re, `$1"${value}"`) + raw.slice(close + 1);
  }
  // Key absent – insert it right after the opening brace, matching the block's indentation.
  const indentMatch = block.match(/\{\s*\n(\s*)"/);
  const indent = indentMatch ? indentMatch[1] : "    ";
  const inserted = block.replace(/\{\s*\n/, `{\n${indent}"${key}": "${value}",\n`);
  return raw.slice(0, open) + inserted + raw.slice(close + 1);
}

/** Human-readable summary: what applied directly + what needs a reviewed source edit. */
export function formatApplyPlan(plan: ApplyPlan): string {
  const lines: string[] = [`# Apply plan for role: ${plan.role}`, ""];
  if (plan.agentMdEdits.length) {
    lines.push("## Direct agent-.md edits (applied on approval)");
    for (const e of plan.agentMdEdits) {
      lines.push(`- ${e.kind}: ${e.kind === "replace-file" ? "(full role definition)" : e.value}`);
    }
    lines.push("");
  }
  if (plan.sourceEdits.length) {
    lines.push("## REVIEW – typed-source edits (I make these as normal reviewed edits, not auto-regex)");
    for (const s of plan.sourceEdits) {
      lines.push(`- ${s.file}: ${s.rationale}`);
      lines.push(`    regression test: ${s.regressionTest}`);
    }
    lines.push("");
  }
  if (plan.notes.length) {
    lines.push("## Notes");
    for (const n of plan.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  if (!plan.agentMdEdits.length && !plan.sourceEdits.length && !plan.notes.length) {
    lines.push("(baseline won – nothing to persist)");
  }
  return lines.join("\n") + "\n";
}
