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

## Configuration

`KEIR_SUPERVISOR_DIR` (required, absolute), `KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE`
or `PROJECTS_ROOT`, `KEIR_SUPERVISOR_MODEL`, `KEIR_SUPERVISOR_EFFORT`,
`KEIR_SUPERVISOR_PUBLISH`, `KEIR_SUPERVISOR_OWNER_IDENTITY` or `KEIR_OWNER_ID`,
`KEIR_GUARDIAN_DIR`, `KEIR_SUPERVISOR_CLAUDE_BIN`. Without `KEIR_SUPERVISOR_DIR`
the routes answer `503 {configured:false, missing}` to the owner.

Requires `/usr/bin/bwrap` and a signed-in Claude Code for the service account;
`GET /status` reports both. Tests that need bubblewrap skip with the reason when
it is unavailable.
