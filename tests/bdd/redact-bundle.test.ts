// The diagnostic-bundle redactor. Everything written to a shareable bundle passes
// through it, so a leaked Lakebase token (in a DSN), a Databricks PAT, a bearer
// header, a secret assignment, or an absolute /Users/<name>/ path never reaches a
// public issue. Bias: over-redact rather than leak.

import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../consort/orchestrator/diagnose/redact";

describe("redactSecrets", () => {
  it("masks the password in a postgres DSN (the minted Lakebase token)", () => {
    const s = redactSecrets('could not connect to postgresql://u_abc:dapi0123456789abcdef0123@ep-x.databricks.com:5432/db');
    expect(s).toContain("postgresql://u_abc:***@ep-x.databricks.com");
    expect(s).not.toContain("dapi0123456789abcdef0123");
  });

  it("masks a jdbc DSN password too", () => {
    expect(redactSecrets("jdbc:postgresql://user:sup3rSecret@host:5432/db")).toContain("jdbc:postgresql://user:***@host");
  });

  it("masks a standalone Databricks PAT and a Bearer header", () => {
    expect(redactSecrets("token=dapiabcdef0123456789abcdef")).toContain("dapi***");
    expect(redactSecrets("Authorization: Bearer eyJhbGci.payload.sig")).toBe("Authorization: Bearer ***");
  });

  it("masks known secret assignments (env + json)", () => {
    expect(redactSecrets("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(redactSecrets('GITHUB_TOKEN: ghp_xxxxxxxxxxxx')).toContain("GITHUB_TOKEN: ***");
    expect(redactSecrets('{"password":"p@ss"}')).toContain('"password":"***"');
  });

  it("anonymizes the username in absolute home paths", () => {
    expect(redactSecrets("/Users/kevin.hartman/code/stockflow/app.py")).toBe("/Users/<user>/code/stockflow/app.py");
    expect(redactSecrets("/home/alice/proj")).toBe("/home/<user>/proj");
  });

  it("leaves non-sensitive text untouched and is idempotent", () => {
    const clean = "relation \"stock_levels\" does not exist";
    expect(redactSecrets(clean)).toBe(clean);
    const once = redactSecrets("postgresql://u:tok@h/db");
    expect(redactSecrets(once)).toBe(once); // idempotent – re-redacting a masked value is a no-op
  });
});
