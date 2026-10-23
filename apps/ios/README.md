# Lakeside Ops

The Lakeside Games studio operations app for iPhone and iPad. Native SwiftUI,
iOS 17 and later.

- **Keir**: a private thread with Keir, the studio's operator. Live task
  status, decisions you can approve or reject, charts.
- **Pulse**: what needs attention, service uptime, operator activity, host load
  and recent alerts.
- **Desk**: open support tickets with fix stages, and the workers on them.
- **Work**: the product board by live lane.
- **Notifications**: replies, time-sensitive decisions with approve and reject
  on the lock screen, and quiet incident alerts.

The app talks only to `ops.lakesidegames.net` with the signed-in staff session.
Credentials stay in the device Keychain, requests are pinned to HTTPS and never
follow redirects. Access is restricted server-side.

## 2.4.0

- The app answers three questions at a glance: what needs you, what Keir is
  doing now, and what is broken. One attention model supplies the count and the
  "Needs you" label on every screen.
- Feed is a live briefing: one hero answer, a needs-you stack with inline
  approve, reject and reply, then what Keir did and what is next.
- Keir's queue names the current ticket, its elapsed time and the queue depth,
  and expands into one collapsible thread per ticket instead of a flat log.
- Ops is one health and queue surface with drill-downs for the scheduler,
  security posture, pull requests, worktrees and agents, world simulations,
  backups and database health, and event recovery. The per-service uptime
  catalogue is gone.
- A single status vocabulary (running, waiting on you, blocked, done, failed)
  replaces the mixed play, pause and arrow icons.
- Status headlines are composed from structured ticket data; template prose and
  empty fields can no longer appear as a status line.
- Ideas support swipe to start or dismiss and show a one-line reason.
- Autonomy mode is a visible banner that spells out what it allows and turns
  off in one tap.

## 2.3.1 beta patch

- Compact chat with Ask-style working shimmer and a persistent toolbar stop/start.
- Model choices grouped by provider and work role, with availability explanations
  and Automatic (Jev) effort. Actual running providers remain in task details.
- Activity groups tasks needing input, running work and recent results. Exact
  approvals and recovery actions appear before history and diagnostic logs.
- Phone tables wrap into readable rows; answered forms leave the live conversation.
- Feed activity graphs support inspection and average model duration. Goals show
  their next milestone and blockers, with editable, evidence-backed suggestions.
- Voice uses microphone energy for listening feedback, Microsoft Ava for spoken
  replies and the configured conversation provider (Gemini Flash by default).

## Building

Requires Xcode 26 and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
swift scripts/icons.swift
xcodegen generate
bash scripts/simulator.sh LakesideOps   # build and run the UI and session tests
```

UI tests run against built-in fixtures (`--uitest-fixtures`) and never contact
a server.

## Releases

GitHub Actions builds and tests every pull request on a macOS runner. A manual
run of **Lakeside Ops iOS** with `release` checked signs the app and uploads it
to TestFlight using the repository's App Store Connect secrets
(`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_CONTENT`,
`APPLE_DEVELOPMENT_TEAM`). Signing output is filtered before it reaches the log.

## License

Source available, not open source. See [LICENSE.md](LICENSE.md).
