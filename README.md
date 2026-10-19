# Lakeside Ops

**Keir for your own stack.** A private agent workspace across the web, desktop,
iPhone, iPad, Discord and the `lakeside` command line. This consolidates the
existing Lakeside Operator, ops dashboard and native app; Keir remains the agent.

One repository, two deployment modes:

| Mode | Experience | Authentication |
| --- | --- | --- |
| Standalone | Keir conversations, project investigation, task history and cancellation | Your installation's local owner account |
| Lakeside | Studio dashboard, support desk and configured game services | Existing studio auth and role checks |

Standalone is the default for a new installation. It does not start Lakeside
services, load their routes, connect to their databases, or require Lakeside SSO.
The desktop client opens the Keir agent workspace, not the studio dashboard.
The optional Discord owner-DM connector uses the existing operator transport
with your own bot and shares its thread and tasks with the portal.

## Get started

The agent server currently targets **Linux**, Node.js 22+, Rust 1.91+, Git and
GNU `timeout`, a C compiler, pkg-config and OpenSSL development headers. The harness keeps a 6 GiB available-memory floor. Install and sign
in to a supported provider CLI on the server first. Desktop clients run on
macOS, Windows and Linux; iOS builds need macOS and Xcode.

```sh
git clone https://github.com/lakesidegamedev/lakeside-ops.git
cd lakeside-ops
npm run build:agent
# Replace the route with a provider/model available to your subscription.
node bin/lakeside.js init --project /absolute/path/to/your/repo --route 'provider:model@medium'
node bin/lakeside.js doctor
node bin/lakeside.js serve
```

`init` prompts for a password without echoing it. Visit <http://127.0.0.1:9724>.
There are no mandatory npm dependencies for the standalone server. Use
`npm link` if you want `lakeside` on your PATH; otherwise `node bin/lakeside.js`
works for every command. The root checkout (`bin/lakeside.js`) and the published
`@lakesidegamedev/code` package both provide a `lakeside` command; install only
one of them globally.

For a remote server, pass `--url https://keir.your-domain.example` to `init` and
put an HTTPS reverse proxy in front of the loopback listener. Keep provider
logins, configuration and state on your own server. Nothing connects to a
Lakeside account or service in standalone mode.

See [installation](docs/INSTALL.md), [clients and CLI](docs/CLIENTS.md),
[architecture](docs/ARCHITECTURE.md), and [migration](docs/MIGRATION.md).

For interactive coding on your own PC, [Lakeside Code](apps/cli/README.md)
adds a distinct terminal interface to a pinned OpenCode engine:
`node bin/lakeside.js code /path/to/project`. Explore its visual design with
`npm run code:preview`. Local coding works independently of the Keir portal;
configured peers add PC/VPS task inspection and handoffs to Keir.

## Repository

| Directory | Contents |
| --- | --- |
| `apps/web` | Keir portal and optional studio dashboard |
| `apps/agent` | Keir runtime, policy modules and Rust task harness |
| `apps/desktop` | Desktop Keir app with isolated sessions per server |
| `apps/ios` | Native SwiftUI app and shared protocol package |
| `bin` | `lakeside` setup, portal, auth and task commands |
| `apps/cli` | Lakeside Code terminal and agent coordination adapters |
| `config` | Public setup examples; actual configuration stays outside Git |
| `docs` | Installation, architecture and contribution guidance |

## Current boundaries

Standalone uses the real Keir conversation/task store and Rust provider harness.
Portal tasks receive a **read grant by default** over the first configured
project, plus any explicitly configured read-only MCP integrations. Portal coding can be explicitly enabled for a registered worktree in private
configuration. Coding work is also available through `lakeside agent run --grant coding --cwd <registered-worktree>`.
The portal adds no publishing or deployment adapters. Coding grants run commands
with the server account's authority; isolate that account and review its access
before enabling them. Studio-specific approval adapters, scheduled watches, push delivery,
goals and feed are not advertised as standalone capabilities.

The iOS app uses the server's capability response to hide studio sections. Set
its server URL before building for your own installation. Desktop connects to
your chosen server at first launch. Both use the same portal account.

## Development

```sh
npm test
node --test apps/desktop/policy.test.js
npm --prefix apps/agent ci && npm run test:agent
npm --prefix apps/web ci && npm run test:web
npm run test:rust
# On macOS:
swift test --package-path apps/ios/Core
```

CI checks the standalone portal, authentication, agent, web regressions, Rust,
source secrets and the iOS app. Desktop packaging runs on pull requests that
change apps/desktop and on manual dispatch.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Source available with permission to build, privately modify and self-host for
your own operations. See [LICENSE.md](LICENSE.md). The imported dashboard keeps
its [MIT license](apps/web/LICENSE), and vendored components retain their licenses.

Owner decision delivery can be pinned to the native app with `KEIR_OWNER_DECISION_CHANNEL=app` on the agent service. Decisions remain available through the authenticated app API and existing push collector; they do not also create owner Discord DMs. The default retains Discord delivery for independent installs. Delegate escalation and exact execution approval validation retain their existing rules. This requires an agent release and restart; updating the support MCP alone does not activate it.


Conversation monitoring can run independently of the agent with `apps/agent/bin/keir-conversation-audit.js`. Supply `--ledger`, `--mcp-config`, `--output`, `DISCORD_BOT_TOKEN`, and `KEIR_OWNER_ID`. The audit reads a bounded sample of real ticket messages and decision copies, checks them against receipts and shared decision state, and writes a private timestamped report. It never changes the operator ledger, tickets, messages, or decisions. `--kanban-id` optionally reports changes and hourly heartbeat summaries through the configured local ops-knowledge MCP. `--exclude` omits specified ticket numbers entirely.

The example systemd service and timer run every five minutes with a45-second request deadline and read-only access to the operator state. Configure `/etc/keir-conversation-audit.env` with `KEIR_MCP_CONFIG`, `KEIR_OWNER_ID`, `KEIR_AUDIT_KANBAN_ID`, and `KEIR_AUDIT_EXCLUDED_TICKETS`. Findings are review cues, including unmatched message delivery, internal handoff text, unanswered players, stale active conversations, closed tickets under a hold, and missing or divergent decision copies. Partial observations and transport failures are reported as failures, not clean audits. This is bounded monitoring; semantic helpfulness still needs review of the retained actual reply samples.

Use `KEIR_OWNER_DECISION_CHANNEL=both` for the native app and Discord to expose the same durable decision. The first authenticated answer wins, pending copies are cancelled, and obsolete or late Discord cards are removed. Switching from app-only delivery restores the existing pending decision in Discord without creating a second decision or changing its action scope.
