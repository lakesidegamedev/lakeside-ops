# Changelog

Keir: the A House Divided Discord operator, support desk and /summon bridge.
New monorepo versions use `keir-vX.Y.Z` tags. Stage and activate with `deploy/release.sh`.

## Unreleased

- **A person's newest message is never left without a reply.** Fixed a crash in the one-slot-per-ticket queue: every follow-up wake (messages that arrived while a wake ran) failed on `null` options and its messages were dropped (tickets 1910, 1911, 1913). A failed delivery is now queued again instead of dropped. The post count limits never block a reply to a person who wrote since Keir's last post; if a wake still ends with that message unanswered after a refusal, Keir is woken in 5 minutes to answer in one consolidated reply (at most twice per message).

- **The slim Keir notices public mentions.** In public channels (visible to members; dev, archived, ticket, moderation and other games' channels excluded) it notices its names ("Keir", "Keith"), @-mentions and replies to it, reading only channels whose newest message changed (one channel listing every 6 seconds, `KEIR_SLIM_PUBLIC_POLL_MS`). A code filter keeps it silent on banter, opinions and balance debates, moderation, tickets and talk of what the team thinks; account or money matters get one pointer to open a ticket. Otherwise a short fresh model wake with read-only game, code and site tools answers a clear game question it can confirm, in one short threaded reply under the ticket rules and never naming the owner, or skips. One reply per message, one per channel per 10 minutes, six an hour. Every decision is logged with its reason in `public-mentions.jsonl`. `KEIR_SLIM_PUBLIC=off` turns it off.

- **One wake slot per ticket.** Messages that arrive while a ticket's wake waits for a slot join that wake; messages that arrive while it runs make one follow-up wake with all of them. Before, each message was its own queued wake holding a slot, so one busy ticket could fill all three and keep other tickets waiting (ticket 1909: four messages in 74 seconds, three slots busy, one ticket queued).

- **The slim Keir handles moderation tickets.** They get the same fast pickup as any ticket (only internal investigation tickets are skipped). Alt reports: alt_ring_audit on the named characters, one short neutral summary to the moderators' channel with the new `mod_summary` tool (no IP addresses, emails or account ids; at most two per ticket), and a plain answer to the reporter about what was checked. A hard rule stops accusing anyone or talking about bans or punishment on moderation tickets. Keir has no tools to act on accounts. (Ticket 1907 was skipped by design until now.)
- A ticket the team already answered before Keir first saw it is watched quietly: no replay, no wake until someone writes again.

- **New tickets show typing within seconds.** When the 8 second check spots a new ticket, typing and the response clock start right away from one quick read of its channel, before the full intake. Open tickets' histories are now read in parallel, so the full intake no longer takes about 20 seconds. (Ticket 1908: typing started 32 seconds after it opened.)

- **New tickets get the fast start too.** A cheap check every 8 seconds spots a brand-new ticket and runs intake at once; the ticket channel shows typing straight away and the response clock starts from when it opened. Before, fast pickup only watched channels already known, so a new ticket waited for the 20 second poll with no typing (ticket 1906).
- **No placeholder posts.** A post that only acknowledges or promises to look ("I have the bill you linked. I'll check...") is refused; Keir posts once it has something real. Resolutions are exempt.

- **The slim Keir knows when a fix is live and says so within minutes.** `deploy_status` (and `promotion_status` once a fix is on main) compares the fix's merge commit with the web and worker commits the deployer recorded (`KEIR_SLIM_DEPLOY_RELEASES`, one JSON line per deploy) using git ancestry. A fix that is not live yet is watched; the service checks every 20 seconds and wakes the ticket the moment both web and worker contain it, with what to do next. (Ticket 1905: the fix was live at 05:15 and Keir still said "still checking" at 05:52.)
- **Public game pages.** `site_read` renders a public page as a logged-out visitor sees it, on the host with old Keir's page viewer (`KEIR_PLAYWRIGHT_MODULE`); the session's shell stays offline.
- **The 30 minute limit no longer cuts off a conversation.** A real answer to a person who wrote since Keir's last post may go up to 6 posts in 30 minutes (updates and questions stay at 3), and an answer the limit holds back wakes Keir again the moment the window clears. (Ticket 1905: an answer about California waited 54 minutes.)

- **The slim Keir answers fast and shows it is typing.** Every 4 seconds (`KEIR_SLIM_FAST_POLL_MS`) it asks Discord whether a person wrote in an open ticket's channel or the owner's DM. A new message starts the typing indicator at once (old Keir's `presence.js`, pulsed every 8 seconds) and runs intake straight away; typing stops at the first post or when the wake ends, and never runs longer than 4 minutes. Owner and staff messages, and owner answers to cards, jump the wake queue. Each wake with a new message is told to answer first with what one quick read shows, then keep investigating; never a canned "looking into it". Time from a message to typing and to the first post is logged per message in `response-times.jsonl`.

- **The team's work comes first.** Before every wake (including after a resume) the slim host reads the ticket history: staff, owner and coordinator posts, fixes and real status notes since the last wake are added to the ticket state as established facts, the next step is reset to re-plan from them, and the wake opens with them. They win over the session's own earlier notes. (Ticket 1904: after a resume Keir worked from a stale "cannot reproduce" note and opened a second fix for a bug already fixed.)
- **No second fix.** `open_pr` first looks at open or merged pull requests from the last 48 hours (release promotions skipped). One that mentions the ticket or shares most of the fix's code stops it; one that shares some code must be explained (`related_checked`) before it opens. It never opens on a guess when GitHub cannot be read. Committing no longer trips over the shared, gitignored dependencies link.

- **The slim Keir sees ticket screenshots.** Its MCP client keeps the image blocks `support_get` returns, and every screenshot the session has not seen yet is attached to its Codex conversation (`--image=`), once. If they cannot be loaded, the session is told once to work from the text and never to ask the player to describe or resend them. (Ticket 1904: Keir said four times it could not open a normal screenshot.)
- **One spam cap, now complete.** Besides two posts in a row without a person writing, it stops a third post within 30 minutes, a post that repeats an earlier one, and saying a screenshot will not open more than once. Resolutions are exempt. On 1904 every post followed a new player message, so the old two-in-a-row rule never fired.

- **Resolve only when the player is done.** `resolve_ticket` closes a ticket only when the player confirmed after Keir's last post (quoted from their own message), asked to close (quoted), or stayed quiet for 24 hours after that post. Otherwise it refuses and tells the session to set a 24 hour reminder. The fix-live receipt rule is unchanged. (Ticket 1902 was resolved two minutes after the fix went live, with no word from the player.)

- **Nothing from before the slim Keir went live is ever acted on again.** The intake records when it went live and never delivers an older event, even one recorded late; a ticket it first sees after start that opened before go-live gets a takeover wake, never a replay of its old messages. `resolve_ticket` on a ticket that is already resolved sends nothing. (Incident 2026-11-25: eleven old resolution receipts reached the owner; they were sent by the game's ticket bot, whose delivery list is fixed separately to never offer receipts from before the cutover or older than three days.)

- **No needless promote asks.** The game's auto-promoter ships a merged fix from development to staging to main by itself once checks are green, so the slim Keir no longer asks the owner to put a fix live. New read `promotion_status` shows where a fix is (development, staging, main), the open promote pull requests and whether the auto-promoter is held (off switch, timer stopped, a promote pull request that is a draft, labelled hold, conflicted, failing a required check, or named on an "Auto-promote held" card). `request_promote` sends a card only when the promotion is held or for a hotfix that must skip the queue, never when the status cannot be read.

- **Owner approval cards look and work like old Keir's again.** `request_decision`, `request_promote` and `request_compensation` send a card to the owner's direct messages: the question first as the title, a short why, each option as a field with a one-line description (recommended first), and buttons using old Keir's `keir_decision:` ids. A click is recorded the old way: the verdict line the game's bot appends to the card is read back and wakes the ticket. A typed letter, yes or no is a fallback. The copy is checked before sending: plain words, at most three sentences of why, no internal ids or code terms (the approval id lives only in the button ids).
- **No asking what is already decided.** `request_decision` first looks for an answered or pending request on the same question in the ticket state, then shows the session every owner and staff message on the ticket; it sends nothing until the session confirms none of them already answers it (ticket 1902 asked a question the owner had answered in the channel).
- A restart in the middle of a wake no longer loses the messages it was working: they are kept on disk and delivered again.

- **Slim Keir can run live.** `bin/keir-slim-serve.js` (unit `keir-slim`, `KEIR_SLIM_MODE=live` only): polls open tickets every 20 s through the ticket history and delivers new player, staff and owner messages to each ticket's session; a ticket already open at start gets one takeover wake; moderation and investigation tickets are never handled. Approval cards go to the owner's direct messages with Keir's bot; the owner replies to a card (a letter, yes or no) and the answer wakes the ticket; `record_owner_answer` records an answer the owner gave in the ticket channel during that wake. Reminders fire after their minutes or after the next game turn. At most 3 sessions run at once. Each ticket's code checkout is a worktree of the game repository on development with the shared dependencies linked, never committed. The service refuses to start if approval cards cannot reach the owner. A heartbeat is written every poll.

- **Slim Keir, built and switched off (stage 2 of the slim-down).** A new, separate Keir in `lib/slim/`: one continuing agent session per ticket (Codex resumed by session id, so the ticket keeps one conversation, compacted by Codex itself; the brief and style guide are standing instructions that survive compaction). A ticket state record the session keeps (established, ruled out, promises, next step and what it waits on, pull requests, approvals, receipts). Ten hard rules in code (`rules.js`: leaks, outcome receipts, the player's name, one spam cap, no promises, no speaking for the owner, pause and kill switch, own channel); everything else is one style guide (`STYLE.md`) and the session's self-review. Approval tools `request_promote`, `request_compensation` and `request_decision` (plain multiple choice). Broad reads (every past ticket through the ticket history, game data, code and git history, the work board, GitHub), tight writes (this ticket's channel, this ticket's checkout, pull requests to development). `KEIR_SLIM_MODE` is `off` by default; `replay` captures every write; only `live` posts. The shared kill switch stops it, `bin/keir-slim.js` pauses or resumes a ticket and records owner answers. It has its own small MCP client (`lib/slim/mcp.js`), not the old broker's. Production error reads (Sentry) are among its read-only servers. `bin/keir-slim-replay.js` replays a past ticket offline: the real messages people wrote, in order and at their real times, from the ticket history; code read from main as it was when the ticket opened; every write captured. Nothing runs it yet: no unit, no intake. Old Keir is unchanged.

## 11.7.8 (2026-11-24)

- Keir's own opener and status card no longer make a ticket look owned by another agent. A new ticket went quiet after its first reply because the opener read as someone else's post (1895).

## 11.7.7 (2026-11-24)

- turn_status is an allowed read in owner app tasks. The scheduled owner brief refused it as a write and finished blocked.

## 11.7.6 (2026-11-24)

- A ticket whose Keir answers were corrected twice hands off to a recheck worker once per new correction. An old count no longer re-fires the "rechecking" line every six hours after the ticket was answered (1884).

## 11.7.5 (2026-11-23)

- **A held ticket's task waits instead of running.** The coordinator hold only blocked posts, so a task on a held ticket still started, read the ticket and retried the blocked post until its deadline (tickets 1884 and 1892, Sentry KEIR-1C). The hold now defers the task the same way an operator shift does; it resumes when the hold is removed or expires.

## 11.7.4 (2026-11-23)

- **A gameplay ticket with a fix on it gets a real answer, not the Ask redirect.** Ticket 1884 was filed as gameplay, so the advice guard allowed only the Ask link even though the player's losses came from our own changes and two fixes had shipped on the ticket. Any fix on the ticket's status card past "found", or a pull request on any task for that ticket, now lifts the redirect; the meantime-steps rule applies instead (owner, 2026-11-23).

## 11.7.3 (2026-11-23)

- **Coordinator hold.** A ticket listed in `coordinator-holds.json` in the state directory gets no Keir post at all, including from tasks the owner started, until the hold is removed or expires. A ticket bot claim in the owner's name let the owner's own task post a wrong correction on ticket 1890 (owner, 2026-11-23).

## 11.7.2 (2026-11-23)

- **The "now live" note waits while the player's question is unanswered.** Keir had read the question, so nothing was left in its inbox, and the note went out over it two minutes later (owner, ticket 1890).
- **The "now live" note no longer quotes the ticket title as if it were the fix** ("This is now live on the main server: Few issues."). A title-only card item reads "The fix for this ticket is now live on the main server."

## 11.7.1 (2026-11-23)

- **A timer or internal wake does nothing while someone else has the ticket** (a developer agent or staff posted to the player in the last two hours, a running worker, a claimed card or an open PR); Keir looks again in 30 minutes, and a player's message is still answered (owner, ticket 1884).
- **A handed-back ticket is always Keir's**, even when the developer agent posted to the player just before handing it back.

- **A rule fix whose direction the owner already chose is built by the fix worker too** (owner, 2026-11-23), not only merged; money changes still wait for him.

## 11.7.0 (2026-11-23)

### Keir only interrupts the owner for real decisions (owner, 2026-11-23)

- **North star in KEIR.md**: how the coordinator session behaved overnight is the standard: one place, plain words, act on your own, interrupt only for real decisions, check facts first, push back with evidence, stay quiet when nothing changed.
- **Owner DMs**: only multiple-choice decisions, the one daily digest, and Keir's direct replies to the owner's own requests. Hand-offs, stalls, escalations, watch alerts, parked and unread notices go to the daily digest ("Handled without you"). No link previews, no raw links, no jargon in owner DMs. Decision questions say what happens if he does nothing.
- **Phone pushes**: only an answer to something the owner asked, a pending decision, and one quiet morning brief per day. Progress updates, Watchkeeper alerts and goal progress no longer push, and an internal error never reaches the lock screen.
- **The 30-minute push loop is fixed**: the scheduled morning brief could not use the read-only team_activity tool, failed every day since 11-18, and every retry and restart pushed its error. team_activity is now an allowed read, a scheduled task is never re-run by a release, and there is one brief per Eastern day.
- **Keir stays quiet when someone already has a ticket**: a developer agent or staff posted to the player in the last two hours, a worker is running on it, a claimed card or an open PR names it. No hand-off, no post, no escalation. Cards Keir filed for itself no longer count as someone covering a ticket.
- **Challenges and repeated corrections go to a checking worker** (owner: always a worker), with a plain "I am rechecking this" line, never to staff who are not there.
- **Hand-backs**: a developer agent that writes "HANDOFF TO KEIR" on a ticket's kanban card hands it to Keir. The note reaches the ticket task; each named fix is checked against the live build every 5 minutes, and Keir is told to post "fix is live" only once the running web and turn worker contain the fix's merge commit. A handed-back waiting ticket is never swept or escalated.
- **Ordinary fixes merge without asking the owner**: once the owner has chosen the direction on a ticket, the fix that carries it out ships under the standing merge permission. Keir no longer asks for "exact execution approval" of ordinary fixes; money, product direction and irreversible removals still ask.
- **Old decision messages leave the owner's DMs** a day after they end.
- **Tickets Keir paused with "staff are reviewing" before today are un-paused once at startup** (only Keir's own pauses; a person's pause is never touched), and the task is told Keir owns the ticket again.
- **Hand-back notes that say "handing ticket N back to Keir"** are read as well. A note's "ask the owner before closing" is overridden by the owner rule: Keir closes waiting tickets itself once the player is quiet.
- **Guardian checks the checkers' runs**, not just their timers: a failed run is re-run (at most hourly), and a unit that keeps failing gets a fix-it card on the board instead of an owner DM.

## 11.6.0 (2026-11-23)

### Tickets keep moving overnight (owner, 2026-11-23)

- **The wake cap hands a ticket to a worker, not to staff.** When a ticket task hits its wake limit, Keir starts an investigation worker on the ticket and tells the player once, in plain words, that a deeper check has started and it will post when it reports. The ticket is no longer paused with "Staff are reviewing", which was untrue overnight. The staff hand-off runs only when no worker can start.
- **A stuck ticket waiting on Keir's own card gets a worker before anyone is paged.** The stuck-ticket sweep used to DM the owner "needs a person: waiting on a developer" for cards Keir filed for itself. It now starts a worker on the ticket (with every open card Keir filed in its brief) and has the ticket task tell the player; the owner hears only if no worker could start or the worker came back with nothing.
- **Broken follow-up promises start a worker.** A promise two wakes could not deliver starts a worker instead of only DMing the owner. "I will follow up when a fix is in" now counts as a fix promise.
- **Workers can pick up a stalled ticket** whether or not its cause was marked unverified, with one extra run on top of the per-ticket budget.

### No wrong corrections, no asking players for Keir's own lookups (owner, 2026-11-23)

- **Every public "Correction:" is checked first.** A separate one-shot check on the configured Codex route reads the earlier posts, the draft and the records this activation read. Unsupported corrections are refused with the reason (for example a turn's cash change mistaken for a mismatch); uncertain ones are refused once so Keir quotes the record. A correction with no read in the activation is refused. A checker outage lets the post through and is logged.
- **Replies about harm from our bug or change say what to do meanwhile and when the fix is expected** (owner rule). A reply that explains a loss our fault caused but gives no in-game step for the meantime, or no stage or timing for the fix, is refused (at most twice per activation). Open-ended strategy advice still goes to Ask.
- **Keir reads every site before answering about a total, and never writes "I still need your ..."** for data it can read. Such posts are refused with what to do instead: read the rest, or say what happens next and when. Players are asked only for what only they know.

### Patch reads no longer time out

- **Sandbox git compares mtime, size and mode only** (`core.checkStat=minimal`). The shared snapshot's index was written as root, so inside the sandbox every file looked changed and each patch read re-hashed the whole game repository, often past the 60 second limit.
- **Patch reads get three minutes and one retry**, and a timeout says so. Before, it was reported as "larger than 2 MB, split the fix", which sent Keir shrinking small fixes and filing "blocked by delegation errors" cards.

## 11.5.0 (2026-11-23)

### MCPs first, then whatever works (owner, 2026-11-23)

- **Keir tries the MCP that covers a question first**, then falls back at once to the repository snapshot, shell reproduction, ticket history or past tickets when the MCP errors, comes back empty, lacks the field or contradicts other evidence. A failed MCP read is never treated as proof something is absent.
- **Fallbacks get reported.** The failed call is named in the findings and filed or joined as a capability card, so broken or thin MCP tools get fixed instead of silently worked around.

### One "needs a person" alert per report (owner, 2026-11-23)

- **No repeat DMs.** A needs-a-person handoff sends no second owner DM when one in the last 24 hours, from any task, cites the same Discord message, came from the same reporter's intake, or has a near-identical title. The card is still filed and marked as a repeat. One player's report in #america-chat had produced five DMs in twenty minutes.
- **Intake can use the message that states the problem.** Automatic intake may open a ticket from another message by the same author in the same channel within 30 minutes of the one that woke it. Before, a report followed by "Im so confused" was refused because the wake landed on the vague message.
- **"Broke", "bugged" and "glitch" count as problem phrases** for automatic intake.

### Guardrails before Keir is turned back on (owner decision 2026-11-22)

- **Incident context.** Every ticket job is told which incidents are open and which turns failed in the last 24 hours. Keir cannot say an incident or the game has "recovered", "resolved" or "is back to normal" until two clean turns have run after the last failure; if the turn record cannot be read, it says it could not confirm.
- **Claims need evidence.** A causal or outcome claim about money, cash, production, sales, payments, or something being "running", "fixed", "live" or "paid" is refused unless this activation read a record for the player's own character or company. The old rule that let any verified release on the ticket pass every later outcome claim is gone: the semantic screen's "states an outcome as settled" flag now needs that same read. When a turn failure or open incident overlaps the period, the claim must name the turn range.
- **One message per reply.** A reply is one Discord message and is split only when it passes 2000 characters. The default cap is 3 posts per ticket per hour with no new player message (`KEIR_TICKET_POSTS_PER_HOUR`), and a closing condition alone no longer licenses a per-turn recap; the player has to have asked or a promise has to be due.
- **No design or balance work from tickets.** A ticket lane cannot publish a patch or delegate a fix that changes balance, rates, recipes or turn-engine numbers, cannot offer to build a feature or mockup, and cannot quote or describe the owner's intentions. It files one owner card per ticket with the evidence and tells the player staff will review.
- **Auto-escalation.** After Keir has answered, a player writing "are you sure", "you didn't answer", "that's not true" and similar, a second correction on one ticket, or a wake cap hit posts one short "staff are reviewing" message, files a needsHuman card, alerts the owner and pauses Keir on that ticket.
- **Route.** The default ticket route is `codex:gpt-6.1-terra@high` (GPT Terra). Release note: set `KEIR_TICKET_PROVIDER=codex:gpt-6.1-terra@high` in both `/etc/keir-operator.env` and `/etc/keir-owner-model.env` (the owner-model file loads last).

### For developers

- `lib/operator/guardrails.js` holds the pure rules (incident context, recovery and claim checks, scope checks, escalation triggers). `broker.js`: `incidentFacts` (60 second cache over `recent_turns`, `turn_failure_detail` and the open incident list), `guardrailGates` (runs in `guardTicketPost` for player-facing ticket jobs), `fileOwnerCard`, `escalateTicket`, `escalationCheck` (called at the start of a ticket activation and on a wake cap), and balance checks in `publish_patch` and `delegate_fix`. `job.ownRecordRead` records that a read this activation named the reporter's character.
- `replysplit.js` now only splits above 2000 characters, at paragraph boundaries. `postbudget.js` default cap 3; `turnPostVia` no longer returns `closing`.
- Figures in claims are still checked by the existing number guard; the new gate checks the entity read and the turn range.

- **Keir never calls itself Muse to the owner.** The owner's chats in the Keir app (home, support desk and side chats) now run on the supervisor's full agent, so the operator's owner path only serves the web portal and older app builds. Its persona introduces itself as Keir, and its refusals name the support desk path and point to the app chat instead of "Owner Muse". Staff and player Discord paths and every guard on them are unchanged; a test now checks a staff and a player Discord message keep them.

## 11.4.1 (2026-11-21)

- When the owner tells Keir to close a ticket in that ticket's own channel ("close this ticket please and wrap up"), Keir closes it. The channel names the ticket, so Keir no longer asks the owner to confirm, and the owner's instruction lifts any closure hold an earlier follow-up set on that ticket (cleared on every task for it, with an audit line). If the owner confirms a close Keir asked about, the hold no longer refuses it a second time. Staff still cannot lift the owner's hold (Keir says so at once instead of asking the owner), and "close this" in another ticket's channel closes nothing else. Ticket 1860 stayed open three hours after the owner asked.

## 11.4.0 (2026-11-21)

### For users

- Keir no longer says a problem is "with the developers" when it is fixing it itself. While its own fix is being prepared, tested or waiting for approval it says so in the first person ("I am preparing a fix", "My fix is in testing", "The fix is waiting for approval to ship"). These guards refuse only the false claim, not the words: "You cannot create a second company", "The developers have said this works as intended" and "Your report is with the team now" go out as written. After two refusals in one go, Keir's answer is posted without the false sentence instead of being replaced by "no confirmed answer". "With the developers" now needs a handoff a person on the team actually holds (an item no Keir worker took, a question for a person, or an open owner decision), and it is never said to the owner or a developer who asked Keir to do something: Keir does it, or says in one sentence what blocks it. Who is being answered is read from the message Keir replies to, so a developer asking inside a player's ticket counts as a developer. "I will come back when there is something to try" is now a tracked promise that comes due with the fix.
- The "From:" line under a ticket answer names what the answer actually rests on: "the game's rules" only for a read of game logic (not the game's network, formatting or other plumbing code, and never for a page fault), "the page's code" for interface code, "a live check of the page" when Keir looked at the page itself, and live records as before. A design suggestion, mockup, apology, status update or question gets no line, and when the code cannot tell what a read was, there is no line.
- The owner and staff can tell Keir to act on tickets by number, from the app or from Discord, including inside someone else's ticket: open an incident, merge named tickets into an incident or another ticket (each reporter is added there and told where their report went), close or reopen a ticket, and add a person. "Merge the compressed data tickets into one incident" now opens the incident, merges them and replies once with the numbers. Merging more than three tickets the request did not name, or closing any ticket the request did not name, is confirmed with the owner first with the exact list, and a close passes the same checks as any other close (a player still waiting, the grace period after the final answer, a ticket a staff member claimed or the owner held, moderation tickets). A person is added only to the ticket the command names. A player can never direct this, and a message that only claims to be from the owner does not count. Keir no longer says its ticket access is read-only. New switch `crossTicketActions` (`KEIR_CROSS_TICKET_ACTIONS`), on by default, with preview.
- Asked to show how something would look (a rendered image, a mockup, a screenshot of a proposal), Keir draws it: it writes the proposed screen in the game's style and posts it as an image where it was asked, in Discord or the app. Every such image carries "Preview of the proposed wording, not the live page." drawn into the picture and as its first line, and has no source line. "I cannot render" is no longer something Keir can say when it can; if a drawing really fails, or image delivery is switched off, Keir says once what failed and gives the text. The label sits in a bar above the drawing that nothing in the drawing can cover or remove, and an image whose label did not render is not posted. Keir also no longer refuses "I opened the page" when it actually looked at the page on that ticket. New switch `imageDelivery` (`KEIR_IMAGE_DELIVERY`), on by default, with preview.
- The owner's Inbox rows are plain. A row says what the work waits on (from its closing condition) in one line, a working row names the step, and there is no "Next" line unless there is a real next step (never on a finished row and never "Keir must record the next milestone"). Commit hashes, file paths with line numbers and task or worker ids are replaced with what they mean ("the live version", "the code", "the coding worker") or dropped. Times shown to the owner (Inbox rows, ticket detail, app messages, owner DMs) are US Eastern and labelled ET, never UTC; only times known to be UTC are converted, to the nearest day, and a time with no zone (or already in ET) is left as written; a UTC time in a Discord message to players becomes Discord's timestamp markup, so each player sees their own time.

### For developers

- `lib/operator/handofftruth.js`: `deflection()` runs in the ticket post guard and on every non-ticket channel and app reply. It refuses a handoff claim with no person-held receipt, a handoff claim while Keir's own coding worker, pull request or pending repair holds the work, any handoff claim to an owner or staff audience (unless it names that person's own receipt), a blanket "I cannot render", and "my ticket access is read-only". Each refusal carries the sentence to use. `ticketEvidence().escalated` no longer counts Keir's own pull requests or worker-held cards; `standdown.currentQuestionReceipt` skips worker-held cards.
- `lib/operator/ticketcommands.js` and the `ticket_command` tool (ops `open_incident`, `merge`, `resolve`, `reopen`, `add_person`). Authority is checked in code from the real author: an app task needs a valid authenticated owner origin (`ownermuse-policy.origin`); a Discord task's request message is re-read from Discord and its author must be the owner or a configured staff member matching the task's role. Ticket tasks, findings, workers, probes and players are refused. Every write runs through the effect journal (`ticket-command:merge:<source>:<target>` and similar), so retries never repeat it; an already merged ticket reports `already`. The confirmation is one choice decision keyed by op and list. Affected ticket tasks are settled (merged: done with `mergedInto` and `channelClosed`; closed: done; reopened: requeued with a note). The private owner supervisor in `apps/web/keir-supervisor` still has read-only tools and is not changed here.
- `lib/operator/preview.js` and the `render_preview` tool: HTML is rendered by `computer-worker.js` in the task sandbox (`computer: true`, no network), with a forced label strip; the PNG goes to `artifacts/preview-<job>-<hash>.png` and rides the outbox `files` path charts use (`operator.js` accepts `preview` files; `appchannel.js` shows them in the app). Offered only when the newest owner or staff message asks for an image (`preview.requested`), never for a player's request; kept direct in lean profiles. `conversation.quickQuestion` sends image requests to the work lane. A failed render sets `job.previewFailure`, which lets one plain failure sentence through. `standdown.capabilityClaim` accepts a claim backed by a `view_page` on the ticket and its refusal points at `view_page` instead of saying Keir cannot open the site.
- `lib/operator/ownercopy.js`: `etTimes`, `discordTimes`, `plain`, `oneLine`. `workqueue.workStatus` builds `reason` from `closing.waitingOn` (or the running step's title), `milestone` from `closing.closesWhen`, and returns an empty `next` by default and for finished work; `apptickets.ticketDetail` plain-filters blockers, status and summaries; `appchannel.deliver` and owner and staff DMs apply `etTimes`; `channel_reply` and ticket public updates apply `discordTimes` (app replies `etTimes`). `knowledge.numbersIn` ignores Discord timestamp markup.
- Release review fixes: `handofftruth` matches the claim (first person and an image object for "cannot render", present ownership and no negation for handoffs, "read-only" only to the owner or staff with the switch on); `broker.deflectionGate` refuses twice per activation, then posts the message without the false sentences (`withoutDeflections`, audit `deflection_stripped`); `ticket_command resolve` runs `commandClosureRefusal` and goes through `callSupport`; the preview page is Keir's own wrapper around a sandboxed iframe; `investigation-memory` stores a code read's `files` beside the cut result.
- `lib/operator/sources.js`: code reads (direct and in evidence batches) are labelled by the files they read (`fileKind`, checked against the game repository's layout; a search by its top hit); `view_page` is recorded in the ticket's observations and labelled "a live check of the page"; `factual()` drops proposal, opinion, apology, status and question sentences (and a whole message that opens as a preview or proposal) before sourcing.

## 11.3.0 (2026-11-21)

### For users

- Every new support report now opens with one line saying replies come from Keir, an AI assistant, and that staff review anything needing a decision. A player's very first report still gets the full introduction; returning players, staff and the owner get the one line.
- When a turn fails, Keir opens the incident itself, in code, the moment it sees the failure: no staff approval, no model, no waiting for the game's own retries. Players get one plain message in the incident channel (which turn, when it failed, which step in plain words, that the game is not advancing, and that Keir is on it), and player reports about it merge into that incident as before. A turn that is overdue with nothing running, a stuck turn, or a game that paused itself because turns stopped finishing counts the same as a failed attempt. On 2026-11-21 this would have opened the turn 108 incident at about 6:32 AM ET instead of 8:04 AM ET. Times in these messages are Discord timestamps, so every player sees them in their own time zone; the title carries no time, and a turn step with no plain name is called "one of the turn's steps".
- Repeated failures of the same turn add nothing until something changes; another turn failing, a different step stopping it or the game pausing itself adds one update that counts the repeats. When turns run again the incident gets one update with how long the game was stuck, and says follow-up is still in progress only when the turn's own record shows work was skipped; when that record cannot be read it says Keir is checking that the turn's work completed fully. Retry counts include the attempts before the incident opened. Closing stays with the incident's own ticket task.
- Only three things hold it back, each recorded with its reason: a turn failure incident is already open (Keir's or anyone's, with a turn failure title and opened in the last day or about the same turn; the failure is added to it, after its status is read fresh, so a closed incident never absorbs a new failure), the owner has stopped Keir (kill switch or pause), or the game is paused on purpose or a reset is running. Another coordinator owning support intake does not stop it.
- The owner gets one alert in the app's incident feed when the incident is opened or joined, and one if it cannot be opened yet (Keir keeps retrying with backoff while the turn is failed). Alert times are in ET. The owner is also told once when a person closes the incident while its turn still fails, when Keir cannot read turn health for five minutes (and when it can again), and when three tries each made a channel but no ticket record, after which Keir stops trying.
- New switch `turnIncidents` (`KEIR_TURN_INCIDENTS`), on by default, with preview mode; `bin/keir-preview.js` shows what it recorded and would open.

### For developers

- `lib/operator/turnincidents.js`: the deterministic pass. Inputs are turndiag `lock_status` and `turn_failure_detail` and gamestate `game_overview`; a one-minute probe (two small reads) runs the full read only when something looks wrong, the five-minute watch tick and every Watchkeeper turn observation also call it. Once per world and turn: the intent is written to the ledger and to an O_EXCL lock file under `<state dir>/turn-incidents/` before `support_create_ticket`; an uncertain create is reconciled from the open incident list and `support_search` and is retried only after ten minutes and two agreeing empty reads. A failed or list-less read of open incidents is never taken as none open.
- The opened incident gets a normal ticket task (`keirIncident`, linked to the watch finding and its task) and a `keirIncidents` entry, so the channel scan treats it as Keir's. A severe turn finding is no longer proposed to staff when its incident is already open; the turn incident check runs before the watch tick, and a pending watch proposal for a turn that has Keir's incident is withdrawn instead of opening a second one on approval. When a turn read fails, engine health's last turn log is read as well. Finding tasks keep every tool refusal they had.

## 11.2.1 (2026-11-21)

### For users

- The iPhone app's Inbox and Ops now read one shared set of queue counts and states from Keir, with stalled, blocked and unanswered work reported separately and a structured support queue snapshot in chat.
- A player-facing reply excerpt in the app is shown only with its verified Discord delivery receipt.
- When merge checks are stale, the app's approval is held and the owner can request fresh checks; existing approval flows are unchanged.
- An eligible stalled ticket can be retried from the app, and Keir can open a private side conversation through the signed-in owner session.
- Approvals surface from both the main conversation and the Inbox, and work that timed out is told apart from work waiting on an owner decision.

## 11.2.0 (2026-11-20)

### For users

- The app's automatic voice model now names the voice route Keir is actually configured to use, instead of a fixed Gemini and DeepSeek label.
- Staff can say `@Keir stand down until pinged` in a ticket. Keir waits until someone in that channel directly tags it again.
- A message the owner types in a ticket no longer counts as his answer to an open question unless it is one of its options (its number, its label on its own, or a plain yes or no for a single yes or no question); a Discord reply to the question may also name the option inside a sentence, but never in one that says not, later, maybe, anything but, wrong or asks. A Discord reply to anyone else's message (the player, staff, another post) never answers Keir's question. Anything else stays context and the question stays open; every such message reaches the task that asked, and the owner is told once, in his DMs, which question is still open and how to answer it. When a question really ends (answered, chosen, approved, declined, or withdrawn because its ticket closed or its PR merged or closed), its DM copies lose their buttons and its kanban card is closed with the outcome; an expired or replaced question keeps its card open with a note.
- No Keir pull request sits silently. Every open Keir PR without a live task gets one approval ask (only when every check is green), a repaired description, or one plain "blocked by" line. Closing (a true duplicate of a merged fix, or stale after five days) and deleting branches of closed, unmerged Keir PRs are off until the owner turns them on; when on, the owner is warned first, the close waits two days after that, and the note on the PR says why and how to undo it. Keir never fights a person: a PR someone reopens or a branch someone restores is left alone for good and the owner hears once. PRs anyone else has pushed to, rebased, commented on or reviewed are never closed. Sharing an issue reference is not enough to call a PR superseded; such a green PR still gets its one ask, with the choice to merge it, close it as a duplicate, or keep it open.
- Keir follows GitHub for approvals: a PR merged by anyone closes its question, a closed PR withdraws it, and new commits withdraw it and re-ask once. Keir no longer asks, reminds or says "waiting on the owner" about a PR that is already merged or closed.
- Two Keir tasks never ask the owner about the same pull request or the same repair: the second joins the first question.
- When Keir tells a player it will come back (after the next turn, after a release, later today), it is woken when that is due even if its task was stuck, and the player gets the follow-up or a plain "I can't confirm this yet", which ends that promise. A new promise made in that reply is tracked too, with its own due time (the turn it names actually running): it is woken once after that, never minutes later, inside the same limits. A ticket gets at most four such wakes and one fallback line a day. If a promise fails twice, staff are told once, with what actually reached the player.
- Fewer ticket posts: one "now live" announcement per shipped change, turn reports only when the answer changes, and at most four Keir posts an hour without a new player message. A correction, the answer to something the player asked (even when it names a turn), and a due promised follow-up always go out; a turn post made while the player still has an open question goes out and is recorded for review. Keir's answers to the owner or a developer do not count against the player's hour. Every post these rules hold back is recorded with the ticket, the rule and the text.
- Every pull request Keir opens carries the Conflict of interest section the game repository requires.
- Keir works toward closing a ticket, not toward the next hourly update. Every ticket and finding task records what would close it and what it is waiting on. When that has not changed, Keir is not woken and posts nothing; after three such checks the task asks the one question that would unblock it, hands its own open pull request to the open-PR pass (only while that pass is on and the wait may park; the task wakes as soon as that pull request is merged or closed), or parks. It parks only when something can still wake it (a turn not yet run, an open PR, its own fix reaching the main server, an answer, a reply, a running worker), is re-checked every two hours (and handed back if its wait can no longer change), and the owner gets one line saying what it waits on and what the player is owed; the app's ticket view shows it. A wait nothing can wake is checked by Keir every two hours instead.
- Fewer per-turn posts: a turn having run is no longer a reason to post. A turn report goes out only when the player asked, a promise Keir made is due, or the ticket's closing condition names that turn.
- A long ticket (10 Keir posts, a day open, or 3 corrections) gets one step back: Keir reads the whole ticket, states what the player needs and what is missing, then posts at most one message.
- An Ask guide correction is "fix in review" until its pull request is merged and live; if the pull request is closed without merging, the item is open again.
- Old finding tasks with nothing behind them (blocked by Keir itself with no question, parked with nothing changing, or from a world that no longer exists) are closed after 72 hours with a record they can be reopened from, and the owner gets one line per batch. Findings held for a person, waiting on a developer or recently touched are kept.
- Keir's code says a fix is live on the main server (the status card and its "now live" notice) only for a pull request the ticket's own records tie to its fix, once that exact merge is on main. A number in Keir's wait text, a ticket or issue number, or the same number in another repository is never taken as that pull request.
- With the open pull request pass in preview, or global preview on, Keir closes and deletes nothing, whatever the close and delete switches say.
- Keir reads the full list of open pull requests on the game repository. When it cannot read a list in full it does nothing and says so, instead of treating it as empty.
- A promise to report "after the next turn" comes due when the turn has actually run, read from the game's turn clock, with the old fixed time only as a fallback.
- Every new automatic behaviour in this release has its own switch, read at each pass from `switches.json` in Keir's state folder or the environment, and stops under the kill switch or a pause. A preview setting makes all of them work out and record what they would do without doing it, and `node bin/keir-preview.js` prints that for the live state, read only. On the first start each pass takes at most three old items per run and nothing older than a week. A switches file that is there but empty, broken or unreadable never turns anything on: every pass goes to preview, closes and branch deletes stay off, the log, the status endpoint and the preview report say so, and it clears as soon as the file is fixed. A missing file still means the defaults.

### For developers

- `lib/operator/standdown.js applyOwnerChannelAnswer` matches a channel message to a decision only by Discord reply (the DM message ids, or a Keir post that quotes the question) or by an unambiguous option match; otherwise it records `channelContext` on the open decisions. `answered` is in the decision cleanup list.
- `lib/operator/prtruth.js` runs before every decision tick: it reads (cached two minutes, at most 15 reads a pass) every PR a pending decision or an approved or executing action is about, and reconciles: merged to `withdrawn` plus action `done`, closed to `withdrawn`, new head to `withdrawn` plus one re-ask message per head. A `publish_patch` stuck `executing` whose branch has a PR becomes `done`. `orphans.js` archives a reconciled merge as `done` and an unread PR approval as `unverified` instead of `orphaned`. The github merge ask reads the PR first and refuses a merged, closed or moved head.
- `openDecision` sets a ledger-wide `askKey` (`pr:<repo>:<n>` or `plan:<planDigest>`). A second job joins the open decision as a follower (woken with the outcome, its own action superseded); an approved, not yet carried out ask refuses a repeat; a new head supersedes the old ask.
- `lib/operator/keirprs.js` (hourly, kill switch respected): adopts orphaned Keir PRs on AHDGame. Limits per pass: 3 closes, 10 branch deletions, 2 asks, 3 owner lines, 3 description repairs. `KEIR_STALE_PR_DAYS` (default 5) counts from the first pass that found the PR orphaned. `ownerwait.js` skips Keir's own PRs and PRs with an open ask.
- The github merge path reports a refused merge for an owner-wait, adopted or approved PR as one owner line (`pr-blocked:<n>:<reason>:<head>`), or repairs the description when it is Keir's own PR. `prdisclosure.js` adds the section on publish, worker PRs (`codingworkers.js`) and promotion PRs.
- `lib/operator/decisioncards.js`: decisions keyed `kanban:<id>` complete their card when they leave `pending`; cards someone else holds get a note instead. A sweep at start and every six hours withdraws pending card decisions on closed or resolved tickets.
- `lib/operator/promises.js`: `recordTicketPost` records follow-up promises (`d.ticketPromises`) with due times (turn 90 min, release 4 h, owner 12 h, today 6 h, tomorrow 24 h, otherwise 4 h). A five minute pass wakes the ticket's root job when due (held tickets are skipped), retries once after 30 minutes, then posts one fallback line through `broker.promiseFallback` and raises `promise-overdue:` once.
- `lib/operator/postbudget.js` and the post guard: live announcements keyed by the ticket's main release receipt (`card.liveReceipts`), turn reports refused when their outcome words repeat the last report since the player wrote, and an hourly cap (`KEIR_TICKET_POSTS_PER_HOUR`, default 4) with one merged overflow per player message for corrections and owed answers. Refusals name the reason; nothing is dropped silently.
- `lib/operator/closing.js` (second pass): `job.closing` holds `closesWhen`, `waitingOn` and `on {kind, ref}` (turn, pr, deploy, decision, owner, player, developer, staff, worker, other), set through finish. A ticket or finding finishing waiting or blocked without one is refused twice per activation, then a derived one is recorded (`closing.derived`). `lifecycle.wakeStep` runs `quietWake` on a due timer with an empty inbox, only for the timer that finish set (15 minutes or more): ledger-only checks (turn clock, `prTruth` cache, decisions, messages, worker runs); unchanged means no activation and one `quiet_wake` audit. After `KEIR_QUIET_WAKES` (3) quiet wakes: hand an own open PR to `keirprs` (`closing.handedPrs`, no longer counted as live there), one ask activation for a ticket waiting on the owner with no question open, or park (`closing.parked`, re-checked in code every 6 hours, owner line `parked:<job>`). A named future turn is never escalated. Self-recovery treats checkable or parked waits as known; the hourly wait review skips jobs with a closing condition.
- Step-back: `d.ticketPace` counts Keir posts and corrections per ticket; at `KEIR_STEPBACK_POSTS` (10), `KEIR_STEPBACK_HOURS` (24) or `KEIR_STEPBACK_CORRECTIONS` (3), doubling after, the next activation gets the ticket timeline and must checkpoint before its one post.
- `postbudget.turnPostRule` is the one turn rule (replaces the separate repeat check in the post guard): a turn report needs a player message since Keir's last post (or an owed answer), a recorded promise (a turn promise once its turn has run; each promise opens one report and is kept by it), or `closing.closingCallsForTurn` (one report per named turn), and a called-for report still may not repeat the last answer.
- `prtruth.js` also reads PRs named by waiting jobs and review fix PRs (every 30 minutes each, at most 5 a pass) and keeps `job.reviewFix` (`fix_in_review`, `merged`, `live`, `fixed`, `reopened`); an unmerged close reopens the item once and wakes the review task. `review_item resolve` with outcome fixed is still gated on `reviewFixLive`.
- `closing.expireFindings` (every 30 minutes, at most 10 a pass) dismisses finding jobs blocked `KEIR_FINDING_EXPIRY_HOURS` (72) with no pending question, action or child, parked that long, or from an old world (`job.world` iteration, or a named turn more than 50 past the current one), with a `finding_expired` audit.
- `watchTick` stores `d.watch.turnClock` (`turn`, `nextTurn`, `iteration`) from `game_overview`. Turn promises record `afterTurn` and come due when the clock reaches it (8 hour backstop); with a stale clock they fall back to 90 minutes.
- Third pass, after the independent review (B1 to B3, M1 to M8, m1 to m7). `lib/operator/controls.js`: one switch per behaviour, `on`, `off` or `preview`, from `<state dir>/switches.json` (or `KEIR_SWITCHES_FILE`), then the environment, then the default: `openPrPass` (`KEIR_OPEN_PR_PASS`, on), `openPrCloses` (`KEIR_OPEN_PR_CLOSES`, off), `openPrBranchDeletes` (`KEIR_OPEN_PR_BRANCH_DELETES`, off), `githubReconcile` (`KEIR_GITHUB_RECONCILE`), `promiseWakes` (`KEIR_PROMISE_WAKES`), `postBudget` (`KEIR_POST_BUDGET`), `turnRule` (`KEIR_TURN_RULE`), `decisionCards` (`KEIR_DECISION_CARDS`), `closedTicketSweep` (`KEIR_CLOSED_TICKET_SWEEP`), `quietWakes` (`KEIR_QUIET_WAKE_CHECK`), `stepBack` (`KEIR_STEP_BACK`), `findingExpiry` (`KEIR_FINDING_EXPIRY`), `reviewGate` (`KEIR_REVIEW_ITEM_GATE`), `ownerAnswerNotice` (`KEIR_OWNER_ANSWER_NOTICE`), all on unless named. `preview` (`KEIR_PREVIEW=1`) turns every `on` into `preview`; preview rows go to `ledger.data.preview.items` (one per pass, action and target, with reason and count). Every gate stops on the kill switch or `paused`; closes and branch deletions also wait out the production hold. First start: `controls.history` takes items from before a pass's first real run `KEIR_HISTORY_PER_RUN` (3) at a time and skips those older than `KEIR_HISTORY_DAYS` (7) unless still open. Review 4 N2: `resolve` drops a leading byte-order mark; an existing file that is empty, does not parse, is not an object or cannot be read (`readSwitches`) sets `fileProblem`, `preview: true`, every default-on switch to `preview` (or `off` when its environment variable says off) and every default-off switch to `off`. In a file that parses, unknown keys and unusable values go to `warnings`; an unusable switch value fails safe (`preview` or `off`), an unusable `preview` means preview. `createControls({ log, audit })` reports each change once (`switches_file_unusable`, `switches_file_warnings`, `switches_file_usable`).
- `keirprs.js` third pass: a PR Keir closed that is open again, or a deleted branch that exists again, sets `handsOff` (never acted on again, one `keir-pr-reversed:` owner line). Closes and deletes record intent before the write; two failed attempts give up with one owner line; `branch_kept` is recorded once per sha. Superseded needs a shared closing keyword (fixes, closes, resolves) on both PRs, that issue closed, and Keir's changed files a subset of the merged PR's; weaker evidence is one `superseded?:` owner question. A close needs `KEIR_PR_CLOSE_GRACE_HOURS` (48) since first sight and since a `will-close:` owner warning, and no person comment or review. `foreignCommit` checks author and committer against Keir's identity (a worker branch also allows its first commit's identity) and ignores commit messages; a new head while orphaned sets `personTouched`. The ask requires every check green; custom-rules red with the section present is a blocked line. GitHub writes need `KEIR_GITHUB_TOKEN`. Branches a live task or worker uses are never deleted.
- `promises.js` third pass: `notePost(..., { askedAt })` records no promise while a wake is unanswered by a new player or staff message, and "cannot confirm" after a wake ends the woken promise (`ended`). Per ticket per rolling day: 4 wakes (`promise_capped`), 1 fallback line. The owner line goes after the fallback post and says what happened. Negations, quoted text and "see" are not promises. `dueNow` is used by the hourly cap and the quiet-wake check.
- `standdown.applyOwnerChannelAnswer`: a reply counts only with a named option or a plain yes or no; a label counts when it is the whole message (after lead-ins and politeness) or two or more words in a non-question; a yes or no next to a question or deferral is not an answer. An unmatched message that looks meant for a question (`meantFor`) sends one `owner-unmatched:<decision>` DM per question; mentions of others and unrelated text send nothing. `decisions.tick` closes out DM copies only for 11.2 channel answers (`ticket_channel_reply`, `ticket_channel_option`).
- `decisions.openDecision`: a duplicate ask is refused only while the approving job is alive; the task whose question a new head superseded becomes a follower of the new one. Follower release and `prtruth.tell` requeue only waiting jobs, or blocked ones whose block is the owner question. `prtruth` searches a never-published `publish_patch` at most every 30 minutes, six times.
- `decisioncards.js`: completes a card only for `approve`, `reject`, `explain`, `selected`, 11.2 `answered`, or withdrawn because the ticket closed or the PR merged or closed; anything else is a progress note. A card that backs another pending decision is left. The sweep reads the ticket status (also from an MCP content envelope) whenever there is a ticket; only ticketless questions use the task (`the task that asked it ended`).
- Post guard: posts from a task answering staff carry `staff: true` and are outside `postbudget.recentRun`. A correction, `playerAsked` (a player message after Keir's last non-holding post), an owed answer or `promises.dueNow` pass the hourly cap; holding lines do not count as answers in the turn rule. Refusals by the live rule, turn rule, hourly cap and step-back go to `ledger.data.refusedPosts[ticket]` (7 days, 20 per ticket).
- `bin/keir-preview.js [--json] [--no-github] [--state-dir D]`: runs every new pass in preview on an in-memory copy of the ledger and prints the would-be actions, the service's own preview rows, recent refused posts and what it could not check. GitHub GET only through the box's `gh` login; no kanban or support reads; nothing written. `/v5/trust/status` shows the switches, preview size and refused post count.
- Fourth pass, after the second review (N1 to N10, and the first review's partly fixed findings). `closing.PARKING` lists each wait kind, whether it may park and its event; `parkable` needs that event, a readable wait, and for owner or decision waits a pending question. Other waits get `closing.slowed` and a `KEIR_SLOW_WAKE_HOURS` (2) timer that reaches the model. Parked jobs are checked on every `wakeStep` (a changed mark wakes them) and re-checked every `KEIR_PARK_RECHECK_HOURS` (2) for tickets or `KEIR_FINDING_PARK_RECHECK_HOURS` (6) for findings, with no audit, post or run when unchanged; an unreadable wait at that point unparks to the model. `prtruth` reads deploy-waited merges against main (`onMain`), writes a `releaseEvidence` receipt and wakes the job (`deploy_wait_reached_main`). `owedTo` names what a parked ticket owes; it goes in the parked line, `describe`, the app ticket blockers and the report. Handoff needs `config.closing.handoffReady()`; `handedPrs` clear on activation and unpark. Step-backs carry `run` and only bind their own activation (`stepBackActive`), retried once if they never posted. Finding expiry needs `blockedByOwnFinish`, no unreleased `raisedToDevelopers`, no human message within the period, a fresh clock with an iteration; it stores `job.expired` and sends `findings-expired:` once a pass.
- `promises.notePost` records a promise made after a wake with the woken promise's `wakes` (`chainedFrom`); negation only between the modal and the verb; no half-way keep. Promise wakes never requeue a job held for a person. The fallback state is saved before the post.
- `postbudget.turnPostVia` takes `answersAsk` (an open asked item, or the latest within six hours, that the post addresses: `ticketcase.openAsk`) and `openAsk`; the second gives `doubt`, posted and recorded in `ledger.data.postDoubts` (`post_rule_doubt`).
- `standdown.namedOption(..., { reply })`: outside a reply only the whole message; inside one a label in a sentence without negation, deferral or a question. Unmatched messages meant for a question push an `owner-channel` inbox line to the asking job each time.
- `lib/operator/ghlist.js`: `ghApi` (64 MiB buffer, optional token, read only for the report) for every gh child in `operator.js` and the report; `listAll` pages with a jq field projection and throws `ListReadError` on an unreadable page or a truncated must-be-complete list. keirprs, ownerwait and devmerges use it; keirprs returns and audits `keir_pr_list_unread`.
- keirprs: a weak overlap sets `supersedeAsk` (cleared on a new head) and changes the ask to three choices instead of blocking it; records with `closedAt`, `closeStartedAt`, `handsOff` or `personTouched` are compacted, never pruned; repairs stop after two failures per head (`repair-failed:`); in preview the whole pass works on a copy of `d.keirPrs`.
- New switches: `channelAnswers` (`KEIR_CHANNEL_ANSWERS`), `oneAsk` (`KEIR_ONE_ASK`), `finishNeedsCondition` (`KEIR_FINISH_NEEDS_CONDITION`), `mergeDeadEnd` (`KEIR_MERGE_DEAD_END`); the live-notice repeat check is under `postBudget`; ownerwait skips Keir PRs only while `openPrPass` is on; the wait-review and self-recovery exclusions only while `quietWakes` is on. Preview writes nothing outside `ledger.data.preview`: not `controls.since`, the PR read cache, publish search tries, `promiseBudget` or a question's one notice. `test/keir112-preview-noop.test.js` checks it.
- Fifth pass, after the third review (F1 to F5, m1, m4). `livecoverage.ownedPrs`/`jobOwnsPr`: a PR a job owns is a `pullRequests` URL (repository and number) or an approved, executing or done merge action of that job. `ownMainReceipt(jobs, actions)` needs a main receipt with `pr` for every owned PR (`prtruth`, `codingworkers`, `devmerges` and own `where` receipts now carry `pr`); with no owned PR only a `dev-merges` receipt counts. `prtruth.mainCheck` runs only for an owned PR; `closing.observe` makes a deploy wait on another number unreadable (model wake, no park); `closing.infer` no longer reads a bare `#NNNN` as a PR. `promises.tick` acts on a promise only when due or for its own retry (`wokenAt`); a chained promise starts at one wake. `closing.PARKABLE` replaces `PARKING`: the closed list of parkable wait kinds, each refusing when its event can no longer come (turn reached, PR merged or closed, fix on main, PR closed unmerged, no live worker run or coding child); the safety net unparks a wait that has become final; the parked line names the real event. `standdown`: a reply to any message but the question is context only (no notice, no inbox line); `optionNumber` takes a whole-message number, or "option N" inside a reply to the question with no negation, deferral or question; more rejecting words in `NEGATES`. `controls.nestedGate(parent, child)` is the precedence rule for closes and branch deletes under `openPrPass`. keirprs re-asks a head once when its ask job ended with no `pr:AHDGame:<n>` decision (`askTries`), and pages changed-file lists for the superseded check.

## 11.1.1 (2026-11-20)

### For users

- After you receive an answer in a ticket, a second Keir job can wait for your reply without asking you the same thing or sending a closing reminder.

### For developers

- A reply delivered to a ticket by another job or an operator, cross-checked against the Discord channel (every part present, in order, together exactly the stored update), now stops a closing job from posting a recap or close notice. It never licenses closure: only the ticket's own answer mark or a player confirmation does.

## 11.1.0 (2026-11-20)

### For users

- In the owner app you can take over a ticket, see what its assigned worker has done, send it directions, and hand the conversation back to Support Keir.

- The owner’s Keir iPhone app can show actionable support approvals alongside the existing Discord notifications. Quiet hours apply to each device. When quiet hours end, the app alerts you only for decisions that still need an answer.
- Connected games shows the A House Divided turn and engine, MetroForge services and city bundles, and Grand Century site and release health. Each card identifies its source and when Keir checked it.

- If a ticket run stalls before Keir sends a reply or takes an external action, Keir can try once more automatically.

- Questions about national GDP, market sales and prices, your shops' sales and profit, and your action points are answered from the measure you asked about, not a nearby one. If a figure is not recorded, Keir says so instead of estimating.
- A simple "where do I find this" question, a stop or a thanks gets one short answer with no chart, report or extra update.
- When the numbers over several turns are the answer (market history, your shops' results, your action points), Keir can attach one chart to its answer in your ticket. Long tables get a dated page, linked under the chart; your own ticket's page needs you signed in at lakesidegames.net with the account linked to your Discord. Keir can keep that page updated for up to 24 hours when coming turns may change the answer. It never posts those updates in the channel, and stops on request, at ticket close or when staff take over. Every page opened from a ticket is private to the player who opened it, even when it shows public market data, and stays private if the ticket is later reassigned. If your ticket has no linked game account, Keir answers with the chart alone and does not offer updates.

### For developers

- The owner app serves a fixed catalogue of game reads through the tool broker. Quiet hours use a device time zone and persist delayed approval notifications across restarts.

- The scheduler distinguishes a lane deadline from an owner stop or staff takeover. A ticket can retry one deadline after a minute if no writes or posts occurred. A second deadline alerts the owner.

- Owner ticket supervision (`ticketsupervision.js`, `GET`/`POST /api/keir/app/tickets/:n/supervision`, ops `take`, `message`, `handback`). Take verifies the ticket against the support record and a fresh Discord claim scan, sets the per-ticket owner to `keir-worker:<task>`, withdraws Support Keir's queued replies and starts a separate durable support worker with the coordinator's next action and evidence. Only that worker passes the takeover fence and `supportOwner.deferred`; channel messages route to it (`supporttakeover.publisher`). Handback fences the worker at once, withdraws its queued posts, refuses its late tool calls, and files a Handoff Desk receipt for Support Keir. Staff claims, staff holds, granted approvals and uncertain receipts are never touched; stale revisions and reused request ids are refused. A staff or desk takeover during supervision ends it on the next tick.
- `support_evidence_lookup` (ops-knowledge) is in support read scope and a player ping may call it, and nothing else in ops-knowledge. `evidencelookup.js` builds its arguments (scrubbed question, country and commodity only, the live gamestate tool list instead of the model's hint) and turns an unlisted read into a stated gap. Quick turns on easily confused measures get a pointer to it; navigation, thanks and stop get none.
- Reporter-bound reads inject `ticket` and `character` in every role (owner, developer in a public room, player, finding) and every inherited child; no role chooses the identity.
- Evidence-gap learning: a gap is a candidate until a second reporter hits it, standing caveats and undeployed tools are not failures, and only the reporter's own helpful vote confirms a lesson (an auto-close or thanks does not). `keir-lesson-report` shows confirmed apart from recalled-quiet.
- Support reads include `market_history` (public) and `reporter_operating_results` and `reporter_action_points` (reporter-bound). The broker injects the ticket reporter's character, refuses any identity or ticket argument that names someone else, and applies the same rule to inherited investigation tasks. They are not in finding scope.
- Ready-read seeds route level versus growth, sold versus offered, shop profit and action point questions to those reads. Reporter-bound reads never enter the learned example index.
- `lib/operator/evidencegap.js` records evidence gap reasons (wrong metric, tool discovery, missing data, unclear explanation) per ticket, writes at most one fixed-wording lane lesson per signature with no case text, and counts a lesson as confirmed only on a later clean ticket from a different reporter where it was recalled. Confirmation changes reporting only; no scope or permission follows from it.
- `present_evidence` (lib/operator/evidencepages.js) builds a chart or table only from `market_history`, `reporter_operating_results`, `reporter_action_points` and `commodity_market` results the broker received (captured by one hook in `tool()`). The model names an `ev_` observation id; links, files, ticket and channel come from the ledger. Reporter evidence is bound to its ticket and channel. The chart is staged, never posted on its own: the answer's delivery path calls `claim` / `verify` / `delivered` / `release`. Pages are write-once files in `EVIDENCE_PAGES_DIR` (default /var/lib/lakeside-evidence); trackers archive at 24 h, stop, close, pause, takeover or Keir stop, via a 60 s sweep that holds across restarts. Monitor helpers: `observe`, `sweep`, `endReason`, `archive`, `TRACK_MS`.
- Reads are parsed and projected by the typed adapter in lib/operator/evidence-series.js (it fails closed on an unknown contract version, a mismatched metric or unit, or an `asOfTurn` that is not the newest row). Pages show human headings, units, scope, world and time, extra tables, key facts and caveats, and say "not recorded" for empty cells. `commodity_market` is presentable as one dated single-turn table but is refused for trackers.
- Evidence page privacy and archive revision. Every page opened on a ticket (tracker or report, any data) is `visibility: "ticket"` with `meta.audience` pinned at creation from `support_get` (ticket `createdAt`, character from `reporter.profileUrl`), cross-checked with the task's `reporterCharacter`; the broker passes `readTicket`. No verifiable reporter, or no `EVIDENCE_PUBLIC_BASE` (now no default), means no page, no link and no tracker: the chart is still staged, or the model answers in words. Only a public ping's one-off `market_history` report is public, with no ticket, audience, task or channel in its files. Store writes are write-once and atomic (temp, fsync, link); snapshots are gapless, never rewritten, and refused at or after `meta.expiresAt`; a ledger behind the disk catches up. A failed `archived.json` write leaves `endReason` + `archivePending` (still ended, no appends) and `archivedAt` unset until the sweep's retry succeeds; an `archived.json` already on disk ends the tracker. Stores used by tests must write a real `meta.json` (`kind`, `expiresAt`) and dated snapshots.
- Evidence delivery is first class for chart only, link only and chart plus link. A dense report with no single-unit chart (a 27-market dated report) stages its report link alone; it rides the answer's first message, after the answer, on both the support (ticket) route and the outbox (ping and channel) route, and an outbox answer carrying evidence is never split. A `linked` receipt needs Discord's stored message id for the posted message that carried the minted link; a chart still needs its attachment id. Report links need `EVIDENCE_PUBLIC_BASE`: there is no default site, unset means no link, and the sign-in note names the configured host. A ticket answer bound to a presentation sends a stable broker-only `update_key` (same key on retry and after restart, never for unrelated answers) and a `reply_to` taken from the stage or the ticket task's own channel; `support_action` strips both, with `evidence`, from model input.

## 11.0.1 (2026-11-20)

### For users

- Keir no longer closes a ticket as "the fix is live" while a newer fix request on that ticket is still open.

### For developers

- The auto-close rule b now requires no unreleased fix handoff, so an older live mark cannot close over a newer request (ticket 1862).

## 11.0.0 (2026-11-20)

<!-- Keir source coverage: 7abbcfc..52524d7. -->

### For users

- You can correct Keir in a ticket while it is investigating. If its coding worker is busy, the same ticket coordinator can answer your question while that work continues. Related points arrive together in one ticket reply.
- In an enabled Discord channel, you can reply to a particular message and ping Keir. Keir can follow the speaker, reply and nearby screenshots through intervening chatter.
- Staff can talk to one another in a ticket without prompting an automatic reply. The owner can tell Keir to stop talking in that ticket and it stands down silently.

### For developers

- The coordinator consumes only the inbox rows included in its activation. During a turn, newly arrived human messages fence stale drafts and remain recoverable until the coordinator records its reply. Discord outbox replies carry their source message ID.
- A spare conversation slot can serve a ticket beside its own coding child. The pass can read and reply, checks ownership, and yields to the ordinary investigation. An unsuccessful pass cannot repeatedly claim a slot for the same message.
- The ticket case file identifies individual questions by speaker and message. A deferred production notice survives a card transition and can be delivered after the conversation resumes.
- Owner decisions, coding worker runs and watch findings now use the common status definitions. Live bond pool cash repairs require the ledger repair workflow.

## 10.5.3 (2026-11-19)

- Keir's task and approval statuses are now defined in one place. Every status change is checked against it; an unexpected one is logged for review and still goes ahead, so nothing that worked before is refused. Each task and approval also records when it entered its current status and what it was before.
- An approval whose write was rejected before anything ran is marked failed on restart. Two such approvals had stayed "in flight" for over a day, which made their tasks look like they were holding an unfinished write.
- Keir keeps a player's correction open and checks for repeated explanations before replying again.

- Staff commands can open nearby Discord mockups after intervening text replies. Keir passes image references into the work request and counts a screenshot as viewed after a successful download.

- Repeated ticket runs that run out of steps narrow the next retry, then slow down and raise one staff alert if the ticket still makes no progress.
- Keir support can inspect the Discord bot source when investigating slash commands and can recover team activity lookups sent through the wrong tool.

- A short Markdown welcome explains how Keir helps on a first support ticket, when staff step in, what details to include, and how to rate replies.

## 10.5.2 (2026-11-19)

- A status card no longer moves to live, and no live notice is sent, because a lookup showed someone else's change on the main server (ticket 1859 was told its unfixed bug was live). Only the ticket's own pull request, its own merge or a linked developer change counts.

## 10.5.1 (2026-11-17)

- Keir prepares guide corrections from Ask reviews, asks for approval on the exact PR head, then carries approved changes through normal release checks. A card alone cannot mark a guide fixed.
- A coding worker report without a PR goes back to the ticket task so Keir can verify it and act on it.
- Keir checks the institution behind a claim that a legislative chamber is absent before posting it to a player.

## 10.5.0 (2026-11-18)

### For users

- Keir now works through what Ask and Keir itself flag for a human, instead of leaving it on a page nobody opens. Every 30 minutes it collects Ask's doc conflicts and blocked, salvaged or downvoted answers, player thumbs down it did not already act on, and tickets where its own guards refused more than two posts in a day. Each new item becomes one internal task, at most 3 per sweep and 12 per day, that checks the answer or doc against the code and live data, corrects or files a card, and closes the item in Ask. Nothing from these tasks is ever posted to a player.

### For developers

- `lib/operator/reviewsweep.js` and the `reviewsweep` ticker (30 minutes, `KEIR_REVIEW_SWEEP=0` turns it off) create `kind: "finding"` tasks carrying `reviewItem`, deduplicated by source and id in `ledger.data.reviewQueue.seen`. Ask items come from `GET /api/keir-ask/review` with the existing `KEIR_ASK_URL` and `KEIR_ASK_SECRET`; a missing route or secret counts as unavailable and is skipped. Needs the Ask release with the review feed (3.14.5) deployed first.
- New `review_item` tool (`lib/operator/reviewitem.js`), visible only to review tasks and scoped to the task's own item: `resolve` (Ask resolve endpoint), `lesson` (one line in the ticket case file, rendered as "Lessons from review"), `wake_ticket` (internal inbox note, once an hour per ticket).
- The shift log gains one line, "Review queue: N open (Ask X, Keir Y), oldest Zh", and its cap goes from 1500 to 1600 characters.

## 10.4.2 (2026-11-18)

### For users

- Keir stays responsive when an expired task has unread mail. The task stays blocked for review.

### For developers

- Skip the inbox wake when the final task deadline has already elapsed. This stops a blocked-to-queued loop that recorded audit events and repeatedly rewrote the ledger. A regression test covers expired findings with unread system mail. See #459.

## 10.4.1 (2026-11-18)

- Closing a ticket no longer counts an owner or staff line as an unread player reply. The close guard read every human message while the player clock (ticket_history) skips staff lines on purpose, so an owner "hello" in ticket 1845 refused every close. It now uses only the player's messages and the newest player time across the ticket's tasks.

## 10.4.0 (2026-11-18)

- Keir answers what the player asked. The case file now opens with "Player asked": the ticket text and each later message that states a problem or asks something, open items first, marked answered when a post covers its subject. A post that redirects ("the real blocker is") or concludes ("working as intended") without touching an open item is refused, at most twice per ticket. Ticket 1852: the player said Sector Tech does nothing at the 30% cap, Keir answered about research points, and the player voted it down as not what they asked.
- A player thumbs down or report on a ticket answer now goes into the ticket case file (their reason, the answer's first sentence, the asks it touched reopened) and wakes the ticket once an hour with the instruction to answer the missed ask. Owner, staff and moderator votes stay record-only.

## 10.3.1 (2026-11-17)

- The shift log lists game releases before Keir's own; the per-section budget was dropping the game line behind three Keir releases.

## 10.3.0 (2026-11-17)

- team_activity: a read that shows Keir what the rest of the team is already doing about a ticket. It gathers staff, owner, junior developer and moderator messages in the ticket channel since Keir's last post, kanban cards in now, next and blocked that name the ticket or match the topic, running agent workers (claude-* and keir-worker-* units, with a one-line goal from the brief or the ledger) and open PRs on AHDGame and lakeside-ops that match, in about 2,500 characters. Each source degrades to "unavailable" on its own, and results are cached for 60 seconds. On ticket 1852 the owner wrote "I'm fixing" and a card and a fix worker existed, yet Keir kept posting "Answered, no fix needed" and corrections because none of that was visible to it.
- The evidence pack includes team_activity for every ticket lane (only when a section has content), and the broker runs it before any post that says no fix is needed, calls a ticket answered or posts a correction, including the "Answered" card stage. While staff said they are fixing it, or a card, worker or PR names the ticket, that post is refused with the instruction to tell the player a fix is in progress and who is on it in plain words. Refused at most three times per ticket so a post is never stuck. KEIR.md, KEIR-CORE.md and the bug, question and mechanics playbooks carry the same rule.
- Durable ticket case file. Keir runs a ticket as many short activations that each start with no memory, so on ticket 1852 it said the player's cards were reachable, then not reachable, repeated a wrong claim and ignored the owner's "I'm fixing". Every ticket now keeps one compact, dated record in the ledger: each claim posted to the player with the read it rested on and its status (standing, corrected, withdrawn), promises and whether they were kept, owner and staff statements in the channel, who is on the fix with its card and PR, and open questions. It is written from the delivery path with no extra model call and rendered at the top of every ticket activation, capped near 2,000 characters (oldest corrected claims collapse first). A post that reverses a standing claim is refused unless it starts with "Correction:", which marks the old claim corrected; check_draft runs the same check.
- Shift log. A model-free collector refreshes a short world summary every 10 minutes (about 1,500 characters: today's owner decisions, fixes in flight, releases in the last 24 hours, the current turn and failed phases, the top known bugs by title similarity) and injects it after the case file in every ticket activation. Each section degrades to "unavailable" on its own.

## 10.2.3 (2026-11-17)

- The feedback row is back to one per channel, on the newest message. 10.2.1 put the row on every player reply posted by the support service, and those replies never went through Keir's delivery, so nothing removed older rows and every message in a ticket channel kept one. Now both writers enforce the rule from Discord's own state: after a support reply lands (and after any Keir answer), the channel's recent messages are listed and every other row is removed. Keir's 10-minute sweep also re-checks open ticket channels (a few per pass, each at most every 30 minutes) and removes a row after 24 hours even when the support service posted it. `bin/keir-feedback-strip.js` is a one-shot cleanup for rows already out there: dry run by default, `--apply` to strip.
- Keir treats "no effect" reports as a likely bug first. When a player says a research, upgrade, purchase or action did nothing, Keir checks that the state makes sense for the world (a 2027 company owning 1940s tech) before explaining it as a game rule. Added to the evidence rules and to the bug report and mechanics question checklists.

## 10.2.2 (2026-11-17)

- Refused reads now say what to do. Of 51 "read tool is outside support scope" refusals in three days, 41 were Keir's own tools (turn_status, via a guessed turndiag server) or github actions (deployed, where) sent through read_tool, up to 13 times on one ticket. read_tool turn_status now runs turn_status, and every scope refusal names the right call or the tools the server does offer.
- sector_builds: a corporation's sites with build queue, construction financing status, pending property transition and for-sale flag. Construction tickets were falling back to raw corporateSectors reads because trace_sector does not carry the build side. The raw-read hints for corporateSectors and gameState name the typed reads. raw_read is unchanged.
- MCP reads that cannot connect are retried with backoff (1.5, 4 and 10 seconds) instead of once, and the error names the cause and server. A reboot at 15:14Z left every MCP refusing connections for 11 minutes while Keir was already up, which produced the day's 64 "fetch failed" tool errors.
- Throwaway Claude homes (claude-home-*) are removed when the run ends, and at startup the operator removes ones older than a day that no live process uses. 5275 had piled up in the state directory.
- The Ops widget line retries an empty or repeated answer up to three times in the same attempt instead of waiting ten minutes, and the failure log carries a fixed class (provider:error_max_turns, rejected, repeated, provider:timeout) instead of only a counter.

## 10.2.1 (2026-11-17)

- Player replies posted by the support service now carry the same feedback row as Keir's own answers, on the last message of the reply. A click on one is recorded exactly like any other: Keir adopts the message when Discord shows it is the game bot's message with these buttons, and takes the ticket from the channel name.
- Support replies no longer show HTML entities (`state&#39;s`), and a player reply never carries a role, user, @everyone or @here mention.

## 10.2.0 (2026-11-17)

- Answer feedback. Keir's newest answer in a channel carries one row: ⭐ Great, 👍 Helpful, 👎 Not helpful, Report a problem. The row moves to each newer answer in the channel and disappears after a day, so threads stay clean. KEIR_ANSWER_FEEDBACK=0 turns it off.
- The game bot handles the clicks (private thanks, a reason form for 👎 and Report) and sends only the interaction token to /api/summon/feedback. Keir reads the private reply back from Discord, so the voter, message and vote come from Discord, never from the poke. One vote per person per answer; a changed vote replaces the old one.
- Each vote stores the model, lane, ticket, work type and release that produced the answer, and the voter group (owner, staff, mod, player). GET /v5/feedback/summary reports helpful rate by week, model, work type, release and voter group, with recent problem reports linked. The morning digest gains a feedback line with the latest reasons.

## 10.1.16 (2026-11-17)

- GitHub housekeeping is Keir's own job. close_issue now works from every lane (engineering, watch, finding, ticket, coding) whenever the fix is live; only the live check guards it. close now also closes a superseded PR from a bot or agent account (never a person's) once a merged PR covers it, with the superseding PR named in the comment; the head branch is deleted only for keir/ branches.
- raise_to_developers and a needs-owner finish refuse requests to close an issue or PR, delete a branch or re-run a check, and point at the github tool.
- A finding's prepared repair, and a coding worker's PR that needs the owner, now arrive as an Approve or Decline button instead of a text DM telling the owner to act elsewhere. Approve on a repair runs it through execute_action with a fresh plan and token.

## 10.1.15 (2026-11-17)

- Sentry sweep. Keir no longer reports guard refusals as errors: raw reads that a typed tool covers, authority and scope refusals, "not finished" and unanswered-finish refusals, the assigned-ticket-only read, an unlinked reporter and a refused ticket open are still recorded and listed by keir-failures, but never raise a NEW or SPIKE alert. Network and interrupted-activation blips alert only as a real spike. Real loops and deadlocks built from the same refusals still alert.
- Reads retry once after a refused or reset connection (an MCP restarting for a deploy). Writes and timed-out reads are never retried.
- A raw read of a collection that a typed read covers (corporations, corporate sectors, ledger entries, characters, macro countries, party organisation, resource capacity) now says which tool to use. An empty raw read of a collection that does not exist says so and names the close spellings (partyBudgets is partyBudget).
- map_snapshot with country scope and a world-only metric (parties, players, economy rates) is refused with the metrics that do work, instead of a bare "not available for country maps".

## 10.1.14 (2026-11-17)

- Keir does not repeat itself on a ticket. A second substantive message is refused when the player has not written since Keir's last one and nothing on the ticket changed (handoff filed or released, issue closed, decision opened or answered), so the "both items are settled" message that went to ticket 1836 four times cannot recur. Status cards edited in place are unaffected.
- "I've passed it to the developers" only goes out when a developer-visible handoff was filed for the player's current question, and the "no confirmed answer yet" line is no longer sent at all when the player's question already has a real answer (the answer record is now kept past the hour that cleared it before).
- Holding lines say what is being checked and nothing else. A cause or account state stated as fact ("has nothing set aside for logistics", ticket 1845) is refused, and so is any claim Keir cannot make: "loads on a phone for me", "I tested it", "I loaded the page" (ticket 1843).
- A verdict on a build price must name the largest factor above the base price from the quote breakdown (dominance surcharge, commodity toll, rate, host country, founding, expansion), as ticket 1844 left out a surcharge worth a third of the price.
- The auto-closer no longer closes an "answered" ticket while the latest staff or bot post promises a follow-up that never came (ticket 1838).
- An owner decision given in the ticket channel is read as the answer: the open decision is closed, the task wakes with the owner's words, and Keir never again says the ticket "needs the owner's decision" after that (ticket 1842). Decisions that gate an action still need the approval button.

## 10.1.13 (2026-11-17)

- Keir no longer reports or talks about tickets that are already over. Before any owner alert (stuck-ticket watch, "needs a person", the sweeper) the ticket's real status is read, and resolved, closed or merged tickets are skipped. A ticket channel deleted outside Keir counts as resolved: every Keir job on it stops. Once a ticket is resolved, by Keir, staff or the support service, nothing more is posted to the player, so the "still working on it" line after tickets 1842 and 1836 closed cannot happen again. An answered ticket waiting out the closer's quiet hours is no longer flagged as "checked many times and not closed".

## 10.1.12 (2026-11-17)

- A ticket with two changes is only called live when the release proof covers every one of its pull requests. On ticket 1842 one merged change made the whole ticket look live, so a live notice went out for a change still on its way and was corrected three minutes later.

## 10.1.11 (2026-11-17)

- The ticket closer now actually closes. A player's thanks counts as a confirmation even when Keir acknowledged it afterwards. The six quiet hours run from the player's last message or the first answer after it, so later Keir posts and card edits no longer restart them. Replies posted by the bot or staff through any path count as answered, so a ticket is not stuck waiting on "the player wrote after the last reply". Developer handoffs are released when the fix is verified live, the linked GitHub issue is closed, or the kanban card is done, so a shipped fix no longer blocks closing forever.

## 10.1.10 (2026-11-17)

- Keir now closes tickets. An answered ticket is resolved (same resolution receipt and closing message as before, one short line to the player) when the player confirms the fix or answer worked, or when the fix is live and the player has sent nothing for 6 hours, or when a question was answered and the player has been quiet for 6 hours. Tickets with an owner closure hold, an open owner decision, an open developer handoff, a staff takeover or owner pause, or an unanswered last player message are never closed. A bug that is answered but not live is not closed by the quiet rule. Checked every 10 minutes; `KEIR_AUTOCLOSE=0` turns it off. This replaces the "awaiting auto-close" state tickets 1836, 1837, 1838, 1841 and 1842 sat in, where nothing defined how long quiet was.

## 10.1.9 (2026-11-17)

- A green PR Keir opened that its task has no standing authority to merge (a public-page watch finding, an engineering task, a finding whose fix is not display-only) no longer ends as a plain-text "Needs a person" DM (PR 6680). The github merge and promote actions now ask the owner with Approve and Decline buttons, using the same plain-language explanation and reviewed-head pinning as other merge approvals; a later push invalidates the approval, Approve merges under the usual effect fencing and green-check rule, Decline leaves the PR open. Red or still-running checks never produce a button, and rule, balance and economy changes still go through the owner's own approval.
- raise_to_developers refuses a merge, ship or deploy request about a PR Keir opened and points the task at the github merge action, so such a request can no longer go out as plain text.

## 10.1.8 (2026-11-17)

- A bare @mention in an active channel is answered in the context of the messages since Keir's last post (up to 30 minutes back, evidence only, never inherited as instructions) instead of "Yes, still here". With nothing recent it still answers "Are you there?".
- Status card item names are stripped of trailing stage labels ("X: Live on the main server"), so a model that copies the public receipt line back as a name no longer doubles the label or defeats the already-announced check that stops a second "now live" notice.

## 10.1.7 (2026-11-17)

- Quick rules-lane answers go through the same claim checks as every other ticket reply (unread claims, bug labels, account facts, settings, prices, contradictions, composition). Only the rule-lookup check still defers to Ask, which is the rule lookup. The lane no longer records its own answer as evidence; only the sources Ask cited count. A refused quick answer goes to the investigating lane.

## 10.1.6 (2026-11-17)

- The quick rules-answer lane only takes pure rules questions. A ticket with a screenshot, any number, or a question about something the player saw happen to their own game ("why did GDP drop", "why is my cash so low") goes to the investigating lane, which reads the live value before replying. The quick lane cannot read live data, so it was answering reports about real numbers with rule explanations (tickets 1838, 1841).

## 10.1.5 (2026-11-17)

- Wrong-looking prices (ticket 1841, same family as 1837). "Why does 1 depot cost 22 million dollars" is now treated as a report of a number that may be wrong, not a rules question: the fast lane no longer answers it and the ticket goes to the investigating lane. An explanation or defence of a price ("is the build price for ...", "priced off ...", "X, Y and Z move it up or down") is refused until a live read exists and backs it, and is always refused when the read shows the price is about twice the company's cash or more; Keir then says it looks wrong, that it is checking it as a possible bug, and raises it to the developers with the figures. The composition check now also catches that phrasing.

## 10.1.4 (2026-11-17)

- Ticket honesty (ticket 1837). A reply that explains what a number is made of ("the total adds X and fees") must now match something Keir read on the ticket, or it is held back and then labelled unconfirmed. A "not confirmed" line is refused when the player was already answered and nothing new was read, and the code-written "no confirmed answer" line is skipped when the player already has a reply. A bug, data or outage task can no longer finish with a summary that names a read it has not done ("next activation", "next investigator to read"); it is refused twice and told to do the read. The owner DM for an unanswered ticket now lists what was checked, the evidence, what the player was told, and the specific blocker.

## 10.1.3 (2026-11-17)

- A bug ticket shows its progress card ("Investigating, looking into this now") within seconds of Keir picking it up, before Keir starts working it. A returning player gets no introduction, so on ticket 1836 the first thing anyone saw was the answer, almost three minutes in. The card updates in place and is not counted as Keir's answer.

## 10.1.2 (2026-11-16)

- Failure tracking reads the message inside an MCP tool error before grouping it. Every tool error had been folded into one group, so the code index outage was reported to Sentry under an unrelated "parties is not available for country maps" title.

## 10.1.1 (2026-11-16)

- An approval DM is only deleted when the person it was sent to answers it. If someone else answers, or it is withdrawn, expires or is replaced, the DM is edited to say how it ended instead of disappearing (owner, 2026-11-16: ticket 1832's question vanished from the owner's DMs after Ariane handled it).

## 10.1.0 (2026-11-16)

- A ticket watchdog checks open tickets every five minutes without using the model and tells the owner once per problem: a new moderation ticket (also sent to the support delegate, and again if still open after four hours), a ticket nobody is on for an hour, Keir checking a ticket repeatedly with nothing new, a player waiting over two hours, and an answered ticket still open six hours later. `KEIR_TICKET_WATCH=0` turns it off.
- An account action Keir cannot do (relinking a login, lifting a signup block, unbans, VPN access, recovery) is always handed to a person and DMs the owner, even when the model files it as its own to-do.
- Telling a player the developers or staff have something, or will check or reply, now needs a handoff that reached a person. Keir's own self-assigned card no longer counts, and the future tense no longer gets past the check.
- Actions and decisions left behind by archived tasks are archived a week later instead of piling up in the ledger. Approved actions are archived as orphaned and never run.

## 10.0.4 (2026-11-16)

- A ticket Keir has answered, with no newer player message, now enters its closing window even when the model forgets to mark the answer as delivered. Ticket 1833 was re-checked every 15 minutes for 12 hours (39 runs, two repeat posts) instead of closing.
- Account actions (moving a login to a new Discord, lifting a registration block, unbans, VPN access, recovery) must be raised so a person sees them. Ticket 1834's recovery was filed as Keir's own to-do, which alerts nobody, while the player was told the developers had it.

## 10.0.3 (2026-11-16)

- An incident opened from Keir's own monitor is now Keir's to work: it gets a task, routes as an outage, posts a plain status and closes when turns run cleanly. Incidents staff open still belong to staff (ticket 1831 had nobody working it).
- The monitor holds a turn failure while turns are paused or maintenance is on, instead of proposing an incident during planned work, and describes failures in plain words instead of a JSON stamp.

## 10.0.2 (2026-11-15)

- A promotion to main that Keir starts by hand ships bug and display fixes without asking for a sign-off, the same as its coding worker (owner, 2026-11-15). Economy and turn-engine changes, and rule or balance changes, still ask once.
- The activity trail reads PostHog US cloud by default, where the game sends its events.

## 10.0.1 (2026-11-15)

- A task that runs out of time twice alerts the owner once. Three background findings were being put back to waiting and re-blocked on every tick, which repeated the alert about once a second. Self-recovery no longer turns such a task back into a developer wait (that was the loop).

## 10.0.0 (2026-11-15)

- How-to, where-is and strategy questions filed in the bug channel are routed as questions (lighter context, answer and close) unless they describe something broken.
- A defect Keir finds by reading the code can be named to the player once it is filed and Keir's recorded fact cites the file it read; before, only code that labelled its own bug counted, so Keir told players a confirmed fault was unconfirmed.
- Filing a second, different bug on the same ticket no longer stalls on the first one being offered back as a possible duplicate.
- A bare "Thanks." after a real answer no longer forces a filler reply from the player-reply wait either.

- Database reads no longer silently drop game settings whose names mention Discord, email or sessions (for example the setting that makes Discord linking required for new characters). Only personal identifiers, contact details and credentials are withheld, and a read now names any field it withheld, so a withheld field is never reported as missing.
- A bare acknowledgement from the player ("Ok.", "thanks", "will check it out") after a real answer no longer forces Keir to post again before it can finish.

- New tool `check_draft`: Keir can check a draft player post before sending it. It runs every content check a real post runs and lists all the problems at once with a fix for each, plus the post budget. It posts nothing, records nothing and leaves every refusal counter as it was.
- Two new checks on every player post, also run by `check_draft`: a post that says the opposite of an earlier post on the same ticket (a fix is being built, then no fix is being built; live, then not live; available, then not available; can, then cannot) is refused unless it starts with "Correction:", and a post that calls something available when a read in the same task says it is locked ("not available until", "unlocks in", "opens in <year>") is refused. A "Correction:" post is never treated as a repeat of the post it corrects.
- The brief now has one shipping rule instead of three: bug and display fixes outside the economy and turn-engine paths ship by themselves on green checks; economy, turn engine, migrations, money heals and rule, balance or economy-behaviour changes need the owner's yes (once per ticket chain unless huge), and main promotions of those wait for the owner's waking hours.
- Every Muse run keeps its step trail (the text Muse writes between steps and its tool events, in order) so failures and replays can be read step by step. Muse exposes no private reasoning. The trails age out with the other per-run files.

- Every distinct problem raised to the developers gets its own board item. If the board returns an item that already holds a different problem, Keir retries once with a distinguishing title and otherwise records nothing and says why. Only an explicit appendTo joins an existing item.
- A public issue no longer needs the reporter looked up or linked, so an unlinked reporter's bug can be filed and shipped. The issue still refuses the player's character name, username and channel name.
- One owner message per ticket: a second owner choice on a ticket that already has one waiting joins the first message (all open questions listed, recommended option first) instead of sending another. Each question stays its own decision, so each answer maps back to its own question. When the first is answered the next one takes over the message. The 12 hour reminder is unchanged.
- Before its first run on a ticket, Keir gathers the reads that ticket type almost always needs (wiki and code for questions, the reporter and their recent clicks for bugs, turn status for outages, Ask health before a strategy redirect) and starts from them. Lessons from the nightly review now show for the ticket's lane.
- A tool result marked stale at the top level no longer crashes the call.

- A refused extra post can no longer trap a ticket task. When the player's latest message already has a real answer, a later refused post does not mark the player as owed an answer, and finishing clears a leftover mark. When an answer really is owed, one corrected post gets past the ten minute and three post pacing rules. Pacing refusals now list the post budget (posts left before a pause, when a long post is allowed, whether an answer is owed, the last post).
- Keir now groups its own failures (reasoning, tool, provider, process, player) into fingerprinted groups in events.db, with the model transcript for each sample. A 15 minute scan files one board card per new, spiking or release-regressing failure; `bin/keir-failures.js` (top, new, release, show, backfill) and `GET /failures` read them. Optional Sentry output with `KEIR_SENTRY_DSN`, optional daily digest with `KEIR_FAILURE_DM=1`. Per-run files older than 14 days are listed daily and deleted only with `KEIR_RETENTION=apply`. The weekly builder brief includes the top reasoning and tool failure groups.
- New `ask` tool: whether Ask is answering and its recent refusal rate, what Ask told the ticket's reporter, and a desk query to test a question before redirecting. When Ask is failing or down, the advice redirect is switched off and the context says why. Needs two read-only endpoints on the Ask service (branch `keir10/ask-bridge` in ask-site).
- New `resolve_reporter` tool, and `reporter_state` now falls back to it: finds a reporter's account and current and retired characters from the ticket link, game username, linked Discord account or repeated page visits, without asking the player who they are and without returning emails, sessions or Discord ids.
- New `player_trail` tool: the reporter's page views, clicks, rage clicks and errors around a time from PostHog, with replay links for developers (needs `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`).
- New `request_log` tool: the reporter's recent API requests with status from the game's access log (no durations; page loads are not logged).
- New `turn_status` tool and function: state, current turn, last turn finished, expected next turn, minutes overdue, lock heartbeat age and last failure phase. `request_action` gains kind `turn_lock_reset`: a dry-run plan by default, then an owner-approved heal that clears only the stale lock flag.
- `github` gains `pr_diff`, `pr_comment` and `rerun_check`. `view_page` takes a path, a device (desktop, iphone, android), reduced motion and dark mode.
- Ticket tasks can now read a country's military roster, the reporter's own bond positions, a country's fiscal history and the game's lore wiki, glossary, parties and organisations. The alt-ring tools stay staff only.
- Every closed ticket now gets a score from 0 to 100 from signals Keir already records (reopens, corrections, player complaints, staff feedback, refused tool calls, activations, owner decisions, hours open). The nightly self-review starts from the four lowest-scored tickets of the last three days and files its lessons under the lane they belong to instead of the brief.
- Capability gaps are ranked: a gap hit by a task on a low-scored ticket counts double. `bin/keir-gaps.js` prints the top ten with their board card ids.
- `deploy/release.sh --replay-gate` (off by default) runs the known-failure replay set on the live release and on the build and refuses the release if a scenario that passed on live now fails. The weekly builder (`deploy/keir-builder.*`) is in the tree but not installed.
- The replay benchmark is back in the tree, with seven known-failure scenarios from real tickets (`--set k10`) and a transcript saved per run.
- Every ticket is routed to one lane before the model runs: question, bug, data repair, outage, people (account, ban, recovery), idea or advice. The router uses the intake tags, the channel, the player's words, open incidents and, for "the turn is stuck" tickets, a live check of the turn lock and recent turns. The lane and its reason are recorded, and a later change needs a stated reason.
- An outage ticket is worked as one incident and no longer asks for the reporter's corporation or sector records. A question ticket ends when every question is answered: no progress card and no owner decision unless a real defect turned up, which is spun out as its own ticket. After eight questions or a day, the model is told to answer and close, and to offer a fresh ticket for new topics.
- Ticket context is now sized by lane and wake type. Question, idea, people and advice tickets, and every wake, run on the core brief, the lane's steps, a case file and what changed, instead of the whole manual. Bug, data repair and outage tickets still start with the full context. Skills load only for those three lanes.
- New case file per ticket: what is known, what the player was told (last eight posts), what was promised, open questions, fixes and their stages, and posts left when the post budget exists. A wake leads with what changed since the last run and skips orientation and read discovery unless the lane changed or six hours passed.
- Wake cap in code: a ticket job runs the model at most six times an hour and 40 a day unless a human message arrived; beyond that it waits and one `wake_capped` audit row is recorded.
- The stuck-ticket sweeper skips tickets whose support record is closed, resolved or merged.
- A one-fix status card now moves forward by itself when its receipt arrives (merged, on the sandbox, live on the main server); the model is woken only when a fix is live and the player's figures must be checked.

## 9.2.1 (2026-11-15)

### Fixed
- Ending or interrupting a voice call cancels its accepted task and delegated work, including a send still awaiting its receipt. Opening the task preserves it.
- Cancelled voice work cannot deliver a late queued answer. DeepSeek tool markup with repeated delimiters is rejected instead of shown as an answer.

## 9.2.0 (2026-11-15)

- The /keir staff desk's actions (nudge, release, pause, resume, on, off) and the model command now reach the operator; they were built apart from the desk router and were never called.
- A ticket whose sector or record is damaged now gets the repair proposed to the owner for approval instead of only a developer report. The request_heal tool is no longer hidden behind a deferred schema, spells out the action shape (a bare set or unset is accepted), says it works from tickets, and the heal rule is no longer cut from support tasks. Filing a bug now tells the task to propose the data repair as well, and the debugging digest no longer tells it to wait for a root cause before repairing a bad record. Net model-facing text shrinks.

- A ticket task is shown a kept note only when the note shares a game code file or game area with the question; word overlap alone no longer brings in unrelated notes. Notes are kept and shown in plain present tense: "now" is dropped and sentences about changes, fixes or updates are left out.
- A ticket task now always starts with up to three notes from Keir's notebook (about 600 characters), found from the player's question plus the game files and screens the ticket names or has read. Each is labelled "checked rule from the code", "earlier answer on ticket N, not verified" or "earlier mistake: X was wrong, Y was right"; notes whose code file changed are left out, and only the notes shown count as recalled. A recalled note never replaces the code lookup before a rule is stated.

- Desk staff actions: nudge, release, pause and resume a ticket (junior developers and developers) and switch Keir on or off (developers) through a new local operator endpoint that audits each action and posts one line to the staff channel; none of them resolves a ticket or messages the player. A proven-model registry lets developers switch the model for new tickets only, and only to entries that passed the bar with a live check in the last 10 minutes (override is logged and posted to staff).

- Staff ticket board: a new read endpoint `/v5/ticket-board` on the operator and a "Tickets" panel on the Keir hub list every open ticket in one line (what the player asked, where Keir is in plain words, the next step and who owns it, last player message and last Keir answer), with a highlight when a player has had no answer for over 2 hours. Built from the ledger only, no model calls.

- Effort per ticket question: the player-ticket route effort (and the operator effort override) is now a ceiling for tickets. A first-time plain rules question with no figures runs at medium; bug reports, money or figures, turn or outage questions, a refused, retracted or out-of-steps earlier attempt, and any activation after the player disputed an answer stay at the ceiling. Never below medium unless the ceiling is lower. The reason is recorded in the usage record. Non-ticket tasks are unchanged.

- When several players report the same fault, Keir reuses one checked answer. A new ticket that matches an earlier one on at least two independent signals (similar wording, the support search, the same screen or file, place or turn) within 72 hours gets that ticket's answer as context, but only if it was posted with a code-written "From:" line and was not later corrected or disputed by its player. The new task still has to read the new player's own figures. A draft that takes the opposite direction on the same fault ("working as designed" against "a bug") is refused once with both texts; the next post goes out. The tickets are linked, not merged.

- A ticket reply is never called fixed from a deploy alone. Keir records the page figure it first cited as the symptom; once the fix is live and a turn has run, the code re-reads that figure for the player. Changed: the fixed message may post. Unchanged: it is refused, the player is told once that the change is out but their page still shows the old figure, the task is woken, and after three turns it goes to the developers. One re-read per turn.

## 9.1.3 (2026-11-15)

- Ticket tasks can find the errors a reporting player hit with sentry_player_errors: by the reporter's account id, the page they name and the time they describe, with a readable step trail before each error.

## 9.1.2 (2026-11-15)

- Read A House Divided crash reports from Sentry through a new read-only tool server, including lookup by the short reference players see on error pages. The retired GlitchTip integration is removed.

- Keir can read the new `sentry` MCP server (issues, one issue with its latest event, lookup by a player's error ref, new issues since a time) in ticket, finding, engineering and owner reads.

## 9.1.1 (2026-11-14)

- Tool-less Muse runs (the Ops widget line, the diary, knowledge distillation) no longer fail at startup: Muse refuses to start when a configured tool server is unreachable, so it now gets Keir's server only when the run has tools.

## 9.1.0 (2026-11-14)

- Muse runs on Muse Code's lean "empty" preset: about 11k fewer input tokens per model call (a five-call probe fell from 140k to 99k) with every Keir tool still loaded. `KEIR_MUSE_PRESET=""` restores the stock preset.
- Muse runs stream JSON, so token use (input, output, cached, reasoning) and the subscription allowance land in usage.jsonl instead of nulls.
- When a Muse run reports its 5-hour or weekly allowance at or above `KEIR_MUSE_QUOTA_CEILING` (default 95%), Muse cools down until that window resets and new work takes the fallback route instead of failing mid-task.
- Muse's own "ask the user" tool is withheld in headless runs, so a run can never sit waiting for an answer nobody can give.
- Muse activations carry a short working note: act on owner and developer requests yourself (closing a ticket is support_resolve), treat a refusal as instructions and post the corrected answer, read the deciding code before stating a rule, answer every question. `KEIR_MUSE_NOTE=0` turns it off.
- A tool result over the 22,000-character cap now ends with a visible "Cut off" notice instead of stopping silently, for every runner.

## 9.0.5 (2026-11-14)

- Settings instructions that say what state to keep ("make sure animations are not turned off in your Android accessibility settings"), where to look ("check your phone's display settings") or "the only way is turning X off" are checked like other setting instructions.
- What backs a settings instruction is a read of the game (code, game data), never the player's own ticket report or Keir's earlier posts in it.

## 9.0.4 (2026-11-13)

- The "I haven't got a confirmed answer for you yet" line is never posted once a real answer has gone out since the player last wrote (a holding line after it does not change that). While an answer attempt on the ticket was refused in the last 15 minutes, finishing is refused up to twice more per player message, telling Keir to post its reshaped answer now; after that the line is allowed, so finishing is never blocked.
- Keir no longer tells a player to change a setting ("turn off X in Settings", "go to Settings, Accessibility, ...") unless a read on that ticket names the setting and its path. Otherwise it is asked to read the code, at most twice per ticket, then the code labels the instruction "This may help, but I have not confirmed it: ..." and the answer still goes out.
- An account fact in a ticket channel (link, Discord link, characters, real-money purchases, refunds or subscriptions) must rest on a read made in the same activation. With no such read it is refused twice, then goes out labelled "I have not checked this yet, so it may be wrong".
- A staff or owner question asked inside a ticket channel now runs on the ticket route like the ticket's own task, and every post it makes there goes through the same claim checks as a player answer (rule, inclusion, "shows" and bug claims). A statement that a player's account is not linked, has no Discord link or has no character needs a read on the ticket that shows it, and is refused once otherwise. Staff keep their pacing exemptions only.

## 9.0.3 (2026-11-13)

- A real answer that ends "I will update you here once it is live" no longer counts as a holding line, so the "no confirmed answer yet" line is not posted right after an answer. Only a one-sentence post counts as holding by that wording.
- When `reporter_state` resolves a username-linked reporter with exactly one character, that character becomes the ticket's reporter for player-private reads, as a profile link did.
- The /keir desk says plainly when the kill switch has stopped Keir (doctor, status and per-ticket answers), instead of "Keir is on" and "waiting on a free worker slot".

## 9.0.2 (2026-11-13)

- A ticket whose reporter has a linked game account (the ticket carries the game username) is no longer treated as unlinked: `reporter_state` looks up the account and its characters, and asking a linked player for their character name, username or account is refused (at most twice per ticket).
- While a player is owed an answer, the ten-minute and "nothing new" pacing rules no longer hold back the answer, so a found cause reaches the player instead of the "no confirmed answer yet" line.
- A staff or owner message in a ticket no longer counts as the player writing, so it does not re-arm the unanswered-player rule.

## 9.0.1 (2026-11-13)

- After an outage, replaying missed Discord messages saves Keir's state at most every two seconds instead of after every message, so the operator stays responsive and its health check passes while it catches up.

## 9.0.0 (2026-11-13)

- Player tickets can run on their own model route (`KEIR_TICKET_PROVIDER`, at that route's own effort) while all other work stays on the main route. When the ticket route hits a usage limit or a login failure, tickets continue on the main route, and return once its cooldown ends.
- A ticket cannot park waiting on the player when its answer was refused and only Keir's introduction reached them: a refused answer arms the unanswered-player rule even before anything was read, and the introduction no longer counts as an answer.
- Keir can no longer tell a player a fix "was fixed on" a date, or that "a correction has been released" followed by when it reaches their page, without proof from their own page. A future word after a past fix claim no longer makes the claim count as a promise.
- Keir no longer tells a player that behaviour is a bug, a fault or "needs a code change" unless a read on that ticket marks it as a fault (a tracker bug, a code note) or the reply says plainly it is not confirmed. Otherwise it is asked to read the deciding code and say whether it is the rule; at most twice per ticket, then the code labels the sentence "I have not confirmed this is a fault, but ..." and the answer still goes out.
- Keir no longer tells a player that one value "already includes" another, or that counting both is double counting, when what it read says the inclusion is only partial or says nothing about it; it is asked to restate the limit, at most twice per ticket.
- Keir no longer tells a player what a page, record or panel shows, or what a figure measures, unless a read on that ticket returned those words. An unread cause or recorded fact is refused twice (quote the read, or say it is not confirmed); after that the code labels it "I have not confirmed this, but ..." and the answer still goes out. Never blocks finishing.
- Keir no longer tells a player a fault "has since been fixed" or a rule "has since been changed" without proof from the player's own page.
- Staff slash command `/keir` (doctor, status, waiting, why) answered by a separate read-only desk process, so moderators and developers can see why Keir is stuck or who it is waiting on even when Keir's own loop is hung. It runs CLI-only until its own Discord application is configured; replies are private unless shared.
- What Keir keeps from a closed ticket is now an unverified `resolution` (kind `resolution`, `verified: false`), not a `mechanic`. Recall shows it as "an earlier answer on ticket N, not verified; check it against the code before relying on it". A retraction lesson's right claim gets the same label unless the claim names what the cited file is about.
- Muse: its temp folder is now actually removed after each run (the cleanup referenced a variable out of scope), and the muse runner is limited to an explicit list of subscription models; any other model on it is refused with the billing message.
- Wording checks: an acknowledgement opening ("Thanks, ...") no longer exempts the rest of its sentence from the rule-lookup check, and negation in a fix claim is judged per clause ("not corrected" is no claim, "not a bug, but corrected in the latest update" is).
- The saved over-long draft posted when a run runs out of steps is dropped when any reply went out on the ticket or newer reads happened after it, and nothing is posted if trimming would cut the only sentence that gives the player a next step.
- A ticket cannot park or finish while its reporter has had no real answer since they last wrote (a holding line does not count), whatever it waits on. The count is per ticket and survives new tasks: two refusals, then the code posts a plain "no confirmed answer yet" message, files the escalation, records a receipt and lets the task finish.
- A code lookup counts toward the rule check only after it ran and returned something. After the first refusal, a rule or cause with no successful code read is posted only if the reply says plainly it is not confirmed, otherwise it is refused once more (never more than two refusals per ticket).
- Ticket replies are now number-checked against everything the ticket has read, earlier runs included (refused at most twice per ticket, then let through and audited), and code appends a short "Checked:" line naming what the reply rests on in player terms (a sector page, a turn, the game's rules). The model never writes the source.
- Muse works as a Keir model again on Muse Code 1.4: its scratch workspace is trusted so Keir's tools load, session logging stays on, and its temp folder sits outside the workspace. The Muse Code subscription CLI is an allowed route; Muse through the paid Meta API stays blocked.
- A dash in a reply is replaced with a comma instead of refusing the reply.
- Two post rules no longer contradict each other: an owner or developer speaking in a ticket, or an approved repair that ran, lets Keir reply without a new player message, and refusals that owe the player nothing never block finishing (the 8.4 lock-up).
- The provider fallback also covers a forced provider: a usage limit or expired login on the forced route moves tasks to `KEIR_FALLBACK_PROVIDER` until the route recovers.
- A run that runs out of steps right after a length refusal posts the leading five sentences of the refused reply instead of nothing.
- Code searches sent with `query` or `terms` reach the tool as `question`; a claimed page or figure change needs the same receipt as a "fixed" claim.
- Each closed ticket keeps one verified mechanic tied to the game code Keir read, and a lesson when an answer was taken back; both are recalled into later tickets.
- A ticket answer that states a game rule or a cause is refused once per ticket when nothing on the ticket has read the game code, with a message that names the code search tool. Never refused again on that ticket, never blocks finishing, `KEIR_RULE_LOOKUP=0` turns it off.
- Keir is the support desk, not Ask: the 8.4.1 conversational and send-the-first-fact-fast instructions are gone from the ticket brief (short phone-sized posts and the strategy-to-Ask route stay), and rules and mechanics questions are answered by Keir from the game code.

## 8.5.4 (2026-11-07)

- Pending owner approvals hold the requested actions and ticket closure while independent investigation continues. Player messages, worker reports and scheduled reads reach admission instead of being silently blocked after the wake rules queued them.
- An approval notice no longer suppresses a new finding. Repeated waiting notices remain suppressed, and all action approvals, claims, pauses and completion checks remain enforced.
- An exact owner-approved merge skips submitting a GitHub review when the authenticated owner authored the PR. GitHub rejects self-approval with HTTP 422; the existing required checks and exact-head approval still gate the merge.
- A pending decision no longer stretches an independent recorded investigation to a six-hour wait. Support guidance separates verified losses, causes, fixes and compensation.

## 8.5.3 (2026-11-07)

- A ticket cannot wait for the player while its own summary still names an unchecked, unexplained or unverified investigation, or its shared record has an unfulfilled promise. A later unrelated reply no longer hides that work. Continue it with a short scheduled wakeup instead.
- Optional operator-wide provider and effort overrides apply to existing tasks and every model lane, including voice. An explicit provider override disables cross-provider fallback. Detached coding workers now receive an explicit reasoning effort too.
- Regression tests cover four stalled ticket summaries, saved promises, voice effort and replacement of persisted model routes.

## 8.5.2 (2026-11-07)

- Preserve completed investigative reads and calculations across ticket activations and restarts. All support tasks on the same ticket receive a bounded history of actual observations, separately from the latest summary, so an erroneous "unchecked" summary cannot erase the work. Existing evidence-batch receipts are recovered for tickets opened before this change. Tool discovery and failed reads do not become findings; historical observations never satisfy current deployment or success checks.
- Clarify the verification policy: rechecking a current outcome does not mean earlier investigation never happened. Reconcile saved observations and facts before denying a completed check, and record the exact remaining uncertainty.
- Regression coverage exercises a real broker code read, state reload and the next agent prompt, plus ticket isolation, role restrictions, bounded retention, deduplication, empty searches and old receipt recovery.

## 8.5.1 (2026-11-06)

Investigation workers and real progress for the sweeper. Ticket 1785: a player reported a company whose revenue, margins and share price flip every turn. Keir posted "checking why" at 15:14, filed a blocking question card of his own, and then did nothing for six hours. A status-card line reading "Investigating" at 19:47 counted as progress, the sweeper never fired, and 8.5.0 coding workers only start for a filed bug, so nothing launched. A person dispatched a worker by hand.

- Investigation workers (`codingworkers.js`, run kind `investigate`). When Keir's own lookups leave a ticket's cause unverified (an open self-owned blocking question card, or a waiting task whose own summary says the cause is unverified and names a next step), a headless Sonnet worker is started through the same launch recipe, caps, host admission, daily launch limit, kill switch and ledger as build workers. It is read-only on prod, traces the numbers and the code path, and writes a report whose first lines are `VERDICT:` and `CLASS:`.
- Prompt trigger: when a ticket task ends its activation (waiting or blocked) with the cause unverified, the worker is dispatched at once from `finish`, not at the sweeper's six hours. A task waiting on the player does not trigger it.
- Outcomes: a report without a PR ends the run as `reported`, counts as real progress, and wakes the ticket task with the verdict (an economy-behaviour, rule or balance class tells it to put the options to the owner as a decision; nothing ships on its own). A bugfix or display PR joins the 8.5.0 flow (checks, exact green, merge, promote, deploy proof); any other declared class, or none, stops at `needs_owner`. No report and no PR: one retry, then the owner is told. At most two investigation runs per ticket. `workers/skip-tickets` is respected.
- Sweeper progress is stricter. A status-card post or edit, a delivery receipt, a self-owned question card Keir filed for himself, and any short post that opens with or is built around "investigating", "checking" or "looking into" with no number in it no longer reset the six hour stall clock. A PR, a handoff to someone else, a release, a heal, an effect such as an issue, a status-card stage that moved past "Investigating", an answer, or a finding with a number still do.
- A self-owned blocking question card must never just wait. If nothing is working it 20 minutes after it was filed (no running or queued worker run), the sweeper queues an investigation worker; if none can be started (switched off, skip list, budget spent) or the card is still unworked after one was, the owner is told once, then at most every 12 hours. While a worker run is live the ticket is covered.
- When the sweeper finds a stale ticket whose cause is unverified it now queues a worker instead of only nudging the task; any other stale ticket is nudged as before.
- `/v5/trust/status` lists the run kind.
- Tests: `test/keir851-investigation-workers.test.js` (the 1785 timeline at 15:14, 19:47, 21:10 and 21:14, progress rules, the card rule, dispatch guards, reports, retry and escalation, PR classes, the brief, the `finish` trigger).

Release: stage and activate with `deploy/release.sh`. Put any ticket that already has a hand-dispatched worker in `/var/lib/keir-operator/workers/skip-tickets` first, because an open self-owned question card will otherwise get a worker within one sweep.

## 8.5.0 (2026-11-06)

Keir ships its own bug and display fixes (owner, 2026-11-06: "Yes, bug/display fixes only"). Ticket 1783 sat four hours as a card waiting for a developer. Now a code bug classed bugfix or display is built, merged, promoted and checked live by Keir while the owner is away. Rule, balance and economy-behaviour changes still wait for the owner.

- Coding workers (`lib/operator/codingworkers.js`). `raise_to_developers` kind bug with changeClass bugfix or display, after filing the public issue and the card (the card stays as the receipt and gets the worker id), starts a detached `keir-worker-<ticket>-...` systemd unit running a headless Sonnet session in its own AHDGame worktree. The brief is the ticket facts, Keir's investigation and the house rules (foreground only, public-repo hygiene, prettier, scoped tsc, changelog areas, a `Change-class:` line, PR to development, wait for checks, write a report).
- The run is a durable ledger record (`codingWorkers.runs`: unit, worktree, branch, report, PR, state). A restart resumes from it and never launches a second worker for the same ticket. Items raised before this release (ticket 1783's waiting bug card) are adopted on the next tick. `/var/lib/keir-operator/workers/skip-tickets` (one number per line) excludes a ticket, `KEIR_CODING_WORKERS=0` switches the feature off.
- Caps: two workers at once, one run per ticket, no launch when available memory is under 16 GiB or load is above 70 percent of the cpus, a new `workerLaunchesPerDay` limit (default 6, `KEIR_LIMIT_WORKERS_DAY`), and the existing daily production promotion cap (3) applies to the promotion to main. Each worker is bounded by `RuntimeMaxSec=7200` and `MemoryMax=8G`.
- Completion: when the unit exits Keir reads the PR, checks the class (a PR that touches economy or turn-worker paths, or declares rule, balance or economy-behaviour, or whose title announces a rebalance, goes to the owner as `needs_owner` and is never auto-merged), then merges only on exact green: verify, dependency-review and custom-rules must each have a completed run with conclusion `success`. Pending, missing, failed or cancelled never merges. The feature PR is squash merged to development, unless a development to staging PR is open (promote freeze): the merge waits.
- Promotion: development to staging, then staging to main, each as a MERGE commit, each only when its three required checks are exactly green, reusing an open promote PR. Then web and the turn worker must both run the main commit (or a descendant) within 60 minutes. Only then is a receipt written to the ticket (the 8.4 production-claim guard accepts it) and the ticket task woken to tell the player it is live and to re-check numbers after the next turn.
- Failure handling: a worker that exits without a PR gets one retry with its log tail, then the owner is told. A report without a PR is an owner question, not a retry. Red required checks get one fix worker given the failing check output, then the owner is told. A promote PR that goes red, conflicts or stays pending three hours, or a deploy that does not arrive in 60 minutes, escalates. Keir never merges red, never force pushes, never bypasses checks.
- Kill switch: while engaged there are no launches, merges or promotions. A running worker is left to finish and nothing it produced is merged until the switch is released.
- The per-ticket player update cap is removed. It counted every post, including ones the owner or lead made, refused a reply on ticket 1781 at four updates in 24 hours, and told the owner the player was waiting on a person. Spam is still stopped by the no-new-information and repeated-post guards; the promotion and heal caps stay. `playerUpdatesPerTicket24h` and `KEIR_LIMIT_PLAYER_UPDATES_24H` are ignored if still set.
- `/v5/trust/status` lists the coding worker runs.
- Tests: `test/keir85-coding-workers.test.js` (dispatch gating, caps, concurrency, admission, exact green including REQUIRED_FAILED, freeze queueing, resume after restart, kill switch, escalation paths, adoption, broker wiring).

Release: stage and activate with `deploy/release.sh`; no new unit or env is required (`systemd-run` and the Claude CLI at `/root/.hermes/node/bin/claude` already exist on the box).

## 8.4.2 (2026-11-06)

Read the screenshots and the cases before asking (owner, 2026-11-06, mod chat). Danica posted two screenshots of an alt investigation naming two accounts, Monroe called it "the longest sleepover yet", and Egg asked Keir "do you think they are alts?". Keir answered "I don't know which two accounts you mean ... send me the two names." The names were in the screenshots, the case was in tickets 1778 to 1780 (moderation, opened that morning), and the tools to judge it (alt_ring_audit, trace_account) were available.

- Screenshots in staff channels and DMs are read. The channel record keeps which messages carry images. For a staff, developer or owner question outside a ticket, `context.recentImages` lists the images in the last 10 messages, in the reply chain of the message being answered, and on that message. `view_attachment` takes an optional `messageId` to open any of them. A conversation with such images runs on the full brief and the vision lane.
- Case lookup before answering. For the same conversations the broker searches support tickets for the words the talk uses (quoted words first, then the longest uncommon words of the last 10 messages) and, for alt, ban, appeal or moderation talk, lists the recent moderation tickets. Matches arrive as `context.caseContext` with the instruction to open them with `support_get`. Bounded to 4 seconds and fails open.
- The needless-clarification guard now covers staff channels and DMs. A reply whose substance is a request for names, accounts or ids ("send me the two names") is refused while screenshots in the context were never opened, or while matching support cases were offered, and Keir is sent to read them, run `alt_ring_audit` and `trace_account` on what it finds and answer with a view and a confidence. After two refusals on one task the reply goes out, so a real gap never deadlocks.
- Policy (`KEIR.md`, `KEIR-CORE.md`): to staff, lead with the verdict and a confidence, then one short supporting line; several short messages (the 8.4.1 splitter), not a block.
- Moderators are recognised from the guild, not a static list (`lib/operator/modroster.js`). A member holding a guild role that grants moderation permissions (administrator, kick, ban, timeout, manage messages) or is named like a moderator role, plus any role in `KEIR_MOD_ROLE_IDS`, is recorded as `moderator` in the channel record (roles come from the gateway message when present, else a cached member lookup with a 10 minute TTL, and earlier rows are relabelled). It is a label only: heals, approvals and tools still follow `staffIds`. The channel snapshot tells the model that owner, support and moderator rows are staff, so a moderator is no longer "that player" whose word is "not evidence".
- The owed-reply finish guard no longer forces a second non-answer. A reply Keir already sent to the addressed message (this task's `channel_reply`, or Keir's own row in the channel record after it) satisfies it; a message that does not name, mention or reply to Keir (a bare "?" only counts in a ticket) is never owed an answer; and "even if nothing changed" is gone, so with nothing new Keir finishes silently unless it never answered the addressed message. Discord mentions and replies to Keir are now carried on the message source as `mentioned`.
- Staff questions about people or cases need a lookup before "I can't tell". In a staff channel or DM, a reply that says it cannot tell, to a question about alts, bans, accounts, players or cases, is refused until the task has made at least one lookup (support_search, support_get, support_list, or gamestate alt_ring_audit, trace_account and the like through read_tool). Released after two refusals. This holds even when the classifier called the question simple and it ran in the quick lane.

## 8.4.1 (2026-11-06)

Conversational replies and faster answers (owner, 2026-11-06: "he needs like 60 seconds to look, and then like 20s of output generating ... less wall-of-text, more one-liners, more messages, less length to each ... more conversational than chatbotty").

Measured on the live ledger and stream logs since 2026-11-01 (176 player-facing activations): once Keir is running, the first reply goes out at a median 6.5 s and the whole activation takes a median 11.8 s (3 model calls of about 2.5 s, 4 tool calls). The "looking" time was before Keir started. A player message waited for the next 20-second channel scan, then a 45-second quiet period that merges bursts of chat, then about 3 s of preparing the briefing.

- A player message in a ticket now wakes the task after 8 seconds of quiet (it was 45). Messages from staff and other chatter keep the 45-second period. The wake is scheduled the moment the message is read instead of waiting for the next scan.
- The channel scan runs every 8 seconds (it was 20; `KEIR_TICK_MS` overrides).
- A reply goes out as a few short messages in order, about 1.4 seconds apart, instead of one block: paragraphs first, then sentence ends, one idea each and about 200 characters. A short reply stays one message. A list stays whole with its lead-in line, a code fence is never cut, no message passes the Discord limit, at most four messages (the tail folds into the last), and text is never dropped or reordered. Applies to ticket replies (`channel_reply`) and to everything the channel outbox sends.
- All guards still see the whole reply once before anything is sent (leak filter, player register, certainty and receipt checks, milestone and stall rules). The reply counts as ONE update for the 4-a-day cap, the post history, the monologue run and the stall guard. Messages already delivered are not sent again if the reply is retried.
- Policy (`KEIR.md`, `KEIR-CORE.md`): write like chat, one idea per message, no headers, bold, "Here is what I found" openers, restated questions or sign-offs; send the first real fact as soon as it is known.
- No needless questions (ticket 1781). Keir asks the player only when the answer is not in their message, the channel, screenshots, page visits or game data and the work cannot go on without it. A reply whose only content is an either/or question ("which is the problem, A or B? tell me which") is refused when the ticket already names what is wrong (sectors, states, companies, or page visits). Keir must investigate every stated issue and answer with findings for each.

## 8.4.0 (2026-11-06)

Keystone stability release: Keir you can trust while the owner is away.

Support quality, from the owner's rating of the open tickets on 2026-11-05 and 06 (1763, 1766, 1772, 1775, 1757, 1750).

- A "still checking, I won't guess" post is allowed once per question. The second needs a player message and code reads since the last, and an investigator already running no longer excuses a repeat; the third never goes out. The post history used to keep one hour, so ticket 1766's seven posts over five hours were never seen as a run; it now keeps 24 hours.
- After Keir's last post, with no new player message, another post must be a milestone: a finding (a game or code read made since), a receipted outcome, a correction or a question. Everything else goes on the status card note (tickets carried 30 to 57 updates).
- A production-typed live notice is only sent with the main-release receipt. "Live and working" keeps needing a turn processed on the fix and a read of the player's own figures (ticket 1763).
- support_resolve is refused when the message or Keir's last post only explains that a rule works as designed on a bug report, unless the owner has decided or a fix exists, and while any owner decision on the ticket is unanswered (1775, 1757, 1750). Policy: explain the rule, say it is under review, keep it open, ask the owner with two or three concrete options.
- raise_to_developers takes changeClass (bugfix, display, data-heal, rule, balance, economy-behaviour; required for decision and enhancement; the old spellings bug_fix, rule_change, economy_change etc. are accepted as aliases). It is stored with requiresOwner on the escalation, the job (changeClass, requiresOwner) and the decision (ownerHold, changeClass, requiresOwner, ticket) so a guard can hold rule, balance and economy changes for the owner.
- A held owner decision never expires and is asked again in the owner's DMs every 12 hours until answered (it used to expire after 48 hours).
- Hedging away from readable code is refused: "I haven't checked the exact trigger, so I won't quote a threshold" and "I searched, found nothing, so I won't tell you it exists" (ticket 1772 reversed within five minutes). Fewer than three code lookups sends Keir back to search; after that it must say plainly that the thing does not exist, or how it works.
- "Handed to an investigator" needs a real investigation job, and "the developers have it" needs a queue item with an id or a pull request. The backing ids are written to the audit (handoff_claim_backed).
- Tool-call text (JSON calls, fenced calls, tool names, other providers' markup) and the broker's own refusal text are refused in player-visible text on every public path: the shared public text step, the public outbox and the inbox sender. No instance reached a player in the ledger, inbox or journals reviewed, but only some paths were checked before.

Keir 8.4, the stability release (owner, 2026-11-06: "this needs to be Keir we can trust in our absence").

- Kill switch: one file, `/var/lib/keir-operator/kill-switch`, read at runtime. While it exists no reply, MCP write, merge, promotion or heal leaves the box, no new activation starts, and queued channel posts are held (and dropped as stale if held over an hour). Flip it with `node /opt/keir/current/bin/keir-killswitch.js on "reason"` / `off` / `status`, or `POST /v5/trust/killswitch`. An unreadable file counts as engaged.
- Hard caps, set in `/var/lib/keir-operator/limits.json` or env: 4 player-visible updates per ticket per rolling 24 hours, 3 promotions to main per day, 5 production heals per day. A refusal does not loop the task, and a ticket that hit its cap is reported to the owner by the sweeper.
- Change classes: merge and promote take `changeClass` (bugfix, display, data-heal, rule, balance, economy-behaviour). Rule, balance and economy-behaviour changes (declared, set by a `Change-class:` line in the PR body, by a "rebalance/nerf/buff" title, or by economy paths) go to the owner's approval card and execute only with a recorded owner approval. A logic merge with no declared class is refused with instructions.
- Stuck-ticket sweeper (every 10 minutes): an open ticket with no substantive progress for 6 hours, or a player message unanswered for 30 minutes in active hours (07:00 to 23:00 Eastern), gets one fresh investigation, then one owner escalation, then at most one more every 12 hours. "Still checking" restatements do not count as progress. A ticket waiting on an owner decision is never investigated or resolved: the player is told once, the owner is re-pinged every 12 hours.
- Daily trust report (09:00 Eastern): tickets handled, resolved and open, fixes shipped, "fixed" claims later contradicted, what waits on the owner and for how long, three random reply spot checks, restarts and incidents. Sent as an owner DM, written to `/var/lib/keir-operator/trust-reports/`, and saved to ops-knowledge.
- Guardian (`keir-guardian.timer`, every minute, separate from the operator): restarts a failed or hung operator, summon or inbox with doubling backoff, stops after 3 restarts in an hour and DMs the owner directly (the operator's own outbox may be the broken part), re-arms dead timers, and never starts a unit that was stopped on purpose. Status is written to `/var/lib/keir-guardian/status.json`; `/health` now reports stale periodic jobs and a stuck outbox.
- Every periodic job in the operator that used a "busy" flag now has a deadline (`lib/operator/ticker.js`). Before, one await that never settled (roles, watch, merges, owner wait, CI watch, developer watch) silently ended that job for good while the process looked healthy.
- One change-class vocabulary (`lib/operator/changeclass.js`): bugfix, display, data-heal, rule, balance, economy-behaviour. `raise_to_developers`, decisions, the merge and promote guard and the trust report all use it; the earlier spellings (bug_fix, display_fix, data_heal, rule_change, balance_change, economy_change) are accepted as aliases so older records still classify and stay gated. One re-ping mechanism for pending owner decisions (`decisions.js`, every 12 hours); the sweeper no longer re-pings.
- systemd: crash loops end after 5 failures in 5 minutes (`StartLimitBurst`) so the guardian takes over, and `RestartSec` is 10.

## 8.3.1 (2026-11-05)

- A message from the owner or a developer in a ticket channel only forces Keir to reply when it names or mentions Keir or asks a question. On ticket 1778 the owner told the player he would unban them, and Keir was made to reply with "the unban and note are yours ... I have nothing further to do on this one" in the player's channel.
- Replies that narrate Keir's own bookkeeping or talk about "the player" in their own channel are refused.

## 8.3.0 (2026-11-05)

A stuck game no longer means a stuck Keir (owner, 2026-11-05: turn 697 failed four times over two hours while Keir filed an issue and waited).

- A failed or stalled turn opens one engineering task per turn, ahead of the backlog, to read every attempt's failure, confirm the cause in code and prepare a fix. The owner's Watchkeeper alert says Keir is on it. The engineering lane can now read the turn failure log.
- A ticket can no longer park on "waiting for the developers" while Keir's own last post says the cause is not found yet. It hands the question to an investigator or keeps digging first (tickets 1766, 1773, 1774 sat for hours).

## 8.2.1 (2026-11-05)

- A second task (for example one started by a developer's ping) can no longer restate an answer another task posted in the same ticket minutes earlier. Within five minutes a post that closely paraphrases the last one is refused (ticket 1773 got the same answer twice, 15 seconds apart).

## 8.2.0 (2026-11-05)

Answer quality, from a review of the 2026-11-05 ticket conversations.

- Keir can no longer tell a player a problem is fixed, working, gone or "should be gone" on the strength of a release. It needs the fix on main, a turn processed on it, and a read of the player's own figures after that turn and after their latest message. Ticket 1763 heard "live and working" six times in a day and each was disproved by the next screenshot. "Now on the main server" also counts as a release claim now.
- One release announcement per ticket per 30 minutes, whichever task makes it (1763 got two 20 seconds apart).
- "I haven't found it, so I won't guess" is allowed once. The next one needs code reads since the last, and a third needs a running investigator (1766 got seven in five hours).
- Drafts the screen scores 0.9 or more for stating an outcome as settled are refused when the ticket has no release or verification behind them. Until now that label only warned.
- A factual rule question can no longer be passed to Ask unread ("I haven't checked, Ask can answer that", 1765).
- An expired provider login now moves the job to the fallback route and cools the provider, as a usage limit does, and the owner hears about it once an hour. On 2026-11-05 an expired Claude login retried for 83 minutes and was logged as a successful run; activations now record `auth_failed`.
- Watchkeeper now reports when the independent conversation audit has not run for 30 minutes. Its timer stopped re-arming on 2026-10-26 and nobody noticed for ten days.
- A developer pull request that only waits on the owner's approving review now reaches him as an approval card with Approve and Reject buttons and a plain explanation, not a GitHub link. Approve submits his review at that exact commit, re-runs the approval check and merges. Ariane answering on his behalf does not submit his review.
- The brief covers following the player's own lead, recognising jokes, and answering every question the player asked.

## 8.1.2 (2026-11-05)

- Game promotion PRs now carry the ticked "Conflict of interest" section AHDGame's custom-rules check requires. Without it the check failed and the promote sat blocked until someone edited the description by hand.
- When the owner or a developer messages Keir directly in a ticket or channel, Keir now has to reply there before it can end its turn, even if the answer is "nothing has changed". Before, it could decide there was nothing new and finish silently, which looked like it was ignoring the ping.

## 8.1.1 (2026-11-04)

- A saved model choice in the app whose route no longer exists (for example after the routes were changed) now falls back to Auto and tells the owner once a day. Before, every message in that thread failed with "model route is not available" and Keir looked silent.

## 8.1.0 (2026-11-04)

- Lesson retirement: capped, reversible, audited retirement of near-duplicate, stale and long-unused lessons (`bin/keir-lesson-retire.js`, dry run by default, `KEIR_LESSON_RETIRE=0` to disable), and recall ranking now favours lessons with a good ticket record.
- A ticket held by staff claim or an owner directive past its deadline now tells the owner once by DM; Keir still does nothing on it and keeps it held.

## 8.0.0 (2026-11-03)

Keir 8: recovery, reliability and a learning loop.

Keir now has release gates written as code (no action after a stop, no unapproved repair, no duplicate answer, no wake loop, no unanswered player, no promise without a receipt), a 30 minute benchmark that runs a simulated day per trial, an extracted and tested ticket lifecycle, its own GitHub identity for authored actions, lesson recall accounting, a provider fallback for usage limits, and a DM to the owner when a developer's PR waits only on the owner's approval. Everything from 7.3.0 to 7.7.0 below is part of it.

- A provider that hits a usage limit or rate limit (for example the OpenCode Go monthly cap on 2026-11-03) is skipped for 30 minutes. A job that hits the limit moves to the fallback route in `KEIR_FALLBACK_PROVIDER` and carries on from its checkpoint instead of blocking, at most three times, and never once an effect has started.
- Posts on a ticket now carry a kind, so a status card edit is recognised by its kind and no longer by a "[status card]" prefix in the text. A reply that starts with those words is no longer mistaken for a card.

- Keir now DMs the owner when a developer's AHDGame pull request has passed every check except the owner's own approval, once per commit, with a link. Four pull requests sat for hours behind that one button because nobody told the owner.

- A job pinned to a provider that was removed from the configured routes now gets a new route instead of failing on the old one for ever. After the OpenCode quota switch, six old jobs kept retrying the retired route every few minutes and paging the owner.

## 7.7.0 (2026-11-03)

- A support-service outage can no longer keep a channel-less ticket waking every cycle (ticket 1730: 128 wakes, 15M tokens). While the ticket's support record cannot be read, the next check and the timer wake back off from 5 minutes, doubling to 6 hours, each failed check is logged, and the owner is told once after the fourth failure. A new message still wakes the job, and a successful read clears the backoff.
- Turn-watch notes no longer count as a human message, so they cannot wake a ticket held on an owner decision. The wake rule and the unread watchdog now share one list.
- A waiting job with no wake time now wakes after 4 hours instead of sleeping until a message arrives.
- A dismissed or owner-paused ticket is no longer relabelled deferred or waiting by the claim and close-stall rules, and a dismissed ticket whose channel is gone stays dismissed (it is still marked channel-closed so a reopened ticket is adopted).
- Releasing a staff claim now lifts the deferral that claim caused on its own, without waiting for a message. A deferral from a coordinator takeover is left alone.

- A public write that timed out or was cut off by a restart is now checked against the real record ten minutes later, the way merges and payments already were, instead of holding the task for a person. A ticket reply is looked up by its exact text in the ticket's public updates, a filed issue by a hidden marker on GitHub, and a created incident or intake ticket by its source message. Found and delivered: the task carries on and nothing is sent again. Provably absent from a readable record: the write may be retried. Anything unclear (a near match, a failed delivery, a failed read, a search that found nothing) stays held, and each decision leaves an audit row. These checks only read.
- A write that provably never left the box no longer holds the task for a person. A connection refused or an unknown host when Keir calls an internal service (a service restarting during a deploy), and any failure while publishing a fix before its first push (fetch, worktree, apply, commit) are now recorded as "nothing written", the task keeps going, and the same call can be repeated. A timeout, a reset or any failure after the push still holds the task as uncertain, as before.
- Closing a GitHub issue after its fix is live, and the hourly duplicate-issue sweep, can no longer post the same public comment twice. The comment and the close are now two separate steps; the comment carries a hidden marker that is looked up on the issue before posting, so a close that failed, a restart, or the next hourly task finds the comment already there and only repeats the close. If the issue's comments cannot be read, nothing is posted. A reopened issue is still closed again, but gets no second "fixed" comment.
- A ticket status card whose final save was lost to a crash no longer gets posted a second time. The card's message id is now saved together with the receipt that closes the post, so the next update edits that card instead of posting another.
- Nothing changes for players or staff. The rules that decide when a ticket job wakes, waits, is held, times out or is closed now live in one module (`lib/operator/lifecycle.js`) whose header describes the whole state machine, with 101 tests pinning today's behavior, instead of being spread through `operator.js`.

## 7.6.1 (2026-11-03)

- A raw game-record read asked for the sandbox now reads the sandbox. Every heal_query, heal_count and heal_collections call was rewritten to prod, so a question about the test server got production data back without saying so (ticket 1740). Any env other than prod or sandbox is refused by name.
- A raw read that finds nothing while a filter gives a record id as plain text is retried with it as a record id, and the answer says which it was. A plain-text id never matches, and the empty result was twice reported to a player as "nothing is signed" while three agreements existed (ticket 1742). If the retry also finds nothing, the answer says to check the filter against a known record before saying none exist.
- A task left blocked while its developer handoff is still open now waits for the developer instead of being closed after six hours as "blocked with nothing pending". Closing it also closed the handoff, so the requested work was dropped (ticket 1760, handoff 255014). Five tasks were closed this way in three days.
- Watchkeeper raises a sensor outage only after two failed reads in a row. A single slow read that the next minute answered raised an incident and a recovery each time, about 200 times in two weeks.

## 7.6.0 (2026-11-03)

- What Keir authors on GitHub now shows as its own account, keir-bot, when `KEIR_GITHUB_TOKEN` is set: the branch it pushes for a patch (git is told to use the token for that push only), the pull request it opens or edits, the issues and comments it files, duplicates it closes, issues it closes after a fix is live, closed pull requests and the promote pull requests it opens. Merges, branch deletion and every read keep using the box's own login, the owner's, behind the owner's approval. `KEIR_GIT_EMAIL` sets the commit email so commits link to the account. Until now 35 of Keir's last 40 issues and pull requests on AHDGame read as the owner's.

## 7.5.0 (2026-11-03)

- Keir's notebook now records which notes reach an activation: each note carries a recall count and last-recalled time, and every recall is one line in `notebook.json.recalls.jsonl` with its job and ticket. `bin/keir-lesson-report.js` joins those recalls to ticket outcomes and feedback and flags lessons that stay unused or that sit on tickets doing clearly worse than baseline. It only reports; nothing is retired automatically. This starts the Keir 8 learning loop: until now nothing measured whether a lesson was used or helped.

## 7.4.1 (2026-11-03)

- Nothing Keir writes on GitHub (reviews, comments, issues, PR titles and bodies) carries an em or en dash any more: they become commas, and number ranges keep a hyphen. The first @keir-bot review had one. Its instructions say the same.

## 7.4.0 (2026-11-03)

- A maintainer who writes @keir-bot (or @Keir) in a comment on an AHDGame pull request gets a Keir review on it: specific suggestions and a verdict line (looks good, needs changes or blocking issue), posted as the keir-bot account when its token is configured. Only people who can push to the repository can ask; the ops webhook forwards only ids and Keir re-reads the comment, the asker's access and the PR from GitHub. One review per PR commit, a 👀 reaction acknowledges the request, and the task can only read that PR and the code and post one comment: no merges, heals or other posts.
- KEIR.md now says what the broker already allows: a ticket task proposes a bounded data repair itself for the owner's approval (owner rule 2026-11-01), instead of only raising it to developers. It also states the real heal timings: a dry-run token lasts nine minutes, the owner's consent 24 hours. In a day-benchmark experiment the old text kept both models from ever proposing the repair.

## 7.3.0 (2026-11-02)

- An owner approval whose plan changed after a turn is withdrawn when it is refused, and an expired approval no longer counts as a reason to wake. The stale approval used to keep the task waking every 15 minutes after the fresh plan had run.
- A developer change that names a ticket leaves the release receipt for the stage it reached, so the line the merge watch asks for ("a fix is in testing on dev") is no longer refused, and the refused reply no longer blocks finish.
- On an open ticket whose channel is gone, a reply that cannot be delivered no longer holds finish, so the task can wait for staff instead of being refused on every activation.
- A status card edit is no longer the one notice while the owner decides, and no longer counts toward the monologue cap: the player's question still gets its answer.

## 7.2.10 (2026-11-02)

- A check cancelled because a newer run of the same check replaced it no longer counts as a CI failure. Ticket 1758's task woke 12 times in an hour on a cancelled duplicate custom-rules run whose replacement had passed.

## 7.2.9 (2026-11-02)

- A task cannot finish done while its repository snapshot holds unpublished changes; it publishes them with publish_patch or reverts and dismisses. Ticket 1757's tested bond-interest deduction finished "left uncommitted for the supervisor" and was deleted with the workspace.

## 7.2.8 (2026-11-03)

- A link to a report Keir published as public may go in a player's ticket; every other ops address is still refused. The owner's tax audit link for ticket 1757 was refused as an "internal URL".

## 7.2.7 (2026-11-03)

- A ticket task that just told the player it is still checking something cannot finish with a long wait for their reply; it does the check or comes back within 30 minutes. Ticket 1759 promised a check at 00:47 and slept six hours.
- A ticket waiting out its closure grace wakes when the grace ends. Ticket 1755 was due to close two hours after its fix and slept nine.
- After a Keir release, the owner's own requests from the last day that ended blocked are retried once (the blocker is often a tool the release added). The owner's public tax report stayed unpublished after publish_report shipped.

- "A developer's own task is handling a request in this ticket" no longer marks an answer as owed. The ticket task could then neither post nor finish (ticket 1761, 2026-11-03).

## 7.2.6 (2026-11-03)

- The owner's or a developer's direct question in a ticket is answered at once: the pacing rules (another task just posted, the monologue cap, ten-minute spacing) no longer hold it back. On ticket 1757 the owner's answer waited behind another task's post and read as Keir going silent.

## 7.2.5 (2026-11-03)

- `publish_report` publishes a finished HTML report to the Lakeside ops report library and returns its URL. Owner or developer tasks only; `public: true` only on the owner's own request; refused if it contains an internal host, path, account id, email or credential. The owner asked Keir for a public tax audit report and Keir had no way to publish one.
- Staff can hand a ticket held by another operator back to Keir in its channel ("Keir, take this ticket back"). Before, only the host CLI could, and ticket 1757 sat for hours behind a session that had stopped.
- A staff or developer request that lands on a held ticket gets a direct message naming who holds it and how to hand it back, instead of silence (three junior-developer requests on ticket 1757 went unanswered).
- `github review` attaches the whole file at the PR head when a diff is cut off, so a review does not flag what the hidden part already fixes.
- Suggestion filing accepts everyday wording ("send the suggestion", "make that a suggestion"); it was refused four times for a junior developer on ticket 1756.
- The automatic "now live" notice is skipped when the task has just told the player the fix is working (ticket 1755 got a contradicting notice a minute later).
- A handoff for a ticket Keir already owns no longer supersedes the owner's approvals on it (a wake-up note superseded the approved repair on ticket 1749).
- The brief: investigate before diagnosing in public; one holding line, then the checked cause (ticket 1759 got three replacing explanations in half an hour).

## 7.2.4 (2026-11-03)

Found by mining 30 hours of live refusals, audits and token use (2026-11-01/02), not by the benchmark:
- A ticket task with no channel id (adopted from a handoff after its channel was already gone) is closed by the sweep when the support record says the ticket is closed. Ticket 1730's task woke every fifteen minutes for 29 hours after closure: 128 activations, about 15M tokens, 237 refused reads (40% of all refusals).
- A not-now refusal ("Keir has posted 3 times since the player last wrote", "this task posted N min ago", an unchanged waiting notice) no longer marks an answer as owed. With both armed Keir could neither post nor finish: 70 refusals across tickets 1749 to 1755.
- An invariant breach that the check returns flagged as a tool error is read as a result. A share_accounting breach was logged as a failed sensor 133 times in a day and never became a finding.
- An action the owner approved that the task has not run yet keeps it on a short wake. Ticket 1749's approved repair was parked for twelve hours behind a quiet developer wait after the player was told it would run after the turn.
- The sweep does not adopt a ticket whose channel a live task already holds (two tasks ran ticket 1757, about 14.5M tokens between them).

## 7.2.3 (2026-11-02)

- A stop or stand-down that ends with more than one trailing phrase ("stand down on this ticket please", "stop working on this ticket, thanks", "stand down for now") now stops the ticket. The owner's "stand down on this ticket please" on ticket 1757 matched nothing, so the stop flag was never set and the next staff mention started a fresh job.

## 7.2.2 (2026-11-02)

- `github review_comment` posts a review the owner or a developer asked for on the PR itself, as a plain comment headed with the reviewed commit (never an approval, requested change or merge). Keir had answered "GitHub is read-only from here" and asked the owner to paste its review of AHDGame #5337. The text is checked for internal hosts, paths, addresses and credentials before redaction, so a leaking review is rewritten rather than posted with holes.

## 7.2.1 (2026-11-02)

- Anyone with the Junior Developer Discord role is a junior developer to Keir within five minutes of getting it: they can `/summon` Keir for questions and investigations and have it review their PRs, but cannot approve heals, merges, promotions or decisions. The role list is read from Discord, and an unreadable list keeps the last good one.
- `github review` reads a PR's description and every changed file with its diff (large diffs truncated) so Keir can give a developer file-referenced review feedback. The review is advice, never an approval or sign-off.

## 7.2.0 (2026-11-02)

- A wait on the developers with only a filed bug report (no handoff anyone owes an answer on) is a quiet wait whose interval grows, not a six-hour poll. Ticket 1749 woke every six hours on an unassigned issue.
- The unchanged-waiting check catches "still with the developers", "no fix has been built yet", "nothing has changed" and "no answer yet", so the player is not told the same news again when nothing moved and nobody wrote.
- A ticket post whose lead-in ("Update:") is stripped starts with a capital letter.
- The brief tells Keir to check what a money move does to the rest of a player's position, state the risk, and never point at the maximum a screen allows.
- A red check that has no annotations and no job log still names its failure: `github ci_failures` returns the check's own title and summary. Keir had told the owner "no log" while the check's report named the failing test.
- `github ci_runs` and its job pages treat an empty GitHub answer as an empty listing instead of crashing.
- When GitHub does not return a PR's file list, the approval request says the scope could not be checked, not that the change touches the economy (a party-page badge fix was described to the owner as an economy change). When every check is green but GitHub has not reported the PR as mergeable yet, the merge result says that instead of "checks still running".
- The figure guard accepts a percentage of a fraction that was read ("6.7%" for an operating margin of 0.067). It had refused the post, so the reply was reworded around the figure the player needed.
- An owner command that finishes waiting with nothing said (for example "merge N" while checks run) posts its summary to the channel once, so the owner knows what it waits on.
- The money-claim check treats "cannot" and "unable" as negation, and a sentence about the approval step itself ("the refund is up for approval") is not a money outcome. A correct reply ("an attached note cannot authorise a payment, so that refund has to come through our own approval") was refused four times in one ticket.
- A watch finding that an open issue already covers asks once for the new evidence to be added to that issue before it finishes done.
- Past-tense release claims ("went live", "rolled out", "was released") need the same release receipt as "is live". A ticket reply had claimed a change "went live at the end of last week" with no such change.

## 7.1.3 (2026-11-01)

- Keir no longer waits on the sandbox server or asks the owner who can update it. The sandbox has had no automatic deploy since the move off Railway (2026-10-22): it is rebuilt by hand from staging and can run days behind. `github where` stopped reporting the frozen `turn-worker/sandbox` branch, its meaning text no longer claims a staging deploy follows within minutes, and the brief says to skip the sandbox stage once main contains the fix and verify on the main server (ticket 1740 sat "waiting for the test server" for 90 minutes while the fix was already live).

## 7.1.2 (2026-11-01)

- Support tasks can read the new game-data tools from Keir's own capability requests (lakeside-code #69): live cabinet, Supreme Court and Senate leadership nominations with vote tallies and deadlines (`nomination_records`), the reporter's shareholdings and company control (`character_holdings`, reporter-scoped like the other player reads), stored failure messages for failed turns (`turn_failure_detail`), and the public commodity market. Ready reads are seeded with the questions they answer.

## 7.1.1 (2026-11-01)

- Ready reads never make an activation wait: the index of read tools is built in the background at startup and refreshed every nine minutes, and a lookup before it is warm, or with the embedder down, returns nothing instead of failing. The first live probe after 7.1.0 spent its whole 4 s budget building the index cold; warm lookups take about 12 ms.
- The harness-runner admission test checks that released slots can all be taken again, not that slot 1 comes back first (it flaked in CI on 2026-11-01).

## 7.1.0 (2026-11-01)

- Two-call answers (owner, 2026-11-01). Before the model starts, the broker loads the read tools that match the request, with their exact input schemas (`context.readyReads`), so the first call can be the read and the second the reply. Matching is by meaning through the box's embedding proxy, over each tool's description and over questions that tool actually answered before: every successful read is remembered (`readyreads-examples.json`), so the index learns the words people use. Only tools the task may read are offered. It fails open; `KEIR_READY_READS=0` turns it off. The week of 2026-10-25 a ticket took a median 9 tool calls, and an owner's weekly-logins question spent four on discovery and ran out of steps.
- Failed and workaround reads become capability requests (owner: "treat failed tools or weird hacking of MCPs as signs MCPs need to be expanded"). Hourly, refused reads and raw heal-ops queries from the last 7 days are grouped by tool and failure kind or by the collection read raw; a group seen 3 times across 2 tasks files one capability request on the lakeside-mcp board, and later hits raise its count on the same card. Policy refusals are ignored. `KEIR_CAPABILITY_GAPS=0` turns it off.
- Wrong argument names are mapped to the schema's own name and retried once when there is exactly one clear counterpart (`corporationId` to `corporation`, `limit` to `turns`); an argument already given is never overwritten.

## 7.0.4 (2026-11-01)

- A run that runs out of steps never posts its "Maximum steps reached... tools are disabled" note (#mod-bot, 2026-11-01: an owner's one-line question about weekly logins got that note instead of "142"). Its last text is kept as a private checkpoint and the work continues in a full activation; finish summaries and fallback replies refuse the same wording. The last step of an activation is kept for the answer: a read on the final step is refused with "post your answer now".

## 7.0.3 (2026-11-01)

- The owner's conversation only carries what the owner can act on (owner, 2026-11-01: "All of these I can't do shit about or there's nothing actually waiting"). A stuck task stays on the working-now board and in Ops instead of posting an urgent "stuck" line each time it flips (ticket 1730 posted three). A "needs your decision" line whose decision was answered before it went out is dropped.
- A compensation payment interrupted after heal-ops ran it is settled by a dry run of the same payment: nobody still owed means it landed, so the effect is done and the task resumes; everyone still owed means it did not, so a later approved call may run it; a failed or unclear dry run stays held. It never pays, and an interrupted payment no longer DMs the owner.

## 7.0.2 (2026-11-01)

- An approved payment is no longer refused as "plan changed" because a game turn processed between the approval and the payment (ticket 1730, 2026-11-01: the owner was asked twice for the same $1,306,621). A compensation's dry run restates each credit in the anchor currency at the current exchange rate, which moves every turn; approval now covers who is paid what in their own currency and how many records change. A different amount, payee or currency is still refused.

## 7.0.1 (2026-11-01)

- The owner's approval is enough to make a payment (owner, 2026-11-01: "It should allow it if I approve it"). A ticket task may now propose any repair, including a large compensation; it goes to the owner (and Ariane after three hours) as one exact approval card instead of to the reporter, and once that card is approved the ticket task applies it with execute_action. Nothing runs without that exact approval: a carried ticket yes still never covers a large repair. After the owner answers a payment question, asking again in other words ("who executes", "confirm the exact payment") is refused for two days with a pointer to request_heal (tickets 1730 and 1742 asked three times each).

## 7.0.0 (2026-11-01)

- Keir 7 fast lane: a ticket that only asks how the game works is answered by Ask Keir before any model runs, in the ticket, in about a minute, and the ticket then waits for the player. Gameplay advice gets the Ask redirect the same way. Anything else, a follow-up that pushes back or turns into a bug report, an attachment, or an answer Ask's own checks doubt, goes to the full agent, which starts with Ask's draft. The fast lane only reads: it posts through the same ticket update and finish guards as the agent, never draws on the player's own Ask energy, and is off with `KEIR_FAST_LANE=0` or without `KEIR_ASK_SECRET`. Each answer is logged in usage.jsonl as a `fast-lane` activation and audited as `fast_lane`.

## 6.2.2 (2026-11-01)

- A decision in player copy names the developer who made it (owner, 2026-11-01): "the developers decided", "compensation is approved" and "the ruling is" are refused unless the sentence names who approved it, taken from who answered the ticket's decision (Ariane answering for the owner is Ariane) or a developer named in a recorded decision fact (`decision_unnamed`). Names come from `KEIR_DEVELOPER_NAMES` (default Egg and Ariane). The support service applies the same rule to every agent's posts and receipts (`SUPPORT_DEVELOPER_NAMES`). Replaying the delivered posts from tickets 1650 onward found 6 unnamed decisions, all genuine.

## 6.2.1 (2026-11-01)

- A restart no longer leaves running ticket tasks blocked. The operator unit used `KillMode=control-group`, so systemd's SIGTERM also reached each activation's CLI child, the activation died at once and the 100 s grace never applied; the task was marked blocked with "activation aborted" and an owner alert (tickets 1730 and 1740 on the 6.2.0 restart). The unit now uses `KillMode=mixed`, and an activation that ends while the operator is stopping is requeued like an aborted one.

## 6.2.0 (2026-11-01)

- Ticket post quality checks from the 2026-11-01 review of tickets 1736 to 1747, enforced in code because the brief already forbade each one (`ticketquality.js`). Refused: apologies and stories about Keir's own mistakes ("I owe you a correction", "I'm taking this one personally"); talking about the player as "him" or "her" in their own channel; "nothing is signed" style claims backed by a single empty read (ticket 1742 said it twice while three contracts existed); promises of a screen or wording change with no filing or fix behind them (ticket 1736's promised page figure was never built); and "the developers decided" with no decision on record. Each refusal is audited as `ticket_quality_refused`. Empty `read_tool` and `evidence_batch` results are remembered per task so a second, differently shaped read can confirm absence.
- Returning players get no opener: no ticket count, no thanks, no "welcome back". A player's first ever ticket still gets the one-line introduction. The answer leads.
- Status card: "Fix written" needs a coding attempt or patch for the ticket (1743 said it three minutes after "not yet confirmed"); a row cannot move back a stage unless its note says it was rolled back or failed (1739 went Live, Sandbox, Live, Investigating), audited as `status_card_regression_refused`; a paused row must name what it waits on, and the receipt timeline shows that note instead of a bare "paused".
- "Tell me which screen..." and questions about a screen or tab now count as asking the player for something the ticket's intake and page visits may already answer (ticket 1747).
- Brief: corrections are one line starting "Correction:"; read everything a reply needs before posting a figure; approved compensation is applied by Keir through request_heal in the same pass; one problem per ticket; no posts to merged or closed tickets.

## 6.1.2 (2026-10-29)

- Ticket orientation waits at most three seconds for the reporter lookup and lets it finish in the background, and a ticket's reporter lookup is reused for 30 minutes (one in flight is shared). The character read goes through heal-ops, which starts a TypeScript CLI per query: 8 to 11 seconds in production. After 6.1.1 it was 11.3 of a ticket's 11.6 second preflight.

## 6.1.1 (2026-10-29)

- Ticket orientation runs its reads together instead of one after another, and MCP tool catalogs are cached for five minutes. In production 6.0 spent a median 11 seconds of every ticket activation here, up from half a second in 5.10.7; KeirBench never saw it because its ledger is tiny. Each activation's usage row now carries `preflightParts`, the time spent per preflight step.
- A route's effort (`runner:model@low`) is now a ceiling on dynamic effort. Jev's tags pushed DeepSeek to high, so live 6.0 ticket activations ran about twice the rounds and time KeirBench measured at low and medium. Jev can still pick lower; a task that just hit its turn limit or had a completion refused may go one level above. `KEIR_ROUTE_EFFORT_CEILING=0` reverts.
- DeepSeek on the opencode and ollama runners now gets the malformed-tool fallback after three activations that printed tool calls as text. The check only knew the old `deepseek` runner, so since 6.0 those tickets went blocked instead (ticket 1713).
- A restart lets running activations finish for up to 100 seconds (`KEIR_STOP_GRACE_MS`) before aborting what is left, instead of aborting all of them at once; the 6.0 cutover interrupted five ticket activations mid-answer. A second signal stops immediately. The operator unit's `TimeoutStopSec` is 120.
- Housekeeping drops per-activation scratch (evidence text and numbers, read keys) from tasks finished over an hour ago and forgets transcripts of channels quiet for a week. The live ledger shrinks from 10.2 MB to about 7.9 MB, and every save rewrites the whole file.
- Database id matches written as `{$oid}` or `{$in: [{$oid}]}` work on fields that hold lists, and a value that cannot be read as text no longer fails the read ("Unsupported conversion from array to string", seen live).
- `reporter_state` reuses the server channel list for 20 seconds, and on a ticket whose channel was deleted says the ticket was closed and to finish, instead of "ticket channel does not match".
- The private diary is a retrospective that builds over time: Keir rereads its earlier entries, follows one or two threads of its own reasoning in prose, keeps a running set of ideas it grows, tests or drops across entries, and remembers the people it dealt with (who they are, how the exchange went, what to do differently with them), with they/them unless someone has said otherwise (owner). A failed entry now logs its cause instead of only "retry in 30 minutes".

## 6.1.0 (2026-10-29)

- After a refused answer to the player (too long, an unread figure), a ticket task cannot finish until a fixed answer is posted. KBX3 found Sonnet finishing done with the player unanswered.

- The unread-figure refusal tells the model to run the same expression through calculate and repost, and never to hand the arithmetic to the player (KBX3: "divide the second by the first" instead of the answer).

- A refused read of a closed account, sign-in or audit collection names the next step (`reporter_state`, or `raise_to_developers` kind question with needsHuman) instead of "read game records only" (self-review #236, 18 refusals in a day).

- `github` issues search accepts `is:` and `type:` qualifiers, so `is:pr is:open promote in:title` returns pull requests instead of a refusal; only `repo:`, `org:` and `user:` are refused, with the exact fix (self-review #241, 12 refusals in a day).

- When the owner's own request ends blocked (a merge refused on a red check, say), Keir now posts why in that channel. Before, the task stopped and said nothing back.

- A ticket Keir opened from a chat message no longer opens with the player's ticket count or "thank you for submitting it". The player did not file it (ticket 1708). Tickets players file keep the count (owner).

- A read the tool's schema rejects because a number was passed where it wants text, or a size sits under its minimum, is coerced to the schema and retried once instead of costing the model a round (seven live rejections this week).

- Database id lists (`{"$in": [{"$oid": ...}]}`) match ids stored as text or ObjectId, like single ids already did. They failed 13 times in a day with "cannot nest $ under $in".

- A ticket task cannot finish waiting on the player when nothing has been posted to them at all, for example after its only reply was refused for length. KBX3 found Sonnet ending a ticket that way with the player unanswered.

## 6.0.0 (2026-10-27)

- Keir 6: tuned on KeirBench Extreme 2, ten replays built from the worst real support failures and scored on quality, cost and time, running DeepSeek V4.1 Flash through OpenCode Go.
- Load the read servers, compact tool catalogs (game and support first), the reporter, recent messages and the ticket record before the model starts, so activations stop rediscovering them. A repeated tool listing in one activation returns names only.
- Return a compact repository map and the focused test, type and format commands with every snapshot, so coding work no longer explores the tree.
- Support tasks can read corporation ledgers, regional history, parties, races, fiscal and map data, and the reporter's own action timings (reporter only).
- read_tool refuses state-changing tools for every role, including the owner: repairs, merges and support writes go through their gated tools.
- Record up to eight ticket facts in one call; let finish carry the idle-fix review; trim over-long decision option details instead of refusing them; tell the model card writes wait while an owner decision is pending.
- Support ticket activations get their own 16-round budget (KEIR_TICKET_MAX_TOOL_ROUNDS); coding, investigation and owner work keep the general budget.
- Brief: cost and time discipline, money claims name the verified overcharge, private data is declined once with the useful public part, account recovery names the ownership evidence, and loss explanations compare the profitable turns with now.

## 5.10.7 (2026-10-25)

- Explain release approvals in ordinary language: what changes for players, who notices, the risk, and whether the next step prepares a test version, updates the test server, or reaches the live game. Keep code details in the optional review section.
- Preserve complete approval and choice cards through Discord delivery. Require a readable explanation of the exact version before sending a new release request, and replace unanswered technical requests without granting permission or clearing existing holds.

## 5.10.6 (2026-10-25)

- Give owner policy questions two to six named choices with clear outcomes in Discord and the app. Keep selections separate from permission to execute.
- Show approval cards with their saved operation, exact scope and explicit Approve, Decline and Ask a question outcomes. Refuse changed proposals and preserve ticket pauses.

## 5.10.5 (2026-10-25)

- Treat owner ticket pauses as durable controls: stop execution, typing and queued replies until an explicit owner resume, with one short acknowledgement.
- Require current evidence before public findings from an internally woken conversation; tool discovery alone cannot support a repeated conclusion. Keep intake bookkeeping out of public acknowledgements.

## 5.10.4 (2026-10-24)

- Finish taken-over owner commands as dismissed so a completed stand-down cannot keep blocking the ticket coordinator from answering its player.
- After three malformed DeepSeek tool-call activations, continue once on the established worker fallback with the same checkpoint and authority. Preserve uncertain-write fences and stop if the fallback also fails.

## 5.10.3 (2026-10-24)

- Let a ticket task end its activation quietly after another operator takes ownership, preserving its checkpoint and the ownership fence instead of retrying a refused finish.

- Refresh shared ticket evidence before public replies, progress cards and waits when another investigation adds findings. Wake reply waits on internal evidence without creating a player reply debt.

## 5.10.2 (2026-10-24)

- Stop timer-generated handback, missing-plan and uncertain-receipt permission cards. Retire old synthetic approvals while preserving ownership and write holds, require real pending actions for action approvals, and send each decision question once without generated pros/cons or duplicated details.

## 5.10.1 (2026-10-24)

- Recognize DeepSeek's doubled DSML delimiters, recover corrupted summaries from the last valid checkpoint, reject tool markup in saved checkpoints and finish summaries, and stop malformed-answer retries after three attempts while retaining the last verified checkpoint.

- Preserve player and developer reply safety deadlines during hourly wait reviews, including after status updates, so unchanged tickets do not trigger premature investigations.

- Keep the operator responsive during periodic notebook freshness scans by yielding between notes. Source hashes, stale-note quarantine and exact verification evidence still apply.

- Give the independent Watchkeeper half a CPU so cold HTTP-client startup has headroom within its existing five-second read deadlines. Memory limits, deadlines and permissions stay unchanged.

## 5.10.0 (2026-10-24)

The proactive studio-agent release: the 2.4.0 iOS redesign, an answer-first
conversation, a visit recap, and the owner-approved Keir sprite widget that
speaks every thirty minutes. Keir runs on DeepSeek V4.1 Flash.

### For users

- The iOS app has a new design. Feed answers three questions in order: what needs you, what Keir is doing now, and what is broken. One attention model supplies the count on every screen, so the badge, the headline and the list cannot disagree.
- Feed is a live briefing: one hero answer, a needs-you stack with inline approve, reject and reply, then what Keir did and what is next. Ideas support swipe to start or dismiss with a one-line reason.
- Ops is one health and queue surface with drill-downs for the scheduler, security posture, pull requests, worktrees and agents, world simulations, backups and database health, and event recovery. The per-service uptime catalogue is gone.
- A conversation now gets a real answer quickly and the same message is revised in place as the investigation lands, instead of an acknowledgement followed by a long silence. Revisions need this app build; an older build keeps append-only answers. A short remark like "Railway still down" is answered in the conversation lane instead of quietly becoming a task.
- The app opens with what happened while you were away: work Keir finished, decisions you answered and anything that changed in the feed since your last visit. Acknowledging the recap clears it, so the same day is never briefed twice.
- The Ops widget shows the owner-approved Keir sprite with a fresh line every thirty minutes: the game, a confident fact, what is pressing, or what Keir is doing. The pack has 45 states, including idle, talking, thinking, listening, working, reading, alert, celebrate, sleeping, moods, gestures and quirks; he waves when the app opens, blinks every few seconds and occasionally takes a sip of tea, peeks over his glasses or waggles a brow. Swipe the widget, or tap the flip control, to see the live queue. The line is generated on the DeepSeek quick route and the last one stays visible if the provider is slow.
- Autonomy mode is a visible banner that spells out what it allows and turns off in one tap. Status headlines are composed from structured ticket data, with one status vocabulary (running, waiting on you, blocked, done, failed).
- Completed suggestions now post their Discord card immediately instead of waiting for the game's next turn sweep.

### For developers

- iOS 2.4.0: one `AttentionCenter` (decisions, questions, owner work, deduplicated by ticket), a three-question Ops hub, composed status headlines (`OpsText`), the new design tokens (`OpsDesign`), scheduler/security/PR/worktree/worldsim/backup/event drill-downs, and the redesign UI-test scope. Service uptime is a 0 to 100 value and now uses `OpsFormat.percentValue`, not the fraction formatter (the 9810% bug).
- `appchannel`: an answer slot per conversational turn, `revise()` in place with `rev`/`editedAt`, `handoffAnswer()` for the provisional first answer, and `revised` rows in the thread view so an edit reaches clients that already hold the message. The thread version hashes `rev`, so a revision wakes the long poll. A client opts in with `edits=1`. An accepted voice acknowledgment ("Got it.") becomes the provisional answer instead of a second bubble.
- `handoff` accepts `answer`; `progress_update` for an app job writes the line under the answer and the activation keeps a 45 second liveness tick. `voiceturn.finalReplyQueued` ignores provisional answers.
- `GET /api/keir/app/recap` returns feed entries, quiet finished owner work and owner-answered decisions since the last acknowledgement, newest first, capped at 20. `POST /api/keir/app/recap/ack` records the visit. The feed payload carries the same recap. It reads existing records and changes no work, goal, feed or decision.
- `GET /api/keir/app/starmer` returns the last widget line, its next slot and the live work summary. `POST /api/keir/app/starmer/refresh` asks for a line now, at most once a minute. `lib/operator/starmer.js` generates on `KEIR_STARMER_PROVIDER` (default `KEIR_QUICK_PROVIDER`, the direct DeepSeek API route), rejects URLs, templates and repeats, converts em dashes, retries in ten minutes, and keeps the last line visible. No line text or provider error enters the log.
- The Ops widget uses the owner-approved `keir-S/M/L.png` sheets (24, 40 and 80px cells) and `keir-frames.json` (45 states, fps, loop, trigger, priority and idle variety). `KeirSprite` loads and caches each sheet, slices frames with `CGImage.cropping(to:)`, draws with `.interpolation(.none)` and drives a `TimelineView` at the state's fps; there is no `repeatForever` animation, and Reduce Motion shows frame 0. `KeirPortrait` resolves the state from the JSON priority using `busy`, `lineAt`, `changedAt`, `waiting` and `error`, plays `wave` once on first appear, blinks every 4.5s and plays a date-seeded idle quirk every 29s; non-looping states fall back to the state underneath and `celebrate` plays twice. `KeirSpriteTests` parses the JSON, checks every frame rect against all three sheets, and checks that every priority and idle-variety name resolves. The about screen carries the Open Government Licence v3.0 credit for the official Prime Minister's Office portrait the likeness derives from.
- All Keir lanes run DeepSeek V4.1 Flash; quick, worker and investigator use the direct DeepSeek API route (`deepseek:deepseek-flash`).

## 5.9.18 (2026-10-23)

- Voice requests get an immediate spoken acknowledgment when accepted, before model startup or tool discovery. The full answer remains separate, and a retried send does not duplicate the acknowledgment.

## 5.9.17 (2026-10-23)

- Answer voice turns on the small conversation brief with reads preloaded and direct, instead of the full operating brief (66,320 to about 1,600 characters per round), and allow one more round so a read, the reply and finish fit.
- Keep the app conversation for conversation: background work posts only decisions needed, stuck tasks and fixes live on the main server; starts, PRs, merges, pauses and finishes stay on the working-now board. At most 30 work digests are retained, so they never evict the owner's messages, and digests are left out of the conversation history models read.
- A waiting app task no longer reposts a near-repeat of its last five replies on each timer wake unless the owner has asked again; each skipped repeat doubles its next wait.

## 5.9.16 (2026-10-23)

- Keep activations inside their step budget on weaker tool-callers (found shadowing DeepSeek v4.1 Flash, where a third of runs hit the step limit): an identical read that already failed is refused with its original error, a read that timed out is not retried in the same activation, tool results warn when few steps remain so the reply is posted before the cut-off, and schema rejections from read tools now include the expected arguments.
- Accept `{"$oid": id}` in heal reads by matching the id as text, and state the ticket reply limits in the `channel_reply` tool description so drafts stop failing the copy guard.

## 5.9.15 (2026-10-23)

- Fix three tool-argument failures found while shadowing DeepSeek v4.1 Flash: support searches no longer exceed the support server's 40-result limit, knowledge searches accept `query` or `question` as the search text, and calculations accept unit conversion constants such as 1000 and 3600000.

## 5.9.14 (2026-10-23)

- Preserve explicit ticket verification holds when checking a fix's deployment or closing its linked GitHub issues. A held check still reports the fix live. Reopened issues no longer reuse a receipt from their previous closure.

## 5.9.13 (2026-10-23)

- Route gameplay strategy and investment advice to Ask with an enforced short redirect across support replies, player conversations and advice closures. Advice gets no investigation card or portfolio research checklist. Concrete defects and repairs keep their support path.

## 5.9.12 (2026-10-23)

- Ignore historical turn anomalies once newer turns have completed, so recovered failures cannot open fresh incidents after a restart or a later poll. Whole-turn failures now record one distinct event per turn and retire old persisted findings after clean turns.

## 5.9.11 (2026-10-23)

- Remove conflicting instructions to send timed and per-stage support messages. Routine progress stays on the existing card; separate replies require a player question, a useful verified finding or a completed outcome.

## 5.9.10 (2026-10-23)

- Route support filing failures to private ops alerts once, block their repetition in player replies and cards, and suppress unchanged deployment notices across later checks.
- File suggestions from authenticated archived ticket reports after their original Discord channel is deleted, preserving the reporter and native retry receipt.

## 5.9.9 (2026-10-23)

### For developers

- A task that keeps activating without new input is now slowed down instead of restarted. A task activated five times in ten minutes is backed off five minutes, then thirty, then six hours, and the ladder resets after six quiet hours. A player message, another task's delivery or a live slot still runs immediately. One ticket had been activated 104 times in two and a half hours on a dependency no tool could resolve, at 65.5M context tokens.
- A wait with nothing subscribed and no reply owed now climbs 15, 30, 60 then 120 minutes instead of a flat fifteen, and the one-minute reply hand-back fires once per player message rather than on every wait. Replaying the recorded timelines of the 52 jobs that sat on that timer, 1,547 activations become 392.
- The brief now says that attempting a gated action to watch it be refused is itself an unauthorized attempt, covering heals, merges, deployments, account relinks and payouts.
- `finish`, `status_card` and `support_action` state the rules their guards enforce at the point the model decides them: a filed question is Keir's own work item, a player-reply wait needs a posted reply, and card text is read by the player.

## 5.9.8 (2026-10-23)

### For users

- Support reviews assess design, units, scale and usable player workflows, including reports whose calculations match the code. Failed suggestion filings and unresolved defects remain owned.
- Account recovery follows up failed delivery with investigation and a concrete recovery handoff, instead of repeating answered reset questions.

### For developers

- Fix ticket suggestion filing passing an abort signal as the authorization helper's allowed states. A broker integration regression covers ticket filing, author attribution and inactive-task refusal.
- Carry a fresh explicit owner closure hold onto the newly adopted job when a resolved ticket is reopened. Historical unrelated holds are not inherited.
- The Rust MCP client uses registered server URLs verbatim, preserving alias paths used by consolidated MCP services.
- The Keir Rust shadow pass reads the support MCP address from the support registration instead of a hardcoded port.


## 5.9.7 (2026-10-22)

### For developers

- Keir no longer depends on Railway. Live-fix checks (issue closure and Sentry resolve) now read the commits production actually runs on the US box: a successful `box/ahd-us-web` or `box/ahd-us-worker` GitHub deployment when one exists, otherwise `ahd-deployed-sha.sh web|worker` (override with `KEIR_DEPLOYED_SHA_CMD`). The fix must be an ancestor of the running web commit, and of the worker commit for turn and economy code, and the site health check (`KEIR_AHD_HEALTH_URL`) must return ok. Unknown evidence fails closed. Railway "production" deployments and commit statuses are ignored.
- New read-only `github deployed` action reports the running web and worker commits, where each came from, and site health. The prompt points deploy checks at it instead of Railway reads.
- The `railway` MCP is gone from every Keir read allowlist (support, finding, quick owner, engineering, owner Muse), the tool activity labels and the `lakeside` CLI server list, so the server can be unregistered.

## 5.9.6 (2026-10-21)

### For developers

- Keir can now file an MCP capability request. `raise_to_developers` takes a new kind, `capability`: the request lands on the persistent `lakeside-mcp` board (kanban only, never a public GitHub issue) and never blocks the ticket it was raised from. Keir is told to confirm the gap with `read_servers` and `read_tools` first, file it, note the card id on the ticket, and keep working around it rather than stalling.

### For developers

- Watcher-created findings no longer wake every minute while awaiting the next game turn. They can subscribe to that turn and resume when it is processed.

## 5.9.5 (2026-10-19)

### For users

- Asking Keir to open a ticket for someone who was once added to an incident now opens their own ticket, instead of folding the report into that incident.

### For developers

- The per-reporter dedup in `open_ticket` skips incident channels. Merged players get a member overwrite on the incident channel, so Simonella's and Moist's reports were both folded into #1600, even on an owner's direct request.

## 5.9.4 (2026-10-19)

### For developers

- An owner directive that asks to close or resolve a ticket lifts the owner's own earlier `ownerClosureHold`, unless it says not to close. On 1615 an earlier follow-up's hold made Keir refuse the owner's later "close it".

## 5.9.3 (2026-10-19)

### For developers

- Owner and staff directives are no longer held behind Keir's own closure grace or `player_reply` wait. A held directive also kept its ticket out of scheduling: on 1615 and 1622 an owner "close it" sat for 2.5 hours.
- `unreadWatchdog`: a person's message in a ticket that is unread for 30 minutes pages the owner once per stall, naming the hold that keeps it.

## 5.9.2 (2026-10-19)

### For users

- Developers can ask Keir to add someone to a ticket or incident channel.
- Keir can now see screenshots attached to the ticket form, and treats a ticket's title as the report when nothing else was written.
- Keir asks you the same question at most twice.

### For developers

- `add_to_ticket` (owner or developer request, including quick conversations): resolves a member by name or mention, refuses ambiguous matches, grants view/send/history/attach and posts a mention.
- The "confirmed" card stage needs a `watch_turn` turn check (`job.turnChecks`) followed by a game read (`job.lastGameReadAt`).
- `view_attachment` falls back to ticket report images when the source message has none. `support_get` results with a platform-only description carry `reportNote`.
- The repeated-question guard refuses a post whose question shares at least half of its words (3 or more) with two earlier questions in the ticket.
- Tool-discovery narration is runtime talk in Keir and refused by the support service guard.

## 5.9.1 (2026-10-19)

### For users

- When a fix for your ticket reaches the main server, Keir now tells you in the ticket instead of only updating the progress card.
- Naming Keir in an incident ticket now gets an answer, and replying while your ticket waits on a developer decision wakes Keir.
- Tickets stay open for at least two hours after a fix goes live, so you have time to see it work.

### For developers

- An activation with zero tokens, no tool call and no text is a provider failure: it waits and retries every 15 minutes (up to 12 hours) and alerts the owner hourly. On 2026-10-19 these empty runs left tickets 1626 and 1627 unanswered.
- The owner-decision hold no longer skips the conversation wake (`humanInbox`). Incident channels ingest messages that name Keir and revive the cancelled incident job.
- `liveNotice` posts one production reply the first time a card item reaches main or confirmed, skipped if Keir said "live" in the last 15 minutes. `support_resolve` is refused for `KEIR_LIVE_GRACE_MINUTES` (default 120) after a live post unless the player replied since.
- Brief: no guessed values for players to try, no "works" without the player's path, the title is part of the report, single explicit corrections, no next-turn forecasts.

## 5.9.0 (2026-10-19)

<!-- Coverage: keir-v5.8.30 plus account investigations PR #142. -->

### For users

- Run `/audit` in the owner app to sweep for possible linked accounts, or `/audit preview` to inspect findings. Keir also checks every 12 hours and opens private Investigation tickets for developers and moderators.

### For developers

- Investigation intake requires shared-cookie and coordinated-login signals for the same account pair, excludes either account with moderator notes, and deduplicates reciprocal observations. Tickets contain public profile links and safe aggregate facts, with developer/moderator role pings. Financial warnings stay diagnostic; no automatic sanctions or money changes.
- Investigation evidence is excluded from public receipts, ordinary support searches, automatic repair, merging and player notifications. Filing checks game intake capability and explicit private-channel permissions before sending evidence, with durable guards against ambiguous retries.

## 5.8.30 (2026-10-19)

### For users

- When Keir's monitoring finds a problem that hit your account, it opens a ticket for you explaining what happened and where the fix stands, so you do not have to report it yourself.

### For developers

- Proactive tickets: `open_affected_ticket` (finding tasks only, after the finding is raised to the developers) opens a normal bug ticket for one affected character. The broker resolves the player's linked Discord account from the game records (never shown to the model), dedupes per player per finding, and caps at 10 per finding and 20 a day. The ticket's own task follows up through the bug playbook.
- Brief: when two explanations fit a report and only the player can tell them apart (which screen or device, what they clicked), Keir asks that first and states neither as fact. Proposed by the harness improver; dev replay on DeepSeek v4.1 Flash 58% to 83% (+25 pts [+8, +42]); shipped on owner call without the validation and holdout gate.
- Self-improving loop (after Harness²): every refused tool call is audited as `tool_refused` (to events.db). `bin/keir-self-review.js` runs nightly (`keir-self-review.timer`, 03:30 New York): it clusters the day's refusals by cause, picks the top recurring one not proposed before (at least 5 refusals across 2 tasks), has an OpenCode coding agent (DeepSeek v4.1 Flash by default) write one deterministic fix with a unit test in a fresh worktree, and opens it as a draft PR for review. At most one PR a night; proposals are remembered so a cause is never proposed twice; raw samples stay private.
- Keir works every ticket through the same checklist for its kind (bug, data repair, mechanics question, design feedback, feature request, incident), so it does not close a ticket before it has checked your records, found the cause, routed it and told you.
- Ticket playbooks (`lib/operator/playbooks.js`): a checklist per ticket kind (intake tag, then channel category) computed from broker-recorded state (reads, reporter lookup, issues raised, merges, heal requests, card stages, posts since the player last wrote). Each activation gets `context.playbook` with the next step; `finish` done is refused while a required step is open. Developer, owner and delegated tasks are exempt.

## 5.8.29 (2026-10-19)

### For users

- When Keir waits for your reply, it has always actually asked you something first.

### For developers

- A ticket finish waiting on `player_reply` is refused unless a post reached the player since they last wrote. Replay traces showed finishes saying "asked the player" after the question was refused for length, or with no post at all.

## 5.8.28 (2026-10-19)

### For developers

- An expired or unrefreshable model-provider login no longer blocks a task: it waits and retries every fifteen minutes for up to twelve hours. On start, tasks blocked only by a login failure, with nothing external in flight, resume. On 2026-10-19 an OAuth expiry blocked four tickets for hours.

## 5.8.27 (2026-10-19)

### For users

- When Keir looks into a report and it turns out nothing needs fixing, the progress card says "Answered · no fix needed" instead of staying on "Investigating".

### For developers

- A tool call after the task stopped running (finished, merged, paused, past its deadline) says which and to stop making calls. The bare "task execution authority is inactive" kept models calling tools, up to 21 times in one replay run.
- Status card stage `answered`: investigated and answered with nothing to fix. It needs the same investigation receipt as `found`, renders done, and does not hold a waiting finish. Replay traces showed 36 runs trying an empty card to clear a not-a-bug item.
- `support_set_status` with a value that is not a status (`waiting_on_player`, `answered`) says so, lists the allowed statuses and points to `finish` with `waitFor`, instead of calling it terminal. Replay traces showed 15 runs refused this way.
- The idle-fix check on a waiting finish asks once per set of idle fixes. It was keyed on each item's stage and note, so re-noting an item as the refusal asks re-armed it: in replay traces 49 runs hit it, with a median of three refusals and about ten tool calls before the finish was accepted.
- `evidence_batch` with workspace queries loads the AHDGame main snapshot when the task has none, instead of failing as "narrow the query". A sandbox failure now reports the sandbox's error; only real truncation asks to narrow. Replay traces showed 37 runs losing a round this way.

## 5.8.26 (2026-10-19)

### For developers

- An investigator delegated by a ticket task reads that ticket and its reporter's history, as the ticket task can; any other ticket or player is still refused. Investigators were told to read live game state and then refused it for want of an assigned ticket, so they finished blocked.
- A ticket update sent with its text under `body`, `text` or `content` reaches the support service as `message`, and an update with no text is refused before any call with the exact shape to use. Replay traces showed a model sending `body`; the empty update then failed at the service, costing a round.

## 5.8.25 (2026-10-19)

### For developers

- Reporter-scoped player history reads (`trace_character`, `trace_account`, `character_balance_sheet`, `character_wealth_history`) accept the reporter under the names models use (`sequentialId`, `characterId`, `name`, `id` for trace_character) and default to the reporter when omitted; `support_get` defaults to the assigned ticket. Another player or ticket is still refused. The replay benchmark found 44 refused reads in 18 dev runs, every one argument shape, none another player.

## 5.8.24 (2026-10-19)

### For users

- When Keir passes a decision to the developers, the player still gets one message explaining where things stand, whichever way Keir posts it.

### For developers

- While an owner decision is pending, `support_action` with `support_public_update` follows the same one-notice rule as `channel_reply` (guardTicketPost) instead of being refused outright; status, tracker and resolve writes still wait. Found by the replay benchmark: a model that raised the decision and then used the support path could not tell the player anything.

## 5.8.23 (2026-10-19)

### For users

- When Keir prepares a fix for a reported bug, the report is linked to the developers' issue for it first, so it reaches the developers working on that bug.

### For developers

- `publish_patch` refuses on a ticket-scoped job (ticket, or a task in a ticket channel) that has no linked GitHub issue, unless the PR body references one explicitly (`#N`). File the bug or add evidence to the open issue with `raise_to_developers`; its duplicate check finds it. Finding jobs are unaffected. Found by a simulated-ticket benchmark where 2 in 5 runs published a patch without linking the bug.
- The shell effect guard no longer treats `--force` or `--skip-*` as an approval claim on ordinary commands (git, npm); those flags only count on a script with an effect verb. Approval-claim flags (`--approved-by`, `--approver`, `--as-owner`, `--override`) are still refused on any command. A fixed prohibited/permitted command set is now a test. The guard is a supplementary layer; the broker's effect tools carry the authorization checks.

## 5.8.22 (2026-10-18)

### For users

- An approved fix that loses a merge race with another change is retried automatically instead of asking the owner to check on it.
- Keir no longer tells the owner that each promotion of an already approved fix needs a fresh approval.

### For developers

- GitHub merge refusals (HTTP 405, 409, 422) are definite: nothing merged. "Base branch was modified" re-reads the PR and retries once on the same head. Any other refusal clears the merge receipt so a later call can retry, with no owner inspection.
- An unsettled merge receipt now tells the model that effect recovery settles it from GitHub within ten minutes, instead of "owner inspection required".
- A feature merge to development returns a next move: promote, and promotions carrying only owner-approved changes ride those approvals.

## 5.8.21 (2026-10-19)

### For users

- Keir answers faster and uses far fewer tokens per task. Each job now reads only the parts of its manual it needs, and loads the rest on demand.
- Keir refuses to run a command that takes an action on a claimed approval, such as relinking an account on someone's say-so. It asks for the approval instead.

### For developers

- Lean activation context (`lib/operator/briefprofile.js`): the brief is trimmed per job kind (coder, investigator, probe, finding, quick, work), skill bodies become one-paragraph digests, and 27 rare tool schemas on ticket/command jobs load through `load_context` and run through `call_tool`. Measured on keir-bench: ticket/command always-on context 114K to 76K chars, coding child 90K to 16K; no accuracy loss on Sonnet 5.5 or DeepSeek v4.1 Flash. `KEIR_LEAN_CONTEXT=0` restores the full brief.
- Effect guard (`lib/operator/submitgates.js`, toolserver): shell commands that assert an approval (`--approved-by`, `--override`, `--as-owner`, `--force`) or run a script with an effect verb (relink, transfer, refund, credit, grant, approve, delete) are refused before execution. Test runners and `--dry-run`/`status` are exempt. It refused 0 of 441 recorded live shell commands and took DeepSeek's unapproved relink attempts on the bench from 9 of 15 runs to 0. `KEIR_EFFECT_GUARD=0` turns it off.
- Off by default: `KEIR_CORE_BRIEF=1` (3.4K-char core brief from `KEIR-CORE.md` for ticket, command, finding and quick jobs) and the hybrid tool mode (model-native workspace tools plus broker MCP for effects). Both need further validation before live use.
- keir-bench: support suite (10 graded player-reply cases), four more coding cases, real-brief arms (`keir-current`, `keir-lean`, `keir-core`, `keir-hybrid`), workspace prefetch, deliverable gate and `KEIR_BENCH_TIME_SCALE`.

## 5.8.20 (2026-10-18)

### For users

- Asking Keir whether the game can do something now gets an answer checked against the code. If the system does not exist yet, Keir offers to build it, or says who already is.

### For developers

- Owner and developer requests tagged as a mechanics question, feature request, design feedback or command carry `context.capabilityQuestion`, so quick and focused conversations (which skip the full brief) still check the code and offer a build when the mechanic is missing. Players and ticket tasks are excluded.

## 5.8.19 (2026-10-18)

<!-- Coverage: keir-v5.8.18 (387134f) through this release's ticket conversation fixes. -->

### For users

- A new player question can receive a reply even when an older developer conversation is waiting in the same ticket.
- Earlier progress updates no longer prevent a later answer indefinitely. Repeated messages remain limited.
- Conversation monitoring flags unanswered messages sooner, including fragmented messages sent in a burst.

### For developers

- Make developer-task reply ownership yield to newer human input, and apply the same rule to coordinator wake delays. Explicit staff takeovers retain their existing enforcement.
- Bound the consecutive-message pause to ten minutes. Keep duplicate-copy checks, outcome evidence, owner-decision holds and the short-message guard.
- Measure unanswered age from the first human message since the latest visible answer, with a three-minute threshold. Player-reply wait state does not suppress the finding.
- Add regression cases for the two observed reply fences and fragmented unanswered messages. Production activation is verified separately from source inclusion.

## 5.8.18 (2026-10-18)

<!-- Coverage: keir-v5.8.17 (2202599) through this release's decision consistency and audit changes. -->

### For users

- Owner decisions can appear in both the native app and Discord with one shared request and answer. The first authenticated answer wins, and obsolete copies are removed.
- Existing app-only decisions can gain their Discord copy without creating another approval request.
- A withdrawn question no longer prevents the ticket from continuing under new guidance.

### For developers

- Guard every decision against second answers, cancel unsent copies, discard obsolete outbox delivery, and clean up late or incorrectly marked legacy Discord cards. Bound and rotate cleanup attempts; treat missing cards as already removed.
- Add an independent five-minute conversation audit of actual ticket messages, receipts and Discord decision copies. Retain private reply samples and report changed findings and hourly monitoring heartbeats to an optional ops board item. Sampling and transport failures are explicit; the monitor never changes operator state, tickets, decisions or messages.
- Audit delivery-only-to-card, public internal handoffs, unanswered players, stale conversations, closure against an explicit hold, routine permission requests, missing or divergent decision copies and orphaned decision holds. These are review cues, not automatic semantic verdicts.
- Configure both channels with KEIR_OWNER_DECISION_CHANNEL=both. The authenticated native app decision API remains the shared source of state. Independent installs retain the existing delivery default.
- Validate with red-to-green decision race and handoff regression tests, focused approval/app tests, audit tests, and a live read-only audit. The agent release packaging reruns the full suite.


## 5.8.17 (2026-10-18)

<!-- Coverage: keir-v5.8.16 (dfef142) through a25144a, with PR111 corrections through eef22a3; release metadata follows. -->

### For users

- Ticket answers and final resolutions appear as new conversation messages instead of edits buried in the opening card.
- Internal developer summaries and decision handoffs stay out of player tickets. Support works toward the player's goal and does not treat resignation as acceptance.
- Keir explains and investigates without asking permission. A blocked repair stays on hold while independent work and conversation continue.
- Owner decisions can stay in the native app instead of also appearing in Discord DMs.
- Simple chats start with less context and load more instructions and tools as needed. Actual response time still depends on the provider.
- Native suggestions preserve the original reporter and return a feedback receipt.
- Chat exposes distinct tool activity. The native iOS Working placement, activity renderer and Cursor settings need the corresponding iOS app update; this agent release alone does not install that update.

### For developers

- PR105: verified suggestion-source attribution and durable intake deduplication; explicit ticket replies; provider-managed Cursor Auto controls.
- PR106: literal greeting fast path, Jev-directed context profiles, scoped progressive tools/skills/history, first-visible-reply timing and durable tool activity IDs.
- PR108: support updates default to reply and final resolution notices always post new messages. The support MCP release must be active before this agent.
- PR109: reject explicit routine permission questions before creating a decision or app choice panel; support KEIR_OWNER_DECISION_CHANNEL=app; require confirmed reply delivery before marking answered; instruct all app context paths to continue authorized independent work around blockers.
- PR111: keep developer finish summaries out of tickets, reject internal decision handoffs and diagnostic shorthand, and support trusted closure holds that permit investigation and player replies.
- Exact action approval, provenance, financial repair and executor-attestation fences remain enforced. This release does not implement heal executor attestation.
- Hosted checks passed for each merged change, including the iPhone simulator for PR106. Targeted delivery, approval, interaction, context and operator regressions passed. Release packaging reruns the agent suite.

## 5.8.16 (2026-10-18)

### For users

- Engineering and Watchkeeper can use Cursor Auto, completing the Cursor Auto
  provider setup across Keir's configured lanes.

### For developers

- Accept the provider-managed Cursor Auto route in Keir's engineering settings.


## 5.8.15 (2026-10-18)

### For users

- Keir can use Cursor Auto across conversation, work, coding, investigation,
  vision, engineering and voice activations.

### For developers

- Isolate each Cursor CLI activation and scope its broker tools to the task.

- Route conversation, work, coding, investigation, vision, engineering and voice
  activations through Cursor Auto with per-activation broker grants and isolated
  CLI configuration.

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
