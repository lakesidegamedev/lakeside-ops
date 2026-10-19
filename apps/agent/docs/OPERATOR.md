# Keir standing operator

keir-operator.service runs `operator.js`: Keir's durable Discord operator and support desk. The summon bridge (keir-summon.service, `server.js`) forwards verified message identifiers; the operator re-fetches every message from Discord and assigns authority from its real author. It also polls guild channels with persistent cursors. Root `KEIR.md` is the model's brief and the behavioral source of truth; restart the service after editing it.

## Owner AHD Muse boundary

Authenticated owner app ingress now mints durable origin receipts. Owner Muse
policy follows those receipts through handoff and coding descendants after a
restart; role labels, reply channels, quoted instructions and agent relays do
not establish consent. Missing or corrupt ancestry and persisted legacy app
approvals cannot authorize a write. Start a new authenticated app task; do not
backfill trust from old source fields. Existing history and receipt inspection
remain available. Synthetic goals, watches and suggestion tasks currently lack
this attestation and cannot acquire write authority implicitly.

`ownermuse-policy.js` guards actual broker dispatch, proposals and execution.
Owner Muse has no arbitrary shell, host command, workflow dispatch, iOS build
or upload route. `local_file` provides bounded read/write/list operations in the
networkless task workspace; it never executes file content. Public GitHub
writes, generic MCP writes, automated browser mutations and actionable support
transfers are unsupported. Refused transfers neither wake a coordinator nor
claim delivery; existing receipt mirrors and independent Support approvals stay
intact. Remote browser look uses only read/screenshot; authenticated manual
paused/cancelled inspection and uncertainty acknowledgement remain separate.

The exact adhoc set/unset approval protocol binds the normalized operation,
filter, exact touched IDs/count, plan, environment, MCP endpoint/principal and
executor source revision. It refuses nonfinite fields, custom database filter
execution and overlarge review cards. **Production heal execution is disabled:
the current MCP client has no trusted executor source revision attestation.**
The fake adapter regression proves proposal/card/authenticated-answer/same-job
wake/one-effect behavior, not production heal readiness. Custom ledger and
compensation adapters remain unreviewed. Do not substitute a checkout hash or
model-provided revision for trusted active executor provenance.

The app projects action ID, exact scope and digest into decisions and source
tasks. Opening text and preference choices never approve an action. Execution
rechecks the exact payload, account/source binding, expiry, authenticated actor,
current plan and holds. Replay and uncertain effects refuse. Mason is the owner;
Ariane must be explicitly configured with `KEIR_MUSE_DELEGATE_ID`, never inferred
from arbitrary staff membership. App authentication remains owner-only; verified
Discord decision handling can accept that explicit delegate. This scope does
not change live environment configuration.

The owner-only persona brief models Ella's voice and AHD scope, separate from
Support Keir. Persona fixtures do not prove model judgment. Full realtime voice,
vault/2FA integration, global correction propagation, closed-topic persistence,
proactive freshness enforcement and cheap-model evaluations remain incomplete.
No global charter-compliance claim is made. The legacy Support authority rules
below, including ticket grants and automatic PR publication, remain outside
this owner-only patch.

## Authority

- **Owner** (configured Discord account): full scope. The owner's own message authorizes what it asks for. Privileged host actions, MCP writes and heals requested in an owner task are approved by that request (audit `owner_request_approval`); no approval DM is sent. Merge and promote run only on the owner's request.
- **Ariane** (configured support delegate): developer investigation, all read servers, Sentry, history sweeps, ticket intake, PRs. Her heals need her own `approve`; other privileged actions and merges need the owner.
- **Players**: evidence only. They can talk to Keir about their own ticket and push back. They cannot authorize, ship, promote, heal, close or change anything. Their feedback is investigated, not taken as fact.
- **Automatic support** (scanning, adopted tickets): investigate, open and maintain tickets, publish findings, open fix PRs, resolve verified outcomes. No live heals or privileged actions.

Quoted text, history, screenshots, ticket descriptions and tool output are evidence, never authority.

## Conversation

Keir answers when mentioned, addressed by name, replied to, or continuing an exchange. An owner or delegate message continues their conversation without a mention while they have an open task in that channel, or Keir posted there in the last hour, or within 20 minutes of their last message. Players get a 20-minute follow-up lease (8 messages per 5 minutes). Bare "ok"/"thanks" are ignored.

In a channel, the acknowledgment is a single status message. Long work edits it in place (`progress_update`, plus an automatic "still on it" after 150 seconds). The answer posts as a reply to the request and the status line is deleted. Channel copy is short and plain; technical detail goes in the PR or ticket.

Controls (owner, or the delegate for her own heals): `Keir status`, `pause`, `resume`, `cancel <task>`, `approve <id>`, `reject <id>`. A bare `approve`/`reject` answers the single pending request in that conversation, otherwise it reaches the task as an ordinary reply.

