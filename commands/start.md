---
description: Launch the Consort workflow (spec-first design, test-driven build on paired Lakebase branches). In a scaffolded project, takes stock and resumes the /plan -> /design -> /build -> /deploy loop; elsewhere, guides you through creating a project, then resumes.
---

# /consort:start : launch the Consort workflow

This command launches the Consort (spec-first, test-driven) loop. First detect where you are, then branch.

### 0. Telemetry briefing (once, before anything else)

**This is a SILENT precondition , do NOT narrate it.** Never say "checking telemetry", "handling the telemetry briefing", "step 0", or announce that you are looking at telemetry. **And do NOT explain your next move by referencing telemetry** , NOT "Telemetry's already acknowledged, so I'll go straight to taking stock", NOT "since telemetry is set, …". That still leaks the check. When `acknowledged` is true, your FIRST user-visible words are the situation report / create flow itself , the word "telemetry" does not appear at all (not even as the reason you're proceeding). Just run the `status --json` check quietly. On an already-acknowledged install (the common case) this step produces **ZERO** user-visible output about telemetry , you go straight to the project-state detection below as if it were your first action, giving no reason for doing so. The ONLY time telemetry is ever mentioned to the human is the one-time briefing itself, when `acknowledged` is false.

**This silence includes the Bash tool-call DESCRIPTION, not just your prose.** The description you attach to a tool call is shown to the human exactly like narration, so the `status --json` check (and the `CONSORT_ROOT` resolve block above it) MUST carry a NEUTRAL description with no telemetry tell , never "telemetry", "checking", "briefing", "step 0", or "quietly". A description like "Checking telemetry requirements quietly" leaks the precondition just as loudly as saying it out loud. Use something generic such as "Prepare Consort environment".

Consort reports pseudonymous usage telemetry to its maintainers. The human MUST be told this in plain language the first time you run `/consort:start` for them , and be offered the Level-1 opt-out and the Level-2 opt-in , **here, where they can actually read it** (a stderr notice buried in a background drive is not a disclosure). Gate on the `acknowledged` flag, not on whether a config file exists.

**Invoke the telemetry CLI via the PLUGIN's binary, NOT `./scripts/lk`.** This step runs BEFORE the Create/Resume branch, and on a fresh install (the Create path) there is no scaffolded `./scripts/lk` yet , so `./scripts/lk consort-telemetry …` silently FAILS and the human's answer is never persisted (exactly the "I chose Level 2 and it didn't stick" bug). The plugin always ships `dist/`, so resolve its binary dir once and use it for every call below (it writes the same home config `~/.config/consort/telemetry.json` regardless of any project). **`$CLAUDE_PLUGIN_ROOT` is NOT reliably exported into a tool shell** , so prefer it but fall back to the plugin cache:
```bash
# Resolve the plugin's shipped binary dir, robust to $CLAUDE_PLUGIN_ROOT being unset.
CONSORT_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$CONSORT_ROOT" ] || [ ! -d "$CONSORT_ROOT/dist" ]; then
  # The plugin installs at ~/.claude/plugins/cache/databricks-solutions/consort/<version>/;
  # after a plugin update the newest cached version is the running one.
  CONSORT_ROOT="$(ls -d "$HOME/.claude/plugins/cache/databricks-solutions/consort"/*/dist 2>/dev/null \
    | sort -V | tail -1 | sed 's#/dist$##')"
fi
TCLI="node \"$CONSORT_ROOT/dist/bin/consort/telemetry.cli.js\""
```
(Same `$CONSORT_ROOT` resolves `consort-watch` for the create relay in **B. Create** below.)

1. Quietly run `$TCLI status --json` and read `acknowledged` (do NOT narrate this , and give the Bash call a NEUTRAL description, e.g. "Prepare Consort environment", NEVER one containing "telemetry"/"checking"/"quietly").
2. **If `acknowledged` is `true`, SKIP this section SILENTLY** , they have already been briefed and made a choice; say NOTHING about telemetry and go straight to the `.consort/` check below.
3. **If `acknowledged` is `false`** (a brand-new install, OR an older config that predates this briefing), present this verbatim and wait for their answer:
   > "One quick thing before we start , Consort's usage telemetry. Consort runs entirely in your own workspace, so a telemetry capture is the only way its maintainers can see what's working and make it better. It's **pseudonymous**: a random per-install id and nothing that identifies you , **no personal data, no code, no file paths, no names** , just event names, counts, and timings from a fixed allowlist. It's **on by default**, and you can opt out or change it anytime. (Separately, Consort sends a **one-time anonymous install marker** , a random id + version + date , so its maintainers know it was installed somewhere; that marker is sent once regardless of the choice below, and the usage telemetry is what you're choosing about now.) How would you like it set?
   > • **ok** , leave it on at the default (Level 1: high-level phase and gate events , the role + phase of each step with timings and counts, PLUS why a step failed or re-routed as closed-enum categories , never code, paths, or names).
   > • **level 2** , opt in to a bit more: the per-turn cost , which model + effort + a coarse token bucket + retry count (per role AND phase) , plus repair/loop dynamics (still allowlisted, no free text). Level 1 already shows WHERE the time goes (role + phase) and WHY a step failed/re-routed (the failure + revise taxonomies); this adds WHY a turn is expensive/slow/flaky and where the ensemble thrashes , the biggest favor you can do the project.
   > • **opt out** , turn telemetry off entirely.
   > (Change it later anytime: `consort-telemetry {enable|disable} [--level 2]`, or `./scripts/lk consort-telemetry …` inside a project.)"
4. **RECORD their choice by actually RUNNING the matching command** (do NOT just note the answer in your reply , if you don't run it, nothing persists). Each sets `acknowledged=true`:
   - **ok / leave on** -> `$TCLI ack`
   - **opt out** -> `$TCLI disable`
   - **level 2** -> `$TCLI enable --level 2`
   Then re-run `$TCLI status --json` and CONFIRM the write landed (`acknowledged:true`, and `telemetry_level:2` for a Level-2 choice) before moving on.
5. **Fire the one-time install marker (the beacon you just disclosed): `$TCLI beacon`.** Run it REGARDLESS of their choice above , including opt-out , since it records only that Consort was installed (a random id + version + date). It is idempotent (sends once per install, then never again) and best-effort (never blocks; exits 0 even offline). Give the Bash call a NEUTRAL description (no "telemetry"/"beacon" tell), same as the rest of this section.
6. Then continue to the branch below. Never block on this , if they don't answer, default to leaving Level 1 on and run `$TCLI ack` so you don't nag them again next run.

**Check the current project root for a `.consort/` directory.**
- If `.consort/` exists, go to **A. Resume**.
- If it does not, go to **B. Create**.

---

## A. Resume an existing Consort project

Drive the workflow through the **deterministic orchestrator** (`consort-drive`), invoked by the slash commands below. You coordinate only: run the right command for the project's state, and surface every gate to the human. The driver spawns the role agents (`product-owner`, `spec-author`, `ux-designer`, `architect-reviewer`, `test-strategist`, `navigator`, `driver`, or `release-engineer`), which are scaffolded into the project's `.claude/agents/` and invoked as `claude --agent <role>`, and obeys the state machine; the orchestrator is not an LLM agent. You write no spec, code, test, or deploy yourself.

1. **Take stock** (read, then summarize back): `.consort/product-overview.md` (what the product is), `.consort/nfrs.md`, `.consort/design/design-brief.md` (if UI), `.consort/planning/feature-proposals.md`, and each `.consort/features/*/` (feature-request, feature-spec, architecture, test-list, gates.json). **For the authoritative "where am I / what next", run `./scripts/lk consort-next`** , it DERIVES the phase + the next ready action from the artifacts on disk (the real source of truth). Do NOT rely on `.consort/workflow-state.json`'s `phase` for that: it is only a COARSE per-project slot that advances during a FEATURE drive (design → build → deploy), so it reads `discovery` all through PLANNING , even after `feature-proposals.md` exists , and treating it as the source of truth reports a stale phase (a planning-done project still shows `discovery`). Confirm SCM state via `lakebase-scm-state`. Give the human a short situation report: what the project is about, the current phase (per `consort-next`), and each feature's status.
   - **This project pins its kit to a version.** A project created by a recent kit records the exact release it was scaffolded with in `.lakebase/kit-ref` (e.g. `v0.3.15`) , an IMMUTABLE tag , so `./scripts/lk` always resolves that same version from a version-keyed cache and never silently drifts onto a moving `main`. That determinism is deliberate: upgrading the runtime kit is an explicit step (below), not something a background tip-move does to you mid-work.
   - **Check for a newer Consort first , this is a STANDALONE step you run on EVERY resume, before any diagnosis.** Run `./scripts/lk consort-check-update` (throttled to once/day, silent when current, never blocks). If it prints that a newer version is available, **relay it and offer to upgrade BEFORE you do anything else** , including before investigating an open blocker. **An open build blocker / escalation is NOT a reason to skip the upgrade offer , it is a reason to surface it FIRST:** the newer kit may be the very fix for that blocker (e.g. a verify/harness bug fixed in the newer release), so jumping straight into diagnosing the blocker on the stale kit is backwards. That "the open blocker drew attention and the upgrade offer got dropped" skip is a real defect , do NOT fold the offer into the situation report, do NOT defer it until after you diagnose, and do NOT proceed to `consort-next`/diagnosis until you have relayed the newer version and let the human choose upgrade-or-continue. To upgrade:
     1. Update the plugin (the slash commands): `claude plugin marketplace update databricks-solutions && claude plugin update consort@databricks-solutions`, then restart Claude Code.
     2. Move THIS project onto that version , the plugin update does NOT touch a project's runtime kit: write the new version tag into `.lakebase/kit-ref` (e.g. `printf 'vX.Y.Z\n' > .lakebase/kit-ref`) then `./scripts/lk --refresh --detach` to install it (detached + relayed poll-once, like Part 2 , a multi-minute install must never be a blocking foreground call). Because the ref is version-keyed, this is a one-time fresh install; future runs are instant.
   - **Older project pinned to `main` (or no `.lakebase/kit-ref`)?** That's the legacy, drift-prone case: `./scripts/lk --install` only reinstalls if `main`'s tip moved and the fast path otherwise serves whatever it first cached. Pin it to a real version once , `printf 'v<current>\n' > .lakebase/kit-ref && ./scripts/lk --refresh --detach` (detached + relayed poll-once) , and it stops drifting. The drive auto-refreshes the project's `.claude/agents/` when it detects the kit changed; to refresh out of band run `./scripts/lk lakebase-update-agents`.
2. **Continue the loop.** Offer the human the autonomous path or a single step:
   - **Whole sprint (autonomous):** **`/sprint [name]`** flows plan -> per feature `design` -> `build` -> `deploy`, pausing only at gates. Resumable; re-invoke to continue past an approved gate.
   - Or one phase at a time (lowest-ready first):
     - No sprint backlog (or the last sprint shipped) -> **`/plan`** (Spec Author proposes; the PO authors the next sprint's requests, folding in what the last working software revealed).
     - A feature has a `feature-request.md` but no conformant `test-list.json` -> **`/design <feature-id>`**.
     - Designed but not built -> **`/build <feature-id>`**.
     - Built but not deployed/reviewed -> **`/deploy <feature-id> --target local`** (the working-software gate).
   - Need to explore an unknown first? **`/spike <slug> [--for <feature>]`** (throwaway, outside the loop).
   - Confirm the chosen step with the human, invoke that project-scaffolded command (it runs the deterministic driver, which spawns the role agents + pauses at gates), then loop.
   - **Run the driver DETACHED, then relay it with short poll-once calls , do NOT run it foreground and narrate from chunks, and do NOT background it with `nohup … &`.** The driver streams one `[drive] NNN dispatch <role> for <phase>` line the moment each role STARTS (e.g. `dispatch dba for design`, then `dispatch test-strategist for design`) and a `[drive] <role> turn Ns` line when it finishes. Two hard rules make this observable AND durable:
     1. **Launch with `--detach`, never `nohup`/`&`.** Run **`./scripts/lk consort-drive <flags> --detach`**. It re-launches the drive in its OWN session (setsid) and returns immediately, printing the child pid + the watch command. This is the ONLY launch that survives your turn ending: a `nohup … &` (or a bare `&`) leaves the drive in your tool call's process group, which the harness SIGTERMs when the call returns , that is the "drive reaped between turns" failure. `--detach` escapes that group; nothing about a later watcher call can reach it either. The drive SELF-WRITES `.consort/drive-live.log` (do NOT redirect stderr to it , the drive owns it; a redirect double-writes).
     2. **To SEE EACH STEP LIVE, relay POLL-ONCE with `consort-watch --since <cursor>` in a loop , this is the ONLY foreground-safe way, and it is mandatory.** Each call returns IMMEDIATELY with the new transitions (role dispatch / turn-done / gate / pause / escalation / done) + a `[consort-watch] cursor=<N> status=<running|gate|pause|escalation|done|waiting>` trailer, then EXITS. You narrate that batch to the human and call again with the printed `<N>` , so the human watches the design lane unfold (Spec Author → UX → Architect → DBA → Test Strategist) turn by turn:
        ```bash
        ./scripts/lk consort-watch --since 0  --pid <drive-pid>   # first batch + cursor
        ./scripts/lk consort-watch --since <N> --pid <drive-pid>  # next batch (use the printed cursor); repeat
        ```
        Poll about every 15-20s FOR NARRATION while the drive pid is alive, and relay each batch to the human.
        **`consort-watch` is NARRATION ONLY , it is NEVER your gate or completion authority.** `drive-live.log` is a transient, per-process sink: truncated each turn, gone between turns, and it may carry NO `[drive]` stop marker at all , so `status=running` does NOT mean "no gate is open" and `status=done` does NOT mean "complete". Deciding a gate (or a stop) from the log is the exact bug that leaves the session sitting silently at a plan gate. **Decide these TWO things ONLY from authoritative sources, never from the log:**
        - **Did the drive stop?** ⇒ the drive PROCESS is gone (its `--pid` is no longer alive). Check the pid, not a log line.
        - **What now / is a human needed?** ⇒ run **`consort-next`** (it reads `.consort/next.json`, which the drive writes on EVERY stop, and derives from disk). Its **`awaiting_human` boolean is the SOLE gate signal: `true` ⇒ SURFACE the decision to the human AT ONCE (use the non-`resume` option's `hil_prompt` + `enact`); `false` ⇒ RESUME the drive.** Do NOT gate on `primary_action.kind` or `state.open_gates` , the planning backlog pause is an `invoke-role` (product-owner) with EMPTY `open_gates`, so those miss it and the session sits silent at the backlog decision (the exact failure). `awaiting_human` catches gates, the backlog commit, AND accept/discard/revise uniformly.
        **The moment the pid is gone, IMMEDIATELY run `consort-next` and ACT , never wait for a log marker that may never come.** `consort-next` classifies the true next action: a gate / planning `author-requests` / `raise-to-hil` ⇒ **surface it to the human AT ONCE** (a gate is a gate because `consort-next` says so, not because a log line appeared); an `invoke-role` ⇒ **RESUME the drive at once** (a normal one-turn-per-session boundary, NOT a crash); `done`/complete ⇒ done. The ONLY hard failure is a `raise-to-hil` / a `.consort/escalations/` record; everything else is "read `consort-next`, do the next thing." Never diagnose a marker-less pid-gone exit as a crash, and never sit idle at a gate waiting on the log , both are the lag to eliminate.
        **NEVER run a BLOCKING `consort-watch` as a foreground Bash call , not `--timeout 0`, not the default bound, not any follow.** The harness buffers a foreground call and shows NOTHING until it returns , the human stares at a spinner for the whole phase and sees no steps (the exact failure to avoid). And NEVER hand-roll a `tail -f … | while read; case …` loop.
        **If (and only if) you are literally invoking the Monitor TOOL** (a persistent background task that streams a command's output live), hand it **`./scripts/lk consort-watch --monitor --pid <drive-pid>`** , the persistent mode, and **PASS `--pid`** (the pid the `--detach` launch printed). It narrates each step live from the log while the drive runs, and , this is the load-bearing part , it **alerts the INSTANT the drive stops**: the moment the drive pid is gone it reads `.consort/next.json` (the authoritative snapshot the drive writes on EVERY stop) and emits `[consort-watch] DRIVE STOPPED , <summary>` plus, when a human is needed, `HUMAN NEEDED: <prompt> , run: <exact enact command>`, then exits so you surface it AT ONCE and re-arm on the next launch. It does **NOT** wait on a `[drive]` terminal marker (the transient log may carry none , that is exactly what left the monitor sitting silently at a gate for hours). Same authority as rule (77): stop == pid-gone, human-needed == `next.json`'s `awaiting_human`, never a log line. That is the kit-owned replacement for a hand-rolled `tail -F | while read; case`. **Per-turn artifact review:** as each design role finishes, the relay opens exactly what that role produced (spec/ACs, architecture, db-design, test-list, design-guide) in the editor , visibility only, and only when the relay runs INSIDE the editor's integrated terminal. A Monitor-TOOL background task is NOT inside that terminal, so to auto-open from it launch with **`LAKEBASE_CONSORT_OPEN=1 ./scripts/lk consort-watch --monitor --pid <drive-pid>`** (it force-opens into the already-running editor); a skip otherwise relays `NOT opened , run inside your IDE terminal / set LAKEBASE_CONSORT_OPEN=1`.
     This is the orchestrator-contract's rule 1 (`skills/consort/references/orchestrator-contract.md`); follow it for EVERY command , `/sprint`, `/plan`, `/design`, `/build`, `/deploy`, and `/spike` alike. **`consort-next` is the gate authority for all of them; query it at the command's scope:** `--sprint <s>` for `/sprint` + `/plan` (planning scope), `--feature <F>` for `/design` + `/build` + `/deploy` (the feature's derived phase distinguishes designing vs building vs deploying , you do NOT need a separate flag per phase). `/spike` is a one-shot branch op with no gate: surface its result, then resume the tagged feature with `consort-next --feature <the --for feature>`. In EVERY case the "is a human needed" decision is `consort-next`'s **`awaiting_human`** flag (NOT `open_gates`/`primary_action.kind`, which miss the backlog pause), and NEVER `drive-live.log`.

**Teardown / reclaim** (run from inside the project; both default the Lakebase instance + host from the project `.env`, so you need not re-specify them):
- **Done with a spike?** `./scripts/lk consort-spike delete --slug <slug>` tears down its paired Lakebase + git branch. Notes are KEPT by default (the learning survives); add `--purge-notes` to also remove `.consort/spikes/<slug>/`.
- **Reclaim a whole project's substrate?** `./scripts/lk lakebase-scm-cleanup list` (see what's there), then `... branches` (delete the ephemeral branches; tiers + trunk protected) or `... project --confirm <id>` (destroy the project). Dry-run unless `--yes`. This is the counterpart to `lakebase-create-project`.

**Upgrading the kit , safe even for a run IN FLIGHT.** A run is a SEQUENCE of drive processes with HITL gates between them, and the kit version is bound at each drive LAUNCH , so upgrade ONLY AT A STOP (a gate/pause), NEVER mid-turn (swapping the kit under a running drive is split-brain within one run). Use the kit-owned command , do NOT hand-edit `.lakebase/kit-ref*` (that is how the committed ref drifts from the run pin and a resume silently runs a stale kit):
1. **Quiesce** , confirm the drive is stopped at a gate: its pid is gone AND `consort-next` shows `awaiting_human`. If a drive is still running, wait for it to reach the gate.
2. **Upgrade** , invoke the TARGET version's upgrade (it pins the project to itself, so refreshing from its own files is always correct):
   `LAKEBASE_KIT_REF=<target> ./scripts/lk --refresh`   then
   `LAKEBASE_KIT_REF=<target> ./scripts/lk consort-upgrade --pid <the drive pid>`
   It REFUSES if a drive is still running (or the run is not at a stop); otherwise it dual-pins `.lakebase/kit-ref.local` (the run) + committed `.lakebase/kit-ref` (CI) IN LOCKSTEP (no drift), refreshes the scaffolded surface (agents + commands + scripts + CI workflows; the `scripts/lk` shim + project config are left as-is), records the prior pins for rollback, and prints the resume + rollback commands.
3. **Resume** , re-run your drive command (`consort-next` gives the exact one). It runs `<target>`, re-derives state from disk, and continues from the gate.
4. **Rollback** (if a resume misbehaves) , `./scripts/lk consort-upgrade --rollback` then `./scripts/lk --refresh` restores the prior kit. Reversibility + upgrading only at a stop is the safety net: a bad resume fails loud before it can damage the run, and you roll back.

The commands (`/sprint`, `/plan`, `/design`, `/build`, `/deploy`, `/spike`) are scaffolded into the project (version-pinned); you invoke them, you do not reimplement them. You write no spec, code, test, or deploy yourself.

---

## B. Create a new project, then resume

There is no `.consort/` here, so bootstrap one.

### First-project example (offer on the FIRST run only)

Before the create questions, on the user's **first** time only, offer the bundled **StockFlow** example so they can see the whole workflow on a real product instead of authoring their own intake:

- **Gate , first run only.** Compute `MARKER="${XDG_CONFIG_HOME:-$HOME/.config}/consort/first-project-offered"`. If it **already exists**, SKIP this offer entirely (they have used Consort before) and go straight to the create questions. Otherwise make the offer, then `mkdir -p "$(dirname "$MARKER")" && touch "$MARKER"` (either way) so it is never offered again. This marker is deliberately SEPARATE from `~/.config/consort/telemetry.json` so it never affects the one-time telemetry notice.
- **The offer.** Ask: create your **own** project, or **run the bundled StockFlow example** (a warehouse-inventory product you drive end to end)?
- **If they pick the example:** most create settings are FIXED for it (language `python`, **`--ui-track` on** , StockFlow is a UI product with a `design-brief.md`, so the create command MUST pass `--ui-track`; E2E is then forced on; model profile **Default**), so the ONLY things left to ask are:
  - **project name** (kebab-case), **parent directory** (default: the parent of cwd, else `~/code`), and **Databricks host** (offer `$DATABRICKS_HOST` / `~/.databrickscfg`). These are FREE TEXT: ask them in plain prose, and do NOT put them through a multiple-choice question (that is what triggers an "Invalid tool parameters" error: a text answer has no options).
  - **GitHub owner, or `--no-github`**: the one genuine either/or, and it sets the tier count. A GitHub owner ⇒ tiers `2` (prod + staging); `--no-github` ⇒ tiers `1` (prod only). This is the only decision worth a structured choice.

  Then create the project (below), `cd` in, **refresh the project's runtime kit to the current release** (the Part-2 kit download , detach + relay it live, exactly as in the Create flow's Part 2 below), and only AFTER it reports `status=done` bring in the seed files:
  ```bash
  ./scripts/lk --refresh --detach   # detached; relay its live log poll-once (see Part 2) until status=done
  ./scripts/lk lakebase-stage-first-project   # run this ONLY after the refresh above has finished
  ```
  The `--refresh` matters: the Consort toolkit is cached per version in a shared location (`~/.cache/consort/<ref>`), so a project created after you last used an OLDER kit can otherwise run that stale cache and miss newly-added bins like `lakebase-stage-first-project`. `--refresh` reinstalls it unconditionally, so the project runs the kit you just installed. (If `--refresh` reports the bin still missing, your Consort plugin itself is behind , update it per "Check for a newer Consort" above , then re-run.)
  It copies the example's intake (`product-overview.md`, `nfrs.md`, `design-brief.md`, and the warehouse icon) and one `feature-request.md` per feature into the new project's `.consort/`. Then resume: **`/plan`** (the Spec Author proposes a sprint from the staged intake), or **`/design F1-stock-visibility`** to jump straight into the first feature. `examples/first-project/README.md` in the kit is the walkthrough.
- **If they pick their own project:** proceed with the questions below as normal.

Walk the user through the create questions (ask, do not assume; offer the noted defaults). Most of these are FREE TEXT (project name, parent directory, Databricks host, GitHub owner): ask them in plain prose. Reserve a structured multiple-choice prompt only for the genuine either/or decisions (tiers 1/2/3, language, UI track (UI SPA / backend-only), E2E on/off, model profile); never wrap a free-text answer in an options prompt (it errors with "Invalid tool parameters").

- **Project name** (kebab-case, the Lakebase id + dir name; on the `--no-github` path the creator makes the target directory, or reuses an existing EMPTY one, but refuses a non-empty directory); **parent directory** (default: parent of cwd or `~/code`); **Databricks host** (offer `DATABRICKS_HOST` / `~/.databrickscfg` if present); **GitHub owner** (or `--no-github`); **tiers** (`1` prod / `2` prod+staging / `3` prod+staging+dev, surface this, do not pick silently; **tiers `2`/`3` require a GitHub repo**, cutting a long-running tier pushes its git side to origin, so `--no-github` with `--tiers 2`/`3` is refused up front, pair `--no-github` with `--tiers 1`); **language** (`python`/`nodejs`/`java`/`kotlin`); **UI track** (see just below , you MUST set it explicitly); **E2E/Infra** (default on for nodejs; forced on when UI track is on); **model profile** (see "Per-role model profile" just below).

**UI track , ASK it, never leave it unset.** A structured either/or that is the SINGLE SOURCE for "this project has a UI": a **UI SPA** project ⇒ pass **`--ui-track`** (the creator scaffolds a React `client/`, sets `clientFramework=react`, and REQUIRES the e2e harness so E2E is forced on), a **backend-only** project ⇒ pass **`--no-ui-track`** (`clientFramework=none`, no client scaffold). It drives whether the design lane may author client/E2E ACs and whether the UX role runs. **`lakebase-create-project` defaults an UNSET flag to backend-only (`--no-ui-track`)**, so if you skip this question a UI product is silently scaffolded with NO client , its home-screen/E2E ACs then have nowhere to build and the run's honest-GREEN verify refuses to pass (the `run-tests.sh` client-scaffold guard). If the intake has a `design/design-brief.md` (a UI product), the answer is almost certainly `--ui-track`; confirm with the user rather than assuming. Pass exactly one of `--ui-track` / `--no-ui-track` on every create.

### Per-role model profile

Offer the user one of two paths (default to **Default**):

1. **Default (recommended).** Use the kit's tuned defaults: each role on its recommended model, with the per-step model + effort tuning that ships in the step-manifests (for example, a deeper model on the `assess` turn and a smaller model at low effort on the mechanical `red` turn). This is the highest-quality, validated configuration. Pick it unless you have a specific reason not to.
2. **Customize.** Cherry-pick the model AND the reasoning effort yourself, per role and (optionally) per manifest step. For a role you can set one model/effort for all its turns, or a per-step map that changes only the steps you name and leaves the rest on the tuned default.

**Default writes no overrides.** The resolver reads model + effort straight from the step-manifests (`agentOptions`) plus each role's recommended base, so the shipped tuning applies exactly as-is. Do NOT pass `--agent-model` on the Default path.

**Customize** is persisted to the project's `.lakebase/consort-config.json` (NOT `agent-config.json`); the resolver layers its `roles.<role>` entries ON TOP of the manifest tuning:
- `model`: a string (applies to all of that role's turns) or a map `{ "<step>": "<model>" }`.
- `effort`: a level (all turns) or a map `{ "<step>": "<level>" }`.

⚠️ A **scalar** `model`/`effort` on a role overrides the tuned per-step values for ALL that role's turns (it flattens the tiering). Use a **per-step map** to change only specific steps and keep the tuning everywhere else: the map is the scalpel, the scalar is the blunt instrument.

Step keys (`<step>`): build turns `red` / `green` / `review` / `refactor` / `assess` / `repair` / `reflect`; design steps `breakdown` / `propose` / `acs` / `estimate` / `architect` / `dba` / `test-list` / `ux`. Effort levels: `default` (omit) / `low` / `medium` / `high` / `xhigh` / `max`.

Realize it: on the **Default** path pass no model flags. On the **Customize** path, pass any simple per-role model picks to `lakebase-create-project` via `--agent-model <role>=<model>`, then write per-role effort and any per-step model/effort maps into `.lakebase/consort-config.json` under `roles.<role>` after creation (the file is editable and resolver-honored). The selection persists there.

Then run the kit's creator (surface the exact command first; report its output, which prints a `Next:` hint).

**BEFORE you run it, give the human the full timeline so they can step away and come back at the right time.** This is a one-time provision of a few minutes; it must not look hung, and they shouldn't have to babysit it. Present the itemized steps with their usual durations and a total ETA , something like:

> "Setting up your project now , a **one-time setup, usually ~4-6 minutes total**, in two parts. You can step away and come back in about **6 minutes**.
>
> **Part 1 , provisioning (~2-4 min):**
> 1. **GitHub repo** , create + clone (~5-15s)
> 2. **Lakebase database** , provision Postgres + resolve the endpoint (~30-90s)
> 3. **Project files** , scaffold the app + `.consort/` + wire E2E (~5-10s)
> 4. **CI service principal** , the workflow identity (~5-15s)
> 5. **Self-hosted CI runner** , download + register + start it (**~1-2 min , the slow one; looks quietest, that's normal**)
> 6. **Staging tier** , cut the paired Lakebase + git branch (~20-40s) *(only for `--tiers 2`/`3`)*
> 7. **Initial commit + push** (~5-15s)
>
> **Part 2 , Consort toolkit download (~1-2 min):** right after create I run `./scripts/lk --refresh`, which downloads the kit + its dependencies **once** for this version (instant on every command after). I'll stream each package as it installs. This is deliberately separate from create , it's a heavy download, so we do it once at a reliable point rather than risk it mid-provision.
>
> I'll narrate each step as it happens and ping you the moment it's done (or if anything needs you)."

**Do not confuse the two parts when you narrate.** **Part 1 (scaffolding) does NOT download the toolkit** , it runs from the plugin's ALREADY-installed binary, so the very first thing you see is `[doctor] …`, not a download. The **only** kit download is **Part 2** (`./scripts/lk --refresh`). Never label a kit download as "Part 1", and never tell the human "Part 1 is downloading the toolkit" , if you see download/`npm http fetch`/`lk: … downloading` lines, that is Part 2. (The old flow re-fetched the kit via `npx` at the start of create, which is exactly the mislabeling this removes.)

Tune to the options (drop step 6 on `--no-github`/`--tiers 1`; a cold toolkit download over a slow network can push Part 2 to ~2-3 min).

**Launch scaffolding from the plugin's OWN binary with `--detach`, and relay it poll-once , NEVER foreground.** The plugin already ships the scaffolder (`dist/bin/lakebase/create-project.cli.js`), so run THAT directly. Do NOT `npx`-fetch the kit again just to run create , that re-downloads the whole kit (a silent multi-minute window BEFORE Part 1 even starts) and is the redundant fetch that used to look hung. `--detach` re-launches scaffolding in its OWN session and returns at once, capturing every step (`[doctor]`, `[Creating GitHub repository...]`, `[Creating Lakebase database …]`, `[Scaffolding project files...]`, `[Setting up CI auth …]`, `[Setting up the self-hosted CI runner …]`, `[Cutting staging tier …]`, `[Creating initial commit...]`, `[Project created successfully!]`) to a log. This is the ONLY launch that both **(a) cannot hit the harness ~2min bash timeout** on a ~3-4 min provision (a foreground call is killed; a plain `&` is reaped at turn-end) **and (b) lets you see each step LIVE** , relay the log with **poll-once `consort-watch --since`** (a foreground tail loop buffers until it returns , "nothing until all done"). Relay each batch, re-poll with the printed cursor until `status=done`, then relay the final `Next:` hint.

```bash
# Resolve the plugin's shipped binaries (create-project + consort-watch), robust to
# $CLAUDE_PLUGIN_ROOT being unset in this tool shell (it usually is). Same resolver as
# step 0. Each bash block is a fresh shell, so re-resolve here.
CONSORT_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$CONSORT_ROOT" ] || [ ! -d "$CONSORT_ROOT/dist" ]; then
  CONSORT_ROOT="$(ls -d "$HOME/.claude/plugins/cache/databricks-solutions/consort"/*/dist 2>/dev/null \
    | sort -V | tail -1 | sed 's#/dist$##')"
fi

# Pin the scaffolded project's runtime kit to THIS plugin's version (immutable), so its
# ./scripts/lk resolves the same release. Precedence: an explicit LAKEBASE_KIT_REF wins;
# else the running plugin's version; else the release-stamped floor. Running the plugin's
# OWN create binary already implies this version , set it explicitly so the pin is
# unambiguous. (Stamp form below is enforced by tests/bdd/start-kit-pin.test.ts.)
KIT_REF="${LAKEBASE_KIT_REF:-}"
if [ -z "$KIT_REF" ] && [ -f "$CONSORT_ROOT/.claude-plugin/plugin.json" ]; then
  KIT_REF="v$(node -p "require('$CONSORT_ROOT/.claude-plugin/plugin.json').version" 2>/dev/null || true)"
fi
KIT_REF="${KIT_REF:-v0.3.63}"   # stamped at release; == package.json version (enforced by tests/bdd/start-kit-pin.test.ts)
export LAKEBASE_KIT_REF="$KIT_REF"

# Launch scaffolding DETACHED (own session): it prints the child pid + a live-log path
# and returns at once. NO npx, NO foreground, NO `&` , --detach handles survival.
node "$CONSORT_ROOT/dist/bin/lakebase/create-project.cli.js" --detach \
  --project-name "<name>" --parent-dir "<parent-dir>" \
  --databricks-host "<host>" --github-owner "<owner>" \
  --language "<language>" --tiers "<1|2|3>" \
  (--ui-track|--no-ui-track) \
  [--no-github] [--enable-e2e|--no-e2e] [--enable-infra|--no-infra] \
  [--agent-model <role>=<model> ...]
#   -> prints: "... scaffolding detached ... as pid <PID>" + "live log: <LOG>" + the relay cmd.

# Relay it POLL-ONCE (one call per turn), narrating each batch, until status=done:
#   node "$CONSORT_ROOT/dist/bin/consort/watch.cli.js" --since 0 --log "<LOG>" --pid "<PID>"
#     -> relays new lines, ends with: [consort-watch] cursor=<N> status=<running|done|...>;
#        re-poll with the printed <N> until status=done.
#   next call: --since <N> (the printed cursor); repeat until status=done.
# On done, relay the final `Next:` hint from the tail of the log.
```

**Environment gate.** Before provisioning anything, `lakebase-create-project`
runs the environment doctor (tool prerequisites + that the target workspace has
Lakebase enabled) and refuses to start if a hard check fails, printing what to
fix. If it stops here, relay the doctor's findings to the human and have them fix
the environment, then re-run; do not pass `--skip-doctor` to force past a real
failure (it only exists for the rare case the human has already verified the
environment another way).

On success, tell the user to enter the new project, refresh its runtime kit, and resume:

```
cd <parent-dir>/<name>
./scripts/lk --refresh --detach   # Part 2 kit download , detached + relayed poll-once (see below), NOT foreground
```

**Part 2 , the kit download (`./scripts/lk --refresh --detach`): relay it live the same way, NEVER foreground.** This is the other multi-minute step, so it uses the SAME detach + poll-once pattern as create , a foreground run buffers behind a spinner and a ~1-2 min install risks the ~2min bash timeout. Pass **`--detach`**: `lk` re-launches the install in its OWN session and returns at once, printing the child pid + a live-log path. The install streams **what is being installed** to that log (each package: `lk: npm http fetch GET 200 …/<pkg>…`), not just a clock. Relay it poll-once with the plugin's `consort-watch` (the project's own `./scripts/lk consort-watch` may not be installed YET , that is what this step installs):
```bash
# from inside the freshly created project dir:
./scripts/lk --refresh --detach
#   -> prints: "toolkit install detached ... as pid <PID>" + "live log: <LOG>".
# Relay poll-once with the PLUGIN's consort-watch (always present), until status=done:
#   node "$CONSORT_ROOT/dist/bin/consort/watch.cli.js" --since 0 --log "<LOG>" --pid "<PID>"
```
If you hand the command to the user to run themselves instead, tell them it's a one-time ~1-2 min download that prints each package as it installs.

then re-run **`/consort:start`** there (it will find `.consort/` and resume at `/plan`), or `./scripts/consort.sh plan` to open the orchestrator session directly. Do not start the workflow from the current directory, the project is elsewhere.

### Offer the viewer extension + get the terminal right (fresh project OR resume)

Make sure the human is driving from the best place , on the hand-off to the first workflow step (`/plan`, `/sprint`, `/design`, `/spike`) of a fresh project, AND on a `/consort:start` that resumes an existing one (this is NOT fresh-create-only , a resuming user needs the same choice). **FIRST detect whether this session is ALREADY inside the editor's integrated terminal** , the same signal the kit uses in `isInsideEditor` (`TERM_PROGRAM` contains `vscode`/`cursor`, or `CURSOR_TRACE_ID` / `VSCODE_PID` is set):
```bash
inside_editor() { case "${TERM_PROGRAM:-}" in *[Vv]scode*|*[Cc]ursor*) return 0 ;; esac; [ -n "${CURSOR_TRACE_ID:-}" ] || [ -n "${VSCODE_PID:-}" ]; }
```
- **Already inside the IDE terminal** (`inside_editor` true) → do NOT tell them to open a new terminal or "move" anywhere , that reads as pushing them OUT of the terminal they are already in. Just offer to install the live-viewer extension if it is not set up, then continue the workflow step in THIS terminal.
- **NOT inside an IDE terminal** → offer the **Consort VS Code / Cursor extension** (a live viewer: paired branches, phase/gate state, per-role progress) AND to move there (or keep driving here). Offer to set it up for them:

> "Consort has a VS Code / Cursor extension that shows the run live , branches, gates, and each role's progress. Want me to install it and open your editor on the project?"

**First check whether they even have an editor**, then, if yes, do it for them (download the latest release `.vsix`, install, open the project). The `cursor` / `code` CLI is often NOT on PATH even when the app IS installed (users skip the editor's "Install command in PATH" step), so fall back to the macOS app-bundle CLI before concluding it's missing:
```bash
# Find a usable Cursor/VS Code CLI: PATH first, then the installed .app's bundled CLI.
find_editor() {
  for c in cursor code; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
  for p in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
           "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
           "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
           "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
}
ED="$(find_editor)"
if [ -z "$ED" ]; then
  echo "Neither Cursor nor VS Code found. Install one, then the extension (manual steps below)."
else
  # Download into a FRESH dir , NOT a fixed /tmp/consort-ext: a leftover older .vsix
  # from a prior run persists (`--clobber` only overwrites the SAME name), so a
  # `*.vsix` glob would then match two versions and `--install-extension` could pick
  # the wrong (older) one. A fresh dir holds only the LATEST release's single .vsix.
  DEST="$(mktemp -d)"
  gh release download --repo databricks-solutions/lakebase-scm-extension \
    --pattern '*.vsix' --dir "$DEST" --clobber          # the latest release (not on the marketplace)
  VSIX="$(ls -t "$DEST"/*.vsix 2>/dev/null | head -1)"   # newest, defensively (should be exactly one)
  "$ED" --install-extension "$VSIX" --force              # --force so a same-version reinstall still applies
  "$ED" "<parent-dir>/<name>"                            # open the PROJECT dir with the extension active
fi
```
- **Confirm which editor** if both are present (prefer the one they're using). The app-bundle fallback means an installed-but-not-on-PATH editor still works; if you used the bundle path, mention they can enable the short command via the editor's *"Shell Command: Install 'code'/'cursor' command in PATH"*.
- **If neither is installed**, don't force it: point them to install Cursor or VS Code, then the manual path , download the `*.vsix` from `https://github.com/databricks-solutions/lakebase-scm-extension/releases/latest` and use the editor's **Extensions → ⋯ → Install from VSIX**, then open the project folder.
- **After the editor opens, offer to RESUME the workflow there , don't just leave them in a fresh window.** Opening the project is only half the hand-off: the new editor window has no session driving it. Tell them how to continue in that window, and let them choose where to drive from:
  > "Your project is open in <editor> with the live viewer. To drive the workflow from there, open a terminal in that window (**Ctrl+`**), run `claude`, and then `/consort:start` , it reads the project state and picks up exactly where this leaves off. Or I can keep driving from here and you just watch the viewer. Which do you prefer?"

  `/consort:start` in the new window is safe to resume with because state is DERIVED from disk (`consort-next` is authoritative) , there is no session-local progress to lose. If they want to keep driving from THIS session, that is fine too; the extension viewer updates from the same `.consort` state either way. Drive from ONE session at a time (two concurrent drives on one project race on the git worktree).
- **Surface the move choice as its OWN standalone STOP , this is a hard gate, not a line buried in a batch of setup questions.** Ask ONLY "move to the editor + live viewer, or keep driving here?" and then STOP: do NOT bundle it with other setup questions (workspace, stack, first feature, etc.), do NOT ask anything else in the same turn, and do NOT proceed to the workflow step until the human has answered THIS question. It is still an offer , if they choose "keep driving here" you continue in this terminal , but the human must actively make the terminal choice; the flow may never skip past it or fold it into other prompts (that is the "I was never gated at the move offer" defect). Present it once per session, on a fresh project OR a resume. **Skip it entirely only when the session is already inside the IDE terminal** (`inside_editor` true): then there is nothing to move, so continue in place and never prompt them out.

---

## Note on the orchestrator

The orchestrator is the deterministic driver (`consort-drive`), not an LLM agent: the slash commands invoke it, and IT spawns the role agents + pauses at gates. `/consort:start` (this command) helps you pick + run the right command from your session; the project's `./scripts/consort.sh` is the equivalent local launcher.
