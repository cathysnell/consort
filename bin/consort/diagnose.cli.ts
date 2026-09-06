#!/usr/bin/env node
// consort-diagnose: package a run's LOCAL forensic artifacts into a shareable
// bundle at error time. This is what actually troubleshoots a failure – the error
// text, failing assertion, escalation reason, and event trail – none of which
// telemetry carries (telemetry is allowlisted enums/counts/durations only). All of
// it is on disk at any telemetry level; this just gathers it so you don't hunt.
//
//   consort-diagnose [--project-dir <p>] [--tdd-dir <p>] [--out <dir>]
//
// Writes .consort/diagnostics/<ts>/ with the escalations, every green-failure.json,
// workflow-state, and tails of agent-log.jsonl + drive-live.log, plus a manifest +
// README. Prints the bundle path. Exit 0 when a bundle was written, 2 when there was
// nothing to collect (no failure artifacts present).

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { collectDiagnosticSources, type DiagnosticSource } from "../../consort/orchestrator/diagnose/collect-bundle.js";
import { analyzeFailure, type FailureAnalysis } from "../../consort/orchestrator/diagnose/analyze-failure.js";
import { redactSecrets } from "../../consort/orchestrator/diagnose/redact.js";

/** The consort repo issues page – where a shared failure condition goes. */
const CONSORT_ISSUES_URL = "https://github.com/databricks-solutions/consort/issues";

/** Render the human-readable analysis block. */
function renderAnalysis(a: FailureAnalysis): string {
  const lines: string[] = [];
  lines.push(`Failure class: ${a.class}${a.location ? `  (at ${a.location})` : ""}`);
  for (const e of a.escalations) lines.push(`  escalation ${e.id}: ${e.source} – ${e.reason}`);
  for (const g of a.greenFailures) {
    lines.push(`  verify failure @ ${g.location}: ${g.summary}`);
    if (g.failureOutput) lines.push(g.failureOutput.split("\n").slice(-12).map((l) => `      ${l}`).join("\n"));
  }
  lines.push(`\nSuggested remediation:\n  ${a.suggestedRemediation}`);
  return lines.join("\n");
}

