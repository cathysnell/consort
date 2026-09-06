import { describe, it, expect } from "vitest";
import { driveAuthPreflight } from "../../consort/orchestrator/provisioning/credentials";

describe("driveAuthPreflight – fail-fast on an expired Databricks session", () => {
  it("ok when the refresh-token probe passes", async () => {
    const res = await driveAuthPreflight(undefined, async () => ({ ok: true }));
    expect(res.ok).toBe(true);
    expect(res.message).toBeUndefined();
  });

  it("fails with the `databricks auth login` remediation when the session is expired", async () => {
    const res = await driveAuthPreflight("https://example.cloud.databricks.com", async () => ({
      ok: false,
      reason: "refresh token is invalid; reauthenticate",
    }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/databricks auth login/);
    // The failing reason travels through so the operator sees WHY.
    expect(res.message).toMatch(/refresh token is invalid|reauthenticate/i);
  });

  it("passes the host through to the probe (so a mis-scoped session is caught for the right workspace)", async () => {
    let seen: string | undefined = "unset";
    await driveAuthPreflight("https://ws.cloud.databricks.com", async (h) => {
      seen = h;
      return { ok: true };
    });
    expect(seen).toBe("https://ws.cloud.databricks.com");
  });
});