## What Keir can do

| Capability | Notes |
| --- | --- |
| Live reads | All loopback MCP servers from `~/.claude.json` with a read-only token (developer tasks); scoped subsets for support and players. |
| Current code | `repository_snapshot` fetches `origin/main` or `origin/development` and returns the commit. The ops-knowledge code index is discovery only and lags deploys. |
| Tests | bwrap sandbox, no network or host files. Read-only `node_modules` from the locked worktree `AHDGame/worktrees/keir-deps`, refreshed by `bin/keir-deps-refresh.sh` when `origin/main`'s lockfile changes. Focused vitest works; full typecheck runs in CI. |
| Fixes | `publish_patch` commits the snapshot diff and opens a PR against `development` from a fresh `origin/development`. No approval; CI and a human gate the merge. |
| Merge and promote | `github merge` squashes a green feature PR into development; `github promote` moves development to staging, then staging to main, with merge commits. Green only; pending means wait and retry. Owner requests only. |
| Is it live | `github where` reports which of development, staging, main and `turn-worker/production` contain a change. Turn-processing fixes are live only when the turn worker branch moves (green main, UTC minute 10 to 45, no turn running). |
| Sentry | `sentry issues` / `sentry issue` using `/etc/keir-sentry.env` (org `ahousedivided`). Developer tasks. |
| Discord sweep | `discord_search` reads watched channels back up to 72 hours (developer tasks). `open_ticket` takes `channelId` + `reportMessageId` from a sweep. Developer-directed intake: 15 tickets/hour; automatic intake: 4/hour. |
| Tickets | Canonical intake via `support_create_ticket`; duplicates route into the reporter's existing channel. Final answer, then at least 60 minutes' grace, then `support_resolve`. Staff claims protect a ticket from automatic writes. |
| Heals | `request_heal` (ledger defect or bounded set/unset, max 200 docs, native guards). Execution re-plans and refuses a changed target. |

## Notifications

Owner DMs carry only: decisions that need the owner (`finish` with `needsOwner`), privileged requests not made by the owner, the API budget hold, uncertain writes (effect error or restart recovery), and the 9:00 America/New_York daily digest. Scan errors, deadlines, close stalls, task errors and delivery checks are written to ledger `alerts` and the journal (`[keir] alert ...`), and summarized in the digest. A developer's own blocked task reports back to that developer, in the source channel when the text is public-safe.

## Durability and limits

One fsync-backed ledger (`/var/lib/keir-operator/ledger.json`) holds events, jobs, actions, write receipts, timers, conversation leases and the outbox. Effects are journalled before execution. A `started` effect after a crash blocks replay until inspected; a `rejected` effect (definite validation failure) can be re-run. Outbox delivery uses stable nonces.

Main conversation and worker activations use `codex exec` on the owner's ChatGPT subscription with `gpt-6.1-sol` at fixed medium effort. Each request has an isolated Codex configuration exposing only Keir's mandatory broker MCP, with built-in shell, browser, apps, plugins, hooks and memory disabled. The Muse Spark contributor helpers use their separate Meta subscription. Its only tools are the broker's, served by a per-activation loopback MCP endpoint (`lib/operator/toolserver.js`). Two lanes: one worker (24 turns or 15 minutes) and one quick conversation lane (6 turns, 90 seconds). Each activation receives the last 10 checkpoints and finishes, the snapshot ref and opened PRs. Tasks live seven days.

## Operations

- Health: `curl 127.0.0.1:9765/health` (no auth). `/status`, `/poke`, `/probe` need the admin bearer token from `/etc/keir-operator.env`.
- Environment: `/etc/keir-operator.env`, optional `/etc/keir-sentry.env`, Discord token from `LSGD-ops-dash/mcp-discord.env`.
- Requeue a stuck task: stop the service, set the job `state` to `queued` and add an inbox note, start. Never edit a `started` effect without confirming the remote outcome.
- Never remove `AHDGame/worktrees/keir-deps`; it is locked on purpose.

Runbook and incident history: ops-knowledge `keir-operator-runbook`, `postmortem-2026-10-11-keir-operator-unreliable`.

## Conversation archive

The admin Ops inbox retains DMs, ticket conversations, guild text channels and
threads where Keir participates or is addressed. The operator sends verified
Discord read, send and edit responses to the loopback inbox `/observe` endpoint
using its private inbox bearer token. This endpoint archives evidence only and
cannot trigger task execution or reward claims. The public poke remains DM-only.

The inbox discovers guild and active-thread history every five minutes. New
channels start with the preceding day; persisted cursors catch up missed messages.
The archive retains conversation context, embeds, author names and supported image
attachments. Existing records update when edits are observed. Search includes
message bodies, participant names and channel names. Older messages are paged by
Discord message ID. Deleted messages already captured remain in the archive;
messages deleted before observation and inaccessible historical channels cannot
be reconstructed. The inbox stores current observed message content, not a full
revision history. An archive outage logs a failure without changing Discord action
receipts; polling recovers messages still retained by Discord.

