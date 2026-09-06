#!/usr/bin/env node
// consort-cross-story-context: print the design-lane cross-story review context for a
// story – the feature's OTHER stories' acceptance criteria + the architecture's
// open_decisions. The architect-reviewer and the navigator reflect turn run this so they
// review a story AGAINST its siblings, not in isolation (hardening for the cross-story AC
// conflict where a later story silently contradicted an earlier, already-gated one).
//
//   consort-cross-story-context --feature <F> --story <S> [--json] [--project-dir <p>] [--consort-dir <p>]
//
// Default output is a readable summary; --json prints the raw CrossStoryContext.

import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { buildCrossStoryContext, type CrossStoryContext } from "../../consort/orchestrator/steps/cross-story-context.js";
import { isCliEntry } from "@databricks-solutions/lakebase-scm-utils/util";

interface Args {
  feature?: string;
  story?: string;
  json: boolean;
  projectDir: string;
  consortDir?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false, projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--feature": out.feature = argv[++i]; break;
      case "--story": out.story = argv[++i]; break;
      case "--json": out.json = true; break;
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-cross-story-context – the feature's OTHER stories' ACs + the architecture's open_decisions.\n\n" +
            "  consort-cross-story-context --feature <F> --story <S> [--json]\n\n" +
            "Run it in the architect-reviewer + navigator reflect turns to review a story AGAINST its\n" +
            "siblings: flag any AC that contradicts a gated sibling AC, or silently resolves an open decision.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

/** Render the context as a compact, reviewer-friendly summary. */
export function renderContext(ctx: CrossStoryContext): string {
  const lines: string[] = [];
  lines.push(`Cross-story review context for ${ctx.current_story}:`);
  if (!ctx.sibling_stories.length) {
    lines.push("  (no sibling stories with ACs yet – this is the feature's first designed story)");
  }
  for (const s of ctx.sibling_stories) {
    lines.push(`  ${s.story}:`);
    for (const ac of s.acs) {
      const st = ac.status ? ` [${ac.status}]` : "";
      lines.push(`    - ${ac.ac_id}${st}: GIVEN ${ac.given ?? "?"} / WHEN ${ac.when ?? "?"} / THEN ${ac.then ?? "?"}`);
    }
  }
  if (ctx.open_decisions.length) {
    lines.push("  open architectural decisions (do NOT silently resolve one in a way that breaks a sibling):");
    for (const d of ctx.open_decisions) {
      lines.push(`    - ${d.id} [${d.decision_status ?? "open"}]: ${d.question ?? ""}${d.resolved_by_story ? ` (resolved by ${d.resolved_by_story}: ${d.resolution ?? ""})` : ""}`);
    }
  }
  lines.push(
    "\nCheck THIS story's ACs against the above. If one contradicts a gated sibling AC (same input, opposite\n" +
      "required outcome), or resolves an open decision inconsistently, raise it as a spec-author reflect finding\n" +
      "(it holds the spec gate) rather than letting it reach the build lane.",
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.feature || !args.story) {
    process.stderr.write("consort-cross-story-context: --feature and --story are required.\n");
    return 2;
  }
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const ctx = buildCrossStoryContext(consortDir, args.feature, args.story);
  process.stdout.write((args.json ? JSON.stringify(ctx, null, 2) : renderContext(ctx)) + "\n");
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`consort-cross-story-context: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
