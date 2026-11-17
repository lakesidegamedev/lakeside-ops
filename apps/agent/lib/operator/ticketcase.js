"use strict";
// Keir 10.3 durable ticket case file. Keir runs a ticket as many short activations, each starting with no memory of what
// the last one said. Ticket 1852 (2026-11-17): "your cards are reachable", then "not reachable", a wrong claim repeated,
// and the owner's "I'm fixing" ignored. This module keeps one compact, dated record per ticket in the ledger
// (d.ticketCases[ticket]) and renders it at the top of every activation:
//   claims      every substantive statement posted to the player, the evidence it rested on, and its status
//               (standing | corrected | withdrawn), so a reversal is visible and must be marked
//   promises    what Keir said it would do or report next, and whether it happened
//   staff       owner and staff statements in the channel ("I'm fixing", a decision)
//   fix         who is on it (plain role words), the card, pull request and stage
//   open        questions still unanswered, in both directions
//   asked       what the player actually asked or complained about (ticket text, then each later message that states a
//               problem or asks something), with whether a post has answered it. Rendered first. Keir 10.4 (ticket 1852:
//               the player reported a tech cap that makes research useless, Keir answered about research points, the
//               player voted it down "this is not what i asked about"): the deflection gate (deflection) refuses a post
//               that redirects or concludes without touching any open asked item.
// It is written from the delivery path (recordPost), deterministically from the posted text and the reads of the
// activation, with no second model call. The contradiction gate (contradiction) shares the claim reader so what is
// recorded and what is checked can never disagree. Pure functions over the ledger data; nothing here throws.

const CAP_CHARS = 2000;
const MAX_ASKED = 8, MAX_SAID = 6, MAX_ASKED_REFUSALS = 2;
const MAX_CLAIMS = 40, MAX_PROMISES = 12, MAX_STAFF = 10, MAX_QUESTIONS = 10, MAX_CLAIMS_PER_POST = 6;
const KEEP_MS = 30 * 86400000;

const STOP = new Set(("a an the this that these those it its is are was were be been being am do does did has have had will would shall should can could may might must " +
  "to of in on at for from by with as and or but if so than then there here you your yours we our i my me they them their he she his her us " +
  "up out off over into onto about after before until when while which who whom what whose how why all any some one two three more most very just also " +
  "now currently right still yet already again too only even really actually keir player ticket issue problem thing things because since so no nothing none without neither nor nobody longer").split(/\s+/));
// Predicate negators only. A bare "no" ("it has no coal supplier") negates a noun, not the claim, and flipping on it
// refused a harmless paraphrase in the first test run; "no longer" is the one "no" that negates the predicate.
const NEG = new Set("not never cannot cant isnt arent wasnt werent wont dont doesnt didnt unable hasnt havent hadnt".split(" "));
// Words whose meaning is the negation of a plain word. Mapped to that word with the polarity flipped, so
// "unreachable" and "not reachable" read the same and "reachable" is their opposite.
// Only clear antonyms: words like "wrong" or "missing" also appear in explanations ("I read the wrong record") and would flip a claim.
const ANTI = { unreachable: "reachable", unavailable: "available", unable: "able", impossible: "possible", locked: "unlocked", disabled: "enabled",
  invisible: "visible", hidden: "visible", inaccessible: "accessible", unfixed: "fixed", unresolved: "resolved", inactive: "active", unsupported: "supported" };
