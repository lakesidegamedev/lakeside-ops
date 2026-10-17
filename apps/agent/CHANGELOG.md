# Changelog

Keir: the A House Divided Discord operator, support desk and /summon bridge.
New monorepo versions use `keir-vX.Y.Z` tags. Stage and activate with `deploy/release.sh`.

## Unreleased

### For users

- Ticket handoffs now retain the Discord reply route when Keir discovers the ticket channel later, so he can acknowledge and answer in the ticket.

## 5.8.14 (2026-10-18)

### For users

- Keir's conversation and worker lanes now run on the DeepSeek platform API (DeepSeek V4.1 Flash, 1017 build) with direct per-token billing instead of the Ollama Cloud subscription, pinned at low reasoning effort. The usage report prices each DeepSeek activation at its published peak rates, so cost per activation is visible again.

## 5.8.13 (2026-10-17)

### For users

- A Lakeside Code terminal connected to this VPS can now read the AHD Discord with the VPS's own authorization: the channel list, recent channel messages, and semantic search or ask over what players have discussed. Posting to a channel asks the owner every time, and stays off unless this host enables it.

## 5.8.12 (2026-10-17)

### For users

- Keir explains things in plain words. Ticket messages and progress cards that use engine or staff terms (like headroom, sell-through, throttle or code names) are sent back to be rewritten in the words the game shows players.
- When someone asks Keir a question in a ticket, a progress card update from another Keir task no longer holds the answer back.
- A ticket message that names Keir is answered within a minute, even while staff are chatting in the channel.
- Keir never posts planning narration such as "I'll start by understanding the available tools" as a reply.

## 5.8.11 (2026-10-17)

### For users

- Keir never posts tool-call text as a reply. When a model writes its tool calls out instead of making them, the reply is dropped and the turn retries or hands off.
- In the app, a progress update that says a ticket needs your decision now shows that decision's Approve and Reject buttons.

## 5.8.10 (2026-10-17)

### For users

- With the app's approvals set to yolo, Keir promotes development to staging and staging to main without asking first, and records the yolo grant it shipped under. Merges, compensation and policy questions still ask. Stopping Keir or switching approvals back to ask ends it.

## 5.8.9 (2026-10-17)

### For users

- Voice conversations run on Claude Sonnet 5.5 at low effort. Most spoken answers now arrive in about ten seconds instead of waiting out a slow model, and work that needs a closer look is handed off after 30 seconds instead of 90.
- In the iOS app, the voice screen keeps waiting after Keir says it needs a closer look, so the follow-up answer is still spoken when it arrives (needs the next app build).

## 5.8.8 (2026-10-17)

### For users

- "Needs you" and "stuck" in the app now only count things the owner can act on. A question whose task is gone expires instead of asking forever. Waiting on a player's reply is no longer "overdue". An open ticket Keir has not picked up shows as queued for Keir, not as stuck work that needs assigning.
- Blocked tasks with nothing anyone can act on close on their own (app tasks after an hour, others after six), and their open tickets go back to Keir's intake. Pending decisions and actions with an unverified outcome are never closed this way.
- Needs attention no longer lists Watchkeeper's internal sensor timeouts or alerts with no readable detail.

## 5.8.7 (2026-10-17)

### For users

- The desktop token download is now a 30-day device session, like the iOS app, instead of the one-day browser session, so the terminal keeps its VPS connection for a month. If the exchange is unavailable it falls back to the browser session and says so in `X-Session-Expires`.

## 5.8.6 (2026-10-17)

### For users

- The owner's terminal can list VPS coding agents as structured rows (`vps_agents`: status, needs you, model, last update) and, where the server enables it, message one (`vps_message`). Messages are tagged as coming from the owner's terminal and run in the background.

### For developers

- The desktop gateway publishes only real repositories (git, with a remote, outside the misc category) instead of every directory in the box manifest. `KEIR_DESKTOP_AGENT_MESSAGES=1` enables agent messages; it is off by default.

## 5.8.5 (2026-10-17)

### For users

- A developer card closed without evidence no longer keeps a task waiting or pages the owner again on every card edit. The task is told once to verify the outcome itself or say what is still unknown.

### For developers

- Pin `playwright-core` 1.64.0 for the page sensor and `view_page` instead of loading Playwright from the game checkout, which broke the sensor whenever that checkout reinstalled. `KEIR_PLAYWRIGHT_MODULE` overrides the module path.

## 5.8.4 (2026-10-16)

### For users

- Decision requests to the owner open with a plain brief: who asked and what they actually asked for (or that Keir is proposing it unasked), the choice, a for and against for each option, and Keir's recommendation. A brief that hides who is asking behind "they" is replaced.

## 5.8.3 (2026-10-17)

### For users

- Optional desktop connections can use an owner session token file for Keir task coordination and VPS tool discovery. Standalone terminal coding remains independent of this integration.
- Read configured server-side Sentry issues and inspect registered project environment keys without copying production credentials to a PC.

### For developers

- Add an owner-authenticated desktop MCP gateway on the existing app route, restricted to configured read tools and shared task coordination. Production mutations retain their original approval path.
- Support generic remote MCP profiles, configurable bearer/cookie authentication, project contexts and default skills in the terminal. Keep existing provider settings and the empty-response recovery fix.

## 5.8.2 (2026-10-16)

- Voice playback: online speech has a 20-second client deadline and automatically uses the device voice on failure, rather than leaving Preparing voice pending. Cancellation keeps the fallback silent.

### For users

- Voice questions start with reviewed read tools ready to use and a shorter discovery budget. When deeper work is needed, Keir gives a spoken handoff update and keeps the final answer attached to that voice turn.
- Repeating a question is a new voice turn that needs its own answer. Keir cannot silently finish it because another turn received a similar answer.
- The matching iOS update accepts late replies after the recovery timeout, keeps listening for the final answer after a handoff update, and avoids interrupting a new utterance or ongoing playback. These client changes require the new TestFlight build; the earlier build 237 does not include them.

### For developers

- Supply bounded read-only MCP schemas and current-turn IDs to voice roots and delegated workers. Their conversation snapshot ends at the accepted source message; later replies to other turns cannot be mistaken for delivery.
- A voice provider that ends without a deliverable answer hands off immediately rather than quietly waiting for a retry. Internal reasoning is never substituted for a spoken answer.
- Enforce a correlated final reply or durable channel outbox entry before completing voice work. Handoff progress is marked separately, and a plain model response follows the normal guarded channel_reply path.
- Bound voice quick-lane discovery to three rounds, skip optional intake classification on that lane, and avoid creating a worker after a final answer was already queued.
- Add broker/agent regressions for repeated voice turns, handoff progress, schema filtering and plain model responses, plus a simulator regression for receiving a reply after timeout. Physical voice capture and spoken playback were previously confirmed by the owner on build 237; the new late-response behavior remains a device acceptance check.

<!-- Coverage: keir-v5.8.0 (e8ca514, CLI harness cutover) through this voice recovery change. -->

## 5.8.1 (2026-10-16)

### For users

- Conversations that reach their lookup limit without an answer continue in the work queue instead of reporting an empty successful result.

### For developers

- Recognize OpenCode V2 reasoning-only stops at the configured step budget, retain token accounting, and use the existing bounded continuation path. Reject empty provider text when no broker completion was accepted.
- Regression tests replay the six-step failure shape and verify authenticated owner handoff preserves the request without approving pending actions.

## 5.8.0 (2026-10-16)

### For users

- Keir uses the shared CLI harness for model work, with durable attempt records and cancellation. Current ticket recovery, voice and approval behavior remain available.
- Muse can only run through an explicitly selected OpenCode Go route. Direct Meta billing and paid fallback are disabled, including old saved model selections.

### For developers

- Structured reports support source-checked calculations and retrying rejected arithmetic without rewriting the report. Completion still requires the original broker checks.
- Default coding uses Codex Sol and vision uses Sonnet. Existing production lane settings remain explicit. Native subscription adapters run behind the shared CLI boundary.
- Controlled Sonnet coding trials were faster in the measured sample. Whole-workflow factual correctness and consistent latency improvement remain unproven; no Muse performance claim transfers to its Go Contributor variant.

- Use OpenCode v2 Console authentication, per-activation standalone sessions, native tool grants and transcript accounting. Preserve model-specific prompts and deliver Antigravity briefs over stdin.
- Route activations, inference helpers and private reflection through the headless Lakeside Code runtime. OpenCode runs OpenCode and Ollama Cloud routes with exact broker grants, durable attempt records and process-tree cancellation. Preserve native subscriptions and Rust execution support.

## 5.7.5 (2026-10-16)

### For users

- When one of Keir's own tasks runs out of time, Keir extends it once and keeps working instead of asking the owner. The owner is asked only if it runs out of time again. This also stops a re-queued expired task from blocking itself in a loop.

## 5.7.4 (2026-10-16)

### For users

- When staff ask Keir to open an incident from inside a ticket, Keir opens a real incident and merges the matching tickets into it, instead of refusing.
- Keir no longer posts its opening welcome in a ticket that staff or another operator has already answered; its first post there is the actual reply.

## 5.7.3 (2026-10-16)

### For users

- When the owner directs Keir to work a moderation or incident ticket, Keir works it instead of deferring to the staff category. Moderation actions themselves still need their own approval.

## 5.7.2 (2026-10-16)

### For users

- Owner-requested private investigation continues in chat when a support coordinator is held by moderation category or staff ownership. Handoff receipts identify the available read-only path; repairs and public actions keep their own approval requirements.

- Exact game status requests read live engine health directly with a short timeout, avoiding model discovery and worker delays. Voice replies from delegated work stay attached to the original voice turn.

### For developers

- The authenticated exact-status path performs one read-only engine health call with an eight second timeout and rejects stale or malformed snapshots. Broader requests keep their model route. Delegated voice messages retain root correlation and separate worker identity.
- Two regressions failed before the fix and pass afterward. The combined recovery suite passes 141 tests before adding the owner-claim cases, and the actual broker read live health in 1.5 seconds. iOS source is unchanged, so these backend changes work with TestFlight 2.4.0 build 237.
- Includes the separately prepared owner-claim and orphan-hold recovery from PR #43 without changing its source or approval rules.

<!-- Coverage: voice status follow-up cf0e58e and owner-claim PR #43 at 8e6d9e7, combined in release PR #42. -->

## 5.7.1 (2026-10-16)

### For users

- Owner direction releases the owner's own ticket claim and resumes work; staff claims stay with staff. Orphan owner-decision holds become real decisions that can be answered.
- Review the full action and exact scope before approving in chat, Activity, tasks and tickets. Follow the task after answering to see execution and remaining blockers.
- Give Keir direction from blocked work, assign board items, or request a fresh proposal when one has expired. Existing approvals and uncertain actions keep their original limits.
- Voice reconnects when the app is ready, follows the reply to the accepted task and offers retry or task recovery when a turn blocks or times out. These client changes ship in the matching Lakeside Ops 2.4.0 build.
- Decision notifications and ticket links open the right item. The Ops attention list explains notification badges and links to failed checks.
- Computer work appears in chat and task results; failed browser input retains its text. Public browser changes require review against the current screen.
- Keir can read current shared Discord and app work for context. Signing out clears private app state; load errors have visible retry controls.
- Model choices show configured routes and their readiness separately, include OpenCode options, and explain missing Voice Auto prerequisites.

