# Keir private owner supervisor

The owner's own conversation with a coding-capable model, served by the ops web
server at `/api/keir/supervisor/*`. It does not use the Keir support operator for
chat, source work or approvals, so it keeps working while the operator is down.

## Pieces

| File | Role |
|---|---|
| `routes.js` | HTTP routes, owner-only auth (same owner identity as `/api/keir/app/*`), CSRF rules, env wiring. |
| `supervisor.js` | Durable job runner, model tools, crash and restart recovery, digest-bound proposals, publisher. |
| `store.js` | One state file written with fsync and rename; old transcript lines spill to an archive file. |
| `executor.js` | Headless Claude Code with all built-in tools off, a throwaway HOME and HOME/PATH/LANG only. |
| `toolserver.js` | Loopback MCP endpoint, one unguessable path per job. |
| `sandbox.js`, `sandbox-tool.js` | Bubblewrap workspace: no network, empty env, only the workspace writable; file operations run inside it. |
| `repos.js` | Fixed repository allowlist. Clients and the model pick a key, never a path. |
| `ticket-commands.js` | `ticket_command` and `retry_ticket`: ticket changes the owner asks for, handed to Keir's operator (below). |
| `owner-words.js`, `ownercopy.js` | What the owner reads: no "with the developers", no "my ticket access is read-only", ET times, no internal ids. `ownercopy.js` copies the operator's helpers; `ticket-commands.test.js` keeps them identical. |
| `studio-evidence.js` | Read-only `ticket_evidence` (one numbered support record: chronology, actors, verified channel delivery, what it cannot prove) and `game_health` (the phone game card's facts). Reads go through the ops web MCP client with this host's credentials; the model picks a ticket number or game id only. The game part copies `apps/agent/lib/operator/appgames.js`; `apps/agent/test/appgames-web-parity.test.js` keeps them identical. |

## Behaviour

- Each owner message is a job persisted before the response. Jobs run one at a
  time in the web process and survive the phone disconnecting.
- A web restart or model crash keeps the workspace, saves its diff as a patch
  and resumes the job once from that state; a second stop reports honestly.
- `clientId` replays return the original message and job, across restarts.
- The model can only propose publishing. `POST /proposals/<id>` with the exact
  patch digest is the only approval path; chat text never is. Publishing is off
  unless `KEIR_SUPERVISOR_PUBLISH=1`, and then pushes one branch and opens a PR
  from a fresh clone. It never merges or deploys.

## Ticket changes go through Keir's operator

The owner can ask this chat to open an incident, merge tickets (into an incident
or another ticket, adding each reporter), close, reopen or add a person, and to
retry a stalled ticket. The supervisor never changes a ticket itself:

- It posts one structured command to the operator's app server
  (`POST /api/keir/app/ticket-commands` on `KEIR_APP_BASE_URL`, loopback only)
  with the owner's own `ops_session` cookie from the request that created the
  job, the same channel side chats use. The operator checks that cookie against
  the ops dashboard itself and runs the command through its `ticket_command`
  (authority, batch limits, confirmation, effect journal, records). The cookie is
  held in memory per job, never written to the state file; a job resumed after a
  restart sends nothing and asks the owner to resend.
- A command is sent only when the owner's own message in that job asks for that
  kind of change (`ticket-commands.js` `INTENT`; a short "yes" also reads the
  owner's previous message). Ticket text and tool output never count.
- A confirmation the operator asks for is shown with a six-character code bound
  to the operator's digest of the exact list; only an owner message carrying the
  code sends it back, once, within an hour.
- Each command has a stable id kept in `state.json` (`ticketCommands`) before it
  is sent, so a retry, a timeout or a resend after a restart reuses it and the
  operator does nothing twice. Opening an incident for the same tickets within a
  day is the same command whichever message asked.
- Retry uses the operator's `GET /tickets/<n>` and `POST /tickets/<n>/retry`
  (the app's Retry button) with every hold the operator applies.

`KEIR_SUPERVISOR_TICKET_TIMEOUT_MS` (default 90000) bounds one command.

## Configuration

`KEIR_SUPERVISOR_DIR` (required, absolute), `KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE`
or `PROJECTS_ROOT`, `KEIR_SUPERVISOR_MODEL`, `KEIR_SUPERVISOR_EFFORT`,
`KEIR_SUPERVISOR_PUBLISH`, `KEIR_SUPERVISOR_OWNER_IDENTITY` or `KEIR_OWNER_ID`,
`KEIR_GUARDIAN_DIR`, `KEIR_SUPERVISOR_CLAUDE_BIN`. Without `KEIR_SUPERVISOR_DIR`
the routes answer `503 {configured:false, missing}` to the owner.

## Approval push alerts

A new pending proposal can raise one required-attention push on the owner's
registered iPhones. Both services need the same explicit absolute directory in
`KEIR_APPROVAL_ATTENTION_DIR` (this web service writes it, the Keir operator
reads it). It holds one tiny file per proposal with only the proposal id, a
`pending` or `closed` state and timestamps: no chat, title, summary or patch, and
it lives outside `KEIR_SUPERVISOR_DIR`. The push is sent by the operator's
existing authenticated device and APNs path, honours each phone's quiet hours and
notification settings, goes once per proposal, is dropped if the proposal is
decided, superseded or older than 72 hours before it is sent, and deep links to
that exact proposal. It never approves anything and has no lock-screen actions.
Model progress updates never push. If the operator is down the files wait; if no
Apple provider is installed, `GET /api/keir/app/notifications` reports
`approvalAlerts.problem`. Leave the variable unset and nothing is projected; the
in-app proposal card works as before.

Requires `/usr/bin/bwrap` and a signed-in Claude Code for the service account;
`GET /status` reports both. Tests that need bubblewrap skip with the reason when
it is unavailable.
