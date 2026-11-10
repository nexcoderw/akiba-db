# Mandatory Agent Instructions

Every automated agent working in this repository MUST read `.agents/README.md` and every rule it
marks applicable before editing files. The rules under `.agents/` are mandatory and take precedence
over generic agent defaults. Human instructions take precedence over repository rules.

This repository exclusively owns Akiba database schemas, migrations, generated Prisma Client,
and database package APIs. It must not acquire controllers, HTTP endpoints, authentication flows, or
inventory business workflows. Agents must never install dependencies, generate Prisma artifacts, run builds,
formatters, linters, tests, migrations, servers, Git writes, or package publication. Prepare exact
commands for a human instead. See `.agents/agent-workflow.md` for the complete restriction list.