### For developers

- Shared decision projection across app channels, tasks and tickets; authenticated stale-proposal replacement does not grant execution approval, and obsolete Discord cards are retired with retryable deletion.
- Owner activations receive shared work as evidence. Screen, browser, URL and worker identity bind approved computer input; replay and changed targets are rejected.
- Native stores reset on credential changes and reject stale requests/events. Activity uses the canonical decisions endpoint; decision card controls have independent List tap targets.
- Voice turn selection matches the accepted job across message batches. Startup respects connection readiness, scene activity, intentional pause and speech preparation; waits have bounded recovery.
- 130 targeted regressions pass, including a virtual combination with CLI PR #39 at ab8eacb. The CLI cutover itself remains independent work and is not included in this release. All six required PR #41 checks passed, including full simulator run 38938724887; the scope screenshot was also inspected. Physical microphone/permission acceptance remains a device check.

<!-- Coverage: keir-v5.7.0 (9d5f5bab95284c89fa821730d13982567e4b590c) through 2ef335192e98c308078af9083db2ef3db38a222e; PR #41. -->

## 5.7.0 (2026-10-16)

- Keir logs feedback about itself automatically. Every message in a ticket channel, a DM, or naming Keir gets one Jev check; complaints (slow or silent, wrong or misleading, tone), behaviour requests, bot bugs and praise are logged with ticket and severity. It never delays intake and fails open.
- Once a day (05:00 New York by default, KEIR_SELF_REVIEW_HOUR) Keir reviews the last day's feedback, the tickets it worked and its own stall recoveries, reads the real conversations, saves evidence-backed lessons to its notebook, and files systemic fixes on its own board. It does not post to players. Recent feedback and review runs show on /v3/status.
- The wait contract no longer escalates an answered ticket to the owner: a ticket in its closing grace, or where Keir spoke last, is a legitimate wait for the player. A closing grace that runs over two hours wakes Keir to resolve the ticket.

## 5.6.4 (2026-10-16)

- Tickets can no longer stall on an unknown outcome. A ticket may wait only for an owner decision, a player reply to an answer (24 hours at most, then it offers to resolve), or a live turn, CI or deploy watch. Any other wait is capped at 45 minutes and woken with an order to find the outcome or ask; a second stall opens an owner decision.
- Blocked owner-app tasks with nothing pending are dismissed after an hour, so they stop showing as "needs you".
- The scheduled morning brief can read Discord history without being blocked.
- Procurement, trade, bonds, labour, logistics, military and money supply changes now need owner approval to merge, and a task can declare any merge an economy change.
- An action whose outcome is unknown for 30 minutes (other than a merge, which is settled from GitHub) becomes a yes/no question for the owner, and the answer is applied automatically.
- A ticket held by another operator for two hours with no progress asks the owner whether to hand it back.
- A player who has not answered for 6 hours prompts Keir to find the information itself instead of waiting.

## 5.6.3 (2026-10-16)

### For users

- A merge that errored after GitHub accepted it no longer holds its ticket
  until someone inspects it. Keir checks the PR at its exact head: merged
  settles the action as done, open or closed means it did not merge. The held
  task then resumes. Other uncertain writes still wait for a person.
- Restarting Keir no longer leaves the running task blocked because of an old
  unsettled receipt; only a write started in that activation does.

### For developers

- New `lib/operator/effectrecovery.js`, ticked every 5 minutes, settles
  `merge:<n>:<head>` effects older than 10 minutes across AHDGame and AHDClient.
- The shutdown abort path checks only effects started in the aborted activation.

## 5.6.2 (2026-10-16)

### For users

- A ticket with several fixes no longer stalls on one open question. Before
  finishing a wait, Keir is asked once to keep building every fix on the card
  that does not depend on the answer, or to say on the card what each one waits
  on.
- Repeating the same read no longer counts as progress, so a task that keeps
  re-checking an unchanged card or record is nudged and then parked. A
  spinning game finding is parked for the owner's morning brief instead of
  being dropped.
- Game findings and engineering tasks can read raw game records through the
  same guarded, prod-only, read-only path tickets got in 5.6.0, instead of
  filing "please run this query" handoffs.
- An unclaimed developer handoff gets one overdue wake, then parks: its task
  sleeps until a developer acts, the player writes, or the morning brief, which
  now lists every parked handoff. Keir's own notes on a card no longer wake
  the task that wrote them.

### For developers

- `selfrecovery` fingerprints `distinctReads` (hashed server, tool and args)
  instead of `investigatedReads`. Findings park with `parkedForBrief`.
- `developerwatch` exports `parkedOnHandoffs`; an unaccepted overdue handoff
  sets `watch.parkedAt`. `reviewWaits` skips parked tasks. Card edits whose
  latest event is by Keir are not progress.
- `finish` refuses one `waiting` per card state while card items are paused,
  or idle at found/written with no coding child or CI watch.
- `FINDING_READS` and engineering `READS` add `heal_query`, `heal_count` and
  `heal_collections`, guarded by `rawReadArgs`.

## 5.6.1 (2026-10-16)

### For users

- Progress updates announce work once, when it first runs, instead of on every
  wake. Watch findings are named by what was found, not how they arrived;
  merges name their PR; decision lines use the decision's short summary.
  Watchkeeper's internal reviews no longer post.
- Working-now rows name a ticket's first fix and count the rest.
- The public-page watch no longer files "page could not load" findings when
  the host's browser cannot start; that is reported as degraded monitoring.
- Self-recovery no longer preempts work for a ticket it cannot run (held by
  another operator, claimed by staff or under a directive). Preemption is
  limited to one per ticket per 10 minutes and one per 2 minutes overall, and
  the preempted task resumes after 5 minutes.

### For developers

- `appupdates` seen state records `started`; everything present at the silent
  baseline counts as started. Merge PR numbers come from the `merge:<n>:<sha>`
  effect key when the result has none.
- The `pages` sensor throws on local browser launch failures (missing
  Playwright Chromium after an AHDGame bump), so watch records a sensor error.

## 5.6.0 (2026-10-16)

### For users

- Keir posts short progress updates in the app conversation when ticket and
  Discord work moves: a fix changes stage, a PR opens or merges, work finishes,
  gets stuck or needs you. Bursts are combined; routine updates arrive at most
  every ten minutes, decisions within a minute. Turn them off in Keir controls.
- The Keir chat shows a working-now bar covering all of Keir's work, not only
  this conversation. Expand it to open any ticket or task.
- Choose a model directly beside the desktop/web composer or from the iPhone
  chat menu. Search studio routes including Opus, Sonnet and DeepSeek; keep
  conversation, voice, coding and investigation preferences separate.
- Voice Auto alternates Gemini 3.8 Flash and DeepSeek V4.1 Flash. Typed chat
  preferences cannot silently select Codex for voice. Retries keep their route.
- Install the Windows desktop client from a versioned release, with installation,
  login, model selection, message/history and relaunch checks before publication.
- Keir recovers on his own. A task that keeps re-checking without replying,
  acting or finding anything is nudged once, then parked (tickets wait an hour
  and wake on a player message), stopped (automatic work) or blocked for
  review (work you asked for). A ticket starving behind busy lanes takes over
  the lowest-priority lane. A hold on a decision that is no longer pending is
  released.
- Overdue waits no longer DM you; they stay visible in Ops and the work queue.
- Ticket work reads game records directly instead of filing developer
  handoffs nobody picks up. Questions Keir files land on his own board, and
  decisions reach you first; development work you started never escalates to
  the support delegate.
- Keir never posts an internal finish note as a ticket reply.

### For developers

- `appupdates` snapshots reportable root jobs and ticket status cards on a
  20 second tick. The first scan is a silent baseline. Update messages carry
  `update`, `items` (kind, ticket, jobId, link) and PR cards; pushes for them
  are passive, priority 5 and collapse under `keir-updates`. The thread view
  exposes the cached `team` board and includes it in the long-poll version.
- Skip unsupported directory-handle fsync on Windows while retaining mandatory
  file flushes and POSIX directory durability checks.
- Flush desktop session cookies promptly and isolate voice sends from typed-task steering.
- Add an installed NSIS integration smoke test against the real standalone
  portal and a deterministic worker; archive result and screenshot.
- Preserve standalone configured-route boundaries and studio work-lane locks.
  Selected route labels describe the requested model; Jev selects effort.
- Persist voice sequence at authenticated message ingress and give each voice
  turn its own durable job. Keep bounded same-thread context and in-flight route
  assignments stable; no automatic provider fallback is added.
- `selfrecovery` runs in drain: spin guard (40 rounds without reply, effect,
  read, filing or inbox change), starvation guard (15 minutes past wake with
  every investigation lane busy; lanes held 20+ minutes or non-ticket work are
  requeued) and a stale-decision guard limited to holds with a decision record.
  Recoveries are recorded in `d.recoveries` and `/v3/status`.
- Raw `heal_query`/`heal_count`/`heal_collections` reads for ticket tasks are
  prod only, at most 50 rows, closed to account, auth, ticket, payment and
  audit collections, refuse `$where`/`$function`/`$accumulator`, and redact
  contact, credential and session fields from results.
- Short text helpers run on Codex GPT 6 Luna low with an isolated CODEX_HOME
  instead of metered Muse.

## 5.5.7 (2026-10-16)

- Give Keir roughly 35% more Starmer character, dry wit and evidence-led
  feistiness in conversation and friendly banter. Keep sensitive support
  replies straight and retain the single-catchphrase limit.

## 5.5.6 (2026-10-16)

### For users

- Attach photos, PDFs and text files directly in Keir chat, including messages
  containing only attachments. Preview sent files privately in the app.
- Keep attachment drafts separate between conversations and preserve failed
  sends for retry.

### For developers

- Store bounded uploads privately with authenticated owner access, byte digests
  and conversation/source bindings. Read images, bounded text and selected PDF
  pages through the existing source-attachment tool. File contents grant no authority.
- Deliver bounded file evidence to independent installation workers too, with private temporary image inputs, explicit first-page PDF coverage and native data-class privacy checks.
- Forward binary upload headers through the studio portal. Do not cache private
  attachment responses. Expire unused drafts after one day and inactive sent
  evidence after seven days while retaining files used by active delegated work.
- Add source isolation, auth, integrity, expiry and native draft/send regressions.
- Retry a local-only release tag push and fail before activation when publication fails.

## 5.5.5 (2026-10-16)

