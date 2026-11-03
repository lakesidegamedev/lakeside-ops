# Ops web changelog

## 4.6.0 (2026-11-03)

- **Economy page.** The AHD macro tracker returns as a dashboard page under Monitor instead of a standalone report. Three scores (economic health, gameplay, commodities) sit on one strip; six tabs split the rest: Overview (every red or amber measure, world macro and activity charts), Markets (commodity health and a supply/demand and real-price table for every good), Companies, Players, Countries and Fixes.
- Every measure is one table row: value, 12-turn change, healthy band and a trend line with the band shaded. A measure that counts in two scores is listed once.
- Time range defaults to the latest economy reset; "Whole world" shows every turn since the world began. Reset turns are marked on the charts.
- Server-rendered from one compact JSON feed (`ECONOMY_FEED_FILE`, default `/var/lib/ahd-economy/economy.json`) written by the tracker exporter each turn. No client script.

## 4.5.0 (2026-11-03)

- **Work board cards, redesigned.** Each card leads with an icon badge for its area and one for its class (project, issue, idea), then the title in bold, then one progress bar: projects show steps done out of total, every other card shows its stage (filed, next, doing, done). Owner and age sit on one quiet line; the progress note moved to the tooltip and the card dialog.
- Column and area headers carry icons; the inbox and backlog lists open with a count per area.
- "Shipped this week" counts finished work only; housekeeping closes (expired, decluttered) are left out.

## 4.4.0 (2026-11-03)

- **Grouping.** Cards carry an `area` (a fixed list per product, e.g. economy, politics, turns, apps for A House Divided), a `class` (project, issue or idea) and an optional `parent_id` that puts a card inside a project. `kanban_add`, `kanban_update` and `kanban_list` accept all three; `kanban_get` lists a project's child cards.
- **Work board.** Filter by class and area. Next, Blocked and Done group by area. Child cards fold into their open project, which shows its step count and a progress bar; the card dialog lists the steps.

## 4.3.0 (2026-11-03)

The work board's rules, from the kanban audit. These apply to agents (MCP tools) and people (the board) alike.

- **Inbox lane.** Next now means committed work with an owner. Cards filed into Next without an owner, and new cards by default, land in the inbox. Unowned Next cards nobody has picked up move to the inbox after a day.
- **Quiet cards are released.** A card in progress with no update for 3 days goes back to Next with its owner cleared and a `released` event. Untouched local backlog cards close as `expired` after 90 days.
- **Monitors.** Always-on agent cards are kind `monitor` (detected automatically from heartbeat volume). A heartbeat updates the card and records at most one history event an hour. Monitors stay out of lanes, briefs and staleness.
- **One name per agent.** Actors are normalized (claude-opus-5-5, Opus and Claude all become claude; `name:session` keeps parallel sessions apart). The shared token name is never used as an actor; a write without an actor is recorded as unnamed with a warning.
- **Cap on work in progress.** Three cards in progress per actor; `force: true` overrides. Keir is exempt.
- **Duplicate guard.** Adding a card that matches an open one in the same product returns the existing card (`duplicate: true`) instead of a copy; `force: true` adds anyway.
- **Plain progress, real evidence.** Progress that looks like a JSON dump is refused. `completed` needs `evidence_url` or `no_evidence_reason`. Titles that are questions for the owner are refused; owners are asked in chat.
- **Fixed kinds.** bug, feature, ops, balance, support, capability, audit, task, monitor; synonyms map automatically.
- **Shorter brief.** `kanban_brief` leads with the rules and returns your own cards (pass `actor`), released cards, blocked, in progress, next, shipped in 3 days and monitor heartbeats. `kanban_list` filters by `assigned_to` and `kind` and says when it truncated.
- **GitHub imports** carry the first 500 characters of the issue body and a kind from labels.
- The GitHub sync job runs board hygiene after each sync (`--no-maintain` skips it).

## 4.2.0 (2026-11-03)

The hub takes the Lakeside Platform look and every view was rebuilt around how the studio works now.

- **Look.** Geist type, near-black canvas, hairline borders and one teal accent, shared with the platform console. Older pages inside the hub pick up the same tokens.
- **Work board.** Always-on agent cards move to a status line. A strip shows what shipped this week, what is stuck, what is in progress, what is next and what is in the inbox. Cards that have gone quiet for five days get their own row. In progress is grouped by who holds it, then Next, Blocked and Done for the last seven days. Automatic filings and the backlog sit in collapsed lists. Cards never show raw JSON status; lane moves, release and notes live in the card dialog.
- **Library.** A category sidebar, a stat strip and cards that say what each report is and what it found, with a color per report type. Docs load only when opened, pages are compressed, and live trackers are no longer a section.
- **Tickets.** Live tab: Keir's 8-bit sprite and status, the models it uses, its watch sensors, and a scrollable row of open tickets with Keir's own summary, refreshed every 20 seconds. History tab: every ticket, searchable. Keir performance tab: 30-day results, runs per day, tickets opened and closed, model mix, and an hourly tracker kept in the data directory.
- **Descriptions are required.** `publish_report` now needs a `summary` (what the report is) and a `takeaway` (what it found) for a new report, and accepts `library_category` and `report_type`. A republish may keep the description already on file. The Keir shadow and bench publishers send both.

## 4.1.0 (2026-11-03)

Ops is now three views under one bar: the work board, the library and the ticket hub.

- **Hub bar.** A persistent top bar replaces the sidebar on every ops page, including the report viewer, tickets and the work board. It carries live counts per view, a search palette across reports, docs, tickets and board cards (`/` or `⌘K`), theme, and the signed-in user. Sign-in state is checked every minute and on focus, and a sign-out in one tab reaches every open tab. A tenant allowlist (`hub.consoleUsers`) controls who sees the fleet console link.
- **Library.** Published reports, older report pages and knowledge base docs in one catalogue with fixed categories, report types and labels, filtering, search, grid and list views, and a monthly publishing chart. A curated overlay (`library.json` beside the report manifest) gives each report a plain title without touching the publisher's manifest; uncurated reports are filed by keyword. Daily operations reports are excluded.
- **Report viewer.** Reports open inside the hub with a breadcrumb, type, newer and older within the category, copy link and full page. Report links inside a framed report move the whole hub. Shared report links still open as plain pages for people without ops access.
- **Knowledge base docs** render as pages with a table of contents and linked docs.
- **Ticket hub.** Open tickets with their latest player update, owner and linked PR; who has worked tickets in the last 14 days (staff and agents only); a compact feed of recent ticket work; pull requests linked to tickets with live GitHub state; weekly opened and closed counts and median fix time; and the full ticket history with search, filters and sorting.
- **Retired pages.** The other admin dashboard pages now redirect to the library. Public pages (status, player suggestion pages, ticket links, shared reports) are unchanged.
