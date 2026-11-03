# Ops web changelog

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