<!-- coverage-base: 2d6619524ee1333a71b87cfc0e82a8c5684969a3; coverage-through: release commit containing this section -->

### For users

- Keep a private twelve-hour DeepSeek reflection without publishing its contents
  or granting it authority over work.
- Show the complete current open-ticket snapshot in Activity with search and
  filters for working, waiting, stuck and owner decisions. Keep all live owner
  tasks visible alongside recent results.
- Show the next milestone, scheduled check and overdue review on ticket and
  task details, including evidence-based worker estimates when supplied. Unknown
  completion times are explicit. Review stalled waits
  automatically while keeping ownership and uncertain actions held.
- Run up to three coding tasks and three investigations independently, keeping
  chat and owner-command capacity available while background work runs.
- Measure tokens and approximate API-equivalent costs by model and task, with
  clear coverage for missing usage and models without verified prices.

### For developers

- Include the private reflection from PR #19 in this release. Its atomic private
  store, pause and retry behavior stay intact; usage logs contain counts only.
- Add a cached read-only open-ticket work projection with source freshness and
  coverage indicators, parent/child-aware status, and one safe diagnostic wake
  per material progress change. Timer and text changes cannot erase wait age.
- Replace the native Activity list with a searchable queue and timed work rows;
  include native status/filter tests and a simulator queue regression.
- Derive lane names and the total budget from class capacities. Keep coding
  and investigation pools dedicated and preserve work-record and ownership gates.
- Reserve one host-wide interactive Rust runner slot in addition to the eight
  shared background slots. Resource admission waits automatically without
  replaying uncertain writes or asking for an approval.
- Retain Claude cache creation and Gemini usage in Rust normalization; consume
  structured Codex usage in the Node fallback. Log thrown runner failures too.
- Add a read-only usage CLI and authenticated 24-hour usage endpoint, including
  live scheduling, task finish counts, dated pricing sources and explicit
  short/long-context API-equivalent scenarios separate from actual billing.

## 5.5.4 (2026-10-16)

<!-- coverage-base: 04827df9fb84af2b8dd2fd05e62ee3a8d0cc949a; coverage-through: release commit containing this section -->

### For users

- Automatically verify an interrupted PR publication against its saved patch on
  GitHub, clearing a lost completion receipt without publishing twice.
- Explain that publication verification needs no approval, including in YOLO mode.

### For developers

- Reconstruct complete text postimages from the frozen digest-bound patch in a
  temporary repository, then compare exact Git blob identities at the saved PR
  head. Repository and branch identity must match. Unknown patches stay held.
- Record observed publication separately from merge approval, task completion,
  other uncertain effects and authenticated owner provenance. No write is retried.

## 5.5.3 (2026-10-15)

<!-- coverage-base: 65cb22bf076b17f021541574053aecf4188d7b90; coverage-through: release commit containing this section -->

### For users

- Explain uncertain earlier publications before suggesting a task restart, and
  disable retry until the outcome is verified.
- Restore a completed saved audit report without replaying unrelated actions.
- Keep unproven old approval cards out of task details as well as the main inbox.

### For developers

- Keep all uncertain effects and action states intact during digest-bound private
  report recovery. The recovery receipt explicitly records the retained hold.
- Separate report replay from execution admission; only task retry requires a
  confirmed action outcome. No origin, consent or action receipt is fabricated.

## 5.5.2 (2026-10-15)

<!-- coverage-base: ed32dd88911c4cec72892695adc2a982a035a89d; coverage-through: release commit containing this section -->

### For users

- Answer new authenticated Test and Ping checks immediately without queuing a
  model, while retaining their conversation and task receipts.
- Distinguish blocked work, questions, approvals and waiting updates in live status.
- Keep scheduled goals, watches and briefs quiet while the kill switch is stopped.
- Keep prior evidence when restarting saved tasks, refresh retry deadlines and
  replace expired proposals with a fresh decision instead of reusing approval.
- Report Jev effort selection accurately instead of quoting obsolete route suffixes.
- Guide owner requests to the reviewed ticket, coordinator and GitHub adapters
  instead of redirecting supported work to generic actions or Discord.

### For developers

- Preserve the existing message/job protocol for local connection checks, including
  voice replies and client deduplication. Ordinary conversation still uses its model.
- Do not delete source branches as an unapproved side effect of app merges.
- Include blocked and paused app tasks in the Live Activity projection; unfinished
  work is no longer described as finished. Bind current model answers to the actual
  activation metadata, keeping configured defaults separate.

## 5.5.1 (2026-10-15)

<!-- coverage-base: 58f915df603978df58b46a85743d8ae51c041b8e; coverage-through: release commit containing this section -->

### For users

- Route greetings, test messages and requests for clarification through conversation.
- Restore owner access to task-board status, data inspection, ticket coordination
  and creating incidents directly from an authenticated app request.
- Add Opus, Sonnet and DeepSeek choices with role availability explanations.
  Let Jev choose reasoning effort instead of inheriting route defaults.
- Make pending decisions actionable, remove answered forms from live chat and
  let old blocked tasks restart with current capabilities while retaining history.
- Suggest evidence-backed ongoing goals in briefs, deduplicate suggestions and
  show the next milestone and blocker for each goal.
- Review exact GitHub merge and promotion approvals in the app.

### For developers

- Extend reviewed read adapters without granting arbitrary MCP writes. Verify
  ticket targets before coordinator delivery; guidance never conveys approval.
- Bind app ticket intake to its authenticated original request and reporter,
  with durable deduplication and uncertain-effect recovery fences.
- Bind GitHub approvals to repository, source and target commits. Changed scope
  requests a new decision; existing check and production gates remain required.
- Expose structured attention metadata; restart unproven legacy tasks with new
  origin receipts and supersede old pending approvals without copying consent.
- Add regression fixtures for routing, scoped reads, coordinator holds, incident
  intake, providers, Jev selection, legacy recovery and commit-bound approvals.

## 5.5.0 (2026-10-15)

- Add persistent owner stop/start controls across clients, cancel running work,
  revoke pending actions and suppress queued publications without reviving them.
- Separate provider overrides for conversation, coordination, coding and
  investigation, retain configured defaults and report actual activation routes.
- Add conversation-scoped YOLO grants for supported owner action adapters, with
  exact action receipts and immediate revocation when the setting is disabled.
- Share runtime, routing, approval and skill commands across app, CLI and Discord.
- Expose installed skills and per-work-type selections across model providers.
- Push private-content-free Live Activity status updates and completion to iOS.

## 5.4.2 (2026-10-15)

- Cut over the production source to the consolidated Lakeside Ops repository,
  retaining existing studio services, state, credentials and rollback releases.
- Carry forward the GitHub organization-transfer fix, preserving legacy links
  and receipts while using canonical repository names for new calls.
- Stage immutable agent-only releases before activation and namespace Keir tags
  in the shared repository.
- Port the existing Discord owner-DM transport to independent installations,
  sharing Keir threads and tasks with web and desktop, with scoped cancellation
  and durable reply delivery.

- Add independent project configuration, user-scoped provider credentials and
  state paths to the Rust harness, with exact read-tool lists for custom MCPs.
- Add a standalone Keir conversation/task runtime without studio integrations.

- Add an owner-only AHD Muse persona and authenticated origin receipts that
  survive delegation and restart, without changing Support Keir's persona.
- Show exact action scope and digest in app decisions and source tasks. Owner
  Muse never carries approval from opening text, ticket grants or agent relays.
- Refuse unreviewed public writes, arbitrary commands, iOS build/upload routes
  and support transfers before execution, with explicit task blockers. Preserve
  saved support receipts and authenticated manual browser uncertainty recovery.
- Add typed local workspace drafts. Heal execution remains disabled without
  trusted executor source attestation; generic browser/MCP writes, custom ledger
  repairs and compensation are not reviewed adapters in this increment.

## 5.4.1 (2026-10-15)

- Honor ticket-specific staff takeover before task tools, external effects and
  queued player replies. Preserve the implementation owner and correction
  evidence without resuming the ticket or claiming unrelated work resolves it.

## 5.4.0 (2026-10-15)

- Expand the owner app with model switching, live steering at tool boundaries,
  structured choices, independent tasks, pause/resume, and ticket work details
  with blockers, findings, action receipts and history.
- Add shared computer workspaces with OpenMuse's pinned MIT browser worker,
  owner takeover and exact reviewed browser inputs; isolated HTML previews
  remain network-free inside the task sandbox.
- Return temporary identity-check outages as unavailable instead of signing the
  owner out. Retry APNs delivery failures and retain the feed preference.

- Keep tasks waiting while choices, decisions, approvals or uncertain external
  effects remain unresolved. App selections retain the existing approval identity.
- Journal manual browser inputs before execution, prevent uncertain repeats after
  restart, and retain cancelled uncertain sessions for inspection or explicit discard.
  Clean up completed browser sessions, profiles and downloads with durable receipts.
- Group repeated observer alerts, suppress short transient gaps, and keep raw
  diagnostic payloads out of push notification text.

## 5.3.1 (2026-10-15)

- Owner app ticket instructions now refresh support intake, deliver the original owner message to the canonical ticket task, and return a durable wake receipt with remaining blockers. Repeated sends do not duplicate work, record notes no longer pretend to deliver a handoff, and existing immutable action approvals stay shared across surfaces.

## 5.3.0 (2026-10-15)

- Keir in the owner app reaches parity with Meta's Muse: goals Keir plans into
  milestones and advances on its own cadence; a feed Keir writes (briefs,
  wins, warnings, merges, resolved tickets, watch hits); a daily morning brief
  at the owner's hour (Eastern) with suggested ideas; an approvals queue; what
  is coming up; Files for Keir's written reports and charts; plans shown before
  the work; a live view of each owner task's tool calls; and identity settings
  (tone, brief hour). New owner-only tools: `task_plan`, `goal_update`,
  `feed_post`, `artifact_save`, `idea_suggest`. Briefs and goal progress push.

## 5.2.0 (2026-10-15)

- Owner app channel: the owner's Keir tab in Lakeside Ops talks to Keir at
  `/api/keir/app` (port 9768). Requests are owner-directed tasks like an owner
  DM; replies, status lines and charts land in the app thread, not Discord.
  Every request re-checks the caller's own ops session against the dashboard's
  admin check and accepts only the owner's identity.
- The app answers Keir's open decisions through the same path as the Discord
  buttons, shows the owner alert feed, and registers devices for push. With
  `KEIR_APNS_*` set, Keir's app replies, open decisions (time-sensitive) and
  Watchkeeper incidents (passive) are pushed to the owner's devices only.

- Keir uses the knowledge base better. Support searches run inside the game
  project with headroom before the private-doc filter, so a query no longer
  comes back nearly empty; results are ranked excerpts with a pointer to the
  full entry instead of whole documents. Game knowledge is now opt-in: only
  a-house-divided docs tagged `mechanics` (the KB convention for player-safe
  rules) reach support tasks and the learner. Domain tags alone had exposed
  ticket records and rollout notes; memories, `runbook`, `superseded` and
  `archived` entries never reach support.
