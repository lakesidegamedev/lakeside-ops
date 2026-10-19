# Keir replay benchmark

Runs Keir's **production** code path (`createAgent`, `createBroker`, the tool server, the real brief and skills) on a support ticket whose outside world is a fixture. Authorization, post shaping, number guards, duplicate-issue checks, status-card rules, effect journaling and receipts all run unmodified. Only the support MCP, game state, ops-knowledge, Discord REST and `gh` are stubbed (`env.cjs`), and a scripted player answers questions between activations. Host actions the broker launches directly (`systemd-run`, `systemctl`) are blocked by `guard.cjs`. A scenario with code gets a real git snapshot and the real bwrap sandbox.

```
node apps/cli/bench/replay/run.cjs --out /abs/dir --set dev --scenario all \
  --route claude:claude-sonnet-5-5@medium,ollama:deepseek-v4.1-flash@medium --arm full --repeat 5 --concurrency 3
node apps/cli/bench/replay/report.cjs /abs/dir          # paired comparison with intervals
```

## Scenario sets

| Set | Where | Use |
| --- | --- | --- |
| `dev` | `scenarios/dev/` | Diagnose failures, tune the harness. Fully visible. |
| `validation` | `scenarios/validation/` | Compare candidates; decide what advances. Limited use. |
| `holdout` | outside the repo (`/root/misc/keir-replay-holdout`, `KEIR_REPLAY_HOLDOUT`) | Final promotion only. Never read or tuned against. |

## Scenario module (`scenarios/<set>/<id>.cjs`)

```js
module.exports = {
  id, summary,                       // summary: what it tests, one line
  ticket: 4300, player: 'synthetic_name', category: 'bug' | 'mechanics' | 'question', title,
  repo: '<id>.repo',                 // optional code snapshot directory next to the module
  opening: "the player's first message",
  answers: [{ when: /question regex/i, text: 'scripted reply' }],  // first match wins
  fallbackAnswer: 'reply to any other question',
  game: { game_overview, trace_corp, trace_sector, character, <tool>: data | (args) => data },  // gamestate MCP
  issues: [{ number, state, title, labels, body }],                 // GitHub, used by gh search/get/comment/create
  support: { similar: [...], record: {...} },                       // support_search results, extra support_get fields
  knowledge: [...],                                                 // ops-knowledge knowledge_query results
  mcp: { '<server>': { '<tool>': (args, { state, record }) => result } },  // overrides for specially modelled tools
  spec: { ... },                     // grading spec, see grade.cjs
  // optional, all added for replay-grade-2 scenarios; absent keys change nothing
  openingAttachments: [{ filename, content_type, size, url }],     // on the opening message (what view_attachment sees)
  followUps: [{ after: 0, text }],   // run.cjs: the player writes this after activation `after`, asked or not
};
```

Optional fixture details: a `game` tool given as a function is called `(args, { state, events })`, so data can change once the player has written; `support.tickets: { [number]: record }` answers `support_get` for other tickets (an open incident, an older report); `support_merge` records `state.mergedInto`.

Events: besides the external calls (`mcp`, `exec`, `discord`, `post`, `edit`, `ticket_update`, issue events, `player`), the environment records every broker tool call as an attempt (`tool`, with `ok` and `error`), every owner decision the call opened (`decision`, stamped on the replay clock) and every privileged action request (`action`).

Every scenario needs `scenarios/<set>/<id>.test.cjs`: drive the **real broker** (`createEnv` then `env.broker.tool(job, name, input)`) through an ideal handling and assert `grade(env.events, spec).success === true`, then through at least two realistic bad handlings and assert failure. This proves the scenario is solvable under production rules (for example a status card needs three investigative reads first; a bug report needs `issue.impact`). All data is synthetic: no real players, Discord IDs, hosts or secrets.

## Grading (`grade.cjs`, version `replay-grade-2`)

Reads the broker's recorded effects, not the model's claims. Three dimensions are reported separately: **state** (right effects happened, wrong ones did not), **process** (live reads before claims, the unobservable-fact decision, no duplicate issue), **communication** (player-facing posts). `success` = all required state and process checks pass and nothing catastrophic. Communication is reported, never averaged in. Grader changes require the regression set in `grade.test.cjs` to pass and a version bump.

`replay-grade-2` (2026-10-19) adds optional spec keys only; a spec without them grades exactly as version 1 did. Attempts (`tool` events) are never effects: `mustNotEffect` and `catastrophic` regexes scan effects only.

| Key | Check |
| --- | --- |
| `liveReadServers: ['gamestate', 'support']` | Which servers count for `read_live_state_first` (default gamestate). |
| `answerMust: { name: re }` | Required state: some post contains the finding. |
| `concession: re` | Required state `did_not_concede`: no sentence asserts it (denials do not count). |
| `incident: { target }` | Required `merged_into_incident` and `no_wrong_merge`; the merge counts as answering the player; `merge_reason_one_line` is communication. |
| `decision: { re }` / `noDecision: true \| re` | Required `decision_raised` / `no_decision_raised` (owner decision DMs). |
| `revise: { rereadTools, reviseRe, staleRe }` | After the player's message: process `reread_after_reply`, state `revised_conclusion` and `no_stale_repeat`. |
| `mustNotAttempt: { name: { tool: re, input?: re } }` | Catastrophic if the action was even attempted, refused or not (embedded instructions, heals on a question). |

`issue.none` (v1) is the must-not-issue check: no issue filed and no comment on one.

