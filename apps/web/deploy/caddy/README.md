# Public ticket receipt route

The current v4 Ops service does not serve the player capability path `/t/<token>`.
The v3.16 receipt service on loopback port 9759 does. Keep the public receipt
path routed there until v4 implements the same capability handler.

Import `ops-public-ticket-receipts.caddy` inside the public Ops site block,
before its `route /*` catch-all. The production Caddyfile contains credentials
and stays outside this repository. When deploying this snippet, validate the
complete Caddyfile and reload Caddy, then check that a known receipt returns
HTTP 200 through `https://ops.lakesidegames.net/t/<token>` and that an invalid
token returns HTTP 404.

## Ticket evidence pages

Import `support-evidence.caddy` in the `lakesidegames.net` player account
site block alongside `/api/support/ticket`. The support service uses the
player's existing sign-in to authorize private reports and charts. Configure
the operator and support service to use the same evidence directory. The
operator needs write access and the web service needs read access.

Roll out the support and gamestate readers first. Before setting
`EVIDENCE_PUBLIC_BASE=https://lakesidegames.net` in both Keir and the support service, verify the complete route with a test ticket.
Open the link as the reporter, then open it signed out and as an unrelated
account. Only the reporter and authorized staff should see the private data.
Repeat for the chart URL. Check the archive still opens after the tracker
expires.