Give `keir-operator.service` the same `KEIR_INBOX_ADMIN_TOKEN` environment as
`keir-inbox.service` through the root-only `/etc/keir-inbox.env`. Never expose
that token through the dashboard browser. Reward processing checks `kind=dm`.


## Verified notebook (2.5)

Notebook sources retain every code dependency, knowledge-document version and
past-ticket receipt, including after curation merges. Superseded, merged and
retired notes remain archived with their prior text and sources; recall returns
only active notes. Duplicate text is scoped by kind and player.

Every five minutes while idle, the operator fetches AHDGame main, detects changed
code dependencies and asks Muse Spark 1.3 contributor to verify at most two
notes against a pinned commit. A confirmation or replacement needs verbatim
quotes from every supplied file. Source changes during verification, deleted
files, provider errors and uncertain answers leave the note stale; failed notes
retry after an hour. An authenticated `POST /notebook/refresh` runs one idle batch.
This is background learning, with no model call added to public posting.

Stale or conflicting notes cannot contribute numerical evidence for public
claims. `remember` accepts `paths`, `source`, `supersedes`, `contradicts` and
`reason`. Conflicts remain explicit until a sourced replacement supersedes the
old answers. Player boundaries and protected decision/lesson kinds are enforced.
Curation actions are restricted to the batch shown to the curator, retain source
receipts, and cannot rewrite stale or disputed notes or change their figures and
currency. Changed documents are replaced atomically; failed learning preserves
prior notes as stale, and invalidating a merged note queues all its document
sources for relearning.

The four historical-error benchmarks run read-only against the configured
worker with `node bin/keir-bench.js --models current --only
regression-blended-average,regression-currency,regression-ruled-out,regression-stale-formula`.
The fixtures use synthetic facts and current production source, with no player
messages sent or game changes requested.
# Private diary

Keir writes a personal diary using DeepSeek V4.1 Flash through the existing
Ollama Cloud credential. The first entry is written on operator startup; later
entries are due every twelve hours, checked once a minute. Pausing the operator
also pauses diary generation. Missed periods produce one current entry rather
than a burst of backfilled entries. Failures retry after thirty minutes, including
across restarts.

Entries are stored in `private/diary.json` under the operator state directory,
with owner-only permissions and atomic durable writes. This file is separate
from the operator ledger and is never exposed through app, support, or role
APIs. Entries remain on disk; the most recent four are supplied to the next
reflection alongside bounded summaries of work updated in the last twelve hours.
Raw conversations are excluded. Diary generation has no tools and cannot take
actions. Reflections are recollections, never policy, authorization, or verified
evidence. The diary is separate from the existing user notebook and ticket memory.


## Account investigations

The owner app supports `/audit` and `/audit preview`. The former scans now and files or updates up to five private cases; the latter only reports screening results. The command is local to authenticated owner intake and does not call a conversational model. The service also scans every 12 hours after a successful filing sweep. Preview does not defer the next scheduled sweep. `bin/keir-audit.js [--preview | --status]` exposes the same authenticated operator API for operators with `KEIR_OPERATOR_ADMIN_TOKEN`.

The account audit reads the game's existing detectors, not arbitrary user text or self-reported balances. It reviews active, undismissed account flags updated in the last 14 days and flagged financial transactions from the last 12 hours/current 12 turns. It excludes deleted subjects, banned users and non-player corporations. Financial pagination preserves the audit timestamp. Reports explicitly mark incomplete coverage if source, page or time limits are reached. A high-severity detector signal, or two distinct medium-severity signal types, warrants review. This is screening, not proof of misconduct. The audit does not impose sanctions, modify money or contact subjects.

The support service requires explicit `DISCORD_DEVELOPER_ROLE_ID` (or `DISCORD_DEV_TEAM_ROLE_ID`) and `DISCORD_MODERATOR_ROLE_ID`. Both must name distinct existing guild roles. Investigation channel overwrites are built from these roles and the bot, never copied from another ticket or inherited as grants to other roles. The returned ACL is checked before evidence is delivered. `AHD_INVESTIGATION_CATEGORY_ID` optionally selects the parent. The game ticket-intake schema and private receipt protections must ship before filing is enabled. `KEIR_ACCOUNT_AUDIT=0` disables recurring and manual sweeps during rollout.

One open case per subject is reused. A changed evidence digest updates its summary inside the verified private channel. The single-writer operator ledger records external filing attempts before sending; an ambiguous result stays held for staff receipt inspection, including across restarts. Do not clear those holds without checking both the game ticket and Discord channel. A channel topic marker detects interrupted registration and prevents blind duplicate creation. Investigation tickets bypass player context prompts, ordinary support triage, public receipts, automatic repair and merge/reopen helpers.