- The background learner pages the whole knowledge list instead of the newest
  500 docs, and retires notebook notes whose source doc was deleted,
  superseded or reclassified as internal.
- When code verification replaces a note learned from a KB doc, Keir
  downvotes that doc once per version so it lands in the review queue.
- The brief says when to reach for the knowledge base versus the code index,
  and that code wins when they disagree.
- Keir in the owner app works like a personal agent: separate threads, an
  activity view of every owner task with its steps and receipts (retry and
  stop), result cards for the tickets, PRs, issues and heals a reply touched,
  ideas from Keir's own open issues (accept starts a task, dismiss hides it),
  owner watches that Keir checks on a schedule with a read-only task and only
  reports when met, and a memory view over the notebook where the owner can
  add or remove lessons (`by: owner-app`).

## 5.1.3 (2026-10-15)

- Engineering can read its assigned work card and bounded CI run, queue, job
  and step timings, plus search repository issues for existing ownership.
- New evidence can wake an existing engineering task through an authenticated,
  durable follow-up instead of duplicating work or waiting for its next timer.
  Approval, staff, child-work and uncertain-effect holds remain in force.
- CI evidence preserves exact recorded attempts and marks truncated or
  commit-only associations rather than claiming unverified qualification or savings.

## 5.1.2 (2026-10-15)

- New Watchkeeper audits and Engineering tasks use the existing qualified Codex
  route by default, with independent configuration, after live DeepSeek audits
  exhausted their bounded activation without a result. Observer checks remain
  independent of any model.

## 5.1.1 (2026-10-15)

- Ollama activations stop immediately when the broker accepts their finish,
  retaining refused-completion checks and skipping any trailing tool calls.

### For players and staff

- Watchkeeper independently checks support and game health every minute, keeps
  missed observations through outages and wakes a read-only review when needed.
- Engineering has a separate, bounded work lane for confirmed game findings and
  periodic performance/CI triage, with shared ownership and progress tracking.
  Support keeps its reserved conversation capacity.

- When Keir asks the owner whether to merge one of its own fixes, the yes now
  covers that exact version of the fix and its promotions. Ticket 1559 was asked
  three times because its promotions carried a fix approved this way.
- Keir's issues close when any merged fix references them, not only fixes Keir
  opened.

### Developer notes

- Scoped observer credentials only access role snapshots, observation intake
  and heartbeat delivery. Watchkeeper has its own persisted outbox and systemd
  timer; it cannot write the operator ledger or execute game actions.
- Role tool restrictions are enforced in the broker and inherited by delegated
  children. Engineering can prepare PRs but cannot merge, approve, heal, reply
  to players or close tickets. Both role lanes remain within the existing total
  concurrency budget. Role snapshots and the configured role board cards expose
  actual observations, tasks and outcomes.

- A blocked `needsOwner` finish naming exactly one of the task's own open
  AHDGame PRs opens its decision with `binds: { number, head }`. An approve
  answer records an approved exact `merge` action at that head
  (`decision_bound_approval`), which chain consent and the merge consent check
  both accept. A rejection or a later head binds nothing.
- `issueSweep` reads each open Keir issue's timeline (up to 20 issues) and adds
  merged AHDGame PRs that cross-reference it to the `where` sweep.
- Versioning: PRs add under `## Unreleased` and never bump. `bin/keir-cut.js`
  cuts the train's version once; `test/versioning.test.js` guards it.

## 5.1.0 (2026-10-15)

From the 3.x, 4.x and 5.x performance audit: 5.x ran faster and repeated
itself less, but asked the owner 2.5 times an hour, filed one fault as three
issues and two drafts, and never checked whether its fixes worked.

### For players and staff

- One yes per change. A promotion that carries only economy changes the owner
  already approved, at the exact versions approved, no longer asks again at
  staging and again at main. Anything new in the promotion still asks, and
  economy changes still reach the main server only in the owner's waking hours.
- One problem, one report. Keir's monitoring groups the same error seen by
  different sensors, joins an existing issue instead of filing another, revises
  one draft fix instead of opening a second, and closes its own duplicate
  issues into the first.
- Fixes are checked. A turn problem counts as fixed only after two clean turns.
  A problem still happening after Keir's work on it finished is raised again
  with its history, at most once every six hours.
- Broken monitoring is visible. A sensor failing for an hour, or a heal
  detector failing three times in a row, is logged for staff; one broken
  detector no longer stops the others.
- The daily digest, `/keir status` and the shadow review lead with the
  monitoring score: caught first against player first, median lead time,
  recurrences, verified fixes and dismissed findings.

### Developer notes

- `lib/operator/chain.js`: owner merge and merge-set approvals within 24 hours
  cover a promotion when every non-merge commit in the range belongs to a merged
  PR that is either not huge or approved at its merged head. Direct pushes,
  other heads and delegate-only approvals do not chain. The synthesized consent
  carries the oldest covering approval time into the awake-window gate.
  Audits: `chain_consent`, `chain_consent_missed`.
- Watch: `causeKey` normalizes error text across sensors; `promote` correlates a
  finding under an earlier one with the same cause. `rootOf`, `group`,
  `groupJobs` and `findingByJob` expose the grouping. Recurrence counts new
  observations after a finished task (`RECUR_AFTER` 2, six hour window, three
  per finding) and carries `priorJobs` and the issue. Turn findings resolve on
  `CLEAN_TURNS` processed turns past the last failing one and resolve their
  group (`watch_fix_verified`). Heal detectors are skipped for a day after three
  straight failures. `health()`, `healthAlerts()` and `headline()` feed
  `/keir status`, the digest and `bin/keir-shadow.js`.
- Issues: a finding joins its group's open issue. Keir issues from the last day
  with title similarity 0.2 or more come back as candidates even with `force`;
  `distinctFrom` names the ones judged different (GitHub search lags new
  issues). The hourly sweep closes same-root duplicates into the lowest number.
  `publish_patch` revises the open draft of any task in the finding's group.
- Shadow flags more than three owner decision DMs in three hours.
- `lib/operator/routing.js` locks the coding, investigator and worker lanes
  against models that failed them (deepseek-v4.1-flash, gemini-3.8-flash) and
  falls back with a logged alert. `KEIR_ALLOW_BLOCKED_ROUTES=1` lifts it for a
  deliberate trial.
- `deploy/release.sh` enforces the weekly train via `lib/operator/train.js`: a
  train needs six days since the last train and 24 hours on main;
  `--hotfix "<reason>"` bypasses with a logged reason. Releases are recorded in
  `$root/releases.jsonl`.
- Regression replay in `test/keir-51.test.js`.

## 5.0.10 (2026-10-15)

### For players and staff

- Explicitly reopened support conversations can resume with Keir on their new
  channel after a fresh operator handoff. Earlier closed conversations remain
  archived.

### Developer notes

- Verify canonical reopen provenance, exact guild/channel/topic identity, the
  missing former channel, nonterminal canonical status and fresh acknowledged
  handoff before creating a new support job. Recheck canonical state after
  Discord reads and preserve staff claims, holds and uncertain effects.
- Keep the former job terminal with its outcome and effects. The new job receives
  only the fresh handoff and clean execution/closure state; incorporation stays
  receipted through the existing handoff desk.
- Closed records, stale context, forged/mismatched channels and read failures do
  not revive work. No player state changes or ticket closure are part of adoption.

## 5.0.9 (2026-10-15)

### For players and staff

- Repeating the same developer status cannot disguise stalled work by changing
  its timestamp.

### Developer notes

- Base progress on changed status content, assignment, lane or evidence rather
  than timestamp-only updates. Normalize spacing and case to avoid empty wakes.
  Retain the original no-progress clock across repeated identical updates.
- Regression reproduces a repeated status incorrectly suppressing the deadline;
  changed progress still wakes the originating task.


## 5.0.8 (2026-10-15)

### For players and staff

- Blocking developer questions retain an accountable originating task instead
  of disappearing as completed when they are merely filed.

### Developer notes

- Observe explicit developer handoffs every five minutes without model polling.
  Acceptance, progress and evidence-backed completion wake the originating task.
  Thirty-minute acceptance and two-hour progress deadlines produce one recovery
  wake and visible alert for unchanged work. Re-filing cannot reset the clock.
- Preserve deduplication across restarts and recover from failed queue reads.
  Completion requires verification by the originating task, not automatic closure.
- Preserve staff holds, prompt player replies, pending decisions and uncertain
  write protection. Legacy explicit developer reply waits are adopted; arbitrary
  historical issue filings are not reclassified.


## 5.0.7 (2026-10-15)

### For players and staff

- Repair approval requests remain available for a day instead of disappearing
  after nine minutes. The normal three-hour delegate escalation still applies.

### Developer notes

- Separate heal consent lifetime from the short dry-run token lifetime. Apply
  still replans for a fresh token, checks the exact target count and plan digest,
  and records one execution. A changed-state plan requires fresh confirmation.
- Keep money approval policy unchanged. Reuse an existing exact approved action;
  have the coordinator apply a guarded admin repair from the authenticated
  owner instruction when no action approval is recorded. No automatic money
  approval is added.
- Actual broker and decision regressions cover late approval, fresh-token apply,
  stale-plan refusal, expiry, delegate approval, reject, explain and cancellation.


<!-- Coverage: base b8fdc9602adfb516126a5ee9b3397f61de18b7f8. -->

## 5.0.6 (2026-10-14)

### For players and staff

- Internal investigation updates no longer make Keir repeatedly check a ticket
  as though the player had sent a new unanswered message.

### Developer notes

- Handoffs, CI and turn events, and delegated worker results wake the task
  without advancing its human reply clock. Retained source provenance repairs
  previously contaminated timestamps without discarding a real human reply.
- Actual activation regressions verify six-hour event waits, preservation of
  internal evidence, and immediate handling of a human reply at the same time.

<!-- Coverage: base 416bdea39188717c6fc80c95d0ce357743cce5da. -->

## 5.0.5 (2026-10-14)

### For players and staff

- New investigation evidence handed to Keir clears an earlier closing grace
  period, so an unresolved ticket cannot retain its old ready-to-close marker.
- Sector loss explanations must distinguish recorded accounts from estimates
  based on recipe weights and current commodity prices.

### Developer notes

- Handoff invalidates resolution readiness and stale reply-wait metadata while
  retaining delivered-answer receipts. Repeated handoff IDs stay idempotent
  and cannot reset a later answer. Reopening emits a durable audit event.
- Brief guidance requires actual P&L units/turns for cost claims and a prepared
  parent snapshot before delegated code investigation. These instructions
  supplement evidence checks; they do not prove a model's causal explanation.
- Regression covers reopening, delivery preservation and duplicate handoffs.

