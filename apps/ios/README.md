# Keir

The Lakeside Games studio app for iPhone and iPad, shown on the Home Screen as
Keir (bundle ID `net.lakesidegames.ops`, unchanged). Native SwiftUI, iOS 17 and
later.

Three places, in this order, on a quiet dock at the bottom (the native tab
bar):

- **Chat**: the landing screen, a private thread with Keir, the studio's
  operator. Keir sits at the top centre, animated by what he is doing
  (listening, talking, thinking, working, asleep when stopped); tap him for
  your conversations. Under his name, small capsules appear only when true:
  running work, what needs you (both open the inbox) and autonomy. The
  timeline is the screen: your messages on the right, Keir's on the left,
  with work, decisions, questions and files shown inline as rounded objects.
  One pill composer sits at the bottom: "+" holds attachments, ticket
  follow-up drafts, message routing and the model; the microphone dictates
  and becomes send once there is text. Keir's menu at the top left holds
  conversations, controls, spoken replies, computer history, the support
  desk, settings and Stop or Start Keir. Voice mode is the button at the top
  right.
  An empty conversation opens on a quiet start: a welcome line, a "Talk to
  Keir" button (the existing voice mode) and, when the studio has a ticket
  with no recorded Discord reply, one editable follow-up draft. Nothing is
  sent automatically and a typed draft is never replaced. After a force-quit
  the app reopens the last private thread, checked against the live thread
  list; only the thread id and a one-way account fingerprint are stored.
- **Connected games** (Keir tools menu, studio mode only): pick A House Divided,
  MetroForge or Grand Century and see what Keir can genuinely read there. Each
  read shows whether it is live, unavailable or unsupported, the values returned,
  when it was read and which read tool it came from. Questions land in the
  message box as editable drafts; nothing is sent. Ticket questions exist for
  A House Divided only. The server serves a fixed read-only catalogue
  (`/api/keir/app/games`, owner session only) of deploy and health reads;
  leaderboards, simulations and any write are not exposed.
- **Inbox**: tickets and tasks with fix stages, your decisions, open questions
  and work waiting on you. Opened by the `lakesideops://keir?view=activity`
  link as before.
- **Ops**: studio health and queues, the support desk, the Feed briefing,
  goals, scheduler, security, pull requests, simulations and backups. Absent in
  standalone mode, as before.
- **Notifications**: replies, time-sensitive decisions with approve and reject
  on the lock screen, and quiet incident alerts.

On iPad with iOS 18 the three places become a sidebar; on iOS 17 they stay a
tab bar. Chat and inbox content keeps a readable width on large screens.

**Appearance**: System (the default), Light, or OLED black, in Settings. OLED
black is a true black background with slightly raised greys for bubbles and
cards. A dark theme chosen in an earlier version is kept and becomes OLED
black.

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
