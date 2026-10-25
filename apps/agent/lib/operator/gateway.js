"use strict";

const { ticketClaim } = require("./ticketClaim");
const authority = require("./authority");

const { quickQuestion, isQuick } = require("./conversation");
const { ackFacts } = require("./admission");
const { composeAck } = require("./publisher");
const { selfInfo } = require("./selfinfo");

const snowflake = (id) => typeof id === "string" && /^\d{15,22}$/.test(id);
const ticketNumber = (name) => Number(/^ticket-.*-(\d+)$/.exec(name || "")?.[1] || 0);
const acknowledgment = (text) => /^(?:ok(?:ay)?|thanks?(?: you)?|thank you|cheers|got it|understood|sounds good|great|cool|perfect|nice|👍|👌)[.! ,]*$/iu.test(text.trim());
const problem = /\b(bug|broken|error|crash|missing|disappeared|stuck|failed|not loading|not working|lost my|won't load|doesn't work|cannot|can't)\b/i;

const DEBOUNCE_MS = 45000;
const STAFF_HOLD_MS = 10 * 60000;
// A developer's own words asking to put work live (Keir 4.0 sign-off).
const SHIP_WORDS = /\b(ship|promote|release|deploy)\b|\bpush (it|this)\b|\bgo(?:es)? live\b|\bsigned? off\b|\bapproved?\b/i;
function source(message, channel) {
  return { messageId: message.id, channelId: channel.id, channelName: channel.name, authorId: message.author.id,
    author: message.author.global_name || message.author.username, content: (message.content || "").slice(0, 6000),
    at: message.timestamp, replyTo: message.message_reference?.message_id, attachments: (message.attachments || []).slice(0, 10).map((a) => ({ url: a.url, type: a.content_type, name: a.filename })),
    embeds: (message.embeds || []).map((e) => ({ title: e.title, description: e.description, fields: e.fields })).slice(0, 5) };
}

// Discord's after cursor returns the oldest page after the cursor. Commit each
// page only after ingestion, retaining the last committed cursor on failure.
async function catchUp(call, channelId, cursor, ingest, maxPages = 10) {
  let after = cursor;
  for (let page = 0; page < maxPages; page++) {
    const rows = await call("GET", `/channels/${channelId}/messages?after=${after}&limit=100`);
    rows.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    if (!rows.length) break;
    for (const row of rows) await ingest(row);
    after = rows.at(-1).id;
    if (rows.length < 100) break;
  }
  return after;
}

function createGateway({ ledger, config, conversation, drain = () => {}, now = () => Date.now(), observe = null }) {
  const d = ledger.data;
  d.conversations ||= {};
  d.summonedChannels ||= {};
  d.participantLeases ||= {};
  d.participantEvents ||= [];
  function stopTicket(channel, ticket, actor, messageId) {
    const at = now(), selected = new Set(Object.values(d.jobs).filter(j => j.ticket === ticket && j.channelId === channel.id).map(j => j.id));
    let changed;
    do {
      changed = false;
      for (const job of Object.values(d.jobs)) if (selected.has(job.codingParent) && !selected.has(job.id)) { selected.add(job.id); changed = true; }
    } while (changed);
    d.channels[channel.id] = { ...d.channels[channel.id], keirStopped: { by: actor, at, messageId } };
    for (const id of selected) {
      const job = d.jobs[id];
      if (!["done", "cancelled", "dismissed"].includes(job.state)) {
        job.state = "cancelled"; job.updatedAt = at; job.wakeAt = 0;
        job.summary = "Stopped by staff; no further automatic work on this ticket.";
      }
    }
    // Retain receipts and evidence, but withdraw work that has not executed.
    for (const action of Object.values(d.actions)) if (selected.has(action.jobId) && ["pending", "approved"].includes(action.state)) action.state = "withdrawn";
    for (const decision of Object.values(d.decisions || {})) if (selected.has(decision.jobId) && decision.state === "pending") decision.state = "withdrawn";
    for (const entry of Object.values(d.outbox)) if (!entry.deliveredAt && (selected.has(String(entry.destination || "").replace(/^channel:/, "")) || selected.has(d.decisions?.[entry.decision]?.jobId))) {
      entry.deliveredAt = at; entry.skipped = "ticket stopped";
    }
    for (const [id, pending] of Object.entries(d.classify || {})) if (pending.channel?.id === channel.id) delete d.classify[id];
    delete d.conversations[channel.id]; delete d.summonedChannels[channel.id];
    for (const key of Object.keys(d.participantLeases)) if (key.startsWith(`${channel.id}:`)) delete d.participantLeases[key];
    delete d.ticketAuthority?.[ticket]; delete d.shipSignoffs?.[ticket];
    ledger.audit("ticket_stopped", { ticket, actor, message: messageId, jobs: [...selected] });
  }
  function ingest(channel, message, { summonTask, historical = false, classified } = {}) {
    if (!snowflake(message.id) || !message.author) return;
    // Claims are application interaction replies, often carrying webhook_id.
    // Record ownership before filtering ordinary webhook and bot traffic.
    const claimant = !summonTask && ticketNumber(channel.name) && ticketClaim(message, config, d.channels[channel.id]?.claimReleasedAt);
    if (claimant) {
      d.channels[channel.id] = { ...d.channels[channel.id], claimedBy: claimant };
      ledger.save(); return;
    }
    if (message.webhook_id) return;
    conversation?.record(channel, message);
    if (!summonTask && message.author.bot) return;
    const actor = summonTask?.actor || message.author.id;
    const role = actor === config.ownerId ? "owner" : config.staffIds.includes(actor) ? "support" : "player";
    const s = source(message, channel);
    if (summonTask) { s.authorId = actor; s.content = summonTask.content; }
    const nTicket = ticketNumber(channel.name);
    // Keir 5.7: feedback about Keir is logged by a fire-and-forget Jev check.
    if (observe && !historical && !summonTask) Promise.resolve().then(() => observe({ text: s.content, role, actorId: actor, channelId: channel.id, ticket: nTicket || null, messageId: message.id,
      dm: channel.type === 1, mentionsKeir: (message.mentions || []).some((u) => u.id === config.botId) || message.referenced_message?.author?.id === config.botId })).catch(() => {});
    const controlText = s.content.replace(new RegExp(`<@!?${config.botId}>`, "g"), "").replace(/^\s*\/?(?:keir|keith)\b[,:]?/i, "").trim();
    const controlAddress = (channel.type === 1 && role !== "player") || message.referenced_message?.author?.id === config.botId ||
      (message.mentions || []).some(u => u.id === config.botId) || new RegExp(`^\\s*(?:<@!?${config.botId}>|\\/?(?:keir|keith)\\b)`, "i").test(s.content);
    const pauseVerb = /^(?:please\s+)?(pause|resume)(?:\s+(?:this ticket|here|for now|now))?(?:\s+please)?[.!]*$/i.exec(controlText);
    if (!historical && !summonTask && nTicket && role === "owner" && controlAddress && pauseVerb) {
      const key = `discord:${message.id}`;
      if (d.seen[key]) return;
      const paused = pauseVerb[1].toLowerCase() === "pause";
      require("./ticketpause").setPause(ledger, channel.id, nTicket, paused, s, now());
      const notice = ledger.createJob(`ticket-control:${message.id}`, { kind: "notice", role: "owner", ticket: nTicket,
        channelId: channel.id, replyChannel: channel.id, ticketPauseControl: true, source: s });
      notice.state = "done";
      ledger.notify(key, `channel:${notice.id}`, paused ? "Paused. I'll wait for you to say resume." : "Resumed.");
      d.seen[key] = "ticket-control"; ledger.save(); drain(); return;
    }
    if (nTicket && d.channels[channel.id]?.keirPaused) {
      d.seen[`discord:${message.id}`] = "owner-ticket-pause";
      delete d.classify?.[message.id]; ledger.save(); return;
    }
    if (!historical && !summonTask && nTicket && role !== "player" && controlAddress &&
        /^(?:please\s+)?(?:stop|stand down|leave (?:this|the) ticket alone)(?:\s+(?:please|now|here|working|work|this ticket|on this ticket|on this|this|it))?[.!]*$/i.test(controlText)) {
      const key = `discord:${message.id}`;
      if (d.seen[key]) return;
      stopTicket(channel, nTicket, actor, message.id);
      d.seen[key] = "ticket-stop"; ledger.save(); return;
    }
    // Keir 4.0 sign-off: Egg or Ariane saying to ship, in a ticket channel or
    // naming a ticket, is the check-off for that ticket's next live promotion.
    if (!historical && authority.granter(config, actor) && SHIP_WORDS.test(s.content) && authority.isDirection(s.content)) {
      const n = ticketNumber(channel.name) || Number(/\b(1\d{3,4})\b/.exec(s.content)?.[1] || 0);
      if (n) { (d.shipSignoffs ||= {})[n] = { by: actor, messageId: message.id, at: now() }; ledger.audit("ship_signoff_said", { ticket: n, by: actor, message: message.id }); }
    }
    const lease = d.conversations[channel.id];
    const participantKey = `${channel.id}:${actor}`;
    // A developer talking in a channel where Keir is working with them, or just
    // spoke, is continuing that conversation even without naming Keir.
    const developerThread = role !== "player" && channel.type !== 1 &&
      Object.values(d.jobs).some((j) => j.channelId === channel.id && j.actorId === actor && ["command", "conversation"].includes(j.kind) && !["done", "cancelled", "dismissed"].includes(j.state));
    const continuation = (lease?.actorId === actor && lease.until > now()) || developerThread || (role === "player" && d.participantLeases[participantKey] > now());
    const reply = message.referenced_message?.author?.id === config.botId;
    // Explicit address starts work. An unaddressed follow-up can only feed a
    // task that is already open; it never starts one or earns an acknowledgment.
    // Only a mention, a reply to Keir or a developer DM is unambiguous. "Keith is
    // hallucinating" starts with the name too, so name-led text goes to the classifier.
    const identityQuestion = /^\s*are you\s+(?:(?:really|actually|the real)\s+)?(?:keir|keith|starmer)(?:\s+starmer)?\s*[?!.]*\s*$/i.test(s.content);
    // "/keir status" typed in Discord with no registered slash command arrives
    // as plain text; it addresses Keir exactly like "Keir status".
    const slashAddress = /^\s*\/(?:keir|keith)\b/i.test(s.content);
    let explicit = Boolean(identityQuestion || slashAddress || summonTask || reply || (channel.type === 1 && role !== "player") || (message.mentions || []).some((u) => u.id === config.botId) ||
      /^\s*(?:keir|keith)\s*[,:]/i.test(s.content) || /^\s*(?:keir|keith)\s+(?:status|pause|resume|cancel|approve|reject)\b/i.test(s.content));
    // A prior conversation or classifier verdict cannot turn staff-to-player
    // chat into a command after staff takes the ticket or tells Keir to stop.
    if (!historical && nTicket && (d.channels[channel.id]?.claimedBy || d.channels[channel.id]?.keirStopped) && !explicit) {
      d.seen[`discord:${message.id}`] = "staff-ticket-conversation";
      delete d.classify?.[message.id]; ledger.save(); return;
    }
    if (!historical && nTicket && d.channels[channel.id]?.keirStopped && role === "player") {
      d.seen[`discord:${message.id}`] = "ticket-stopped"; ledger.save(); return;
    }
    if (!historical && explicit && nTicket && authority.granter(config, actor) && authority.isDirection(s.content)) {
      delete d.channels[channel.id]?.keirStopped;
      // Keir 5.7.1: the owner telling Keir to work a ticket marks it owner
      // directed (lifts the moderation/incident stand-down) and releases the
      // owner's own claim. Staff claims stay with staff.
      if (actor === config.ownerId) {
        d.channels[channel.id] = { ...d.channels[channel.id], ownerDirectedAt: now() };
        ledger.audit("owner_directed_ticket", { ticket: nTicket, message: message.id });
        // A ticket job stood down as moderation/incident comes back to life.
        const stood = d.jobs[d.seen[`ticket:${nTicket}`]];
        if (stood && stood.state === "cancelled" && /^(Moderation|Incident) ticket/.test(stood.summary || "")) { stood.state = "queued"; stood.wakeAt = 0; }
      }
      if (actor === config.ownerId && d.channels[channel.id]?.claimedBy === config.ownerId) {
        d.channels[channel.id] = { ...d.channels[channel.id], claimReleasedAt: now() };
        delete d.channels[channel.id].claimedBy;
        ledger.audit("owner_claim_released", { ticket: nTicket, by: "owner-message", message: message.id });
        const held = d.jobs[d.seen[`ticket:${nTicket}`]];
        if (held && held.state === "deferred") { held.state = "queued"; held.wakeAt = 0; }
      }
    }
    // Players get conversational replies only in ticket channels or where a
    // developer has opened the channel (/summon start, or open_channel for a time).
    const grant = d.summonedChannels[channel.id];
    const summoned = Boolean(grant && (!grant.until || grant.until > now()));
    // Not clearly addressed but plausibly for Keir: a fast classifier reads the
    // channel and decides, instead of guessing from timers.
    const recentKeir = (conversation?.lastAssistantAt?.(channel.id) || 0) > now() - 30 * 60000;
    // In a ticket channel the ticket's own task is the only voice: player
    // messages go to it directly, never to a separate quick conversation.
    const playerVenue = summoned && !ticketNumber(channel.name);
    const ambiguous = !explicit && !historical && !summonTask && channel.type !== 1 && (role !== "player" || playerVenue) &&
      (/\b(?:keir|keith|starmer)\b/i.test(s.content) || continuation || recentKeir);
    const text = s.content.replace(new RegExp(`<@!?${config.botId}>`, "g"), "").replace(/^\s*\/?(?:keir|keith)\b[,:]?/i, "").trim();
    // A mention-only nudge may refer to the author's immediately preceding
    // unanswered read-only question, never to older action requests or another user.
    let addressedText = text;
    if (explicit && !text && role !== "player" && !s.attachments.length && !s.embeds.length) {
      const prior = (conversation?.snapshot({ source: { channelId: channel.id } })?.messages || []).filter(r => r.id !== message.id).at(-1);
      const age = prior ? Date.parse(message.timestamp) - Date.parse(prior.at) : Infinity;
      if (prior?.authorId === actor && age >= 0 && age <= 5 * 60000 && quickQuestion(prior.content)) {
        s.content = prior.content; s.contextMessageId = prior.id; addressedText = prior.content;
      } else {
        s.content = "Are you there?"; addressedText = s.content;
      }
    }
    const key = `discord:${message.id}`;
    if (d.seen[key]) return;
    // Keir 4.2: Egg (or Ariane) telling Keir to work a ticket is that
    // ticket's one yes; later non-huge steps do not ask again.
    if (!historical && explicit && authority.granter(config, actor) && authority.isDirection(s.content || "")) {
      const n = ticketNumber(channel.name) || Number(/\bticket\s*#?(1\d{3,4})\b/i.exec(s.content)?.[1] || 0);
      if (n && authority.grant(d, config, n, { by: actor, messageId: message.id, how: "directed", at: now() })) ledger.audit("ticket_authority_granted", { ticket: n, by: actor, message: message.id, how: "directed" });
    }
    // Staff talking in a ticket without naming Keir are handling it: hold the
    // ticket's task for ten minutes so Keir does not talk over them.
    const heldTicket = !historical && role !== "player" && ticketNumber(channel.name) && !explicit && !/\b(?:keir|keith|starmer)\b/i.test(s.content || "") && d.jobs[d.seen[`ticket:${ticketNumber(channel.name)}`]];
    if (heldTicket && !["done", "cancelled"].includes(heldTicket.state)) {
      heldTicket.staffActiveUntil = now() + STAFF_HOLD_MS;
      if (heldTicket.state === "waiting" && !heldTicket.addressedPending) heldTicket.wakeAt = Math.max(heldTicket.wakeAt || 0, heldTicket.staffActiveUntil);
      ledger.save();
    }
    // "itch test" in a DM switches on the inbox's reward-claim test mode; the
    // inbox answers it, so the operator stays out of that one message.
    if (channel.type === 1 && /^\s*itch\s*test\b/i.test(s.content || "") && !s.attachments.length) { d.seen[key] = "itch-test"; ledger.save(); return; }
    if (!historical && (explicit || ambiguous) && acknowledgment(text) && !summonTask && !s.attachments.length && !s.embeds.length) {
      d.seen[key] = "acknowledgment"; ledger.save(); return;
    }
    if (ambiguous && classified === undefined) {
      d.classify ||= {};
      d.classify[message.id] ||= { channel: { id: channel.id, name: channel.name, type: channel.type }, message, at: now() };
      ledger.save(); return;
    }
    if (classified === true) explicit = true;
    const trigger = explicit;
    if (!historical && role === "player" && trigger && channel.type !== 1 && summoned && !ticketNumber(channel.name)) {
      // A participant's words are evidence in their own low-authority task.
      // Never append them to an owner task or inherit its approval context.
      d.participantEvents = d.participantEvents.filter((e) => e.at > now() - 5 * 60000);
      const recent = d.participantEvents.filter((e) => e.actor === actor);
      if (recent.length >= 8) { d.seen[key] = "conversation-rate-limited"; ledger.save(); return; }
      d.participantEvents.push({ actor, at: now() });
      const live = Object.values(d.jobs).find((j) => j.kind === "conversation" && j.channelId === channel.id && j.actorId === actor && ["queued", "running", "waiting"].includes(j.state));
      let job = live;
      if (job) { d.seen[key] = job.id; (job.inbox ||= []).push(s); delete job.waitingFor; if (job.state === "waiting") job.state = "queued"; }
      else job = ledger.createJob(key, { kind: "conversation", role: "player", actorId: actor, channelId: channel.id, replyChannel: channel.id, ticket: ticketNumber(channel.name), source: s, deadline: now() + config.taskLifetimeMs });
      d.participantLeases[participantKey] = now() + 20 * 60000;
      const ticketJob = d.jobs[d.seen[`ticket:${job.ticket}`]];
      if (ticketJob && !["done", "cancelled"].includes(ticketJob.state)) {
        (ticketJob.inbox ||= []).push(s); delete ticketJob.waitingFor; delete ticketJob.resolutionReadyAt;
        if (ticketJob.state === "waiting") ticketJob.state = "queued";
      }
      if (!job.ticket && config.watched(channel)) {
        (d.screen ||= {})[message.id] ||= { key: `candidate:${message.id}`, actor, channel: { id: channel.id, name: channel.name, type: channel.type }, source: s, at: now() };
      }
      ledger.save(); return;
    }
    if (!historical && trigger && role !== "player") {
      if (role === "owner" && message.content.trim().startsWith("/") && !/^\/(?:keir|keith)\b/i.test(message.content.trim())) {
        const controls = require("./appcontrols").createControls({ ledger, config, now, drain });
        try {
          const result = controls.command(message.content.trim());
          if (result) { d.seen[key] = "control"; ledger.notify(key, actor, result.text, { controlResponse: true }); ledger.save(); return; }
        } catch (error) {
          if (!error.status) throw error;
          d.seen[key] = "control"; ledger.notify(key, actor, error.message); ledger.save(); return;
        }
      }

      let control = /^(status|pause|resume|cancel|approve|reject)\b(?:\s+(\w+))?\s*$/i.exec(text);
      if (control && ["approve", "reject", "cancel"].includes(control[1].toLowerCase()) && !control[2]) {
        // A bare "approve" answers the single pending request in this conversation;
        // otherwise it is an ordinary reply for the task to read.
        const pending = Object.values(d.actions).filter((a) => a.state === "pending" && d.jobs[a.jobId]?.channelId === channel.id && d.jobs[a.jobId]?.actorId === actor);
        control = control[1].toLowerCase() !== "cancel" && pending.length === 1 ? [control[0], control[1], pending[0].id] : null;
      }
      if (control) {
        d.seen[key] = "control";
        const verb = control[1].toLowerCase(), target = control[2];
        const developerHealDecision = ["approve", "reject"].includes(verb) && d.actions[target]?.kind === "heal" && role === "support" && authority.granter(config, actor);
        if (role !== "owner" && verb !== "status" && !developerHealDecision) {
          ledger.notify(key, actor, `${verb} requires the owner.`);
        } else if (verb === "status") {
          const active = Object.values(d.jobs).filter((j) => (role === "owner" || j.actorId === actor) && !["done", "cancelled", "dismissed"].includes(j.state));
          let running = ""; try { running = `${selfInfo(config).sentence}\n`; } catch { /* version facts unavailable */ }
          // Keir 5.0 scorecard: problems Keir found before any player did.
          const sc = d.watch?.score, open = Object.values(d.watch?.findings || {}).filter((f) => f.state !== "resolved");
          if (d.watch?.headline) running += `${d.watch.headline}\n`;
          else if (sc || open.length) running += `Watch: ${open.length} open findings. Caught first ${sc?.caughtFirst || 0}, player first ${sc?.playerFirst || 0}.\n`;
          if (role !== "player" && d.watch) {
            const w = d.watch;
            running += `Watch mode: ${w.mode || "active"}. ` + Object.keys(require("./watch").CADENCE).map((name) => `${name}: ${w.errors?.[name] ? "failing" : w.succeeded?.[name] ? `${Math.max(0, Math.floor((now() - w.succeeded[name]) / 60000))}m since success` : "no successful run"}`).join("; ") + ".\n";
          }
          ledger.notify(key, role === "owner" ? "owner" : actor, `${running}Operator ${d.paused ? "paused" : "active"}. ${active.length} open tasks.\n${active.slice(0, 15).map((j) => `${j.id}: ${j.state}, ${j.summary || j.source?.content?.slice(0, 120) || j.kind}`).join("\n")}`);
        } else if (verb === "pause" || verb === "resume") {
          d.paused = verb === "pause";
          if (verb === "resume" && d.control) d.control.stopped = false;
          drain();
          ledger.audit(verb, { actor, message: message.id });
          ledger.notify(key, "owner", `Operator ${verb === "pause" ? "paused; active execution is being stopped" : "resumed"}.`);
        } else if (verb === "cancel") {
          const job = d.jobs[target];
          if (job) {
            job.state = "cancelled"; job.updatedAt = now();
            if (d.conversations[job.channelId]?.actorId === actor) delete d.conversations[job.channelId];
            ledger.audit("cancelled", { job: target, actor });
          }
          ledger.notify(key, "owner", job ? `Cancelled task ${target}.` : `Unknown task ${target}.`);
        } else {
          const action = d.actions[target], job = action && d.jobs[action.jobId];
          if (!action || action.state !== "pending" || !job || job.state === "cancelled" || action.expiresAt < now()) {
            ledger.notify(key, "owner", "That action is absent, expired or already handled.");
          } else {
            action.state = verb === "approve" ? "approved" : "rejected";
            // Ariane may approve without being asked (owner, 2026-10-14); her
            // yes carries the owner's authority, recorded as on his behalf.
            const delegate = actor !== config.ownerId && config.staffIds.slice(0, 1).includes(actor);
            action.approvedBy = delegate ? config.ownerId : actor; action.approvalMessage = message.id; action.approvedAt = Date.now();
            if (delegate) action.approvedOnBehalfBy = actor;
            if (verb === "reject") {
              const n = job.ticket || ticketNumber(job.source?.channelName);
              if (n) delete d.ticketAuthority?.[n];
            }
            if (verb === "approve") {
              const n = job.ticket || ticketNumber(job.source?.channelName);
              if (n && authority.grant(d, config, n, { by: actor, messageId: message.id, how: "approved", at: Date.now() })) ledger.audit("ticket_authority_granted", { ticket: n, by: actor, action: target, how: "approved" });
            }
            // The DM copies of the same request are answered too; the decision pass deletes them.
            for (const x of Object.values(d.decisions || {})) if (x.actionId === target && x.state === "pending") { x.state = verb; x.answeredBy = actor; x.answeredAt = Date.now(); }
            job.state = "queued"; job.summary = `Authenticated ${role === "owner" ? "owner" : "developer"} ${verb}d action ${target}.`;
            ledger.audit(verb, { action: target, actor, message: message.id });
          }
        }
        ledger.save(); return;
      }
      if (!addressedText) return;
      if (summonTask && channel.type !== 1) d.summonedChannels[channel.id] = { actorId: actor, at: now() };
      d.conversations[channel.id] = { actorId: actor, until: now() + 20 * 60000, startedAt: now() };
      const quick = !summonTask && quickQuestion(addressedText);
      const live = Object.values(d.jobs).find((j) => isQuick(j) === quick && j.channelId === channel.id && j.role === role && j.actorId === actor && !["done", "dismissed", "cancelled"].includes(j.state));
      if (!live && !explicit) {
        const open = Object.values(d.jobs).find((j) => ["command", "conversation"].includes(j.kind) && j.channelId === channel.id && j.actorId === actor && !["done", "dismissed", "cancelled"].includes(j.state));
        if (!open) { d.seen[key] = "ambient"; ledger.save(); return; }
        d.seen[key] = open.id; (open.inbox ||= []).push(s); delete open.waitingFor;
        if (["waiting", "blocked"].includes(open.state)) open.state = "queued";
        ledger.save(); return;
      }
      if (live) {
        if (channel.type !== 1) live.replyChannel = channel.id;
        d.seen[key] = live.id; (live.inbox ||= []).push(s); delete live.waitingFor;
        if (["waiting", "blocked"].includes(live.state)) live.state = "queued";
      } else {
        const job = ledger.createJob(key, { kind: quick ? "conversation" : "command", role, actorId: actor, channelId: channel.id, ...(channel.type !== 1 ? { replyChannel: channel.id } : {}), ticket: ticketNumber(channel.name), source: s, deadline: now() + config.taskLifetimeMs });
        // The model writes a specific one-line acknowledgement as its first step.
        if (!quick && job.replyChannel) job.needsAck = true;
        // Keir 3.0: when no slot is free the request would sit unacknowledged
        // until one frees. Say so at once, truthfully, with its place in line;
        // the model's specific line later replaces this same message.
        if (job.replyChannel) queuedAck(job);
      }
      ledger.save(); return;
    }
    const n = ticketNumber(channel.name);
    if (n) {
      // Only the ticket bot's "has claimed this ticket" message is a claim (handled
      // above). A developer chatting or joking in a ticket never hands it off.
      if (d.channels[channel.id]?.claimedBy) return;
      // Moderation tickets belong to the moderators; Keir stays out of them.
      // Incidents are staff-owned catch-alls; merged players post there too.
      // Anyone who names Keir in an incident gets an answer: players merged
      // into incident 1600 asked Keir directly and waited about 21 hours.
      const cat = d.channels[channel.id]?.category;
      const named = new RegExp(`\\b(?:keir|keith|starmer)\\b|<@!?${config.botId}>`, "i").test(s.content || "");
      if ((cat === "moderation" || (cat === "incident" && !named)) && !d.channels[channel.id]?.ownerDirectedAt) { d.seen[key] = `${cat}-ticket`; ledger.save(); return; }
      const keyTicket = `ticket:${n}`;
      let job = d.jobs[d.seen[keyTicket]];
      if (!job) job = ledger.createJob(keyTicket, { kind: "ticket", role: "support", ticket: n, channelId: channel.id, source: s, deadline: now() + config.taskLifetimeMs });
      // An incident job is cancelled on adoption (staff own it); a message
      // naming Keir brings it back for that conversation.
      if (job.state === "cancelled" && cat === "incident" && named && !job.channelClosed) { job.state = "queued"; ledger.audit("incident_named", { job: job.id, ticket: n }); }
      if (job.state === "cancelled" || job.channelClosed) return;
      // A finished ticket whose channel is still open is reopened when the player
      // writes again; before, their message was silently dropped.
      if (["done", "dismissed"].includes(job.state) && role !== "player") return;
      if (job.state === "done") { delete job.resolutionReadyAt; job.resolved = false; ledger.audit("ticket_reopened", { job: job.id, ticket: n }); }
      d.seen[key] = job.id;
      (job.inbox ||= []).push(s); delete job.waitingFor;
      // A player reply reopens the question: no closure until it is answered.
      if (role === "player") delete job.resolutionReadyAt;
      // Keir 4.1.10 (owner): a burst of chat is one run, not one per message,
      // and while staff are talking in a ticket Keir keeps quiet for ten
      // minutes unless someone addresses it (ticket 1550 woke sixteen times in
      // twelve minutes while Ariane and the player talked).
      const addressed = new RegExp(`\\b(?:keir|keith|starmer)\\b|<@!?${config.botId}>`, "i").test(s.content || "");
      if (role !== "player" && !addressed) job.staffActiveUntil = now() + STAFF_HOLD_MS;
      // A message that names Keir is answered promptly; later chatter that does
      // not name Keir must not push that wake back behind the staff hold
      // (ticket 1602: "Why can't I sell it Keith" sat ten minutes).
      if (addressed) job.addressedPending = true;
      if (["waiting", "dismissed", "done"].includes(job.state)) {
        job.state = "waiting";
        const hold = !job.addressedPending && (job.staffActiveUntil || 0) > now() ? job.staffActiveUntil : 0;
        const wake = Math.max(now() + DEBOUNCE_MS, hold);
        job.wakeAt = job.addressedPending && job.debounceWake && job.wakeAt ? Math.min(job.wakeAt, wake) : wake; job.debounceWake = true;
      }
      ledger.save(); return;
    }
    // Every player post in a public channel is screened by the fast classifier;
    // only a "yes" or an unsure verdict becomes a candidate task.
    if (!historical && role === "player" && config.watched(channel) && (s.content.trim().length >= 4 || s.attachments.length)) {
      (d.screen ||= {})[message.id] ||= { key, actor, channel: { id: channel.id, name: channel.name, type: channel.type }, source: s, at: now() };
      ledger.save();
    }
  }
  function queuedAck(job) {
    const facts = ackFacts(Object.values(d.jobs), job, { now: now() });
    if (facts.startingNow) return;
    ledger.notify(`ack:${job.id}`, `channel:${job.id}`, composeAck({ ...facts, nextAction: "attempt" }));
  }
  return { ingest };
}
module.exports = { catchUp, createGateway, source, snowflake, ticketNumber, problem, acknowledgment };