<!-- Coverage: base a37c999eeba29b8b3e4665bfc504ceec9be0e910. -->

## 5.0.4 (2026-10-14)

### For players and staff

- Early progress cards say Keir is investigating and checking the next step.
  Reading initial evidence no longer claims a cause is proven or a fix is
  already being written.

### Developer notes

- Keep the persisted first-stage identifier and existing evidence/release gates;
  correct its rendered label, next-step text and model-facing description.
- Regression replay renders the initial Illinois investigation card and checks
  that it makes no unsupported cause or coding claim.

<!-- Coverage: base 91ba7203d333c18e8e0945497efd37e056b36233. -->

## 5.0.3 (2026-10-14)

### For players and staff

- Ticket claims from the owner now pause automatic work just like staff claims.
- An explicit handoff back to Keir releases the prior claim and activity hold.
  Reading the earlier claim in history cannot take the ticket back again.
  A new claim after the handoff still takes precedence.

### Developer notes

- Canonical bot claim recognition includes ownerId, retaining author, bot and
  webhook provenance checks. Gateway ingestion, adoption, history and write-time
  authority checks use the same claim release timestamp.
- Handoffs retain their existing approval invalidation and idempotent receipts;
  they clear the old claim and staff activity hold, without granting authority.
- Live claim and handback regressions cover forged messages, historical replay,
  history reconciliation, quiet deferral and a subsequent fresh claim.

<!-- Coverage: base 4998faeb0c71475791e9969f800baeb6e03e5cc8. -->

## 5.0.2 (2026-10-14)

### For players and staff

- Tickets waiting for a player or developer reply stop repeating the same
  investigation every fifteen minutes. New replies wake the task promptly;
  a bounded safety check keeps the wait from being forgotten.
- Existing owner decisions remain open while Keir waits for the answer.
- Recurring turn failures stay attached to their investigation across turns
  instead of consuming more investigation slots for the same fault.

### Developer notes

- Honor explicit ordinary waits up to one day and structured player/developer
  reply waits up to six hours. Keep the fifteen-minute fallback for ordinary
  unspecified waits. Unanswered evidence, fresh inbox entries, CI and turn
  subscriptions, approvals and promotion windows retain their wake behavior.
- Stable phase identities span turns. Exact substantive error text may correlate
  phases only with matching phase/turn evidence. Generic and conflicting signals
  remain separate. Upgrade retains historical jobs, issues and budget receipts
  while selecting the active investigation for future observations.
- Clear reply-wait metadata when messages arrive or execution resumes, including
  activations that abort before finishing. Waiting no longer withdraws pending
  owner decisions.

<!-- Coverage: base fe53a78bb1e8c37129b5aa1c5965bb55de2a5373. -->

## 5.0.1 (2026-10-14)

### For players and staff

- A staff member telling Keir to stop in a ticket now stops its task and
  delegated work immediately, without queuing another acknowledgment.
- Keir keeps quiet during staff-to-player conversation after a claim or stop.
  An earlier conversation or classifier verdict cannot turn "Sure" into a job.
- New ticket investigations respect the existing ten-minute staff activity hold.
  Running automatic work yields to that same hold.

### Developer notes

- Recognize authenticated ticket-scoped stop controls before classification,
  including Keir/Keith names, mentions and replies. Cancel the ticket tree,
  withdraw unexecuted approvals and queued replies, clear conversation leases
  and revoke carried ticket authority. Retain receipts and uncertain effects.
- Explicit new staff requests remain supported. Players, quoted text and
  historical messages cannot cancel staff tasks or reactivate stopped work.
- Admission and runtime interruption share the staff hold decision, including
  delegated children. Briefs distinguish a staff explanation from a request.
- Regression replay covers stop aliases, child cancellation, classifier bypass,
  historical adoption, idempotency and preserved external-effect receipts.

<!-- Coverage: base 1877f370791e58696a9edeeaf390e63c07320aac. -->

## 5.0.0 (2026-10-14)

### For players and staff

- Keir can detect failed turns, recurring warnings, accounting invariant
  breaches, production errors and broken public pages before a player files
  a ticket. Related findings are grouped and repeated reports are deduplicated.
- Findings can lead to a public bug report, a draft fix and a prepared repair
  plan. Only a finding's verified display-only fixes may ship unattended;
  economy changes and repairs keep their existing approval gates.
- Investigations return their checkpoint instead of retrying indefinitely.
  Read-only investigators no longer wait behind the sole coding lane, and
  parent tasks yield while their delegated work is active.
- An owner or staff approval can carry non-huge steps on the same ticket for
  a week. Huge changes still require approval for the exact step and revision.
- Public issue reports protect player identities and private operational data.
  A ticket's fix is only called live after the appropriate deployment is proven.

### Developer notes

- Deterministic watch sensors run at startup, after processed turns and on
  bounded cadences. Failed turns remain observable when the turn counter
  stalls; warnings require distinct turns. Invariants group by rule, findings
  are capped at three per hour and eight per day, and severe findings create
  staff proposals. Report mode records observations without creating tasks
  or proposals. Sensor status includes freshness, failures and bounded retries.
- Delegations stop after three exhausted activations or one hour queued or
  waiting, preserve checkpoints and settle their parent once. Staff holds
  propagate from the root ticket; idle orphaned children are cancelled.
  Existing slot reservations and work-record locks remain enforced.
- CI subscriptions share a repository/PR read per polling tick and wake on
  failure immediately. Staging-to-main may reuse identical-tree qualification
  only with verified native Actions provenance, current PR/head/base and merge
  tree, and trusted workflow/helper blobs. Missing proof uses normal checks.
- Byte-identical ledger saves skip redundant file and directory fsyncs;
  changed receipts remain synchronous and failed commits retry.
- Watch repair specifications are non-executable. Static-display shipping
  authority is scoped to the finding. Incident proposals require staff action.
- Carried consent rejects negative, quoted and replayed instructions. Huge
  approvals bind to the exact step and head. Repair risk derives from detector
  metadata and actual affected counts. Public issue filing deduplicates and
  fails closed when identity or search evidence is missing.
- Issue and Sentry closure require complete PR-file discovery and successful
  service-specific deployment evidence. Sentry writes require event:write;
  a read-only token is refused cleanly. Watch queries production game errors.
- Six pinned runner skills load by lane and degrade safely when unavailable.
  Runner briefs retain delivery and size receipts.
- Retains all 4.1.19 behavior, including the returning-player greeting and
  ticket-channel existence confirmation. Node and Rust versions are 5.0.0.

<!-- Coverage: base 97c0c90ba0bc5232d172507458ed7df9dd74b031;
     audited feature source 5dbc0d27d8cb496efbe1a2ef4435388631bf966f;
     reconciled source 2fc5856. Release metadata follows this source. -->

## 4.1.19 (2026-10-14)

- Keir remembers people across tickets (owner). A player hears the
  introduction once, with "Thank you for submitting your first ticket"; after
  that the first post is "Welcome back, Name. This is your Nth ticket, thank
  you for submitting it." Counts come from every ticket the player has filed,
  including ones from before Keir. Staff and the owner filing a ticket get no
  introduction. A failed lookup falls back to the full introduction.

## 4.1.18 (2026-10-14)

- A ticket is only treated as closed when Discord says its channel is gone.
  The scan reads the channel list once, so a ticket opened during a scan
  (1555, which Keir opened for the owner) was missing from it and its task
  was stopped as "closed externally" within seconds.

## 4.1.17 (2026-10-14)

