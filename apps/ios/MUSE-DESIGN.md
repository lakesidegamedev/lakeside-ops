# Keir and Meta Muse: design brief

Research date 2026-11-20. Compared against this branch at `da83290`.
Audience: whoever changes the Keir iPhone app next.

Keir is a personal app for one owner. Its first job is Discord support
tickets and pings: what is waiting, what Keir did about it, and what needs
the owner's yes or no. Meta's Muse is the closest shipped reference for a
personal agent on iPhone. This brief takes from Muse only what was seen in
Meta's own screenshots and demo videos, and labels everything else.

**Labels used below**

- **Seen**: visible in a first-party Meta asset, with the source and
  screenshot number or timestamp.
- **Meta says**: stated in Meta's own text, not visible in an asset.
- **Ships**: what Keir's code does today at `da83290`.
- **Recommend**: a proposal. Nothing in this brief is built.

## Sources

All first-party. Local copies, frames and hashes are kept outside the repo
in the studio's research archive (`muse-research/SOURCES.md`).

| Id | Source | Date |
|---|---|---|
| AS | App Store, "Muse from Meta", id6760173601, v16.1. https://apps.apple.com/us/app/muse-from-meta/id6760173601. Screens from https://itunes.apple.com/lookup?id=6760173601&country=us. iPhone screens AS-1 to AS-8, iPad screens AS-P1 to AS-P7, in listing order. | released 2026-09-08, v16.1 on 2026-11-16 |
| NR | Meta Newsroom, "Introducing Muse". https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/. Clips `Muse_FieldTrip.mp4` (FT), `Muse_Japan.mp4` (JP), `Muse_Relationships.mp4` (RL), `Muse_Shopping.mp4` (SH), `Introducing-Muse_Sizzle-Video.mp4` (SZ). | 2026-09-08 (page metadata; the brief said Sep 14, the page says Sep 8) |
| VO | Meta Newsroom, "Give Your Muse a Voice". https://about.fb.com/news/2026/11/introducing-muse-ai-voice-expressive-avatars/. Clip `01_Muse-Realtime-Voice-technology.mp4`. | 2026-11-05 |
| SP | Meta Newsroom, spaces. https://about.fb.com/news/2026/11/introducing-spaces-customize-muse-app/. Clip `01_Design-the-Muse-App_Just-for-You.mp4`. | 2026-11-06 |
| BL | Muse blog, "How We Designed Muse". https://muse.ai/blog/how-we-designed-muse. Images `status`, `checkout`, `goals`, `ideas`, `artifacts`. | 2026-09-08 |
| MS | Product site https://muse.ai/ | fetched 2026-11-20 |

