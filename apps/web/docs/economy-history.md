# Economy history explorer

`/economy` reads a persistent SQLite index outside application releases and game
collections. The existing aggregate exporter remains the data source. The new
capture step only reads its local history and compact feed; it adds no production
collection scans or game writes.

The page has separate overview, macro, commodity, corporate, player, country,
cash-flow, history and change views. Each analytical view shows one selected
chart, a range/resolution selector and expandable exact readings. Country and
commodity tables drill into the same measure. Company views break down into
family, industry, ownership and company country. CSV export is numeric and
limited to 10,000 exact readings per selected window.

## Capture and persistence

Set these server-side environment variables for the capture process:

- `ECONOMY_FEED_FILE`: the compact aggregate feed.
- `ECONOMY_SOURCE_HISTORY`: the existing collector's `history/turns.json`.
- `ECONOMY_HISTORY_DB`: durable SQLite file, outside releases; defaults to
  `history.sqlite` beside the feed.
- `ECONOMY_DASHBOARD_ROOT`: deployed dashboard directory, for the service hook.
- `ECONOMY_EVENTS_FILE`: optional operator-maintained event annotations.

Run `node scripts/collect-economy-history.js` once to import retained aggregates.
Install `deploy/economy-history-post-export.conf` as a drop-in on the existing
collector unit, with `/etc/lakeside-economy-history.env` supplying those paths.
Reload systemd configuration; its next successful export also updates the index.
This captures data without a browser request. Keep the original source archives.
The web server uses a read-only SQLite connection and never collects on page load.

World identity and turn form the namespace. An explicit world epoch is used when
provided by the source; otherwise the collector's world/iteration identity is
used. A backwards completed-turn clock starts a separate capture generation.
The original collector must still report correct world identities. The index
cannot recover unseen resets or reconstruct data that was never retained.
Archived `turns-*.json` files with a completed-turn boundary are also imported.
The index stores immutable observed aggregate revisions and a queryable latest
value per metric. Repeated capture is idempotent. Unfinished turns are excluded.
No retention timer deletes earlier iterations or reset periods.

Back up the SQLite database with SQLite's backup API, or stop writers and copy
it with its WAL state consistently. Do not copy a live main database file alone.
Removing the index is a deliberate data-loss operation, not release cleanup.
All inputs and runtime database files remain outside Git.

## Boundaries, coverage and comparisons

An iteration start is separate from an economy reset. Resets detected by the
collector's company-count discontinuity are labelled **inferred**. Confirmed
annotations can be supplied as:

```json
{"events":[{"worldId":"recorded-world-id","turn":120,"kind":"economy_reset","label":"Economy reset","confidence":"confirmed: operator receipt reference"}]}
```

Annotations override inferred markers at the same turn; they do not cause a game
reset. Graphs break at resets and missing observations. The default window begins
at the most recent reset; custom windows and whole-iteration views are available.
Changes across a reset are not presented as an ordinary growth delta. Iteration
comparisons align turn age, or age since reset, rather than mixing reused turns
from different worlds. Missing data is never filled with zero.

Raw observations are available as exact readings. Larger windows are bucketed
to keep the page bounded: stock/rate metrics use a mean with min/max shading;
flow metrics sum recorded values and disclose the bucket size. Observation
counts and coverage stay visible. Cash-runway sentinel values are excluded
rather than plotted as measured runway.

Historical imports are retained collector aggregates, not freshly observed
production events. Published commodity supply/demand ratios retain the source's
meaning and must not be described as budget-backed demand. Recorded corporate
cash-flow categories are not a complete economy-wide reconciliation. Scores
are derived from the collector's scoring rules, which can change between versions.

## Access and validation

Junior Developers can read the page and CSV export. Production controls, private
conversations and database editing stay restricted. Kanban collaboration is a
separate capability. A missing index falls back to the legacy feed view during
initial setup; an unreadable index returns an explicit temporary error.

Run the focused tests under `economy/`, the economy-page renderer and staff-role
suite. They cover separate iterations with reused turns, revision retention,
completed-turn filtering, reset/gap breaks, stock versus flow aggregation,
comparisons, bounded charts, escaping, CSV limits and actual HTTP route policies.
