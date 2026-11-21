# Keir private owner supervisor

Every chat the owner has with Keir in the iPhone app (the private home chat,
the support desk and side chats), served by the ops web server at
`/api/keir/supervisor/*`. Each chat is its own conversation (`thread`:
`owner-supervisor`, `main` or a side chat id); all of them are the same agent. Talking to Keir here works like the owner talking to
Claude Code as root on this box: a full Claude Code agent with every built-in
tool, every MCP server registered for the account, real credentials, real
network and a headless browser. There is no approval step, allowlist or
proposal flow. It does not use the Keir support operator for chat, so it keeps
working while the operator is down.

The one hard boundary is access: only the owner's signed-in admin session (the
same owner identity the Keir operator accepts for `/api/keir/app/*`) reaches
these routes, because they are reachable from the internet.

## Pieces

| File | Role |
|---|---|
| `routes.js` | HTTP routes, owner-only auth, CSRF rules, env wiring. `GET /attention` returns what needs the owner. |
| `supervisor.js` | Durable job runner, the chat's own tools, restart recovery, the brief. Old proposals stay decidable. |
| `executor.js` | Runs Claude Code with permissions skipped in its own transient systemd scope (memory cap), with the host's own settings, CLAUDE.md files and `~/.claude.json` MCP servers; stream-json progress; stop and the runtime cap kill the whole tree. |
| `owner-attention.js` | The one "needs you" function: Keir's pending decisions (valid task origin) and pending questions on open tasks, the same records and rules as the app badge (`apps/ios/Ops/Attention.swift`). Also a CLI (`node owner-attention.js`). |
| `files.js` | Owner-only files: the owner's uploads (`POST /uploads`, raw bytes with `X-Filename` and `X-Keir-Thread`) and files Keir attaches (`attach_file`), served from `GET /files/<id>`. Types are decided by the bytes. |
| `models.js` | The picker: Claude models and effort levels, chat keys. `GET /models?thread=` and `POST /models` save a choice per chat; a message may override it. |
| `et.js` | US Eastern time formatting ("12:08 PM ET") for everything the owner reads. |
| `render.js` | Renders a URL or HTML file to a PNG with the installed Playwright and Chromium, saved under the public preview directory, and prints its public URL. |
| `store.js` | One state file written with fsync and rename; old transcript lines spill to an archive file. |
| `toolserver.js` | Loopback MCP endpoint for the chat's own tools, one unguessable path per job. |
| `studio-evidence.js` | The ticket queue card (`support_queue`), one ticket's chronology (`ticket_evidence`) and the phone game card facts (`game_health`). |
| `repos.js`, `attention.js` | Kept for proposals made by the earlier read-only design (publishing and their push alerts). Nothing creates new proposals. |

## Behaviour

- Images and files the owner attaches are stored under `<dir>/files/<id>.<ext>`
  and listed in the job's prompt with their paths; the brief tells the model to
  open each with the Read tool, which shows it the image itself.
- The job runs with the chat's chosen model and effort (`--model`, `--effort`),
  or the service default.

- Each owner message is a job persisted before the response. Jobs run one at a
  time and survive the phone disconnecting. Progress shows as the job's
  `activity` line (the latest tool call) and as `post_update` messages.
- Each run is `systemd-run --scope -p MemoryMax=<cap> -p MemorySwapMax=0`, so a
  runaway job cannot take down the web service or the box. Stop (`POST
  /jobs/<id>/cancel`) and the runtime cap kill the process group and every
  process left in the scope.
- A web restart stops the old run's scope and resumes the same Claude Code
  session once (`--resume`); a second stop reports honestly. A model crash
  resumes once the same way. A timed-out job is not retried automatically.
- Every job's context lists what needs the owner from `owner-attention.js`, and
  the chat answers "what needs me" from its `owner_attention` tool, so the chat
  and the app badge cannot disagree.
- `clientId` replays return the original message and job, across restarts.

## Configuration

`KEIR_SUPERVISOR_DIR` (required, absolute), `KEIR_SUPERVISOR_MODEL` (default
`claude-opus-5-5`), `KEIR_SUPERVISOR_EFFORT` (default `high`),
`KEIR_SUPERVISOR_JOB_TIMEOUT_MIN` (default 60), `KEIR_SUPERVISOR_MEMORY_MAX`
(default `16G`), `KEIR_SUPERVISOR_CWD` (default `HOME`, so `/root` with its
`AGENTS.md`), `KEIR_SUPERVISOR_CLAUDE_BIN`, `KEIR_SUPERVISOR_SYSTEMD_RUN`
(empty runs without a scope, process group only), `KEIR_SUPERVISOR_OWNER_IDENTITY`
or `KEIR_OWNER_ID`, `KEIR_GUARDIAN_DIR`, `KEIR_LEDGER`. Render output:
`KEIR_RENDER_DIR` (default `/srv/ahd-public/keir-renders`) and `KEIR_RENDER_URL`.
For old proposals only: `KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE` or
`PROJECTS_ROOT`, `KEIR_SUPERVISOR_PUBLISH`, `KEIR_APPROVAL_ATTENTION_DIR`.
Without `KEIR_SUPERVISOR_DIR` the routes answer `503 {configured:false, missing}`
to the owner.

The model process gets a root login environment (HOME, USER, PATH, LANG,
`TZ=America/New_York`, `IS_SANDBOX=1` so Claude Code accepts skipped permissions
as root), not the web service's own secrets. Needs a signed-in Claude Code for
the service account; `GET /status` reports the executor, its memory cap and the
host MCP server names it will load.
