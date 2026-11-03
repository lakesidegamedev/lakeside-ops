# Junior Developer dashboard access

Junior Developer is an operations role, stored as `users.opsRole: "junior_dev"`.
It does not change the account's game `role`, `isAdmin` or `isModerator` flags.
The dashboard reads current account metadata at sign-in and on each new request.
Deleted or banned accounts and revoked sessions remain denied. Removing
`opsRole` removes dashboard access on the next request. Existing game admins
keep their admin role.

The role opens a dedicated development landing page and navigation. It can read
the work board and item history, the project guide, public technical docs,
commodity and extraction reports, and engine diagnostics. On the board it can
claim unassigned tasks and report progress, blockers, resumption, completion or
release on tasks it owns. Completion requires an evidence URL; release requires
a handoff note. The reports directory shows only
this role's economy links, not daily operations or private report libraries.

An explicit server-side path and method allowlist denies everything else by
default, including future routes. It runs before HTTP dispatch and is also
checked at the generic API gate. Production controls, credentials, raw database
access, backups, private conversations, agent execution and admin proxy gates
are restricted. Existing WebSocket authorization remains admin-only. POST is
permitted only for logout and `/api/kanban/items/:id/collaborate`. That endpoint
accepts only `action`, `summary` and `evidence_url`; the actor comes from the
authenticated session. Claims and ownership checks use an immediate SQLite
transaction so competing contributors cannot claim the same card. Agent
`started` reports also reject another owner's card unless explicitly forced by
a privileged caller. Administrative fields, creation, reassignment, monitors,
closed tasks and ordinary mutation endpoints remain restricted.
Navigation filtering is presentation, not authorization.

See [coding agent instructions](kanban-coding-agent.md) for the shared workflow.

Grant or remove this role only through an authenticated operator workflow on the
verified immutable account ID. Do not identify users by a display name alone.
Record owner authorization and before/after evidence privately, and verify the
game privilege fields did not change. No browser role-management endpoint is
introduced by this feature. The application never trusts an ops role supplied
in a request or a session snapshot without checking current account state.

To add another view, review its data exposure and all supporting endpoints,
then update the explicit allowlist, route permission and navigation together.
Run the role, session, hub, kanban and WebSocket authorization tests.
