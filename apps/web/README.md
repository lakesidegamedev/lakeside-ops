# Ops Dashboard

Config-driven, self-hosted operations dashboard for one or more projects — status, backups, database explorer, AI tools, agents, and reports.

## Quick start

```bash
cp config/dashboard.example.yaml config/dashboard.yaml
cp .env.example .env
# edit TENANT_*, projects, MONGODB_URI, OPS_USERS / OPS_PASSWORD_HASH
npm install
npm start
# → http://127.0.0.1:9724/api/health
```

Docker:

```bash
cp config/dashboard.example.yaml config/dashboard.yaml
cp .env.example .env
docker compose up --build
```

See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for paths, SSO, and feature flags.

## Configuration

| Layer | Role |
|-------|------|
| `config/dashboard.yaml` | Tenant branding, project registry, status probes, finder roots, feature defaults, external links |
| `config/dashboard.local.yaml` | Gitignored local overrides |
| Environment variables | Secrets + path overrides (always win) |

The optional `codeAgent.promptFile` points to project-specific coding
instructions. Without it, the code agent uses a generic prompt and discovers
project skills from the target repository's `.claude/skills` directory.

Feature flags (`ENABLE_CODE_AGENT=false`, etc.) hide sidebar items and return 404 for gated routes.

## Features

Toggle via `features:` in YAML or `ENABLE_*` env vars:

- Status / uptime, backups, DB browser
- Code agent, tickets/suggestions, wiki export
- Discord ideas / community voice, agents page
- Optional SSO (`SSO_*` or legacy `LAKESIDE_AUTH_*` aliases)

## Auth

The example tenant uses rate-limited password login. Set `auth.mode: sso` (or
`OPS_AUTH_MODE=sso`) to use a configured identity broker and disable local
password login and local sessions. The Lakeside deployment uses this mode.

### Studio owner’s private Keir

The iPhone owner chat runs on this web service. Configure an absolute durable `KEIR_SUPERVISOR_DIR`, the read-only `KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE` checkout, and a signed-in Claude CLI for the service account. The owner’s `/api/me` reports runner readiness. The authenticated `/api/keir/supervisor/status` reports the workspace, model, and guardian checks. Ordinary staff sessions have no access to this conversation. The support operator separately owns ticket handback and Discord delivery. See the [supervisor deployment settings](keir-supervisor/README.md).

## Security

- No secrets in git (`.env`, `.sessions.json` gitignored)
- Prefer `OpsDom` helpers over raw `innerHTML` / `eval`
- Semgrep rules in `security/semgrep/ops-dash-rules.yml` (CI)
- Admin routes require auth + role checks

## Development

```bash
npm run test:unit
npm start
```

Entry point: `src/index.js` (loads config, then `server.js`). Modularization plan: [`plans/open-source-genericization-plan.md`](plans/open-source-genericization-plan.md).

## License

MIT — see [`LICENSE`](LICENSE).
