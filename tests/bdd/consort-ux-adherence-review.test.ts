// The REVIEW step runs the deterministic UX gate (checkUxClean) and, on a dirty
// UI-track project (an unreachable or bare feature page), flags the story-scoped
// `ux-adherence` smell – with NO model cooperation. Because `ux-adherence` is
// build-refactor-routable, the open smell then routes the Driver's REFACTOR turn
// in-loop (covered by sftdd-layering-self-heal.test.ts, which shares the smell).
// This guards the review-time WRITE: a dirty client -> smell written once
// (idempotent); a clean client / a non-UI project -> nothing written.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewStory } from "../../consort/pipeline/cycle-record.js";
import { readSmellsLog } from "../../consort/smells/smells.js";

const F = "F6";
const S = "S1";
let proj: string;
let tdd: string;

function writeJson(file: string, obj: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

/** A client/ workspace with the given App.tsx + pages. */
function writeClient(app: string, pages: Record<string, string>): void {
  const pagesDir = join(proj, "client", "src", "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(proj, "client", "package.json"), "{}");
  writeFileSync(join(proj, "client", "src", "App.tsx"), app);
  for (const [name, src] of Object.entries(pages)) writeFileSync(join(pagesDir, name), src);
}

const HOME = `export function HomePage(){return(<main className="page"/>);}`;
const STYLED_SKU = `export function SkuDetailPage(){return(<main className="page"><div className="card" style={{gap:"var(--space-4)"}}/></main>);}`;
const BARE_SKU = `export function SkuDetailPage(){return(<table><tr><td>{x}</td></tr></table>);}`;
const APP_BOTH = `import {Routes,Route} from "react-router-dom";
  export function App(){return(<Routes>
    <Route path="/" element={<HomePage/>}/>
    <Route path="/sku" element={<SkuDetailPage/>}/>
  </Routes>);}`;
const APP_HOME_ONLY = `import {Routes,Route} from "react-router-dom";
  export function App(){return(<Routes><Route path="/" element={<HomePage/>}/></Routes>);}`;

const openUxSmells = () =>
  readSmellsLog(tdd).detected.filter((d) => d.smell === "ux-adherence" && !d.resolution);

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "ux-review-"));
  tdd = join(proj, ".sftdd");
  // A minimal story so reviewStory can record its verdict.
  writeJson(join(tdd, "features", F, "stories", S, "acs", "AC1.json"), { id: "AC1", layer: "client" });
});
afterEach(() => rmSync(proj, { recursive: true, force: true }));

describe("reviewStory flags ux-adherence on a dirty UI-track project", () => {
  it("writes the story-scoped ux-adherence smell when a feature page is unrouted", () => {
    writeClient(APP_HOME_ONLY, { "HomePage.tsx": HOME, "SkuDetailPage.tsx": STYLED_SKU });
    reviewStory(tdd, F, S);
    const hits = openUxSmells();
    expect(hits.length).toBe(1);
    expect(hits[0].story_id).toBe(S);
    expect(hits[0].detail).toMatch(/SkuDetailPage/);
  });

  it("writes the smell when a routed feature page is bare (unstyled)", () => {
    writeClient(APP_BOTH, { "HomePage.tsx": HOME, "SkuDetailPage.tsx": BARE_SKU });
    reviewStory(tdd, F, S);
    const hits = openUxSmells();
    expect(hits.length).toBe(1);
    expect(hits[0].detail).toMatch(/bare|SkuDetailPage/);
  });

  it("does not double-write on a repeat review (idempotent)", () => {
    writeClient(APP_HOME_ONLY, { "HomePage.tsx": HOME, "SkuDetailPage.tsx": STYLED_SKU });
    reviewStory(tdd, F, S);
    reviewStory(tdd, F, S);
    expect(openUxSmells().length).toBe(1);
  });

  it("writes nothing when every feature page is routed + styled", () => {
    writeClient(APP_BOTH, { "HomePage.tsx": HOME, "SkuDetailPage.tsx": STYLED_SKU });
    reviewStory(tdd, F, S);
    expect(openUxSmells().length).toBe(0);
  });

  it("writes nothing for a non-UI project (no client/ workspace)", () => {
    // no writeClient() call -> checkUxClean is a no-op
    reviewStory(tdd, F, S);
    expect(openUxSmells().length).toBe(0);
  });
});
