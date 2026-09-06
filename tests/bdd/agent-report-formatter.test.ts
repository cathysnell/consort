// agent-report-formatter: the record/log-phase seam that lets a SANDBOXED spawned agent
// satisfy the agent-log requirement without executing a subprocess. The agent AUTHORS raw
// content (.agent-report.json: what it did + any warn/error it surfaced) – a plain file write
// it CAN do – and the ORCHESTRATOR formats that into conformant agent-log.jsonl entries
// (stamping timestamp + role, validating each vs agent-log-event.schema.json). Conformance is
// guaranteed BY CONSTRUCTION: the agent never touches the schema; the provided formatter owns
// it. Authorship stays the agent's (empty/absent report => a real, surfaced problem).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { formatAgentReport, extractReportBlock } from "../../consort/orchestrator/turns/agent-report-formatter";
import { getValidator } from "../../consort/orchestrator/validators/schema-loader";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "agent-report-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const validate = getValidator("agent-log-event.schema.json");

describe("formatAgentReport: agent-authored report -> conformant agent-log.jsonl", () => {
  it("formats a single-entry report into a conformant log line stamped with role + timestamp", () => {
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ level: "info", event: "artifact.written", message: "wrote feature-spec.json + 2 stories" }));
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(1);
    const lines = readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(validate(obj)).toBe(true);           // conformant by construction
    expect(obj.role).toBe("spec-author");         // orchestrator stamped the role
    expect(typeof obj.timestamp).toBe("string");  // orchestrator stamped the timestamp
    expect(obj.message).toBe("wrote feature-spec.json + 2 stories"); // agent authored it
  });

  it("formats a MULTI-entry report (agent surfaced a warn alongside the write)", () => {
    writeFileSync(
      join(ws, ".agent-report.json"),
      JSON.stringify([
        { level: "info", event: "artifact.written", message: "wrote feature-spec.json" },
        { level: "warn", event: "open.question", message: "pagination strategy unresolved" },
      ]),
    );
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.entries).toBe(2);
    const lines = readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(validate(JSON.parse(l))).toBe(true);
    // the warn the agent surfaced survived into the conformant log.
    expect(lines.some((l) => JSON.parse(l).level === "warn")).toBe(true);
  });

  it("defaults level=info + event=artifact.written when the agent omits them (message required)", () => {
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ message: "did the thing" }));
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.ok).toBe(true);
    const obj = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
    expect(obj.level).toBe("info");
    expect(obj.event).toBe("artifact.written");
  });

  it("FAILS (does not write a log) when the report is ABSENT – the agent surfaced nothing", () => {
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/report|absent|nothing/i);
    expect(existsSync(join(ws, "agent-log.jsonl"))).toBe(false);
  });

  it("FAILS when a report entry has an empty message (no real authorship)", () => {
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ level: "info", event: "artifact.written", message: "" }));
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/message/i);
  });

  it("FAILS when a report entry uses an off-vocabulary event (schema-rejected)", () => {
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ level: "info", event: "made-it-up", message: "x" }));
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    expect(r.ok).toBe(false);
  });

  describe("STDOUT channel (containment-proof: report in the agent's final message)", () => {
    it("extracts a ```agent-report block from the final text and formats it – NO file needed", () => {
      const finalText = [
        "I broke the feature into 2 stories. Here is my report:",
        "```agent-report",
        JSON.stringify({ level: "info", event: "artifact.written", message: "wrote feature-spec.json + 2 stories" }),
        "```",
        "Done.",
      ].join("\n");
      const r = formatAgentReport({ workspaceDir: ws, role: "spec-author", reportText: finalText });
      expect(r.ok).toBe(true);
      expect(r.entries).toBe(1);
      const obj = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
      expect(validate(obj)).toBe(true);
      expect(obj.role).toBe("spec-author");
      expect(obj.message).toBe("wrote feature-spec.json + 2 stories");
    });

    it("reportText wins over any file (the stdout channel is authoritative)", () => {
      writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ level: "info", event: "artifact.written", message: "from FILE" }));
      const finalText = "```agent-report\n" + JSON.stringify({ level: "info", event: "artifact.written", message: "from STDOUT" }) + "\n```";
      formatAgentReport({ workspaceDir: ws, role: "spec-author", reportText: finalText });
      const obj = JSON.parse(readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim());
      expect(obj.message).toBe("from STDOUT");
    });

    it("FAILS when the final text has no agent-report block (agent surfaced nothing)", () => {
      const r = formatAgentReport({ workspaceDir: ws, role: "spec-author", reportText: "I did some stuff but forgot to report it." });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/agent-report|surfaced nothing/i);
      expect(existsSync(join(ws, "agent-log.jsonl"))).toBe(false);
    });

    it("extractReportBlock: labeled fence, unlabeled json fence, or none", () => {
      expect(extractReportBlock("```agent-report\n{\"a\":1}\n```")).toBe('{"a":1}');
      expect(extractReportBlock("x\n```json\n[{\"a\":1}]\n```\ny")).toBe('[{"a":1}]');
      expect(extractReportBlock("no fence here")).toBeUndefined();
    });
  });

  it("writes the log at a NESTED logFile, creating the parent dir (the live .sftdd/ path)", () => {
    // The live-run block: the declared agent-log path is nested (.sftdd/agent-log.jsonl) and
    // writeFileSync does not create intermediate dirs. The formatter must mkdir the parent, or
    // the write throws and validate-outputs never finds the log – wrongly blocking the turn.
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ message: "wrote it" }));
    const r = formatAgentReport({ workspaceDir: ws, role: "spec-author", logFile: ".sftdd/agent-log.jsonl" });
    expect(r.ok, r.error).toBe(true);
    const p = join(ws, ".sftdd/agent-log.jsonl");
    expect(existsSync(p)).toBe(true);
    expect(existsSync(dirname(p))).toBe(true);
    expect(existsSync(join(ws, "agent-log.jsonl"))).toBe(false); // NOT at the root
  });

  it("appends to an existing agent-log.jsonl rather than clobbering it", () => {
    writeFileSync(join(ws, "agent-log.jsonl"), JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", level: "info", role: "orchestrator", event: "phase.start", message: "prior" }) + "\n");
    writeFileSync(join(ws, ".agent-report.json"), JSON.stringify({ level: "info", event: "artifact.written", message: "new one" }));
    formatAgentReport({ workspaceDir: ws, role: "spec-author" });
    const lines = readFileSync(join(ws, "agent-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).message).toBe("prior");
    expect(JSON.parse(lines[1]).message).toBe("new one");
  });
});
