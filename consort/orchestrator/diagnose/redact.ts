// Redact secrets + environment identifiers from diagnostic-bundle content BEFORE it
// becomes shareable. The bundle is raw forensics (log tails, failure output), which
// can carry a minted Lakebase token inside a `postgresql://user:PASS@host` DSN, a
// `dapi…` PAT, a bearer header, or an absolute `/Users/<name>/…` path – none of
// which should land in a public issue. Conservative over-redaction is the right bias
// for a shareable artifact: better a masked value than a leaked credential.
//
// Applied ONLY to what is WRITTEN TO THE BUNDLE. The local terminal analysis stays
// full-fidelity (the human needs the real error to troubleshoot); the shared copy is
// scrubbed.

const RULES: Array<[RegExp, string]> = [
  // Postgres / JDBC DSN password: postgresql://user:PASSWORD@host -> mask the password.
  [/((?:jdbc:)?postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi, "$1***$2"],
  // Any user:pass@host authority (covers non-postgres URLs too).
  [/(\/\/[^:/\s]+:)[^@\s/]+(@)/g, "$1***$2"],
  // Databricks PAT.
  [/\bdapi[a-z0-9]{16,}\b/gi, "dapi***"],
  // Authorization: Bearer <token>  /  "Bearer <token>".
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***"],
  // KEY=VALUE / KEY: VALUE / "key":"value" for known-secret key names.
  [
    /\b(DB_PASSWORD|PGPASSWORD|DATABRICKS_TOKEN|DATABRICKS_CLIENT_SECRET|GITHUB_TOKEN|GH_TOKEN|CONSORT_TELEMETRY_TOKEN|password|passwd|secret|access[_-]?token|api[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/gi,
    "$1$2***",
  ],
  // Absolute home paths -> anonymize the username segment (keeps the path shape).
  [/(\/Users\/|\/home\/)[^/\s"']+/g, "$1<user>"],
];

/** Scrub secrets + environment identifiers from bundle-bound text. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}