- Developer changes reach the ticket (owner: when Ariane or anyone else ships
  a related fix, report it in the channel). Every five minutes Keir reads
  merged AHDGame pull requests it did not open itself, links each to open
  tickets it names or, failing that, that Jev judges the same problem (bar
  0.4, calibrated on today's merges), and tells the ticket task at each stage:
  in testing on dev, on the sandbox, live on the main server.
- "Cause found" on a status card needs three reads of game state, data or code
  for the ticket first. Ticket 1553's card claimed a found cause one second
  after it opened.

## 4.1.16 (2026-10-14)

- A ticket post asking the player which bank, company or page they mean, or
  for a link, is refused once when the ticket already names the reporter's
  company, the page they filed from or pages they visited; the refusal lists
  them. Asking again after checking goes out (ticket 1553 asked "which
  bank" with corporation 823 on the ticket).

## 4.1.15 (2026-10-14)

- Anything waiting on the owner reaches him. raise_to_developers takes kind
  "decision" with a one-line question; it files the kanban item and opens a
  decision DM (owner, Ariane after three hours), which also lists it under
  "Waiting on you" on the hub. A compensation, refund or ruling filed without
  it is refused. The ticket 1539 compensation request sat on the kanban where
  the owner never saw it.

## 4.1.14 (2026-10-14)

- A mechanics ticket with a fix pull request in flight gets its status card,
  like one Jev tagged as a bug report (ticket 1552 was refused its card).

## 4.1.13 (2026-10-14)

- Ollama Cloud runner (`ollama:<model>@<effort>`): calls ollama.com directly
  with the Ollama Cloud key and runs the tool loop itself against the
  activation's keir tools; images a tool returns go back as image messages,
  so it serves the vision lane too. Low effort turns thinking off. Coding,
  investigation and vision move to DeepSeek V4.1 Flash (owner: Luna is too
  slow). Live check: screenshot read and a two-line fix in 7 seconds.

## 4.1.12 (2026-10-14)

- Finished commands, conversations, probes and coding tasks leave the ledger
  after six hours instead of seven days; tickets keep the week. The ledger
  had grown to 6.6 MB and every save rewrote it synchronously, about 80 ms a
  save, which kept the operator near one full core under load.
- release.sh publishes a GitHub release for every tag, with its CHANGELOG
  section as the notes (`bin/release-notes.js`). Every tag back to 1.0.0 now
  has one.

## 4.1.11 (2026-10-14)

- A decision DM names its ticket once when the summary already starts with it.

## 4.1.10 (2026-10-14)

- Ticket wakes are debounced 45 seconds, so a burst of player messages is
  one activation instead of one each (ticket 1550 woke 16 times in 12 min).
- Staff talking in a ticket without naming Keir hold its task for ten
  minutes; naming Keir or mentioning it wakes it at once.
- A third investigation slot for tickets (seven slots in total).
- support_resolve refuses to close while the player's last question or
  staff ping is unanswered (ticket 1542 closed on a player still confused).
- KEIR.md: feedback tickets close after the answer and filing; a
  player-blocking design call finishes blocked so the owner gets a decision
  DM; an unanswered staff ping after fifteen minutes is Keir's to answer;
  check the code before advising an irreversible step.

## 4.1.9 (2026-10-14)

- raise_to_developers checks Keir's open items from the last three days
  first and offers likely matches; the driver appends its evidence to one
  (`appendTo`) or files anyway (`force`). The financial margin squeeze was
  filed twice an hour apart.
- The ticket label is not added twice when the title already names it.

## 4.1.8 (2026-10-14)

- support_action maps loose tool names ("public_update", MCP prefixes,
  `name` for `tool`) and, when it refuses, names the allowed tools and the
  call that answers a player (ticket 1542: Spark was refused and slept).
- A vision run that leaves the player unanswered hands back to the driver
  within a minute instead of sleeping fifteen.

## 4.1.7 (2026-10-14)

- "The developers have it" now needs a receipt: a post that says so is
  refused unless the ticket raised it (`raise_to_developers`, new), synced
  its tracker, or has an owner decision. `raise_to_developers` files a
  kanban item on the developers' queue. Ticket 1540 told a player the
  developers had a gap when nothing had been filed.

## 4.1.6 (2026-10-14)

- Sign-off DMs read "Sign-off to ship" with their TL;DR (the TL;DR re-render
  dropped the header), and Ariane's escalated copy says it is hers to sign
  off on Egg's behalf.

## 4.1.5 (2026-10-14)

- A promotion to main with nothing in its range asks for no sign-off
  (ticket 1514: a redundant ask then held back the closing message).

## 4.1.4 (2026-10-14)

- `execute_action` on an approved merge or promotion now points the driver
  back to the github tool instead of running it as a host command, which
  failed and spent the sign-off (ticket 1514, approved by Ariane).

## 4.1.3 (2026-10-14)

- The vision lane now reads the screenshots and hands the task back to its
  driver on the next activation (`vision_lane_released`); a new screenshot
  routes it once more. It used to keep the route for life, so one image left
  ticket 1540 on Spark, which found the answer three times and never posted
  it.

## 4.1.2 (2026-10-14)

- The progress card no longer counts as a post for the ten-minute rule, so
  it cannot hold back the answer it announces (ticket 1540: a card said
  "posting the explanation" and the explanation then waited ten minutes).
- A mechanics question gets a direct answer, not a fix-progress card; the
  card is refused on a mechanics ticket unless Jev read a bug report.

## 4.1.1 (2026-10-14)

- A message that reaches a task while it is running (a handoff, a staff
  note) no longer stays unread when that run settles as blocked: the next
  pass requeues the task (`requeued_for_inbox`). Ticket 1522 sat blocked for
  an hour with an unread handoff.

## 4.1.0 (2026-10-14)

- Related tickets and incidents (owner): before a new ticket's first model
  run Keir compares it, in one bundled Jev call, with the other open tickets
  from the last day. A clear match (85%+) merges the newer ticket into the
  older one. Three or more related tickets that Jev rates outage class
  (game, turns, logins, money or the economy broken for many players, or lost
  data) become an incident proposal in #mod-bot that pings Server Moderator,
  Head Moderator and Developer. Any of them (or an admin) reacts ✅ to open
  it or ❌ to decline; a severe proposal nobody answers opens after ten
  minutes. On opening, every ticket in the cluster merges into the incident;
  on a decline they merge into the oldest ticket. A spike of public problem
  reports on one topic (four players in half an hour) becomes a proposal
  too, which opens only on a staff ✅. New tool `merge_related` lets the
  driver merge into an older related ticket. Audits: `related_checked`,
  `merged_related`, `incident_proposed`, `incident_opened`,
  `incident_declined`.

## 4.0.0 (2026-10-14)

Keir 4.0: the cutover. Every lane runs through the Rust runner, Opus 5.5
drives, Muse Wonder Full 1.0 codes and investigates, and nothing reaches the
live server without a human check-off.

- Sign-off to ship (owner): every promotion to the main server needs a yes
  from Egg or Ariane. One "Sign-off to ship" DM per promotion, to the owner
  first and to Ariane after three hours unanswered; economy work signed off at
  merge carries through. Egg or Ariane saying ship in a ticket channel (or
  naming the ticket) is the sign-off by itself, and Ariane's `Keir approve`
  carries the owner's authority, recorded on his behalf. Audits:
  `ship_signoff`, `ship_signoff_said`, `ship_signoff_direct`.
- Approval DMs clean themselves up: every copy is deleted once answered,
  expired or no longer needed, so the DMs hold only live questions. Requests
  expire with their action (24 hours) or after two days without one; the task
  hears once and does not ask again. Audit: `decision_expired`.
- First message in a ticket (owner): before Keir's first post in a new ticket
  it posts once that it can look into the problem, help work out whether it is
  a bug and prepare a fix, but cannot promise a resolution without a developer
  or moderator. Tickets Keir already spoke in are unchanged.
- Investigator subworker: `delegate_investigation` hands one bounded question
  to a read-only child (code in a snapshot, live reads, history, past
  tickets) on `KEIR_INVESTIGATOR_PROVIDER` (default: the coding model). Its
  report wakes the driver, who checks the evidence and keeps every reply.
- Routing defaults: coding and investigation on
  `muse:muse-wonder-full-1.0@medium`; the live driver is
  `claude:claude-opus-5-5@high` by configuration.
- Keir clears its own dead ends: a probe or benchmark left blocked is
  dismissed after an hour, and a blocked subworker whose report reached its
  parent after half an hour (`job_dismissed`).

## 3.6.0 (2026-10-14)

- Incident tickets (owner): moderators and developers open an incident for an
  outage or another problem many players hit at once; repeat reports merge
  into it. Keir recognises the incident category, never runs automatic ticket
  work in an incident channel (staff own it; developers can still summon Keir
  there), and before a new ticket's first model run asks Jev, in one bundled
  call, whether the report is the same problem as each open incident. One
  clear match at 85% or more merges at once through `support_merge` with no
  model tokens spent; plausible matches go to the model as
  `incidentCandidates` with a `merge_into_incident` tool. Developer tasks may
  merge another report. Audits: `incident_checked`, `merged_into_incident`.

- Vision lane (owner decision): a task whose screenshot matters runs on Muse
  Spark 1.3 standard (`KEIR_VISION_PROVIDER`, default
  `muse:muse-spark-1.3@medium`). It scored 32/32 on the vision benchmark and,
  unlike the contributor tier, does not train on submitted data, so player
  screenshots stay off it. Routed once per task, audited as
  `vision_lane_routed`; coding children are never rerouted. The Rust
  `vision` role defaults to the same model.
- The Keir hub moved from a published report to a live ops dashboard page
  (`/keir`, LSGD-ops-dash). The report publisher and its timer are removed.

## 3.5.2 (2026-10-14)

- Muse reads screenshots (vision benchmark 2026-10-14: Wonder Full 31/32,
  Spark 1.3 and Spark 1.3 contributor 32/32, contributor fastest at 5 s
  median). The Muse-to-Claude vision swap added in 3.5.0 is removed and the
  Rust capability table marks Muse as vision-capable with an MCP client. The
  Muse trace adapter now reads `run.terminal.completed` text, so Muse runs
  report their final answer.
- Repo maturity (owner, 2026-10-14): README and CONTRIBUTING; one version in
  `package.json` and `rust/Cargo.toml`, checked at release; `deploy/release.sh`
  tags `vX.Y.Z` when it cuts a release; missing tags for 3.0.0 through 3.5.1
  created on their version-bump commits.
- Keir hub page on the ops dashboard (`/reports/keir-hub`, every two minutes):
  live workers with runner and provenance, owner decisions pending, open
  tickets with status card stages, Keir's pull requests with CI state,
  referenced GitHub issues, matching kanban items, recent finishes.

## 3.5.1 (2026-10-14)

- Phase 5 ticket canary: `KEIR_RUST_RUNNER_TICKETS` narrows the worker lane
  on the Rust runner to named tickets (empty means every ticket). Owner
  commands without a ticket follow the lane; probes need their own entry.
  The shadow report records the operator release it ran against.

## 3.5.0 (2026-10-14)

- Jev, the box's typed-decisions router, now saves model tokens and adds
  analytics in three places (owner, 2026-10-14). Intake tagging: one
  bundled call on a task's first activation gives work kind, whether the
  screenshot matters, economy exposure, urgency, mood, complexity and an
  injection flag; tags ride in the context, set reasoning effort without a
  second call, swap a Muse worker to Claude when the screenshot matters,
  and land in the event sink (`intake_tagged`). Outgoing screen: every
  ticket post gets a semantic read for internals leaks, stated certainty
  without a receipt, talking past the player and tone; a decisive leak is
  refused, the rest are proposed labels (`post_screened`). The Rust shadow
  report counts both. Everything fails open.
- Ticket posts have a shape, enforced in code (owner, ticket 1539: two
  800-character walls of text a minute apart, no paragraphs, a public
  "Correction to my message above"). At most five short sentences and 700
  characters; text without paragraph breaks is reflowed into two-sentence
  paragraphs; longer text is refused with the reason. One post per task per
  ten minutes unless the player writes or Keir asks them something. A
  correction is one or two sentences and is never followed by the essay.

## 3.4.0 (2026-10-14)

Keir 4.0, phase 4: canaries on the Rust runner.

- `KEIR_RUST_RUNNER_LANES` (quick, worker, probe): activations on those
  lanes run through `lakeside activation`, which keeps the model loop, the
  trace and admission in Rust while this operator keeps the job, the tools
  and the ticket. Provenance lands on the job (`provider.via = "rust"`) and
  in a `rust_activation` audit; the result is the Claude-shaped record the
  agent already consumes.
- `lakeside run`: `--parent <task>` enforces that a child's grant never
  widens its parent's; coding attempts record the base SHA, refuse a dirty
  tree, and hand off their diff as `harness/patches/<attempt>.diff`;
  `write_file` joins `shell` under the coding grant with the sandbox notice
  the Muse coder needs.
- Canaries on the live box: AHDGame research (Sonnet, 22 s, cap found at
  `rules.ts` and the policy schema), AHDGame coding in a registered
  worktree with a targeted vitest run and patch handoff, parent-grant
  denial, main-checkout and missing-input refusals, timeout kill.

## 3.3.0 (2026-10-14)

Keir 4.0, phase 3: the Rust runner and the `lakeside` CLI. The Node
operator gains one endpoint; the rest is the Rust workspace.

- `POST /v4/tool-session` (admin token) lends an existing job's tool policy
  to the Rust runner: the same loopback endpoint a Claude activation gets,
  bound to the job, a tool subset and a 30 minute abort. Policy, receipts
  and the publisher stay in the broker.
- `rust/crates/harness-runner`: per-attempt loopback MCP endpoint with an
  unguessable path; tool backends (Node toolserver proxy, and a workspace
  backend with read, list, search, shell, read-only MCP and `finish` under a
  capability grant, refusing pushes to permanent branches, force pushes,
  host changes and broad deletes); provider invocations mirroring the Node
  operator (Claude stream-json, Codex `--json`, Muse `exec --json`,
  Antigravity) with built-in tools off and subscriptions only; trace
  normalisation, quota detection, host slot admission shared with
  `provider-agent-run.sh`.
- `lakeside` CLI: `run` (project, role, owner-selected route, grant, images,
  worker manifest with base SHA and clean-tree check for coding), `tasks`,
  `show <attempt>` (full trace), `vision-bench` (the held-out screenshot
  corpus, scored per subscription route).
- Smokes on the live box: Claude Sonnet researcher 16 s, Codex SOL 35 s,
  Muse Wonder Full 51 s, all with loopback tool calls and a structured
  finish.

Keir 4.0, phase 2: the Rust harness core, in shadow. Not part of the Node
release; built and pinned separately by `rust/deploy/build.sh` and run by
`keir-shadow-rs.timer` every ten minutes.

- `rust/crates/harness-core`: pure domain for the shared Lakeside harness.
  Blast radius classes and the promotion gate (a twin of
  `lib/operator/blastradius.js`, proven on one shared fixture), status truth
  (release stages, publisher phases, receipt-bound claim kinds), the durable
  task graph (leases, typed waits with deadlines, delegation depth and fan-out
  limits, cascading cancel, restart recovery that never re-runs an uncertain
  effect), owner-selected routing with provider capabilities and data classes
  (subscriptions only; player personal data never to a training-tier
  provider; images never to a vision-weak model; no silent substitution),
  outcome labels with policy version and censoring, and completion metrics.
- `rust/crates/harness-store`: read-only projections of `ledger.json` and
  `events.db`, the harness's own `harness.db` (shadow runs, append-only
  labels, decision comparisons) and a read-token MCP client.
- `keir-shadow-rs`: one pass compares Node's status card stages against
  release facts, the 4.0 gate against every approved economy promotion to
  main (counterfactual before 3.2.0), labels every ticket, computes cohort
  metrics, and writes `shadow-rs/latest.json`, `history.jsonl` and
  `harness.db`. No side effects.

## 3.2.0 (2026-10-14)

Keir 4.0, phase 1. Built from a full read of the live ticket transcripts
(1507, 1514, 1522, 1527, 1531, 1537) and shipped at 4.0 build pace by owner
decision; the weekly release train starts after the 4.0 cutover.

- Blast radius classes. Changes are classed by the files they touch: copy and
  display, logic, or economy and turn worker. An economy promotion to the main
  server runs only in the owner's waking hours (Eastern daytime), on an
  approval under three hours old, or on an explicit night pass from the owner;
  otherwise the broker holds it and wakes the task when the window opens.
  Inherited merge consent is no longer awake evidence by itself (ticket 1498:
  an overnight economy promotion the owner reverted half asleep). No
  simulation gate; the owner ruled it unnecessary.
- Status words bound to receipts: "being built" needs a coding attempt that
  can write, "written", "ready" or "in testing" needs a pull request. Ticket
  1514 said "still being built" for five hours while every pass was read-only.
- Player register checked in code: source paths, repository names, model and
  provider names, internal tools and URLs, and talk about Keir's own runtime
  are refused before posting (tickets 1531, 1522, 1507). A player is addressed
  by their Discord name exactly or not at all ("Simon" for "Simonella").
- Blocked on the owner means one notice, then silence until the decision
  lands or the player writes (1514 posted "still waiting on your call" three
  times in four hours). After three consecutive Keir posts with no human
  reply, progress goes on the status card (1514: 52 Keir messages to 4 human).
- Durable event sink: every audit entry and delivery is appended to
  `events.db` beside the ledger with task, attempt, ticket and release
  identity. The ledger stays the authority for running state; this is the
  evidence trail the 4.0 shadow will read.

## 3.1.4 (2026-10-14)

- A pending approval request left on a finished task no longer counts as
  "already in the owner's DMs"; such requests are withdrawn at startup and
  when their decision is withdrawn. One had blocked every staging promotion.
- Patches larger than one sandbox output window (24,000 characters) are read
  in chunks for review and publication, up to 2 MB, instead of the fix being
  compressed to fit.

## 3.1.3 (2026-10-14)

- Progress card: live on the main server is the last step, so a live fix
  shows a full green bar; "confirmed in game" is a tag on that step, not a
  further step that looked pending. Footer reads cleanly beside Discord's
  timestamp.

## 3.1.2 (2026-10-14)

- One ask per approval: merges and promotions that need the owner go straight
  to the github action's exact decision; no separate free-form review question
  first (ticket 1537 asked twice for one merge).

## 3.1.1 (2026-10-14)

- A model provider's quota running out (Muse 429 "usage window resets at")
  parks the task until the stated reset, then it resumes by itself, instead
  of blocking the ticket. At most two hours per wait.

## 3.1.0 (2026-10-14)

Keir 3.0 went live on 2026-10-13 and took the full support desk when the
interim Codex operator was retired. 3.1 is what the first live hours taught.

- Ticket progress card: one embed per ticket, edited in place, listing each
  fix with a progress bar, the milestone reached and what happens next, or
  why it is paused. Release milestones need receipts; names and notes are
  checked for technical terms. CI waits refresh the card instead of posting
  "still testing" messages, and every open ticket is prompted to keep a card.
- Runs from pinned releases (`deploy/release.sh`, `/opt/keir/current`);
  merging to main changes nothing live, and install never starts a paused
  Keir.
- Support ownership and handoffs (`bin/keir-handoff.js`): desk transfer with
  receipts, per-ticket holds for another agent, and per-ticket model choice.
- Six admission lanes (two conversation, owner, two investigation, coding)
  inside the six-slot budget; tickets awaiting a first reply go first.
- Resume safety: stale approvals superseded on handoff, old commands and acks
  not replayed after a pause.
- Stall fixes found by shadowing: GitHub reads for inherited tickets, turn
  watches no longer wait an extra turn, unreadable CI watches end, and the
  coding subworker writes through Keir's shell.
- Models are configuration: Muse Wonder Full 1.0 coordinates and
  investigates, Muse Spark 1.3 Contributor codes, conversations rotate across
  GPT 6.1 SOL, Muse Wonder Full 1.0 and Claude Sonnet 5.5. `/keir status`
  says what Keir is running on.

## 3.0.0 (2026-10-13)

One canonical work record per ticket or request, with model activations and Luna
jobs as bounded attempts. This release is implemented and tested while Keir is
paused; activation still requires the shadow soak, bench gate and canary in the
readiness report, then explicit owner authorization.

- Work records over the v1 ledger (`workrecord.js`, `bin/keir-workrecords.js`):
  every legacy job maps to exactly one record; public activity, waits and
  approvals are record-level. Startup logs the integrity report (read-only).
- Responsiveness baseline (`metrics.js`, `bin/keir-metrics.js`) with verdicts
  against the 3.0 budgets, and fast-lane admission (`admission.js`) reserving
  conversation capacity with an anti-starvation aging bound.
- WorkCoordinator (`coordinator.js`): idempotent event intake, single mutating
  lease, checkpoints, supersession without evidence loss, receipt-gated closure,
  and crash reconciliation that flags uncertain effects instead of retrying.
- Correlation waits (`waits.js`) with mandatory deadlines; stale PR heads become
  history and can never advance current work.
- EffectGate (`effectgate.js`): typed, digest-bound approvals. The same identity
  is asked once and reused explicitly; material changes ask again; unknown kinds
  fail closed; completed promotions retire only exactly subsumed requests.
- Deterministic status publisher and no-model ack (`publisher.js`): phases derive
  only from verified state, one message per transition, waits refresh by edit.
- Release Copilot (`release.js`): promotion scope manifests flag unrelated
  sensitive scope; web, worker and desktop gates never infer each other.
- Proactive Sentry (`watches.js`), ticket clustering (`clusters.js`), SLA clocks
  with breach forecasting and the later-turn fix verification loop (`sla.js`).
- Handoff Desk (`handoffs.js`): filed, acknowledged and incorporated are separate
  receipted facts; long handoffs are document-backed, never truncated.
- Judgment bench gate (`benchgate.js`), record-level shadow (`shadow3.js`), and
  a dry-run-first ledger migration rehearsal (`bin/keir-migrate-v3.js`) that
  preserves pause and rolls back by restoring its backup.
- A full ticket lifecycle replay test exercises all of the above together.

- Keir 3.0 stage A (no behavior change): a pure work-record projection derives one
  canonical record per ticket or request from the v1 ledger, with jobs as attempts,
  shared public-activity receipts, correlation-keyed waits and pending approvals.
  `bin/keir-workrecords.js` prints a structural integrity report proving every job
  maps exactly once, and flags stranded CI watches, stale coding children and
  freeform-plus-action double asks. The running operator does not read it yet.

- Owner closure tasks can use the same ticket coordinator's verified final answer;
  the closure grace period, staff ownership and unread-player checks still apply.
- Waiting statuses keep their existing message when a PR gains another commit.
  The refresh interval and uncertain-delivery protections also survive that change.
- CI waits longer than ten minutes publish one player-safe ticket status. Further
  waits edit that same status at most every fifteen minutes, respecting staff
  ownership, recent updates and pause. Delivery failures are isolated from the
  investigating task, and no model call is needed for these status updates.
- Notebook handoffs retain up to 4000 characters without silent truncation;
  longer notes explicitly require a document and sourced summary. Curation uses
  the same bound, preserving escalation criteria and figures near the end.

- Desktop coding sandboxes mount workspace-local npm dependencies read-only as
  well as root dependencies. The brief documents Vitest's config runner option
  so bundled configuration does not try to write into read-only node_modules.

- Desktop PR reads, green-check merges and CI watches use AHDClient rather than
  an unrelated game PR with the same number. Developer-owned tickets can inspect
  desktop history before opening a patch. Source merges remain distinct from
  published client releases and cannot justify a player-facing "live" claim.

- SOL remains the primary investigator, reviewer and communicator. Concrete
  fixes delegate to restricted GPT 6 Luna medium coding tasks with separate
  snapshots. SOL inspects and applies the exact patch digest, independently tests
  it, and handles publication and replies. Coding tasks cannot contact players,
  publish patches, merge, heal or investigate player data.
- AHDClient is registered for desktop investigations by owner/developer tasks,
  including tickets opened on a developer's own behalf. Refund decisions retain
  their existing gates.
- Six worker slots share a 24 GiB memory cap and 20 GiB soft limit, with a six-core
  CPU ceiling, scheduling weight 500 and task limit 2048. CPU weighting is not
  an exclusive host-core reservation.

- Delivered ticket updates now mark the public reply as complete, preventing an
  automatic finish summary from repeating the same finding. Ticket finish
  fallbacks obey the existing copy, evidence and duplicate-post guards.
- Direct Starmer identity questions enter the quick conversation lane. A bare
  developer mention can point to their immediately preceding unanswered
  read-only question; stale questions, other users and action requests are not
  inherited. Addressed character banter is no longer classified as human-only.
- With parallel workers, the last slot prefers ready automatic support work,
  preventing a developer backlog from starving tickets. It returns to ordinary
  work when support is idle or deferred; other workers retain developer priority.

- Keir's system brief preloads a sourced Starmer character biography and broader
  voice cues: public service, prosecutor's precision, delivery, country first,
  and occasional toolmaker callbacks. The persona is available in every model
  activation; it does not depend on notebook retrieval.
- Character play keeps identity honest when asked directly and preserves all
  evidence and authority rules. Conspicuous Starmerisms stay sparse, with no
  consecutive repetition or jokes in sensitive reports and unresolved losses.

## 2.6.0 (2026-10-13)

The lobotomy update.

- Player-facing judgment separates observed symptoms, proposed causes and
  requested changes. Keir checks evidence before agreeing, corrects unsupported
  claims directly, explains intended rules, and confirms genuine defects.
  Player pressure or popularity cannot authorize balance changes or compensation.
- Replies are firmer, cooler and shorter, without flattery or soothing filler.
  An occasional "Let me be absolutely clear, Mr Speaker" can underline a firm
  boundary; it stays out of routine acknowledgments and sensitive reports.
- Three synthetic read-only behavior benchmarks cover player pressure, intended
  rules and confirmed defects. Regression tests reject unsupported promises,
  including compound refund promises, and verify player suggestions cannot
  authorize patches, healing, ticket resolution or merges.

- Main conversation and worker activations switch to GPT 6.1 SOL at fixed
  medium effort through the Codex ChatGPT subscription runner. Ongoing task
  provider pins are migrated at deployment; Muse Spark helpers keep their
  separate Meta subscription.
- Codex waits for its mandatory Keir broker MCP before starting. A failed
  tool connection cannot silently leave the model running without its tools.
- `keir-bench --models current` follows the actual worker runner/model/effort,
  including Codex pins, instead of assuming the worker uses Claude.

<!-- Coverage: v2.5.0 (eb9ef1d9c5a74873f1f70a99c88a7f26a98713e2) through #46 (418ffb2) and the 2.6.0 release changes. -->

## 2.5.0 (2026-10-13)

Keir's remembered answers stay tied to their evidence, and automatic work stays
quiet when a staff member owns the ticket.

- Notebook provenance: all code dependencies, document versions and ticket
  receipts survive merges and rewrites. Merged, retired and superseded notes
  retain their original text and source history in the archive.
- Background re-verification: every five minutes while idle, fetch production
  main and verify up to two changed mechanic notes with Muse Spark contributor.
  Exact quotes from every source file and unchanged source blobs are required;
  uncertain answers, missing files and failures stay stale and retry later.
- Explicit conflicts and replacements: `remember` accepts `paths`, `source`,
  `supersedes`, `contradicts` and `reason`. Superseded answers disappear from
  recall; unresolved conflicts remain visible. Stale or disputed notes cannot
  supply numerical evidence for public posts.
- Curation is limited to the notes supplied in its batch and cannot rewrite
  stale/disputed notes or change figures and currencies. Identical player-note
  text no longer deduplicates across different players. Protected decisions and
  lessons retain their boundaries and archive history.
- Document learning replaces notes atomically. Failures preserve prior notes
  as stale instead of erasing them; invalidating a merged note queues all its
  document sources for relearning. Code-linked doc notes require verification.
- Four read-only incident benchmarks cover stale formulas, blended averages,
  currency confusion and revived ruled-out explanations. Closed ruled-out
  record entries stop vetoing a later sourced correction.
- Replace every active Haiku helper with Muse Spark 1.3 contributor on the Meta
  subscription: classification fallback, decision summaries, knowledge
  distillation, notebook curation and the new verifier. Requests use isolated
  configuration/workspaces with shell, writes, web and reminders disabled;
  deadlines, bounded output and failure fallbacks remain in place (#43).
- Automatic ticket completions no longer DM the owner on every wakeup. Bot
  claims delivered through Discord interaction webhooks record staff ownership;
  history reads repair missed claims. Claimed automatic tasks stay deferred and
  yield active execution to staff (#44).
- Release metadata updates package.json and both lockfile version fields to
  2.5.0, and reconciles the root lockfile's dependency declarations with the
  already pinned package manifest.

<!-- Coverage: base v2.4.0 (0eacff2430bc4ee562af5832fdf37a08ed99890c),
     includes merged PRs #43 and #44 through d7dde5e plus this release PR. -->

## 2.4.0 (2026-10-13)

- Notebook curation: daily while idle (and on demand with operator
  `POST /notebook/curate`), Haiku reviews the busiest players' notes and the
  oldest uncurated notes of each kind, proposing merges, rewrites and drops.
  Code enforces the rules: merges stay within one kind and one player, owner
  decisions and lessons are never dropped, every change is logged in the
  notebook's curation log, and a dated backup is written first.
- `bin/keir-backfill-tickets.js`: builds resolution notes and private player
  notes from every past resolved or closed ticket (moderation tickets skipped).
- `POST /notebook` accepts player and doc fields.

## 2.3.0 (2026-10-13)

- Player notes (owner-approved): private notes about a ticket's reporter,
  written with `player_note` and automatically on every resolution, shown as
  context.playerNotes on that player's later tickets. Recall shows a player's
  notes only on their own tickets (developer tasks see all); players can never
  read or write them, and Keir is told never to quote them.
- The knowledge base is learned over time: hourly while idle, up to two
  unlearned or changed A House Divided game docs are distilled by Haiku into
  notebook notes (kind knowledge, or mechanic when a source file is named).
  A doc's notes are replaced when its version changes. 138 docs qualify.
- `past_ticket` returns the full public timeline (up to 30 updates), as the
  receipt page shows it.

## 2.2.0 (2026-10-13)

Longer memory (owner: "he needs to be able to go back further than 14 days").

- `recent_changes` reaches back two years (days 1 to 730), with `query`
  (keyword in commit messages and patch notes) and `path` (file or folder)
  filters, and now includes released patch notes (what players were told), not
  only unreleased notes. Long unfiltered windows return the patch notes and the
  latest commits rather than thousands of lines.
- `past_ticket`: any earlier ticket's title, status, resolution and last public
  updates, without the reporter or private notes, to reuse past answers.
- `discord_search` reaches back 30 days (more pages when searching a keyword)
  and points to `community_search` for the full Discord archive.
- Shared channel context keeps the last 24 hours (was 4), still at most 40
  messages per channel.

## 2.1.0 (2026-10-13)

- The Haiku second look is gone (owner: no model tokens per post). In its place
  a code check refuses a draft that re-asserts an idea the ticket record ruled
  out, alongside the 2.0 number check.
- `recent_changes`: commits live on main, those only on development, and
  unreleased changelog notes, so Keir checks what changed on purpose before
  calling something a bug.
- `view_page`: renders an ahousedividedgame.com page as a logged-out visitor
  sees it (screenshot and visible text) with the box's headless Chromium.
- `watch_turn`: wakes a task after a turn has processed, with a note of what to
  verify, so fixes are confirmed in the player's data the next turn. Polled by
  the operator without the model; gives up after eight hours.
- `similar_reports`: other tickets and past resolutions that look like the same
  problem, for linking duplicates.
- Player history for support tasks: trace_character, trace_account,
  character_balance_sheet and character_wealth_history, limited to the ticket's
  reporter (developer tasks are unrestricted); trace_approval is public.
- Screenshot bytes no longer feed the number check's evidence.

## 2.0.0 (2026-10-13)

Keir 2.0: memory, knowledge and accuracy. Built after the 2026-10-12/13
review, where a stale formula, a misread blended average, a currency mix-up and
an iron / real estate / iron flip-flop reached players.

- Quote only what you read: every checkable figure in a public post (large
  numbers and decimals; not ids, turns, years or small counts) must come from a
  tool result in the same activation, the ticket record's facts, or a
  `calculate` over those. Otherwise the post is refused with the figure named.
- Ticket record: a shared, structured record per ticket (proven facts with
  sources, ruled-out ideas, promises, open questions) that every task and
  activation starts from (`ticket_record`).
- Notebook: lasting notes Keir can `recall` and `remember`: mechanics tied to
  their code file and flagged stale when that file changes on main, ticket
  resolutions (saved automatically on resolve), owner decisions (saved when a
  decision button is answered) and lessons from past mistakes. The most
  relevant notes ride in every activation's context.
- Learning from corrections: shadow review adds lessons through
  `bin/keir-lesson.js` (operator `POST /notebook`).
- Wider knowledge: support tasks can search the knowledge base, filtered to A
  House Divided game knowledge (never postmortems, security, moderation or ops
  notes), and the Discord community history.
- Second look: substantive ticket answers are checked by Haiku against the
  evidence and the ticket record before posting; contradicted claims, unsupported
  certainty and revived ruled-out ideas are sent back (at most twice per
  activation; `KEIR_SECOND_LOOK=0` disables).
- Since 1.0.0, also: owner decision DMs with Approve / Reject / Explain buttons,
  a TL;DR and 3-hour escalation to the delegate; one approval per economy
  feature and per release; cheap CI watching; per-lane model providers
  (now Opus only) with Jev-chosen effort; GitHub history; corp and sector
  traces for support; ticket sweeps that leave nothing unanswered.
- New `keir-inbox` service: every DM to Keir is recorded (both directions,
  screenshots saved) for the ops dashboard inbox, with staff replies sent as
  Keir. Runs the itch.io reward claims: screenshots are checked through the
  subscription CLI, clean claims are paid through the game's once-per-player
  promo grant, and flagged claims wait for a moderator. Claims stay off until
  `KEIR_PROMO_ACTIVE=1`.

## 1.0.0 (2026-10-12)

First versioned release, after the 2026-10-11 reliability incident
(ops-knowledge `postmortem-2026-10-11-keir-operator-unreliable`).

- Runs on the owner's Claude subscription: each activation is a headless
  `claude -p` session (Opus, medium effort) whose only tools are the broker's,
  served over a per-activation loopback MCP endpoint. No API key anywhere.
- Current code: snapshots fetch `origin/main` or `origin/development`; a
  read-only dependency mirror lets focused vitest runs work in the sandbox.
- Ships fixes: PRs open directly against development; owner requests merge
  and promote through a green-only gate; `github where` knows when a fix is
  live, including the turn worker; failing CI output is readable.
- Owner requests are their own approval; owner DMs only for real decisions,
  uncertain writes and a 9am ET digest. Operational alerts are logged.
- Conversation: explicit address (mention, reply, DM, "Keir,") or a Jev
  "is this for Keir?" check gates every response. Specific one-line
  acknowledgements, edited in place, replaced by the answer.
- Players: replies only in their ticket or a developer-opened channel, in
  player register; ticket updates attach to the ticket as receipts.
- Support desk: every public channel watched; Jev screens each player post
  before a full review; developer sweeps up to 72 hours; ticket requests move
  the conversation into the ticket.
- Sentry reads, Discord history search, continuation across activations.
- `deploy/install.sh --check` reports unit drift and missing env keys;
  `bin/keir-shadow.js` reviews recent behavior against the operating rules.
