import { test, expect } from "@playwright/test";

// The reachability pattern proven end-to-end: a feature page is reachable by
// NAVIGATING the real app (a navbar link / a route), not just by mounting the
// component in isolation. This drives the real <App> router – the check a bare
// component test cannot make. Model your feature-flow e2e specs on this.
test("the About page is reachable by navigating from the navbar", async ({ page }) => {
  await page.goto("/");
  // Click the nav link (reachability via a nav affordance), not a direct URL.
  await page.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("About");
});

test("the About page is reachable directly by its route", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("About");
});
