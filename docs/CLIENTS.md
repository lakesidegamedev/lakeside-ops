# Clients

## Desktop Keir app

```sh
npm --prefix apps/desktop ci
npm run desktop
```

Enter your portal's HTTPS origin, then sign in with your installation password.
The desktop app opens directly into Keir's conversation and task workspace.
Each origin has a separate persistent browser session. Remote content has no
Node integration, preload bridge or filesystem access. Navigation and redirects
stay on the selected origin. The local connect screen exposes only server
selection. Use the Keir menu to connect to a different installation.

Run the manual **Desktop Keir** workflow to package macOS, Windows and Linux
artifacts, or `npm --prefix apps/desktop run dist` on the target OS. These are
unsigned development distributions unless your own signing is configured.
The Windows job silently installs the NSIS executable into an isolated temporary
profile and exercises the installed app: connection, real standalone password
login, composer model search/selection, a fixture worker reply, retained history
and relaunch. `Keir-windows-smoke` contains the result and screenshot. This checks
the Windows binary and portal integration, not real studio SSO or provider quality.
The desktop workflow builds installers as workflow artifacts; publishing a
release is a manual step. Windows distributions remain unsigned; there is no built-in
updater. The installer connects to your Keir server, which must be running the
matching portal version to expose the latest controls.

## Discord

The port reuses Lakeside Operator's Discord REST transport and catch-up reader.
For an independent installation, configure these environment variables for the
process running `lakeside serve`:

```text
LAKESIDE_DISCORD_BOT_TOKEN=<your own bot token>
LAKESIDE_DISCORD_OWNER_ID=<your Discord user ID>
```

Store the token in a private service environment file outside the checkout,
readable only by the service account. Do not put it in Git, a command argument
or portal chat. Both variables are required to enable the connector. Your bot
and Discord account must be able to exchange DMs. The standalone connector uses
REST polling and needs no gateway or privileged guild message-content intent.

After the server connects, send your bot a new DM. Only the configured user's
messages in that bot's owner DM become tasks. Bots and webhooks are ignored.
The first connection skips old DM history; subsequent restarts resume the saved
cursor. Text requests and replies share a dedicated **Discord** thread visible
in web, desktop and iOS. Other portal threads are not forwarded to Discord.
Replies in the Discord thread, including replies to requests made in that
thread through the portal, are delivered to the owner DM.

Use `/tasks` to list recent Discord tasks and `/stop TASK_ID` to cancel one.
Task execution uses the same project, provider route and read/coding grant as
the portal. Replies have a durable outbox, per-part receipts, stable Discord
nonces for retries and disabled mentions. Discord deduplicates recent nonces;
a retry after a long outage can still duplicate a remotely accepted message.
Attachments, guild support tickets and studio approval buttons remain in the
existing Lakeside-mode operator; they are not enabled by this owner-DM port.

## iPhone and iPad

The native app needs Xcode 26 and XcodeGen. Copy
`apps/ios/project.local.example.yml` to `apps/ios/project.local.yml`, then edit it:

```yaml
include: project.yml
settings:
  base:
    OPS_SERVER_URL: https://keir.example.com
```

Then, from `apps/ios`:

```sh
swift scripts/icons.swift
xcodegen generate --spec project.local.yml
bash scripts/simulator.sh LakesideOps
```

Use your own bundle identifiers and signing team for distributing your build.
The app pins requests to your configured HTTPS origin and isolates Keychain
credentials for independent hosts. Standalone mode shows Keir instead of studio
service tabs. The existing Lakeside TestFlight workflow and secrets stay attached
to the canonical GitHub repository.

## Command line

For the local interactive coding client, see
[Lakeside Code](../apps/cli/README.md). Launch it with
`lakeside code /path/to/project`, or explore the terminal design with
`npm run code:preview`. It uses a pinned OpenCode engine and can inspect
configured PC/VPS peers or hand work to Keir. It does not require the portal
setup described below.

`npm link` installs the public `lakeside` command from the checkout.

```sh
lakeside init --project /path/to/repo --route provider:model@medium
lakeside doctor
lakeside serve
lakeside login --url https://keir.example.com
lakeside chat "Inspect the authentication module"
lakeside tasks
lakeside logout
```

Chat returns a durable job ID; use the portal or `tasks` to follow execution.
CLI sessions have the same seven-day expiry and logout revocation as browser
sessions. `--password-stdin` keeps secrets out of process arguments.

The lower-level harness is available through `lakeside agent`:

```sh
lakeside agent run --project my-project --prompt-file question.md --grant read --json
lakeside agent tasks
lakeside agent show ATTEMPT_ID
```

For coding, create a separate registered Git worktree, start with a clean tree,
and pass `--grant coding --cwd /path/to/worktree --role coder`. The actual diff
and execution trace are saved for review. Shell grants run with your Unix user's
authority. Worktree checks and command guards are not an OS security boundary;
use a dedicated account/container for untrusted code and do not expose secrets
to the worker environment.

## Keir controls

The native app, web portal, desktop shell and CLI share authenticated owner
controls at `/api/keir/app/controls`. Stop cancels all current tasks, revokes
pending actions and decisions, suppresses pending publications and aborts worker
process trees. Start enables new work; cancelled tasks remain cancelled.
Already dispatched external requests cannot be undone, and their receipts remain
available for inspection. Older servers show their existing controls until updated.

