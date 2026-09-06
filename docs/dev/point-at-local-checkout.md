# Point Claude Code at this local checkout (dev linking)

Run Consort from THIS working tree instead of the published plugin + a packed tarball, so your edits
here (e.g. `commands/start.md`, `skills/`, and the built `dist/` bins) are what actually runs. No
tarball needed.

There are **two** surfaces to point, because they load from different places:

| Surface | What it covers | How it loads |
|---|---|---|
| **Plugin** | the `/consort:*` slash commands (incl. `/consort:start`), the `skills/`, the SessionStart hook | Claude Code plugin marketplace |
| **Runtime kit** | the `dist/` CLIs the workflow runs (`consort-drive`, `consort-next`, the probe, gates, …) | a scaffolded project's `./scripts/lk` shim |

Point both to get the full behavior (e.g. the PO-intake precondition needs the drive bins from
`dist/`, and its onboarding step needs `commands/start.md` from the plugin).

`REPO` below = `/Users/kevin.hartman/code/databricks-solutions/consort`.

---

## 1. Plugin (commands + skills + hooks)

**Heads-up — same-name marketplace.** This repo's `.claude-plugin/marketplace.json` is named
`databricks-solutions`, which is ALSO the name of the published marketplace you already have
(`GitHub: databricks-solutions/consort`). You can't have two marketplaces with the same name, so
pointing local means **replacing** that one. Swap it:

```bash
# 1. Drop the published (GitHub) marketplace so the name is free.
claude plugin marketplace remove databricks-solutions

# 2. Add THIS checkout as the databricks-solutions marketplace (reads .claude-plugin/marketplace.json).
claude plugin marketplace add /Users/kevin.hartman/code/databricks-solutions/consort

# 3. (Re)install the consort plugin from it.
claude plugin install consort@databricks-solutions
#    If it's already installed, refresh it from the new source instead:
#    claude plugin marketplace update databricks-solutions && claude plugin update consort@databricks-solutions
```

Then **restart Claude Code**. `/consort:start`, the skills, and the hook now load from this tree.
Because it's a directory source, editing `commands/start.md` or a skill and restarting picks up the
change immediately — no repack, no reinstall.

**Scope (optional).** `claude plugin marketplace add … --scope project` (or `local`) registers it only
for the current project/checkout instead of user-wide — handy if you don't want to disturb your global
setup. `claude plugin install … --scope project` likewise. Default is `user`.

**Verify:**
```bash
claude plugin marketplace list         # databricks-solutions → Source: Directory (…/consort)
# In Claude Code, run /consort:start in a fresh project: the no-seed path should offer the
# "Product Owner intake interview" step before /plan.
```

**Revert to the published plugin** when you're done testing:
```bash
claude plugin marketplace remove databricks-solutions
claude plugin marketplace add databricks-solutions/consort   # the GitHub repo (owner/repo shorthand)
claude plugin install consort@databricks-solutions
```
…then restart Claude Code.

---

## 2. Runtime kit (the `dist/` CLIs a scaffolded project runs)

A scaffolded project's `./scripts/lk` shim resolves the kit in this precedence:

```
LAKEBASE_KIT_DIR  >  .lakebase/kit-ref (version-pinned cache)  >  default cache
```

So to make a project run THIS checkout's `dist/` (which carries the intake precondition), export
`LAKEBASE_KIT_DIR` in the shell you drive the project from:

```bash
export LAKEBASE_KIT_DIR=/Users/kevin.hartman/code/databricks-solutions/consort
# then, from inside the scaffolded project:
./scripts/lk consort-next --sprint <name>     # runs THIS repo's dist bins
```

Notes:
- It reads the **built `dist/`**, so after changing kit source run `npm run build` in `REPO` first
  (the committed `dist/` here already includes the intake change).
- It's per-shell. Set it only in the terminal you use for dev testing; unset it (or open a fresh
  shell) to go back to the project's pinned kit. Exporting it globally makes ALL your Consort projects
  run this dev tree — fine for focused testing, risky if the tree has WIP.
- New project creation: `LAKEBASE_KIT_DIR=$REPO node "$REPO/dist/bin/lakebase/create-project.cli.js" …`
  (or set the env and use the plugin's create flow) scaffolds against this checkout.

---

## Quick test of the PO-intake change specifically

1. Plugin linked (section 1) + `export LAKEBASE_KIT_DIR=$REPO` (section 2).
2. Create a fresh project **without** the StockFlow seed (decline the first-project offer).
3. `/consort:start` → it should route to the **Product Owner intake interview** (author
   `product-overview.md` / `nfrs.md` / — UI — `design-brief.md`, grounded in `@software-design-principles`
   / `@ui-ux-design-principles` and the `examples/first-project/stockflow-seed/intake/` worked example)
   **before** `/plan`, and `consort-next --sprint <name>` should report `awaiting_human` with the
   `intake.run` option.
4. Author + approve the three docs → resume → the Spec Author proposes from them.
5. Seeded control: a project that took the StockFlow seed should skip intake and go straight to
   propose (byte-identical to before).
