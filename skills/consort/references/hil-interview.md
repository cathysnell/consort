# HIL Intake Interview

How the coordinating session gathers a new project's intake from the human. This is the
**live, conversational step** run by the coordinating session (the orchestrator) — NOT a
role agent. Its sole output is `.consort/intake/answers.md`; the metered `product-owner`
`intake` turn later DRAFTS `product-overview.md` / `nfrs.md` / `design-brief.md` FROM that
file. Keep the interview short: the answers file is the PO turn's input, not a final artifact.

Run this only when the intake artifacts are ABSENT (a project the human authored themselves).
SKIP it entirely when they already exist — the StockFlow seed path, or a resumed project.

## The rule: domain first, then wizard

The interview is **consistent and wizard-style**, never free-form. Conduct it in two beats:

1. **Open with the domain + project name — one or two sentences, one prompt.** Ask a single
   opening question and let the human answer in prose:
   > "In a sentence or two: what is this product, and who uses it?"
   (If only a project name was given, treat it as the clue and confirm the domain back in a
   sentence before proceeding.) This orients the rest of the interview.

2. **Then walk the rest ONE QUESTION AT A TIME.** Ask a single question, wait for the answer,
   record it, then ask the next — never dump the whole question list at once, never let the
   human free-associate across topics. Go in canonical order, drawing the question CONTENT
   from the canon so it is never improvised:
   - **Product overview** — the core jobs, the first usable version vs. later, expected growth,
     explicit non-goals, per-sprint delivery expectations. (framing per `@ui-ux-design-principles`)
   - **Non-functional requirements** — walk each category in turn: performance, scalability,
     security, observability, operability, resilience, and anything the architect should
     explicitly NOT pursue. (per `@software-design-principles`)
   - **Design brief (UI track only)** — 1–3 reference sites and *what to take from each*, plus
     brand / interaction / accessibility constraints. (per `@ui-ux-design-principles`; this is
     what the UX Designer later extracts the look from — name concrete sites.)

After each answer, capture it before moving on. Confirm nothing is left blank that the human
meant to fill; it is fine for a category to be "no specific requirement" — record that explicitly
rather than skipping it silently.

## Writing `answers.md`

Copy the blank template (`intake-answers-template.md`) to `.consort/intake/answers.md` and fill
each section as you go. Keep the section headers intact and unchanged — the PO `intake` turn reads
this structure, so a deterministic shape matters more than prose polish. One answer per question,
in the human's own words; do not invent, expand, or draft the briefs here (that is the PO turn's job).

When every section is filled, the interview is done: run `/plan`, and the `product-owner` `intake`
turn drafts the artifacts from `answers.md` for your review.