Provider settings distinguish conversation, work coordination, delegated coding
and delegated investigation. Each conversation can override configured defaults;
the task detail view also supports overrides for an individual task and its
children. Changes apply on the next activation. Running tasks display the actual
provider/model/effort, separately from the configured selection. Unavailable
selected routes fail explicitly instead of silently substituting another provider.

YOLO is off by default and scoped to a conversation. An authenticated owner can
enable it to skip approval prompts for supported action adapters. Each action is
still sealed to its exact target, operation and origin; the receipt records the
owner's grant. Disabling YOLO invalidates unused automatic approvals. It does not
add installation permissions, support unknown adapters or approve old proposals.

Installed skills can be selected by work type, including an empty selection or
restoring the installation defaults. Task detail shows skills used by the actual
activation. Skills are instructions, not additional capabilities.

Shared commands: `/stop`, `/start`, `/status`, `/model`, `/approval`, `/skills`,
`/tasks`, `/new`. For example `/model coding codex:your-configured-model@low`,
`/approval yolo`, `/approval ask`, `/skills coding none`, and
`/skills investigation default`. In the CLI use `lakeside stop`, `lakeside start`,
`lakeside model coding <route>` or `lakeside chat '/skills coding none'`.
Discord commands are owner-only text commands; they do not require new bot scopes.
Independent installations can list `available_routes` and per-work-type `routes`
in their agent configuration. Only configured routes are offered in clients.

Native presence follows runtime, approval, microphone and playback state, with
Reduce Motion, background animation suspension, haptics and VoiceOver labels.
Voice previews and speed are configurable; playback prefers premium, then enhanced,
then standard installed voices and removes Markdown syntax and code from spoken
replies. Download additional voices in iOS Accessibility settings. Speech playback
is local; dictation uses on-device recognition when available, otherwise Apple.
Voice quality and Bluetooth interruption should also be checked on a physical iPhone.

Lock Screen / Dynamic Island work status uses Live Activities. Server-side APNs
updates continue after the app backgrounds when Apple push is configured. Otherwise
status becomes explicitly stale after 90 seconds. Task content is never included.
The Home Screen widget launches chat, voice, activity or controls; it does not claim
to display a live server snapshot. Notification approval actions retain device
unlock requirements. Independent installations need their own Apple push configuration.

In the studio deployment the ops dashboard release serves the canonical portal
itself: `/keir/app`, `/portal.js`, `/portal.css` and `/api/portal/config` come
from `apps/web/portal` in the same release and use the same SSO session as
`/keir`. The Keir hub opens the chat and the chat links back to Ops, so there is
no separate `/opt/keir/portal` release or Caddy import to keep in sync.

An independent studio host that wants to publish the portal separately can still
copy `apps/web/portal/public/*` into an immutable directory under
`/opt/keir/portal`, add a public `config.json` containing `mode`, `auth` and the
configured HTTPS `loginOrigins`, and point `/opt/keir/portal/current` to it.
Import `apps/web/deploy/caddy/keir-portal.caddy` inside the existing Ops site.
Validate Caddy before reloading it. Keep the original `/api/keir/app/*` route and
its owner authentication. The public configuration contains no credentials.

### Conversational voice mode

The iPhone waveform button opens a dedicated voice screen. A short pause submits
what you said; Keir speaks its reply and resumes listening. Pause the microphone,
interrupt with the waveform, or end the conversation. Leaving the screen or
backgrounding the app releases audio. Voice transcripts remain in the selected
thread. Voice replies use Gemini 3.8 Flash at low effort by default in studio
mode, with existing explicit provider overrides respected. Coding and
investigation keep their own routes. `KEIR_VOICE_PROVIDER` changes the default;
independent installations can set that environment variable to an installed route.

Voice mode uses Microsoft Ava through the optional open source `edge-tts`
adapter. Install `edge-tts==7.3.1` in a dedicated Python environment and set
`KEIR_SPEECH_BIN` to its executable. `KEIR_SPEECH_VOICE` selects another Microsoft
voice. This is an online Microsoft Edge service accessed through a community
client, without an Azure key; availability depends on that service. Speakable
reply text is sent to Microsoft. Temporary synthesis files are private and
removed after the request. Authentication, same-origin writes, response timeouts
and concurrency limits apply. Service failures are shown explicitly; voice mode
does not silently switch to an Apple voice. The separate Speak replies preference
continues to use installed Apple voices outside voice mode.

## Model choice and voice routing

Use **Model** beside the web/desktop composer, or the **Chat** model menu above
the iOS composer. Search by provider or model and select Chat, Voice, Coding,
Investigation or Coordination separately. Advanced lane settings remain in
Controls. Studio mode includes the ten routes with successful historical adapter
receipts; independent installations list their configured routes. Availability
for a work lane is checked separately. Historical completion does not guarantee
current credentials or provider availability. Jev chooses effort at activation.

Voice has its own selection. Auto alternates Gemini 3.8 Flash and DeepSeek V4.1
Flash once per accepted voice message, with an immutable route on that turn's
job. A retry uses its original route, and typed-chat choices do not override
voice. Independent installations must configure both routes for voice Auto or
select an available explicit voice route. No Codex fallback is introduced.
Voice turns share bounded conversation history from their own thread. The route
label reports the requested model, not independent provider confirmation. Voice
capture and playback currently remain in the iOS app; desktop model settings do
not add a desktop microphone interface.
