# Lakeside Code changelog

## Unreleased

## 0.1.4 preview 6 (2026-10-21, experimental)

- The home screen opens on a full-width mountain range: sharp static ridges, a vertical gradient, and a lake whose line-work is the only moving part. It sizes itself to the terminal and keeps the prompt below it at every height. `/motion` or `LAKESIDE_CODE_REDUCE_MOTION=1` still freezes the water.
- The session panel and status bar name the model in plain words with a small provider mark, e.g. `OpenCode Zen - Deepseek V4.1-Flash-Free` instead of the raw id.
- `lakeside code vps --help` explains the command, unknown VPS subcommands print usage, and `/doctor` reports the VPS connection alongside the other checks.
- Windows: the engine starts through the `.cmd` shims and shuts down without a file lock, so terminals no longer fail to launch or leave a busy binary behind. Transient VPS connection failures get one fresh retry.

## 0.1.4 preview 5 (2026-10-17, experimental)

- Discord through a connected Keir VPS: sessions read channels and recent messages, and search or ask what players discussed, all with the VPS's own credentials. Posting to a channel (`vps_discord_send`) asks for confirmation every time and stays off unless the host enables it.

## 0.1.4 preview 4 (2026-10-17, experimental)

- A Lakeside status bar runs along the bottom of every screen: project and branch, local or VPS, MCP health, and in a session the model, tokens and cost.
- The session sidebar opens with a small mountain-and-lake scene and the Lakeside Code wordmark.

## 0.1.4 preview 3 (2026-10-17, experimental)

- The logo is an animated mountain and lake: snow on the tall peaks, a rippling reflection, glints on the waterline. `/motion` or `LAKESIDE_CODE_REDUCE_MOTION=1` turns the animation off.
- Connecting a VPS from a running terminal now attaches its remote tools within about ten seconds; no restart. The connect message says so.
- `/studio` fits the terminal instead of running off its edges, and lists agents on the VPS (Paseo) with what needs you. Click one to have the agent check it.
- Health shows the VPS connection live instead of the state at startup. The sidebar footer no longer wraps.
- Messages to agents on a connected VPS (`vps_message`) ask for confirmation every time, since they act for the owner.

## 0.1.4 preview 2 (2026-10-17, experimental)

- `/studio` shows open support tickets and the kanban queue (needs you, now, next) from a connected Keir VPS. Click a row to start work on it; reading never posts to players or changes tickets. Tall terminals show the panel on the home screen, shorter ones a one-line summary.
- Home shows your registered projects with branch and uncommitted changes; click one to load it.
- The sidebar shows the session's model, tokens and cost (subscription routes say "no metered cost" rather than $0.00), MCP server health and the VPS connection.
- `/doctor` checks providers, MCP servers, the VPS, the engine and updates, and says what to do about each problem.
- `/theme` switches between Midnight, Daybreak (light) and High contrast with a live preview, and remembers the choice.
- Once a day the terminal checks for a newer release on your channel and shows it in the sidebar footer and /doctor. It never installs anything by itself.

- `lakeside code update` works without a GitHub sign-in for public release repositories. A signed-out GitHub CLI used to stop the update; it now falls back to anonymous HTTPS, and private repositories still use `gh`.

## 0.1.4 preview 1 (2026-10-17, experimental)

- Headless agents no longer assume the studio server layout. Provider binaries, credentials and the optional provider launcher resolve from `HOME` and `PATH`, with `LAKESIDE_<NAME>_BIN` and `LAKESIDE_PROVIDER_RUNNER` overrides. Without a launcher, OpenCode runs directly in its disposable worktree.

- Validate remote connections immediately after setup and on `vps status`. Discover generic MCP tools and Keir remote projects/services with the existing token file; provide the agent a `remote_connection` check and actionable recovery for expired credentials or network failures.

- Add `lakeside code update` and `--check` for Windows and WSL packaged installs, with checksum verification, configurable release repository, preview/stable channels and pinned rollback tags. Preserve user configuration and require GitHub authentication for private releases.

## 0.1.3 preview 1 (2026-10-17, experimental; stable 0.1.3 unreleased)

- Add configurable optional remote profiles: generic MCP or Keir deployments, token-file references, bearer/cookie authentication and connection names, preserving standalone coding and existing provider configuration.
- Add owner-authenticated Keir desktop read capabilities, shared knowledge/skills, task coordination, redacted environment inspection and server-side Sentry reads.
- Configure or disable default bundled skills while retaining on-demand skills.
- Prevent logo rows from shrinking, show a clear compact mountain and display remote setup status.

- Start outside a repository and load multiple project contexts during a session. API tools and native local commands retain scoped instructions across resume; native file access includes explicitly loaded project roots.

- Translate local Windows checkout paths in WSL with `wslpath`, preserving project aliases and remote directory semantics.
- Authenticate Keir peers with the owner session cookie expected by the live gateway; reject malformed session tokens.
- Poll VPS task metadata without repeatedly downloading private conversation history.
- Add `/reconnect`, connection latency and expired-session guidance for VPS peers.
- Retain clearly stale task snapshots across connection drops; credential changes or access failures clear them. Reconnect never resubmits work.

- Add explicitly selected API or native ACP backends, with Claude/Codex/Gemini adapter presets.
- Add a separate native conversation view and authenticated loopback bridge.
- Persist native prompt intent and ids, deduplicate retries, and retain uncertain outcomes.
- Add native permission forwarding, project file access, scoped skill reads, resume and explicit task transfer.
- Typecheck transport, storage, permissions, lifecycle and native workflow contracts.
- Native vendor acceptance and physical Windows/WSL acceptance remain pending. This preview passed hosted Windows installation/runtime/ConPTY and Linux installed-package checks. The interactive engine remains pinned to OpenCode 1.19.0.

<!-- Preview coverage: code-v0.1.2-preview.3 (38fc781cf7916e91afbc484565115b42dc89120f) through 18565d625096f4a140b9415e8b3c778de6eb4896. Includes user changes and developer implementation notes above; performance experiments in PR53 are excluded. -->

## 0.1.2 (preview)

- Split terminal views, workflow policy, recovery storage and MCP configuration into focused modules.
- Add a compact logo, Lakeside session composer, workspace actions and terminal titles.
- Add live repository diff, recorded command outputs, resume and MCP connection views.
- Add opt-in GitHub, kanban and ticket workflow guidance, plus durable recovery tools shared across model changes.
- Add secure MCP configuration with environment credential references and missing-credential handling.
- Add five first-party design skills covering systems, UX, accessibility, terminals and rendered reviews.
- Strictly typecheck workflow/storage/connection contracts and validate persisted inputs at runtime.

## 0.1.1

- Bare `lakeside` opens coding in the current folder; explicit `lakeside code` remains available.
- Accept absolute Windows worktree paths when configuring peer agents.
- Check the native PowerShell installer, engine, skills and terminal on Windows CI.
- Exercise preview and coding home through the Windows ConPTY interface.

## 0.1.0 (prototype)

- Installable coding CLI with its own pinned OpenCode engine and startup checks.
- Mountain/lake identity, blue/steel-grey terminal, useful project shortcuts and
  responsive Changes, Review and Checks preview.
- Configured Keir and OpenCode peer inspection, scoped task submission and results.
- Durable handoff history, conservative recovery and confirmed cancellation.
- `doctor`, `peers` and `handoffs` commands plus in-session coordination tools.
- Package installation and actual engine/plugin validation in CI.

- Bundle Keir’s Ponytail, review, debugging, TDD, verification and frontend skills, including references, licenses and native slash commands.
