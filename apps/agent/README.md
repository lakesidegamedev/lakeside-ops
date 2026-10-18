> For an independent installation, start with the [root README](../../README.md).
> This document describes the legacy Lakeside studio deployment.

# lakeside-operator (Keir)

**[Latest release](https://github.com/lakesidegamedev/lakeside-ops/releases/latest)** · [All releases](https://github.com/lakesidegamedev/lakeside-ops/releases) · [Changelog](CHANGELOG.md)

Keir is the standing AI operator for A House Divided: the Discord support desk,
the `/summon` edge, the owner DM inbox, and since 4.0 the shared Lakeside agent
harness that routes subagents for any Lakeside work. This component now lives in the public `lakesidegamedev/lakeside-ops` monorepo.
Anything that touches the public game repository (`lakesidegamedev/AHDGame`) goes
through pull requests Keir opens there.

## What runs

| Unit | Entry | Role |
|---|---|---|
| `keir-operator` | `operator.js` | Durable owner operator and support desk: tickets, owner commands, decisions, publishing, releases |
| `keir-summon` | `server.js` | Discord `/summon` edge, forwards pokes to the operator |
| `keir-inbox` | `inbox.js` | Owner DM inbox and reward claims (ops dashboard `/inbox`) |
| `keir-shadow-rs.timer` | `rust/bins/keir-shadow-rs` | Rust harness shadow pass every ten minutes, published to the ops dashboard |
| `lakeside-agent` CLI | `rust/bins/lakeside` | Raw task harness; root `lakeside` is the product setup/client CLI |

The live Keir hub is an ops dashboard page, `/keir` (LSGD-ops-dash `keir-hub-*.js`), reading this operator's ledger, usage log, harness database and shadow report.

All units run from a pinned release under `/opt/keir/current` (Node) and
`/opt/keir/bin` (Rust). Merging to `main` changes nothing live until a release is cut.

## Architecture (4.0)

- **Node operator** (`operator.js`, `lib/operator/*`): owns job, ticket and effect
  state (`ledger.json`), the tool broker and its policy, receipts, the publisher,
  the status card, decisions, admission lanes. Models never get authority from
  text; every external effect needs a receipt.
- **Rust harness** (`rust/`): `harness-core` (blast radius classes, status truth,
  task graph, routing with provider capabilities and data classes, outcome labels,
  metrics), `harness-store` (ledger and event-sink readers, `harness.db`, MCP
  client), `harness-runner` (per-attempt loopback MCP endpoint, tool backends,
  subscription CLI invocations, traces, admission), `keir-shadow-rs`, `lakeside`.
- **Runner split**: subscriptions only, so each provider CLI (Claude, Codex, Muse,
  Antigravity) owns its model loop with built-in tools off; the harness serves the
  tools over a loopback MCP endpoint and keeps the trace. `KEIR_RUST_RUNNER_LANES`
  decides which operator lanes execute through `lakeside activation`.
- **Gates in code, not in the brief**: blast radius hold for economy promotions,
  status words bound to receipts, player register filter, ticket post shape,
  blocked-on-owner silence, monologue cap, Jev intake tagging and post screening.

`KEIR.md` is the model brief. `docs/OPERATOR.md` is the operator design note.
Runbooks, plans and incident notes live in ops-knowledge, never here.

## Layout

```
operator.js  server.js  inbox.js   entry points
lib/operator/                     broker, agent, providers, publisher, gates, decisions, store
lib/inbox/                        inbox ingestion and discovery
test/                             node:test suites (KEIR_JEV=off, no network)
rust/                             Cargo workspace: crates/{harness-core,harness-store,harness-runner}, bins/{keir-shadow-rs,lakeside}, deploy/
deploy/                           release.sh, install.sh, systemd units and env examples
bin/                              operator scripts (handoff, scores, lessons)
assets/                           chart fonts and marks
```

## Develop

```
npm test                                  # Node suites, Jev off, no network
cd rust && cargo test                     # Rust suites
```

Work in a registered worktree under `worktrees/`, never on the main checkout.
Conventional commits. Feature PRs add lines under `## Unreleased` in
`CHANGELOG.md`. At release time, `bin/keir-cut.js` moves those lines under a
version heading and updates the Node and Rust manifests together.

## Release

```
deploy/release.sh origin/main --stage     # build and test apps/agent only; leave current unchanged
deploy/release.sh origin/main             # enforce train gate, tag keir-vX.Y.Z, publish, repoint current
systemctl restart keir-operator           # (and keir-summon / keir-inbox when their code changed)
rust/deploy/build.sh                      # build and pin the Rust binaries, install the CLI
deploy/release.sh --rollback              # point current back at the previous release
```

New monorepo versions use `keir-vX.Y.Z` tags and GitHub releases whose notes are their
`CHANGELOG.md` section (`bin/release-notes.js`). Name the version in
`package.json`, `rust/Cargo.toml` and the changelog heading before releasing;
`release.sh` refuses a mismatch.
Each immutable release includes `SOURCE.json` with its canonical repository,
commit and component. Run heavy build/test commands through the shared check
scheduler on the production host.

Owner rulings: the 4.0 build shipped at build pace; from the cutover on, a weekly
release train, nothing ships the day it is written, one shadow day per release.

## Configuration

`/etc/keir-operator.env` (see `deploy/keir-operator.env.example`). The ones that
change behaviour most: `KEIR_WORKER_PROVIDER`, `KEIR_QUICK_PROVIDER`,
`KEIR_CODING_PROVIDER`, `KEIR_RUST_RUNNER_LANES`, `KEIR_RUST_RUNNER_TICKETS`,
`KEIR_JEV`. Secrets are never committed.

Cursor CLI activations can use `cursor:auto`. Each activation links the host's
Cursor CLI login into a private temporary home, exposes only that task's Keir
broker MCP tools, and denies local shell, file and web tools. Cursor login is
host-managed (`cursor-agent login`); do not put Cursor credentials in this file.

## Concurrency and usage

Keir has three dedicated coding slots and three investigation slots. Two chat
slots, an owner slot, Watchkeeper and engineering have separate capacity.
Investigations do not borrow coding slots. Work-record locks, staff claims,
approvals and owner holds still apply. The Rust runner shares eight background
host slots with other external workers and reserves one additional host slot
for conversation. Memory admission still applies. A busy host waits and retries;
a reserved slot cannot guarantee provider availability or response latency.

`node bin/keir-usage.js [usage.jsonl] [hours]` reports measured tokens and
approximate API-equivalent USD by provider/model and task. The authenticated
admin endpoint `GET /v5/usage` reports the last 24 hours plus live lane occupancy
and queue counts. It requires the operator admin bearer token. Neither surface
includes prompts or secrets.

API-equivalent estimates use a dated exact-model rate table with source URLs.
They are scenarios for standard text-token API pricing, not subscription bills.
Cache counts are normalized by provider; missing usage and unknown models remain
explicitly unpriced. The upper scenario allows OpenAI long-context premiums and
unknown Claude cache TTL. It excludes service-tier/regional premiums, tools,
audio and cache storage. Update and verify the rate table when prices change.
Old Rust Claude records omitted cache creation and are left unpriced; new
records retain it. Muse currently supplies no normalized token usage.

Task finishes are recorded separately from activations and child finishes.
They are not evidence of a deployed feature or a resolved support ticket.
Concurrency is capacity; compare equal time windows and delivered outcomes
before claiming a throughput improvement.

## Work queue and wait reviews

Activity uses the authenticated app `/work` projection. Studio support tickets
come from an open-only source with freshness and completeness indicators. All
live owner tasks remain in `/tasks`, independently of the recent-history limit.
Parent/child state, ownership, decisions and uncertain outcomes have distinct
labels. A finished task cannot close an open ticket by implication.

A checkpoint may supply `completionMinutes` plus `estimateBasis` for a credible
whole-task forecast. It is labelled as a worker estimate and cannot extend a
deadline or reset wait age. Unknown delivery times remain unknown. Scheduled
checks, task deadlines and delivery estimates are separate fields.

Wait reviews persist their age across timer wakes and text-only checkpoints.
After one hour without material progress, or five minutes after an estimate
expires, a safe waiting task receives one diagnostic wake per progress change.
Claims, uncertain effects and real owner decisions remain held. The queue shows
overdue reviews; recovery is not a claim of successful external delivery.

## Private app attachments

The authenticated owner app accepts up to six images, PDFs or UTF-8 text files
per message, at most 10 MB per file and 20 MB total. Images become metadata-free
JPEGs bounded to 2048 pixels. Upload bytes live in the private state directory,
never the repository. Descriptors bind the saved digest, owner, conversation and
source message. Only the owning task and its delegated children can inspect them
through `view_attachment`; file text cannot approve actions or alter policy.

PDF inspection requires Poppler (`pdftotext` and `pdftoppm`) and `prlimit` on the
agent host. Install `poppler-utils` on Debian/Ubuntu. PDF extraction renders one
selected page, bounded to pages 1-40, a 12 second timeout and 512 MB address space.
Text tool results are capped at 40 KB. Missing PDF utilities return an explicit
inspection error; image and text uploads continue to work.

Pending uploads expire after 24 hours; inactive sent files expire after seven
days. Cleanup runs on new uploads and preserves evidence for active jobs and
children. The private upload store is capped at 512 MB. Attachment endpoints
require the same owner session as chat and return `Cache-Control: no-store`.

Independent portal installations supply up to six recent task attachments to the
configured worker as bounded untrusted evidence. Images use private temporary
model inputs that are deleted after the attempt. Standalone mode supplies only
the first PDF page and explicitly labels that limit; the full operator can
request individual pages through the source attachment tool. Uploaded data is
classified as private operations data for native provider privacy checks.

## Common model execution boundary

Operator activations, text helpers and private reflection enter the headless
Lakeside Code runtime through `lib/operator/cli-runner.js`. Provider adapters
live in `apps/cli/headless`; old operator module paths are compatibility imports.
Immutable releases bundle the runtime under `cli-runtime`, so production never
imports a mutable checkout. OpenCode executes OpenCode and Ollama Cloud routes.
Other subscription routes retain their selected model and authentication.
Existing Rust lane settings select a compatibility transport inside the CLI.
Task state and authorization remain in the operator and broker.