interface Args {
  projectDir: string;
  consortDir?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "--out": out.out = argv[++i]; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-diagnose – package a run's local forensic artifacts into a shareable bundle.\n\n" +
            "  consort-diagnose [--project-dir <p>] [--out <dir>]\n\n" +
            "Collects escalations, green-failure.json(s), workflow-state, and tails of\n" +
            "agent-log.jsonl + drive-live.log into .consort/diagnostics/<ts>/. Exit 0 if written, 2 if nothing to collect.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

/** Copy a source into the bundle, REDACTED (secrets/paths scrubbed), optionally
 *  tailed to the last `n` lines. Everything written to the shareable bundle goes
 *  through here – never a raw `copyFileSync` – so no unscrubbed content lands in it. */
function redactedCopy(src: string, dst: string, tailLines?: number): void {
  let content = fs.readFileSync(src, "utf8");
  if (tailLines) {
    const lines = content.split("\n");
    content = (lines.length > tailLines ? lines.slice(-tailLines) : lines).join("\n");
  }
  fs.writeFileSync(dst, redactSecrets(content));
}

/** Flatten a source's absolute path to a bundle-local filename that keeps its
 *  cycle context (e.g. cycles/F1/S1/AC1/green-failure.json => the cycle path). */
function bundleName(consortDir: string, s: DiagnosticSource): string {
  const rel = path.relative(consortDir, s.path).replace(/[\\/]/g, "__");
  return rel || path.basename(s.path);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const sources = collectDiagnosticSources(consortDir);
  const present = sources.filter((s) => s.exists);

  // ANALYZE first: classify the failure + extract the real reason/assertion + a
  // remediation to attempt. No failure evidence => nothing to diagnose.
  const analysis = analyzeFailure(consortDir);
  if (!analysis.hasFailure) {
    process.stderr.write(
      "consort-diagnose: no failure artifacts found (no escalations, no green-failure.json). " +
        "Nothing to diagnose – run this after a run raises to HIL or a verify fails.\n",
    );
    return 2;
  }

  // The analysis is the point of the tool – print it for the human/agent to act on.
  process.stdout.write(`consort-diagnose: analysis\n${renderAnalysis(analysis)}\n\n`);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out ?? path.join(consortDir, "diagnostics", ts);
  fs.mkdirSync(outDir, { recursive: true });

  const collected: Array<{ kind: string; from: string; file: string; tailed?: number }> = [];
  for (const s of present) {
    const name = bundleName(consortDir, s);
    const dst = path.join(outDir, name);
    redactedCopy(s.path, dst, s.tailLines);
    collected.push({ kind: s.kind, from: path.relative(consortDir, s.path), file: name, ...(s.tailLines ? { tailed: s.tailLines } : {}) });
  }

  const manifest = {
    created_at: new Date().toISOString(),
    consort_dir: consortDir,
    counts: {
      escalations: collected.filter((c) => c.kind === "escalation").length,
      green_failures: collected.filter((c) => c.kind === "green-failure").length,
    },
    items: collected,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The analysis IS the diagnosis – persist it in the bundle so a shared bundle
  // carries the classification + suggested remediation, not just raw files. Redacted
  // like everything else in the bundle (its reason/summary/failureOutput fields can
  // carry a DSN password or path).
  fs.writeFileSync(path.join(outDir, "analysis.json"), redactSecrets(JSON.stringify(analysis, null, 2)) + "\n");
  fs.writeFileSync(
    path.join(outDir, "README.md"),
    "# Consort diagnostic bundle\n\n" +
      "The local forensic record of a failed run – what actually troubleshoots the error.\n\n" +
      "- `analysis.json` – the classified failure + suggested remediation (start here).\n" +
      "- `*escalations__*.json` – the raise-to-HIL reason + source.\n" +
      "- `*green-failure.json` – the verify-failure pre-localization (what failed, where).\n" +
      "- `workflow-state.json` – the phase/feature/story the run was at.\n" +
      "- `agent-log.jsonl` – tail of the structured event trail.\n" +
      "- `drive-live.log` – tail of the live narration.\n\n" +
      "Telemetry does NOT contain any of this (it is allowlisted enums/counts/durations only); " +
      "this bundle is the content, for you to inspect or share with the maintainers.\n\n" +
      "## Redaction\n\n" +
      "This bundle is auto-REDACTED before it is written: DSN passwords " +
      "(`postgres://user:***@host`), `dapi…` tokens, `Bearer …` headers, known secret " +
      "assignments (DB_PASSWORD / *_TOKEN / *_SECRET / password), and absolute home paths " +
      "(`/Users/<user>/…`) are masked. Redaction is best-effort – **still review the files " +
      "before sharing**; a novel secret shape may not be caught.\n",
  );

  process.stdout.write(
    `consort-diagnose: bundle written to ${outDir}\n` +
      `  ${manifest.counts.escalations} escalation(s), ${manifest.counts.green_failures} green-failure(s), ` +
      `${collected.length} file(s) total.\n\n` +
      // Next steps for the driving session (see orchestrator-contract rule 5):
      `Next: 1) TROUBLESHOOT – attempt the suggested remediation above, then re-run ` +
      `(clear the halt with consort-resolve-escalation once the cause is fixed).\n` +
      `      2) SHARE (optional, ask the human first) – if they consent, send the failure condition to the\n` +
      `         maintainers: attach the bundle at ${outDir} to a new issue at ${CONSORT_ISSUES_URL}\n` +
      `         (auto-redacted – DSN passwords / tokens / home paths masked – but REVIEW it before sharing; nothing is uploaded automatically).\n`,
  );
  return 0;
}

process.exit(main());
