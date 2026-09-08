# DO NOT MODIFY HERE

This `templates/project/common/**` tree is **not** the source the initial project scaffold
copies from.

`lakebase-create-project` scaffolds a new project's `scripts/`, `.claude/`, `.github/`, and
`deploy-targets.yaml` via `@databricks-solutions/lakebase-scm-utils`'s `scaffold.ts`, which
copies from the **scm-utils package's own** templates
(`@databricks-solutions/lakebase-scm-utils/templates/project/common/`) — verified: scm-utils
ships its own full copy of these files.

**A file added or changed ONLY here does NOT reach a freshly-scaffolded project.** (This is
how `run-dashboard.sh` went missing: it was added here, so `lakebase-create-project` never
copied it.)

To change what scaffolded projects get, edit the copy in the **lakebase-scm-utils** package,
then re-point/release scm-utils. Keep any change that must exist in both places in sync.
