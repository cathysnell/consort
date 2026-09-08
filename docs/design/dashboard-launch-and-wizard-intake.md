# Local dashboard launch + consistent wizard-style intake

## Context

Two ergonomics gaps in the `consort:start` flow:

1. **No one-move way to open the dashboard on the project you just started.** The dashboard's data path is already 100% local — its live source reads a project's `.consort/` straight off disk (`agent-log.jsonl`, `next.json`, `turns/`, and `lk lakebase-feature-status` shelled in the project dir), no git/remote. But `apps/dashboard` isn't shipped in the installed kit (`apps/` isn't in `package.json` `files`), and there's no scaffolded launcher — you run `apps/dashboard/run.sh` by hand from a dev clone.
2. **The intake interview style is unspecified**, so it's wizard sometimes and free-form other times. `commands/start.md:68` says only *"Interview the human… Ask the intake questions"* — no order, no style. The questions themselves are canonical (product-overview ×6, NFR ×7, UX ×6, from `@software-design-principles` + `@ui-ux-design-principles`); only the delivery is unpinned.

Decision taken: **ship a prebuilt dashboard** so `run-dashboard` works from any locally-deployed kit.

## Part A — `run-dashboard` (prebuilt, shipped, scaffolded)

**1. Standalone build.** Add `output: "standalone"` to `apps/dashboard/next.config.ts`. Add a kit build script (`build:dashboard`) that runs `next build` and assembles the self-contained output (`.next/standalone` + `.next/static` + `public`) into **`dist/dashboard/`**. This reuses the kit's existing committed-`dist/` release ritual (build → `git add -f dist` at publish; `dist` is already in `files`), so the prebuilt server ships with every kit and needs **no runtime install**. The runnable entry is `dist/dashboard/server.js` (run with `node`, honoring `PORT` + the `CONSORT_*` env at launch).

**2. Scaffolded launcher.** Add `templates/project/common/scripts/run-dashboard.sh`, sibling to `run-dev.sh` / `run-tests.sh`. It auto-ships (`templates/` is in `files`) and auto-scaffolds into every project (scaffolder copies all `common/scripts/*` wholesale + `chmod +x` — **no scm-utils change**). Behavior:
   - Resolve the **locally-deployed** kit dir exactly as `lk` does: `LAKEBASE_KIT_DIR` → `.lakebase/kit-ref.local` → `.lakebase/kit-ref` → cache (reuse the existing resolution — do not reinvent; factor the shared bit out of the `lk` shim if practical).
   - Prefer the prebuilt server: `node <kit>/dist/dashboard/server.js`. Fall back to `<kit>/apps/dashboard/run.sh` (`next dev`) when the deployed kit is a dev clone with source but no `dist/dashboard/` build.
   - Set `CONSORT_PROJECT_DIR=<this project root>`, auto-detect `.consort/record` → `CONSORT_RECORD_DIR`, pick a free `PORT` via the existing `templates/project/common/scripts/port-utils.sh`, print + open the URL.

**3. Release/CI.** Add `build:dashboard` to the release build so the committed `dist/dashboard/` bundle is rebuilt alongside `dist/`. Trade-off (accepted): package size grows by the standalone bundle.

**4. Start-flow offers.** After create/resume, `commands/start.md` should **offer two next actions** (not silently require the user to know the scripts): (a) **open the dashboard** — `./scripts/run-dashboard.sh`; (b) **open in VS Code to run the drive** — `code <project-dir>` (then the drive runs there via the terminal / consort extension). These are offers, not auto-runs. This is what wires Request 1 into the actual start UX.

**Critical files:** `apps/dashboard/next.config.ts` (output standalone); a `build:dashboard` script (root `package.json` + release flow); `templates/project/common/scripts/run-dashboard.sh` (new); `commands/start.md` (the offers); `package.json` `files` already covers `dist/`.

## Part B — enforce wizard-style intake

**Who interviews (corrected):** the **coordinating session / orchestrator** runs the interview and writes `.consort/intake/answers.md`; the metered **`product-owner` `intake` turn** then DRAFTS the briefs *from* `answers.md` (`start.md:68–69` confirm this split). The PO never interviews — so `product-owner.md` is NOT touched.

**New shipped canon: `skills/consort/references/hil-interview.md`** — the single authoritative definition of the interview, extracted from the one-line aside at `start.md:68`. It defines the *flow* (the question *content* stays in `@software-design-principles` + `@ui-ux-design-principles`, referenced from it):
1. **Open by capturing domain + project name** in 1–2 sentences ("What is this product, in a sentence or two? Who uses it?").
2. **Then conduct the rest ONE QUESTION AT A TIME** (wizard-style), in canonical order — product-overview → NFR (walk each category) → UX (UI only) — capturing each answer to `answers.md` before the next question.
3. **Defines the `answers.md` structure** (section headers per question set) so the file's shape is deterministic for the PO turn to read.

**New shipped blank template:** an `answers.md` **blank template** (canonical section headers, empty) — NOT a filled example (a filled one anchors the interviewer, and the PO already has its filled drafting reference at `examples/first-project/stockflow-seed/intake/`). The interviewer creates `.consort/intake/answers.md` from this structure and fills it wizard-style. Ship it where the interview canon can point at it (alongside `hil-interview.md`, or a `templates/` intake asset).

**`commands/start.md` change:** replace the inline "Ask the intake questions" aside with a reference to `hil-interview.md` (conduct the interview per that canon → `answers.md`, then the PO turn drafts). Enforcement = the imperative canon (a conversational step has no deterministic gate, so the prompt is the mechanism); extracting it to one authoritative file removes the improvisation.

## Verification

- **Hermetic:** guard tests that `next.config.ts` sets `output: "standalone"`; `templates/project/common/scripts/run-dashboard.sh` exists + is executable; `hil-interview.md` carries the domain-first + one-question-at-a-time directives and defines the `answers.md` structure; the blank `answers.md` template exists; and `start.md` references `hil-interview.md` and offers the dashboard + VS Code actions. `next build` (standalone) produces a bootable `dist/dashboard/server.js`.
- **Manual/live:** `consort:start` a project → it offers the dashboard + VS Code → `./scripts/run-dashboard.sh` opens on the local `.consort/` with no git, on a free port; and a fresh intake runs domain-first, then wizard-style one-question-at-a-time, writing a structured `answers.md`.
- Full hermetic suite stays green.

## Open sub-decisions (recommended defaults; will proceed unless you say otherwise)

1. **Bundle location** — recommend `dist/dashboard/` (rides the existing committed-dist release ritual). Alt: a dedicated `apps/dashboard/.next/standalone` force-added.
2. **Dev-clone fallback** — recommend yes: `run-dashboard.sh` uses `next dev` when the deployed kit is a source clone without a `dist/dashboard/` build.
3. **Auto-open browser** — recommend yes (like a typical dev script), with the URL always printed so it works headless.
4. **`answers.md` template home** — recommend alongside `hil-interview.md` under `skills/consort/references/` (canon + its template together); the interviewer copies it to `.consort/intake/answers.md`.
