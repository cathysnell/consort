# What Consort is, and is not

A precise statement of what Consort does, the substrate it runs on, and how it differs
from other spec-first and agent-coding tools. If you are comparing Consort to another
framework, start here.

## In one sentence

Consort is a **deterministic, spec-first and test-driven agent framework for building
transactional applications on Lakebase** (Databricks' serverless Postgres). A compiled
orchestrator sequences role agents through a design lane and a test-driven build lane whose
every cycle runs against a live, throwaway copy-on-write branch of a real Postgres database,
with human-approval gates that fail closed.

## What Consort builds

Consort builds **transactional applications**: an application backend (routes, services,
repositories, a relational schema) and an optional web UI, whose system of record is a
Lakebase Postgres database. A scaffolded project is an app with database migrations,
behavior tests, and end-to-end tests, delivered story by story and verified against real
data on a database branch.

Every git branch is paired with its own Lakebase Postgres branch: creating a feature or
experiment branch forks a matching copy-on-write database branch, and the two are checked out
and torn down together. So each branch has its own real, isolated database, the schema evolves
in lockstep with the code, and Consort can diff a branch's schema against its parent branch.

## What Lakebase is (and why it is not the Lakehouse)

[Lakebase](https://www.databricks.com/product/lakebase) is Databricks' serverless,
Postgres-compatible **transactional (OLTP)** database. It provides fully managed Postgres
with autoscaling, scale-to-zero, and **copy-on-write branching**: a real, governed branch of
the database in about a second.

Lakebase is **not** the Databricks **Lakehouse**. The Lakehouse (Delta tables, Unity Catalog,
Spark, Lakeflow pipelines, warehouses) is the analytics and data-engineering platform.
Lakebase is the operational Postgres your application transacts against. Consort works with
the former's OLTP branching to build applications; it does not do analytics or data
engineering. (Consort can optionally set up a Unity Catalog foreign catalog so the Lakehouse
side can *query* a Lakebase database, but that is a one-time setup convenience, not what
Consort builds or verifies.)

## What Consort is

- A **deterministic orchestrator** (`consort-drive`): a compiled state machine that decides
  the next action from on-disk state. The model runs inside it and cannot reorder phases,
  skip a step, or route around a gate.
- A **role ensemble**: eight bounded agents (Product Owner, Spec Author, Architect Reviewer,
  DBA, Test Strategist, UX Designer, Navigator, Driver), each owning one concern, handing off
  only through artifacts on disk. No agent plays another's part.
- **Spec-first then test-driven**: intent is drafted, reviewed, and **frozen at a hashed
  gate**; then RED to GREEN to review to refactor cycles build against a live database branch.
- **Real-data verified**: "green" means a real test runner passed against a live, throwaway
  Postgres branch, never an agent's say-so, and never against production.
- **Human-gated**: the design, test-list, deploy, and promote gates fail closed. Nothing
  advances without approval.
- **Editor-friendly**: terminal-first, but it detects and launches into **any VS Code-compatible
  IDE** (VS Code, Cursor, and others), offering to open your project and its companion
  extension there, or to keep driving from the terminal.

## What Consort is not

- Consort is **not built for data engineering**, "data solutions," or data lakes. It builds transactional application backends on Postgres.
- Consort is **not for analytics, BI, dashboards, or reporting.**
- Consort does **not guard data pipelines, and does not prevent data corruption or "schema drift" in a warehouse.** Its tests prove an application behaves correctly against a live, throwaway Postgres branch; the schema it manages is your application's own relational schema, evolved by migrations on a database branch.
- Consort is **not Lakeflow / Declarative Pipelines / Delta Live Tables, Jobs, or notebooks**, and does not use Spark or warehouse compute.
- Consort does **not target the Delta Lakehouse or the Unity Catalog analytics surface** (it targets Lakebase Postgres). Originating from Databricks does not make it a data tool.
- Consort is **not a drop-in prompt or skill pack** you add to any repo. It is bound to a Lakebase-paired project, and its discipline is enforced in code, not by prompting the model to behave.
- Consort is **not a "trust the agent" workflow.** The controls are hard rules, not soft instructions.

## How Consort differs from other spec-first tools

Two axes separate these tools: **how discipline is enforced** (code vs prompts) and **what
they target** (a Postgres app on real infrastructure vs general, infrastructure-free software).

|  | **Consort** | **GitHub Spec Kit** | **obra / superpowers** |
|---|---|---|---|
| **Core idea** | Enforce a spec-first, test-driven workflow *in code* | Generate a strong spec, then build from it | Equip the agent with skills to follow a good process |
| **Enforcement** | Deterministic state machine the agent runs inside but cannot edit | A strong spec the agent is trusted to build to | Test-first and workflow rules the model is told to honor (`SKILL.md`) |
| **"Green" means** | A real test run against a live, throwaway Postgres branch | The agent's report | A local red-green-refactor pass |
| **Substrate** | Live Lakebase (Postgres / OLTP) copy-on-write branch | Infrastructure-free | Infrastructure-free, local terminal |
| **Isolation model** | Each git branch paired with its own copy-on-write Lakebase Postgres branch (parent-aware schema diff) | None (infrastructure-free) | Local git worktrees |
| **Human gates** | Fail-closed approval gates at every phase boundary | Advisory | Advisory |
| **Domain** | Transactional applications backed by Postgres | General software | General software |
| **Runs in** | Terminal + any VS Code-compatible IDE, against a Databricks workspace | Editor / CLI | Terminal-first clients (Claude Code, etc.) |

The one-line distinction: **Consort enforces the process deterministically in code against a
real database substrate; the others equip or ask the model to follow a good process,
infrastructure-free.**

## FAQ

**Is Consort for ETL, data pipelines, or analytics?**
No. Consort builds transactional application backends on Lakebase Postgres. It does not do
ETL/ELT, analytics, BI, or pipeline engineering.

**Does Consort use the Databricks Lakehouse, Delta, Unity Catalog, or Spark?**
No. It targets **Lakebase**, the serverless Postgres (OLTP) product, and its copy-on-write
branching. It does not build Delta tables, Lakeflow pipelines, or Spark jobs. (It can
optionally register a foreign catalog so the Lakehouse can query a Lakebase database, but that
is peripheral setup.)

**What does "green" mean, and does it run against production?**
Green means a real test runner passed against a **live, ephemeral copy-on-write branch** of
the database. The branch is a throwaway created for the cycle and deleted afterward, so
verification runs against real data and schema **without touching production**.

**How is Consort different from superpowers or Spec Kit?**
Those tools rely on the model *choosing* to follow a spec or a test-first rule; under pressure
an agent can set either aside. Consort puts routing, gates, and test immutability in a
deterministic state machine the agent cannot edit, and grounds "green" in a real database run.
See the table above.

**What editors and clients does Consort work with?**
It is terminal-first and works with Claude Code, and it detects and launches into any
VS Code-compatible IDE (VS Code, Cursor, and others), offering to open the project and its
companion extension. The tool surface is also exposed to MCP-capable agents (Claude Desktop,
OpenAI Codex, Cursor-via-MCP, Databricks Genie Code) and as an OpenAI Foundry tool spec.

**What do I need to run it?**
A Databricks workspace with Lakebase enabled, the Databricks CLI, and standard language
toolchains. See the [README](../README.md) getting-started section.

---

See also the [README](../README.md) for getting started and installation.