Connect 2026 is cited only through VO ("At Connect 2026, we previewed
real-time conversations"). No separate Connect asset was used. The guided
product tour on muse.ai loads its video by script and was not retrieved; only
its cover image was.

**Not app UI.** The App Store captions and the blue gradient behind each
phone are store framing. SZ is a marketing edit with zoomed, restyled UI
fragments (for example the "Inbox" at 0:16 and the "Submit" button at 0:44);
it is not used as evidence of layout. The MS hero animation (`og-video.mp4`)
and the furry avatar clips (`hatch_working.mp4`, `hatch_connecting.mp4`) are
brand art. None of these are cited as app screens.

**Gestures.** Several clips show a round touch marker. This brief says
where it sits and what changes next. It does not name a gesture the clip
does not show.

## Screen by screen

### 1. Main chat (iPhone)

**Seen**

- One header: a small avatar at top centre, its name in a pill under it,
  and under the name a grey live status line. FT 0:00.5 "is working",
  FT 0:04 "Filling out paperwork...", FT 0:18 "Drafting email..." with a
  writing-hand emoji, SH 0:21 "Order confirmed.", AS-3 "Booking
  reservation...".
- Left: a round menu button. Right: "Invite" in FT, JP, RL and SH. In AS-P1
  to AS-P6, SP 0:00 and VO 0:00 the right side holds a phone icon and a gift
  icon instead, so builds differ.
- Bubbles only. Muse in light grey, owner in light blue, both left text
  aligned, no sender name and no timestamp on any bubble (AS-1, FT, JP).
- A typing indicator is three dots in a grey pill (FT 0:00.5, JP 0:01).
- Composer is one pill: "+", "Message", mic icon (AS-1 to AS-8).
- iPhone tab bar in a floating capsule with five icons: chat, feed, ideas,
  goals, library (FT 0:00.5). Text labels for them appear on iPad: Main
  chat, Feed, Ideas, Goals, Library (AS-P1).
- Muse opens conversations on its own. RL 0:05: "You and Sarah have been
  meaning to hike... Want me to plan it?" with a map card, before any owner
  message. JP 0:08: "Sushi Kaze just opened up on Saturday. Booked dinner
  ... Send reservation details to Sarah?"
- Before acting, Muse states the plan and asks a short question: "Good to
  go?" (RL 0:17.5), "Good to send?" (FT 0:22.5). The owner's answer is a
  short bubble ("Do it.", "Send it.", "Yes!"). The result is one line:
  "Saturday 8 AM is on your calendar." (RL 0:17.5), "Sent. I'll remind you
  on Thursday to pack a lunch." (FT 0:24).

**Meta says** (BL) the main chat is "one long conversation"; the owner can
send several messages without waiting; bubbles exist because proactive
messages arrive out of turn; "side chats" exist for separate topics.

**Ships** (`Ops/KeirView.swift`)

- Toolbar centre: Keir sprite, thread title and a chevron that opens the
  thread list (`ToolbarItem(placement: .principal)`). Status is a separate
  row under the toolbar (`runtimeStrip`, `KeirPresence`), hidden when ready
  or waiting on approval.
- Keir messages: a raised bubble with a "Keir · 2m ago" header above every
  message (`KeirMessage`). Owner messages: sky-tinted bubble.
- Composer: a control row above the field with the model picker, a ticket
  menu, a task count and a message routing menu, then attach, voice, field
  and send (`composer`).
- Empty main thread: `KeirStart` shows the portrait, "Talk to Keir" and at
  most one ticket with no recorded Discord reply, which fills an editable
  draft and never sends (`Ops/KeirPersonal.swift`).
- Three tabs: Conversation, Inbox, Ops (`Ops/OpsApp.swift`, `TabView`).

### 2. Approval card

**Seen**

- Email, FT 0:22.5: a card in the chat flow above the composer, not a modal.
  Mail icon and bold title "Allow Muse to send this email?". One sentence:
  "Muse wants to email grade7@... to volunteer as a chaperone for Amara's
  field trip." A grey inset shows From, To, Subject and the start of the
  body. Full-width blue "Allow", grey "Deny" under it.
- This card appears after the owner already said "Send" in chat (FT 0:20.5).
  Chat consent did not replace the card.
- Purchase, AS-2 and BL `checkout`: cart icon, "Checkout · Muse wants to
  place an order at ncvss.com", a caution sentence, a live screenshot of the
  merchant page with a "Review order" chip, the payment method row, the
  estimated total, then "Deny" and "Allow" side by side, Allow filled blue.
- While the card waits, the work row reads "Browser · Blocked · Waiting for
  confirmation" with an orange icon (SH 0:16.5).
- A round touch marker sits near the buttons at FT 0:23.5. The next frame
  (FT 0:24) shows "Sent...". The clip does not make clear which button the
  marker is on.

**Meta says** (BL) structured approval cards are "non-negotiable"
deterministic UI; approval stops "anything hard to undo" and lets ordinary
browsing run, to avoid "banner blindness".

**Ships** (`DecisionCard` in `Ops/KeirView.swift`): status badge, ticket
number, age, title, question, a monospaced scope block for non-choice
decisions, an always-visible line "Approve authorizes this operation.
Decline prevents it. Asking a question gives no approval.", then three
buttons in one row: "Approve this action", "Decline", and an icon for reply.
Disclosure "Review full action and scope" with action kind, arguments,
digest and expiry. Decisions now render inside the conversation that
started them (`threadDecisions`). Lock-screen notifications offer Approve,
Reject and Reply (`Ops/OpsPush.swift`, `KEIR_DECISION`).

### 3. Work in progress and evidence

**Seen**

- Inline work card: globe icon, "Browser", a verb status ("Selecting
  seats...", AS-3; "Adding Glide Pro to cart...", SH 0:15; "Completing
  checkout...", SH 0:21), a live thumbnail of the page and an "Open
  browser" button (AS-3).
- When the work finishes, the card is gone and one result bubble remains
  (SH 0:24.5).
- Produced files arrive as a preview with a title row and type: a PDF form
  thumbnail, "Field Trip Permission Slip", "PDF" (AS-1, FT 0:04); "Growth
  Plan - Year Summary", "DOCX" (AS-6). Built pages arrive as "Artifact" cards
  with title and date (BL `artifacts`), or a space card such as "December
  Japan Trip" (JP 0:08).
- Activity log (AS-P5 right panel, BL `status`): avatar, name, status line
  ("Connected", "Checking price"), four icon segments (list, shield, clock,
  fingerprint; only the list is selected in either image), then entries
  grouped by day ("Today", "Yesterday", "Thursday"). Each entry: icon, bold
  title, one line of result, time. A running entry has a small black square
  button at its right (BL `status`, "Find rain jacket options").

**Meta says** (BL) the line under the avatar is "a snippet of what it's
working on"; tapping the avatar shows "its full activity log as well as
permissions you've approved". The other two segments are not described.

**Ships**: `KeirToolCalls` shows the last three tool calls with tool title,
source and a check, failure or spinner. Running jobs show a "Running"
badge. "Keir's computer · View or take control" opens `KeirComputerScreen`.
The ticket screen shows "What Keir did" receipts, and "View reply in
Discord" or "No Discord reply receipt" (`Ops/DeskView.swift`). The stop
control is one toolbar button for all of Keir.

### 4. Lists: Goals, Ideas, Feed

**Seen**

- Goals (AS-7, BL `goals`): sections "Tracking" (green dot) and "Goals"
  (blue dot). Each row: empty checkbox, bold title, one grey line of current
  state ("First practice is Sep 17 - 10 days out", "Your Sep 7-13 draft is
  ready for approval"), chevron or overflow. "Show 2 more" collapses the
  rest.
- Ideas (AS-5, BL `ideas`): each row starts "I can..." in bold with an
  emoji-style icon, then two or three lines naming the evidence ("I found an
  email from the airline confirming your canceled flight...").
- Feed exists as a tab (AS-P1). None of the assets reviewed shows its
  content.

**Ships**: Inbox (`ActivityView` in `Ops/KeirAgent.swift`) leads with the
decision receipt, "No recorded reply" tickets, "Needs you", then a
Tickets/Tasks segmented control, five filter chips with counts (All,
Running, Queued, Blocked, Decisions), source warnings, "Your decisions" and
the queue. Goals and Ideas exist under Ops.

### 5. Voice

**Seen** (VO clip)

- 0:00.3: a touch marker under the phone icon at top right of the main
  chat. 0:01.5: the icon has changed to a connecting glyph. 0:03: a vertical
  pill holds a red end-call icon and a mic icon.
- The avatar grows from a header icon (0:00.3) to a large figure filling the
  top third (0:08). Chat, composer and tab bar stay on screen.
- The owner's speech appears as a normal owner bubble that fills in while
  they speak ("Can we role play my interview," at 0:03, complete at 0:08).
- Muse's reply appears as a normal bubble; at 0:28.5 the trailing words are
  lighter than the rest while it is still speaking.

**Meta says** (VO) start with the phone icon; choose "voice only, the avatar
alongside your conversation, or full screen"; interrupt at any time; pick
from hundreds of voices. Only the "alongside" layout appears in the clip.
The App Store text says the avatar is "audio only or as a live animated
video".

**Ships** (`Ops/KeirVoiceMode.swift`): a separate full-screen cover. Title
"Keir voice", a provider line ("Microsoft Ava · online voice"), a model
menu ("Auto · Gemini / DeepSeek alternating"), an SF Symbol orb, a large
status word, the current transcript and only the latest reply in a 200 pt
scroll area, the hint "Pause to send. Tap the waveform to interrupt.", and
three round buttons (mic pause, interrupt, end). Reached from the waveform
button in the composer or "Talk to Keir".

### 6. Navigation and customisation (iPad and spaces)

**Seen**

- iPad sidebar (AS-P1): "Muse", "TABS" (Main chat, Feed, Ideas, Goals,
  Library), "SIDE CHATS" (topic names), footer with settings, search and
  compose.
- Later build (SP 0:03, 0:15): "TABS", "SPACES" (user-built pages, plus
  "Create a space") and "CHANNELS" (WhatsApp). The tab bar changes as rows
  move between TABS and SPACES while a touch marker is on them; by 0:18.5
  the iPhone tab bar has three icons. The clip does not show how a move
  starts.

**Ships**: three tabs that become a sidebar on iPad with iOS 18
(`sidebarAdaptable`). Threads are a sheet from the title.

## Synthesis for Keir

Muse's pattern in one line: one conversation, a status line under the
agent's face, a fixed card for anything hard to undo, and a short receipt
when it is done. Everything else is a second tap away.

### Conversation

- **Recommend** a single header: Keir's portrait, name, and one live status
  line under the name ("Reading ticket #1234", "Waiting for you", "Posting
  reply"). Retire the separate `runtimeStrip` row.
- **Recommend** tapping the portrait opens Keir's activity: today's work by
  day, a stop button on each running item, and the autonomy grant. Move the
  thread switcher off the title into the leading menu, and on iPad into the
  sidebar as side chats.
- **Recommend** dropping the "Keir · 2m ago" header from every message. Show
  time when the gap is long, or on long press.
- **Recommend** the composer becomes "+", field, mic, send. Model picker,
  routing ("New task", "Follow up", "Steer") and the ticket menu move into
  the "+" menu or the Controls sheet.
- **Ships and keep**: Keir never sends a suggested draft by itself
  (`KeirStart`, `KeirTicketMenu`). Muse's proactive messages are the model
  for the next step: Keir posts one message when a ticket goes unanswered,
  rather than a chip or a count.

### Voice

- **Recommend** voice as a state of the conversation, not a separate cover.
  The spoken turn and Keir's reply land in the thread as ordinary bubbles,
  so nothing said by voice is lost when the call ends.
- **Recommend** the portrait (`KeirPortrait`, already in the app) grows at
  the top in place of the SF Symbol orb. Controls: end and mute in one small
  pill at top right. The interrupt button is not needed if talking over Keir
  interrupts, which is what VO claims; keep it until that is true in Keir.
- **Recommend** removing provider and model text from the voice screen.
  Keep voice choice in Controls.
- **Ships and keep**: the waveform shows real microphone level, never a
  fake animation (`KeirAudioWaveform`).

### Ticket and ping triage

- **Recommend** the Inbox opens on one section, "Waiting on you", ordered:
  Discord pings that mention the owner, tickets with no recorded reply
  (oldest first, as `KeirTicketFollowUp.waiting` already sorts), then
  decisions. Each row copies the Goals row: title, one grey line of current
  state, age. "Show N more" after five.
- **Recommend** moving the segmented control, filter chips and source
  warnings below that section or behind a filter button. Keep the "capped at
  60" warning, but only when it is true.
- **Gap**: the iOS code has no notion of a Discord ping today. Notification
  routes are `keir`, `decision`, `alerts` and `feed`. Pings need a server
  feed and a notification category before any of the above applies. A ping
  notification should reuse the decision pattern: Reply as a text action.
- **Recommend** Keir writes ideas in the first person with the reason, as
  Muse does: "I can reply to #1234. The player asked twice since Monday."

### Evidence

- **Recommend** when Keir says it replied to a player, the claim carries a
  receipt card in the chat: channel, the first lines actually posted, time,
  and "View in Discord". If there is no receipt, the card says "No reply
  recorded" in those words, as the ticket screen already does.
- **Recommend** a work card like Muse's Browser card: one verb line while
  running, the blocked state stated plainly ("Blocked · Waiting for your
  approval"), and the card folds into the result bubble when done.
- **Ships and keep**: "A merged PR is not proof that a fix is live" on the
  ticket screen. Muse has nothing comparable; Keir's receipts are stricter
  and should stay.

### Decisions

- **Recommend** reshape `DecisionCard` after FT 0:22.5: icon plus a question
  title ("Post this reply in ticket #1234?"), one plain sentence of what
  happens, a preview of the real payload (the Discord message text and
  channel), then a full-width primary "Approve" above a plain "Decline". The
  reply-or-ask action becomes a text button under them.
- **Recommend** the scope JSON, digest, arguments and the "Approve
  authorizes..." sentence move inside "Review full action and scope". The
  meaning stays; the default view gets shorter.
- **Ships and keep**: approval comes only from the card or the lock-screen
  action, never from a chat "yes". Muse does the same (FT 0:20.5 then
  0:22.5).

### What to hide

Muse shows none of these on its main screens; Keir shows them today:

- model, provider and effort names (composer, voice screen);
- tool names and sources in the work rows;
- raw scope JSON and proposal digests on decision cards;
- per-message author and time headers;
- explanatory sentences that repeat on every card.

Keep them one tap away in Controls, task detail or the disclosure. Do not
hide: what Keir is doing now, what is waiting on the owner, and whether a
player actually got a reply.

## Do not copy

- The five-tab layout and user-built spaces. Keir has one owner and three
  jobs; three tabs stay.
- Avatar personas and costumes (VO, MS brand clips). Keir has one
  recognisable sprite.
- The "Invite" and gift buttons.
- The store gradient and captions.
- Any gesture that the clips do not clearly show, such as swipe actions on
  chat cards.

## Ships vs. recommended, at a glance

| Area | Ships at `da83290` | Recommended |
|---|---|---|
| Status | Separate presence row under the toolbar | One line under Keir's name |
| Avatar tap | Thread list | Activity log, per-item stop, autonomy grant |
| Messages | Bubble plus "Keir · time" header each | Bubble only |
| Composer | Control row with model, tickets, tasks, routing | "+", field, mic, send |
| Decision | Badge, scope JSON, explainer, three buttons in a row | Question title, payload preview, Approve above Decline |
| Work | Tool rows with tool names | One verb line, plain blocked state, folds into result |
| Reply proof | On ticket screen | Also inline in chat as a receipt card |
| Voice | Full-screen cover with model and provider text | In-thread, portrait grows, transcript as bubbles |
| Inbox | Sections, segmented control, five chips | One "Waiting on you" list first |
| Pings | Not modelled | Server feed, notification with Reply |
