// Corpus finalizer: build a browsable .consort/ mirror + sweep recorded paths onto it, so a reader
// examining the corpus AFTER the ephemeral project is reclaimed can OPEN the referenced files.
// The load-bearing assertion is #3: join(recordDir, rewrittenRelPath) is a REAL file – the definitive
// "opens in a file browser" proof.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildConsortMirror, sweepRecordedPaths, finalizeCorpus } from "../../consort/logging/finalize-corpus.js";
import { PROJECT_ROOT_TOKEN } from "../../consort/logging/turn-recorder.js";

const tmp: string[] = [];
function w(f: string, body: string): void { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); }
function mkRec(): string { const d = mkdtempSync(join(tmpdir(), "finalize-corpus-")); tmp.push(d); return d; }
afterEach(() => { while (tmp.length) { const d = tmp.pop(); if (d) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

describe("finalize-corpus: browsable .consort mirror + path sweep", () => {
  it("mirrors produced (recorded-artifacts) UNION seed (intake), produced wins; sweep makes paths openable", () => {
    const rec = mkRec();
    // seed (intake) + produced (recorded-artifacts), disjoint like a real run.
    w(join(rec, "intake", "product-overview.md"), "# overview\n");
    w(join(rec, "intake", "nfrs.md"), "# nfrs\n");
    w(join(rec, "intake", "design", "assets", "warehouse.png"), "PNGBYTES");
    w(join(rec, "recorded-artifacts", "planning", "feature-proposals.md"), "# proposals\n");
    w(join(rec, "recorded-artifacts", "features", "F1", "architecture.json"), "{}\n");
    // a recorded prompt referencing BOTH a seed path and a produced path via the token.
    w(join(rec, "turns", "0000-spec-author-propose", "replay-set", "prompt.txt"),
      `Read ${PROJECT_ROOT_TOKEN}/.consort/product-overview.md and ${PROJECT_ROOT_TOKEN}/.consort/planning/feature-proposals.md. Also ${PROJECT_ROOT_TOKEN}/app/main.py (code).`);
    w(join(rec, "turns", "0000-spec-author-propose", "transcript.md"),
      `## Prompt\nUse ${PROJECT_ROOT_TOKEN}/.consort/nfrs.md\n`);

    const { mirror, sweep } = finalizeCorpus(rec);

    // 1) mirror has BOTH homes merged.
    expect(existsSync(join(rec, ".consort", "product-overview.md"))).toBe(true); // from intake
    expect(existsSync(join(rec, ".consort", "planning", "feature-proposals.md"))).toBe(true); // from produced
    expect(existsSync(join(rec, ".consort", "design", "assets", "warehouse.png"))).toBe(true); // binary seed
    expect(mirror.fromProduced).toBe(2);
    expect(mirror.fromIntake).toBe(3);
    expect(mirror.collisions).toEqual([]);

    // 2) sweep rewrote the .consort refs to ./.consort/... and left the code path as the token.
    const prompt = readFileSync(join(rec, "turns", "0000-spec-author-propose", "replay-set", "prompt.txt"), "utf8");
    expect(prompt).toContain("./.consort/product-overview.md");
    expect(prompt).toContain("./.consort/planning/feature-proposals.md");
    expect(prompt).toContain(`${PROJECT_ROOT_TOKEN}/app/main.py`); // code path: no mirror, left honest
    expect(prompt).not.toMatch(new RegExp(escapeRegExp(PROJECT_ROOT_TOKEN) + "/\\.consort")); // no .consort token left
    expect(sweep.rewrittenToConsort).toBeGreaterThanOrEqual(3);

    // 3) DEFINITIVE browser-openable proof: every ./.consort/<x> in the swept prompt resolves to a real
    // file (trailing sentence punctuation trimmed the same way a reader would when opening the path).
    for (const m of prompt.matchAll(/\.\/(\.consort\/[^\s"'`)\]]+)/g)) {
      const rel = m[1].replace(/[.,;:)\]]+$/, "");
      expect(existsSync(join(rec, rel))).toBe(true);
    }
    // transcript too.
    const tr = readFileSync(join(rec, "turns", "0000-spec-author-propose", "transcript.md"), "utf8");
    expect(tr).toContain("./.consort/nfrs.md");
    expect(existsSync(join(rec, ".consort", "nfrs.md"))).toBe(true);
  });

  it("is idempotent – a second finalize is a byte-identical no-op", () => {
    const rec = mkRec();
    w(join(rec, "intake", "product-overview.md"), "# o\n");
    w(join(rec, "recorded-artifacts", "planning", "x.md"), "# x\n");
    w(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"), `${PROJECT_ROOT_TOKEN}/.consort/planning/x.md`);
    finalizeCorpus(rec);
    const after1 = readFileSync(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"), "utf8");
    finalizeCorpus(rec);
    const after2 = readFileSync(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"), "utf8");
    expect(after2).toBe(after1);
    expect(after1).toBe("./.consort/planning/x.md");
  });

  it("collision guard: a seed file colliding with a DIFFERENT-content produced file is skipped + flagged", () => {
    const rec = mkRec();
    w(join(rec, "recorded-artifacts", "design", "shared.md"), "PRODUCED\n");
    w(join(rec, "intake", "design", "shared.md"), "SEED\n"); // same path, different bytes
    const rep = buildConsortMirror(rec);
    expect(rep.collisions).toContain(join("design", "shared.md"));
    expect(readFileSync(join(rec, ".consort", "design", "shared.md"), "utf8")).toBe("PRODUCED\n"); // produced wins
  });

  it("a .consort ref with NO mirror file is left as the token (never a dead relative path)", () => {
    const rec = mkRec();
    w(join(rec, "recorded-artifacts", "planning", "x.md"), "# x\n"); // mirror has only planning/x.md
    w(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"),
      `${PROJECT_ROOT_TOKEN}/.consort/planning/x.md and ${PROJECT_ROOT_TOKEN}/.consort/does/not/exist.md`);
    const { sweep } = finalizeCorpus(rec);
    const p = readFileSync(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"), "utf8");
    expect(p).toContain("./.consort/planning/x.md"); // exists -> rewritten
    expect(p).toContain(`${PROJECT_ROOT_TOKEN}/.consort/does/not/exist.md`); // absent -> kept as token
    expect(sweep.leftAsToken).toBeGreaterThanOrEqual(1);
  });

  it("normalizes a residual raw absolute project root (legacy corpus) via --live-root", () => {
    const rec = mkRec();
    const live = "/Users/x/tdd-workflow-smoke/proj-123";
    w(join(rec, "recorded-artifacts", "planning", "x.md"), "# x\n");
    w(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"),
      `${live}/.consort/planning/x.md and ${live}/app/main.py`);
    finalizeCorpus(rec, live);
    const p = readFileSync(join(rec, "turns", "0000-t", "replay-set", "prompt.txt"), "utf8");
    expect(p).toContain("./.consort/planning/x.md"); // abs .consort with mirror file -> relative
    expect(p).toContain(`${PROJECT_ROOT_TOKEN}/app/main.py`); // abs code -> token
    expect(p).not.toContain(live); // no raw ephemeral abs path remains
  });
});

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
