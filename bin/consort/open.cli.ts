#!/usr/bin/env node
// consort-open: open the Consort roles' reviewable artifacts (feature-spec,
// architecture, db-design, test-list, story + ACs, design guide) in the user's
// editor, so they review them in Cursor/Code at a gate instead of hunting for files.
// Opens only when the session is INSIDE the editor (its integrated terminal); else it
// prints the paths. Invoked by a driving session at a gate, and by `consort-watch`
// when it stops at one.
//
//   consort-open [--feature <id>] [--story <id>] [--force] [--project-dir <p>]
//
// With no --feature it uses workflow-state's current feature/story, else the
// planning/design review set.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConsortDir } from "../../consort/config/consort-paths.js";
import { openArtifactsInEditor } from "../../consort/orchestrator/open/open-in-editor.js";

interface Args { projectDir: string; consortDir?: string; feature?: string; story?: string; force: boolean; }

function parseArgs(argv: string[]): Args {
  const out: Args = { projectDir: process.cwd(), force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project-dir": out.projectDir = argv[++i]; break;
      case "--tdd-dir": case "--consort-dir": out.consortDir = argv[++i]; break;
      case "--feature": out.feature = argv[++i]; break;
      case "--story": out.story = argv[++i]; break;
      case "--force": out.force = true; break;
      case "-h": case "--help":
        process.stdout.write(
          "consort-open – open the reviewable Consort artifacts in Cursor/Code.\n\n" +
            "  consort-open [--feature <id>] [--story <id>] [--force] [--project-dir <p>]\n\n" +
            "Opens only when inside the editor's terminal (else prints paths). --force opens regardless.\n",
        );
        process.exit(0);
    }
  }
  return out;
}

function currentScope(consortDir: string): { feature?: string; story?: string } {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(consortDir, "workflow-state.json"), "utf8")) as {
      feature_id?: string | null;
      story_id?: string | null;
    };
    return {
      ...(ws.feature_id ? { feature: ws.feature_id } : {}),
      ...(ws.story_id ? { story: ws.story_id } : {}),
    };
  } catch {
    return {};
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const consortDir = args.consortDir ?? resolveConsortDir(args.projectDir);
  const scope = args.feature ? { feature: args.feature, story: args.story } : currentScope(consortDir);

  const res = openArtifactsInEditor(consortDir, { ...scope, force: args.force });
  if (res.opened) {
    process.stdout.write(`consort-open: opened ${res.files.length} artifact(s) in ${res.editor}:\n${res.files.map((f) => `  ${f}`).join("\n")}\n`);
    return 0;
  }
  if (res.reason === "no-artifacts") {
    process.stdout.write("consort-open: no reviewable artifacts found for this scope yet.\n");
    return 0;
  }
  // no-editor / not-in-editor: surface the paths so the info is never lost.
  const why = res.reason === "no-editor" ? "no Cursor/VS Code CLI found" : "not inside an editor terminal (use --force to open anyway)";
  process.stdout.write(`consort-open: ${why}; review these artifacts:\n${res.files.map((f) => `  ${f}`).join("\n")}\n`);
  return 0;
}

process.exit(main());
