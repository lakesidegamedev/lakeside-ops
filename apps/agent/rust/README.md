# Keir 4.0 Rust harness

The shared Lakeside agent harness, new in this repository (the earlier
lakeside-code crates were judged a failure and are not reused). Plan and
amendments live in ops-knowledge: `keir-40-rust-harness-plan-2026-10-14`,
`keir-40-rust-harness-plan-v2-audit-2026-10-14`,
`keir-40-plan-v3-transcript-evidence-2026-10-14`.

- `crates/harness-core`: pure domain, no I/O. Blast radius, status truth, task
  graph, routing, outcome labels, metrics.
- `crates/harness-store`: ledger and event-sink readers, `harness.db`, MCP client.
Build and pin: `rust/deploy/build.sh` installs `/opt/keir/bin/lakeside.<sha12>`
and repoints `/opt/keir/bin/lakeside`.

Owner rulings baked in: subscriptions only (CLI-hosted model loop, harness-owned
tools), no simulation gate, routing seeded from owner directives, player personal
data never to a training-tier provider, the 4.0 build ships at build pace and the
weekly release train starts after cutover.