const HEDGE = /\b(?:may|might|could|possibly|perhaps|probably|seems?|appears?|looks like|i think|i believe|not sure|unsure|likely|should be|suspect)\b/i;
const PROMISE = /\b(?:i(?:'|’)?ll|i will|we(?:'|’)?ll|we will|i(?:'|’)?m going to|i am going to|will (?:report|update|let you know|post|check|come back|follow up|confirm|tell you|get back)|i(?:'|’)?ll (?:keep|come back|follow up|report|check))\b/i;
const CORRECTION = /^\s*(?:correction|to correct my (?:last|previous|earlier) message)\b/i;
const WITHDRAW = /\b(?:withdraw|withdrawn|disregard|retract|ignore (?:what i|my (?:last|earlier|previous))|was wrong|were wrong|mistaken|i got that wrong|that was incorrect)\b/i;
const FIXING = /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are|i(?:'|’)?ll|i will|on it|looking into|working on|fixing|patching|deploying|shipping|will fix)\b[^.!?\n]{0,60}\b(?:fix|fixing|patch|it|this|that|looking|working|deploy|ship|handle|sort|address|build)\b|\bi(?:'|’)?m (?:on|fixing|handling)\b|\bon it\b/i;

const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const stamp = (at) => { const n = typeof at === "number" ? at : Date.parse(at || ""); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(5, 16).replace("T", " ") : "?"; };
const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

// One sentence as a claim: polarity and subject words. Null when it is a question, a hedge, a promise or too thin.
function readClaim(sentence) {
  const s = String(sentence || "").trim();
  if (!s || s.endsWith("?") || s.length < 12 || s.length > 320 || HEDGE.test(s) || PROMISE.test(s) || CORRECTION.test(s)) return null;
  let negs = 0;
  const words = new Set();
  // The claim is the first clause; a tail like ", I read the wrong record" explains it.
  const clause = s.split(/,\s+(?:i|we)\s/i)[0].replace(/\bno longer\b/gi, () => { negs++; return " "; });
  for (const raw of clause.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean)) {
    if (NEG.has(raw)) { negs++; continue; }
    let w = raw;
    if (ANTI[w]) { negs++; w = ANTI[w]; }
    if (STOP.has(w)) continue;
    if (w.length > 2 || /^\d+$/.test(w)) words.add(stem(w));
  }
  if (words.size < 2) return null;
  return { pol: negs % 2 ? "neg" : "pos", words };
}

// Same subject: the smaller word set is mostly inside the larger and the larger is not mostly something else. Two shared words minimum.
function sameSubject(a, b, ratio = 0.6, maxRatio = 0.5) {
  const A = a instanceof Set ? a : new Set(a), B = b instanceof Set ? b : new Set(b);
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 2 && shared / Math.min(A.size, B.size) >= ratio && shared / Math.max(A.size, B.size) >= maxRatio;
}

// Deterministic "this message states a problem or asks something": a question mark or a problem phrase.
const ASK_SIGNAL = /\?|\bdoes(?:n['’]?t| not) (?:do|work|help|show|change|count|apply|update|appear|matter)\b|\b(?:does|do|did) nothing\b|\bnothing happens\b|\bcan['’]?t\b|\bcannot\b|\bunable to\b|\bbroken\b|\bwrong\b|\bnot working\b|\bwon['’]?t\b|\bstuck\b|\bwhy\b|\bno effect\b|\buseless\b|\bbug\b|\bincorrect\b|\bmissing\b/i;
// A post that steers away from the question (redirect) or closes it without answering (conclude).
const REDIRECT = /\b(?:real (?:blocker|issue|problem|cause)|(?:the )?actual (?:problem|issue|blocker|cause)|what matters(?: here)? is|instead|rather than|the bigger (?:issue|problem))\b/i;
const CONCLUDE = /\b(?:no fix (?:is )?(?:needed|required|necessary)|nothing to fix|working as (?:intended|designed)|by design|the game(?:'|’)?s (?:own )?rule)\b/i;

// Subject words of a free text: the same tokenising as readClaim, without polarity.
function subjectWords(text) {
  const words = new Set();
  for (const raw of String(text || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean)) {
    if (NEG.has(raw)) continue;
    const w = ANTI[raw] || raw;
    if (STOP.has(w)) continue;
    if (w.length > 2 || /^\d+$/.test(w)) words.add(stem(w));
  }
  return words;
}
// Does a post (its subject words) address this asked item? sameSubject with the larger-set ratio off: a long answer still counts.
const addresses = (postWords, item) => sameSubject(postWords, new Set(item.w || []), 0.5, 0);

function store(d) { return (d.ticketCases ||= {}); }
function blank(ticket) { return { ticket: Number(ticket), claims: [], promises: [], staff: [], questions: [], asked: [], said: [], askedRefusals: 0, fix: null, touchedAt: 0, scan: 0 }; }
function get(d, ticket, { create = false } = {}) {
  const all = d?.ticketCases;
  const key = String(ticket);
  if (!all?.[key]) { if (!create) return null; store(d)[key] = blank(ticket); }
  return all?.[key] || store(d)[key];
}

// Record what the player asked. Returns true when a new item was added. Thin or signal-free text is not an ask.
function addAsked(c, text, at) {
  const full = String(text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (full.length < 12 || !ASK_SIGNAL.test(full)) return false;
  const w = [...subjectWords(full)].slice(0, 16);
  if (w.length < 2) return false;
  c.asked ||= [];
  const key = clip(full, 80);
  if (c.asked.some((x) => clip(x.text, 80) === key)) return false;
  c.asked.push({ at, text: clip(full, 220), w, answeredAt: null });
  return true;
}

// The newest reads of this activation as a short label: "trace_corp, support_get; 3412". Tool names and the first figure of the
// claim that also appears in what was read. No result text is kept.
function evidenceFor(d, job, sentence, { since = 0 } = {}) {
  try {
    const rows = (d.ticketObservations?.[job.ticket] || []).filter((o) => (o.at || 0) >= since).slice(-4);
    const tools = [...new Set(rows.map((o) => { let inner = ""; try { inner = JSON.parse(o.input || "{}").tool || ""; } catch { /* input is only a label */ } return clip(inner || o.tool, 30); }).filter(Boolean))].slice(-3);
    const figure = (String(sentence).match(/\d[\d,]*(?:\.\d+)?%?/g) || []).find((n) => n.replace(/\D/g, "").length >= 2 && (rows.some((o) => String(o.result || "").includes(n.replace(/,/g, ""))) || String(job.evidenceText || "").includes(n.replace(/,/g, ""))));
    if (!tools.length && !figure) return "";
    return clip(`${tools.join(", ")}${figure ? `; ${figure}` : ""}`, 70);
  } catch { return ""; }
}

// Delivery path: every player-visible post lands here. Records claims and promises, closes promises it fulfils and
// player questions it answers, and, when the post is a "Correction:", marks the standing claims it reverses.
function recordPost(d, job, message, { now = Date.now(), card = false } = {}) {
  try {
    if (card || !job?.ticket) return null;
    const text = String(message || "").trim();
    if (!text) return null;
    const c = get(d, job.ticket, { create: true });
    const correction = CORRECTION.test(text);
    const since = job.startedAt || job.lastRunStartedAt || now - 20 * 60000;
    const sentences = sentencesOf(correction ? text.replace(/^\s*(?:correction|to correct my (?:last|previous|earlier) message)\s*[:,.-]?\s*/i, "") : text);
    const made = [];
    for (const s of sentences) {
      const claim = readClaim(s);
      if (claim && !(correction && WITHDRAW.test(s)) && made.length < MAX_CLAIMS_PER_POST) made.push({ s, claim });
    }
    // A correction reverses standing claims on the same subject; a plain withdrawal ("disregard that") retires them.
    if (correction) {
      const withdraws = WITHDRAW.test(text);
      for (const old of c.claims) {
        if (old.status !== "standing") continue;
        const sameWords = new Set(old.w);
        const flip = made.find((m) => m.claim.pol !== old.pol && sameSubject(m.claim.words, sameWords));
        if (flip) { old.status = "corrected"; old.by = clip(flip.s, 140); old.byAt = now; continue; }
        if (withdraws && sentences.some((s) => { const r = readClaim(s) || { words: new Set(String(s).toLowerCase().split(/\W+/).map(stem)) }; return sameSubject(r.words, sameWords); })) {
          old.status = "withdrawn"; old.by = clip(text, 140); old.byAt = now;
        }
      }
    }
    for (const { s, claim } of made) {
      const dup = c.claims.find((x) => x.status === "standing" && x.pol === claim.pol && sameSubject(claim.words, new Set(x.w)));
      if (dup) { dup.at = now; dup.text = clip(s, 150); continue; }
      c.claims.push({ id: `c${(c.seq = (c.seq || 0) + 1)}`, at: now, text: clip(s, 150), pol: claim.pol, w: [...claim.words].slice(0, 14), ev: evidenceFor(d, job, s, { since }), status: "standing" });
    }
    // Promises made, and earlier promises this post keeps.
    const kept = [];
    for (const s of sentences) {
      if (PROMISE.test(s) && !s.endsWith("?")) {
        if (!c.promises.some((p) => !p.doneAt && clip(p.text, 60) === clip(s, 60))) kept.push({ at: now, text: clip(s, 150) });
      } else {
        const r = readClaim(s);
        if (r) for (const p of c.promises) if (!p.doneAt && p.at < now && sameSubject(r.words, new Set(p.w || []), 0.4, 0)) { p.doneAt = now; }
      }
    }
    for (const p of kept) c.promises.push({ ...p, w: [...(readClaim(p.text.replace(PROMISE, " ")) || { words: new Set() }).words].slice(0, 12) });
    for (const s of sentences) if (s.endsWith("?") && s.length > 8 && !c.questions.some((q) => !q.closedAt && q.by === "keir" && clip(q.text, 50) === clip(s, 50))) c.questions.push({ at: now, by: "keir", text: clip(s, 150) });
    // A substantive post answers the player's questions asked before it.
    if (made.length) for (const q of c.questions) if (q.by === "player" && !q.closedAt && q.at < now) q.closedAt = now;
    // A substantive post that addresses an open asked item answers it. A post that touches no asked item answers none.
    if (made.length && c.asked?.length) {
      const postWords = new Set(made.flatMap((m) => [...m.claim.words]));
      for (const a of c.asked) if (!a.answeredAt && a.at <= now && addresses(postWords, a)) { a.answeredAt = now; a.answeredBy = clip(made[0].s, 80); }
    }
    c.touchedAt = now;
    trim(c);
    return c;
  } catch { return null; }
}

// Pull what the channel and the ledger know that no post records: owner and staff statements, the player's questions,
// and the fix status. Called at activation start. Cheap and idempotent (statements are de-duplicated).
function syncActivation(d, job, { now = Date.now(), ownerId = null, botId = null } = {}) {
  try {
    if (!job?.ticket) return null;
    const c = get(d, job.ticket, { create: true });
    const rows = [...(d.channelContext?.[job.channelId || job.replyChannel] || []), ...(job.requestInbox || []), ...(job.inbox || [])];
    // The ticket's own opening text (title and description) is the first thing the player asked.
    const src = job.source;
    if (src && src.role !== "owner" && src.role !== "support" && src.authorId !== botId && !(ownerId && src.authorId === ownerId)) {
      const head = [src.content, ...(src.embeds || []).map((e) => [e?.title, e?.description].filter(Boolean).join(". "))].filter(Boolean).join(". ");
      addAsked(c, head, Date.parse(src.at || "") || now);
    }
    for (const m of rows) {
      if (!m || m.role === "assistant" || m.authorId === botId || m.investigationResult || m.codingResult) continue;
      const at = Date.parse(m.at || "") || m.observedAt || 0;
      const text = clip(m.content, 400);
      if (!text) continue;
      const isOwner = m.role === "owner" || (ownerId && m.authorId === ownerId);
      const staff = isOwner || m.role === "support" || m.role === "moderator";
      if (staff && !/^(?:developer-watch|system|dev-merges|turn-watch|sweeper|engineering-followup)$/.test(String(m.authorId || "")) && m.role !== "system") {
        const who = isOwner ? "the owner" : "staff";
        if (!c.staff.some((x) => x.who === who && clip(x.text, 80) === clip(text, 80))) c.staff.push({ at: at || now, who, text: clip(text, 200) });
        if (FIXING.test(text)) c.fix = { ...(c.fix || {}), who: isOwner ? "the owner" : "staff", stage: c.fix?.stage || "being worked on", said: clip(text, 100), at: at || now };
      } else if (m.role === "player" || (!staff && m.role !== "system")) {
        addAsked(c, text, at || now);
        for (const s of sentencesOf(text)) if (s.endsWith("?") && s.length > 8 && !c.questions.some((q) => q.by === "player" && clip(q.text, 50) === clip(s, 50))) c.questions.push({ at: at || now, by: "player", text: clip(s, 150) });
      }
    }
    // Fix status from the ledger: developers' cards, Keir's own coding work, pull requests.
    const raised = (job.raisedToDevelopers || []).slice(-3);
    const children = Object.values(d.jobs || {}).filter((j) => j.codingParent === job.id && !["cancelled", "dismissed"].includes(j.state));
    const prs = [...new Set([...(job.pullRequests || []), ...children.flatMap((j) => j.pullRequests || [])].map((p) => String(p?.number || p?.pr || p).split("/").pop()).filter((x) => /^\d+$/.test(x)))].slice(-3);
    const card = (d.statusCards?.[job.ticket]?.items || [])[0];
    const who = children.length ? "Keir's coding worker" : raised.length ? "the developers" : c.fix?.who;
    if (who || prs.length || card) {
      const released = raised.some((r) => r.releasedAt);
      c.fix = { ...(c.fix || {}), ...(who ? { who } : {}), ...(prs.length ? { prs } : {}), ...(card?.name ? { card: clip(card.name, 60), stage: clip(card.stage || c.fix?.stage || "", 30) } : {}), ...(released ? { stage: "released" } : {}), at: c.fix?.at || now };
    }
    c.touchedAt = now;
    trim(c);
    return c;
  } catch { return null; }
}

// Keep the stored record bounded: oldest corrected or withdrawn claims go first, then done promises, then old standing ones.
function trim(c) {
  const dropOldest = (list, max, pred) => { while (list.length > max) { const i = list.findIndex(pred); list.splice(i >= 0 ? i : 0, 1); } };
  dropOldest(c.claims, MAX_CLAIMS, (x) => x.status !== "standing");
  dropOldest(c.promises, MAX_PROMISES, (x) => Boolean(x.doneAt));
  dropOldest(c.staff, MAX_STAFF, () => true);
  dropOldest(c.questions, MAX_QUESTIONS, (x) => Boolean(x.closedAt));
  if (c.asked) dropOldest(c.asked, MAX_ASKED, (x) => Boolean(x.answeredAt));
  if (c.said) dropOldest(c.said, MAX_SAID, () => true);
}

function prune(d, now = Date.now()) {
  for (const [k, c] of Object.entries(d.ticketCases || {})) if (now - (c.touchedAt || 0) > KEEP_MS) delete d.ticketCases[k];
}

// The first standing claim the draft reverses, or null. A draft that starts "Correction:" is the intended way to reverse one.
function contradiction(d, ticket, message, { now = Date.now() } = {}) {
  try {
    const text = String(message || "").trim();
    const c = get(d, ticket);
    if (!c || !text || CORRECTION.test(text)) return null;
    const standing = c.claims.filter((x) => x.status === "standing");
    if (!standing.length) return null;
    for (const s of sentencesOf(text)) {
      const r = readClaim(s);
      if (!r) continue;
      const hit = standing.slice().reverse().find((x) => x.pol !== r.pol && sameSubject(r.words, new Set(x.w)));
      if (hit) return { kind: "case-contradiction", sentence: clip(s, 200), earlier: hit.text, minutesAgo: Math.max(0, Math.round((now - hit.at) / 60000)), claimId: hit.id };
    }
  } catch { /* the gate fails open */ }
  return null;
}
function contradictionRefusal(hit) {
  return `Not posted: this reverses what the player was told earlier in this ticket (${hit.minutesAgo >= 120 ? `${Math.round(hit.minutesAgo / 60)} h ago` : `${hit.minutesAgo} min ago`}, standing claim in the case file: "${hit.earlier}"). If the earlier statement was wrong or the situation changed, start the post with "Correction:" and say what was wrong and what is right; the case file then marks the old claim corrected. If it was not wrong, drop "${hit.sentence}" and keep one consistent account.`;
}

// Keir 10.4 deflection gate. A post is a deflection when the player has an open asked item, the post touches none of them,
// and it redirects ("the real blocker is...") or concludes ("working as intended"). Questions back to the player,
// corrections and posts that address an open item are never deflections. Null, or { asked, phrase }.
function deflection(d, ticket, message) {
  try {
    const text = String(message || "").trim();
    const c = get(d, ticket);
    if (!c || !text || CORRECTION.test(text)) return null;
    const open = (c.asked || []).filter((x) => !x.answeredAt);
    if (!open.length || sentencesOf(text).some((s) => s.endsWith("?"))) return null;
    const words = subjectWords(text);
    if (open.some((a) => addresses(words, a))) return null;
    const phrase = (REDIRECT.exec(text) || CONCLUDE.exec(text) || [])[0];
    return phrase ? { asked: open[0], phrase } : null;
  } catch { return null; }
}
const deflectionBudgetLeft = (d, ticket) => (get(d, ticket)?.askedRefusals || 0) < MAX_ASKED_REFUSALS;
function noteDeflectionRefusal(d, ticket) { const c = get(d, ticket); if (c) c.askedRefusals = (c.askedRefusals || 0) + 1; }
function deflectionRefusal(hit) {
  return `Not posted: the player asked "${clip(hit.asked.text, 160)}" and this post does not answer it (it says "${hit.phrase}" instead). Answer what they asked first, in their own words, in the first sentence or two. Do not call their report the wrong problem. Other findings, such as a different blocker, go after that answer.`;
}

// A player marked a Keir or support answer unhelpful or reported it. Records it as a player statement, quoting the answer's
// first sentence, and reopens the asked items that answer had touched (or had been marked answered by). Returns the summary.
function playerUnhelpful(d, ticket, { answerText = "", reason = null, at = Date.now() } = {}) {
  try {
    const c = get(d, ticket, { create: true });
    const first = clip(sentencesOf(answerText)[0] || "", 140);
    const why = clip(reason || "", 200) || "no reason";
    (c.said ||= []).push({ at, text: `Player marked an answer unhelpful: ${why}${first ? `. Answer began: "${first}"` : ""}` });
    const words = subjectWords(answerText), reopened = [];
    for (const a of c.asked || []) {
      if (a.answeredAt && ((words.size && addresses(words, a)) || (first && a.answeredBy && clip(first, 80) === a.answeredBy))) { a.answeredAt = null; delete a.answeredBy; a.reopenedAt = at; reopened.push(a.text); }
    }
    if (reopened.length) c.askedRefusals = 0;
    c.touchedAt = at;
    trim(c);
    return { first, reopened, open: (c.asked || []).filter((x) => !x.answeredAt).map((x) => x.text) };
  } catch { return null; }
}

// Render for the top of an activation, at most `cap` characters. Oldest corrected claims collapse first.
function render(d, ticket, { cap = CAP_CHARS } = {}) {
  const c = get(d, ticket);
  if (!c) return null;
  const claimLine = (x) => `- ${stamp(x.at)} ${x.status}${x.status !== "standing" && x.by ? ` (${x.status === "corrected" ? "by" : "via"} ${stamp(x.byAt)}: ${clip(x.by, 70)})` : ""}: ${clip(x.text, 120)}${x.ev ? ` [${x.ev}]` : ""}`;
  const entries = [];
  (c.asked || []).forEach((x, i) => entries.push({ section: "asked", line: `- ${stamp(x.at)} ${x.answeredAt ? "answered" : "OPEN"}: ${clip(x.text, 150)}`, open: !x.answeredAt, rank: x.answeredAt ? 50 + i : 2000 + i }));
  (c.said || []).forEach((x, i) => entries.push({ section: "said", line: `- ${stamp(x.at)} ${clip(x.text, 220)}`, rank: 1500 + i }));
  c.claims.forEach((x, i) => entries.push({ section: "claims", line: claimLine(x), rank: x.status === "standing" ? 1000 + i : i }));
  c.promises.forEach((x, i) => entries.push({ section: "promises", line: `- ${stamp(x.at)} ${x.doneAt ? "done" : "open"}: ${clip(x.text, 120)}`, rank: x.doneAt ? 100 + i : 900 + i }));
  c.staff.forEach((x, i) => entries.push({ section: "staff", line: `- ${stamp(x.at)} ${x.who}: ${clip(x.text, 130)}`, rank: 800 + i }));
  c.questions.filter((x) => !x.closedAt).forEach((x, i) => entries.push({ section: "open", line: `- ${stamp(x.at)} ${x.by === "keir" ? "you asked" : "player asked"}: ${clip(x.text, 110)}`, rank: 700 + i }));
  const fix = c.fix ? `Fix: ${[c.fix.who ? `on it: ${c.fix.who}` : null, c.fix.card ? `card "${c.fix.card}"` : null, c.fix.prs?.length ? `PR ${c.fix.prs.map((p) => `#${p}`).join(", #")}` : null, c.fix.stage ? `stage ${c.fix.stage}` : null, c.fix.said ? `said "${c.fix.said}"` : null].filter(Boolean).join("; ")}` : "";
  const head = `Case file, ticket ${ticket}. What this player was already told, dated. Never repeat a standing claim; never reverse one without starting the post with "Correction:" and saying what was wrong. Do not repeat or contradict what owner or staff said. Answer what the player asked, in their words, before anything else; never call their report the wrong problem.`;
  const build = (list, dropped) => {
    const by = (name) => list.filter((e) => e.section === name).sort((a, b) => (name === "asked" && a.open !== b.open ? (a.open ? -1 : 1) : a.line.localeCompare(b.line))).map((e) => e.line);
    const parts = [head];
    for (const [name, title] of [["asked", "Player asked (answer the OPEN ones first, in the player's own words, before any other finding)"], ["said", "Player statements"], ["claims", "Claims told to the player"], ["promises", "Promises"], ["staff", "Owner and staff in the channel"], ["open", "Open questions"]]) { const l = by(name); if (l.length) parts.push(`${title}:\n${l.join("\n")}`); }
    if (fix) parts.push(fix);
    if (dropped) parts.push(`(${dropped} older entries collapsed)`);
    return parts.join("\n");
  };
  let list = entries.slice(), dropped = 0, out = build(list, dropped);
  while (out.length > cap && list.length) {
    let i = 0; for (let j = 1; j < list.length; j++) if (list[j].rank < list[i].rank) i = j;
    list.splice(i, 1); dropped++;
    out = build(list, dropped);
  }
  if (!entries.length && !fix) return null;
  return out.slice(0, cap);
}

module.exports = { get, recordPost, syncActivation, contradiction, contradictionRefusal, deflection, deflectionRefusal, deflectionBudgetLeft, noteDeflectionRefusal, playerUnhelpful, addAsked, render, readClaim, sameSubject, prune, CAP_CHARS, CORRECTION };
