// ─── COMMUNITY TRIAGE WORKER ─────────────────────────────────────────────
// A background worker that assesses tickets and suggestions read-only.
// Automated ticket repair is available only with an explicit opt-in.
//
// For each assessed item it inserts an `assessments` doc, links it back on the
// item, and posts a Discord embed (best-effort). Everything is wrapped so a
// failure can never crash the host process.
//
// This module also hosts the GlitchTip new-issue poller, since both are simple
// periodic Mongo/HTTP loops.

const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const { notifyDiscord, COLORS } = require("./ops-discord");
const {
  pollTicketPrOpsTldrs,
  OPS_TLDR_POLL_MS,
  maybePostTicketContextRequest,
} = require("./ticket-ship-notify");
const { callChat } = require("./llm");
const { ensureTicketContextRequest } = require("./ticket-context");

const PUBLIC_BASE = (process.env.PUBLIC_BASE || "https://ops.lakesidegames.net").replace(/\/+$/, "");
// Master kill switch for automated ticket/suggestion triage. Set
// TRIAGE_ENABLED=0 to stop the loop AND make every runTriageTick caller a
// no-op (the dashboard exposes a manual tick route, so gating only the
// interval would leave a way to fire it by hand). Defaults ON so nothing
// else changes for anyone who has not set the variable.
const TRIAGE_ENABLED = process.env.TRIAGE_ENABLED !== "0";
const TICK_MS = parseInt(process.env.TRIAGE_TICK_MS || "60000", 10);
const MAX_PER_TICK = parseInt(process.env.TRIAGE_MAX_PER_TICK || "3", 10);
const RETRY_BACKOFF_MS = parseInt(process.env.TRIAGE_RETRY_BACKOFF_MS || "600000", 10); // 10 min
// Everything below sizes the prompt. The numbers were set when triage ran on
// models with an 8k–128k window and a metered bill, so they were deliberately
// stingy: 16k chars of report is ~4k tokens. The caps were raised for a
// 1M-token-window triager (glm-5.3-flash:cloud measured on this box at 247k
// prompt tokens answered correctly in 10.5s) and kept for its successor,
// Muse Spark 1.3 — the old caps threw away ~99% of what the model can read
// and truncated long Discord threads mid-report for no reason. Tunable,
// because the next model may not have the same window.
const MAX_CONTEXT_CHARS = parseInt(process.env.TRIAGE_MAX_CONTEXT_CHARS || "200000", 10);
const MAX_TRIAGE_IMAGES = parseInt(process.env.TRIAGE_MAX_IMAGES || "12", 10);
const MAX_OUTPUT_TOKENS = parseInt(process.env.TRIAGE_MAX_TOKENS || "32000", 10);
// How much real source code to feed the assessment. /api/code-context clamps
// each of these against its own ceilings; see the CODE_CONTEXT_MAX_* env there.
const CODE_CONTEXT_FILES = parseInt(process.env.TRIAGE_CODE_CONTEXT_FILES || "24", 10);
const CODE_CONTEXT_MAX_CHARS = parseInt(process.env.TRIAGE_CODE_CONTEXT_MAX_CHARS || "240000", 10);
const CODE_CONTEXT_MAX_FILE_CHARS = parseInt(process.env.TRIAGE_CODE_CONTEXT_MAX_FILE_CHARS || "12000", 10);
// Triage uses the shared llm.js route (LLM_PRIMARY, Ollama by default). It used
// to name its own provider chain and model here, but callChat never read them.
// Auto-repair starts ~5 min after open (AHD sets reviewAfter; we also enforce
// createdAt age so a stale 2-min hold cannot launch early). Recheck at 30 min
// from ticket creation so the agent can adjust and commit more work if needed.
const TICKET_LAUNCH_MIN_AGE_MS = parseInt(process.env.TICKET_LAUNCH_MIN_AGE_MS || String(5 * 60_000), 10);
const TICKET_RECHECK_DELAY_MS = parseInt(process.env.TICKET_RECHECK_DELAY_MS || String(30 * 60_000), 10);
// Cap automatic repair launches per ticket. Without this a ticket whose fix never
// produces a PR (or whose launch keeps throwing after the worktree is cut) gets
// relaunched every backoff window forever — the 2026-08-15 runaway that spawned
// ~20 empty worktrees each for #1098/#1099/#1100. After the cap we park the ticket
// as repair_exhausted for a human instead of spinning.
const MAX_REPAIR_ATTEMPTS = parseInt(process.env.TICKET_MAX_REPAIR_ATTEMPTS || "3", 10);
// Same idea for the 30-minute recheck nudge. See dispatchDueTicketRechecks.
const MAX_RECHECK_ATTEMPTS = parseInt(process.env.TICKET_MAX_RECHECK_ATTEMPTS || "3", 10);
// Auto-repair floor: only tickets created at/after this epoch-ms are eligible for
// an automatic repair launch. Set to a deploy timestamp to stop the existing
// backlog from ever auto-spawning while new tickets still flow. 0 = no floor.
const TICKET_REPAIR_MIN_CREATED_MS = parseInt(process.env.TICKET_REPAIR_MIN_CREATED_MS || "0", 10);
// Ticket triage is an assessment workflow. Repair agents require an explicit
// opt-in; the presence of a launcher must never turn assessment into coding.
function ticketAutoRepairEnabled(env = process.env) {
  return env.TICKET_AUTO_REPAIR_ENABLED === "1";
}
const CODING_TICKET_CATEGORIES = new Set(["bug"]);

// The only tags the model may assign (item must pick 1–4 from this set).
const TAG_SET = [
  "elections", "legislature", "executive", "economy", "corporations", "parties",
  "npps", "map-geo", "military", "diplomacy", "onboarding", "notifications",
  "ui-ux", "performance", "crash", "data-integrity", "balance", "mobile",
  "accessibility", "auth", "other",
];

// In-memory guard so two overlapping ticks never grab the same item.
const inFlight = new Set();

// Fetch an image URL and return a base64 data URL. Kimi (and most vision APIs)
// reject remote URLs ("unsupported image url") and require inline base64, so we
// download the bytes here. Returns null on any failure / oversize image.
const MAX_IMAGE_BYTES = parseInt(process.env.TRIAGE_MAX_IMAGE_BYTES || String(10 * 1024 * 1024), 10);
async function imageUrlToDataUrl(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!/^image\//i.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── LLM call (provider fallback handled inside ./llm callChat) ─────────
// `opts` may carry { isReassessment, imageUrls } to adjust the prompt and add
// vision content.
async function callLlmAssessment(contextStr, kind, opts = {}) {
  const { isReassessment = false, imageUrls = [], retrievalQuery = "" } = opts;
  const isTicket = kind === "ticket";
  const depthGuidance = isTicket
    ? `This is a BUG TICKET, so go deep. Your "summary" must be a thorough analysis paragraph ` +
      `(several sentences): state what is most likely happening, give the leading root-cause ` +
      `hypotheses (and any alternatives worth ruling out), and call out the affected areas/files ` +
      `and how they interact. Your "recommendation" should explain the overall approach and ` +
      `anything a human should verify first. Your "nextSteps" must be a concrete, ordered list of ` +
      `actionable steps an engineer would take to confirm the cause and fix it (e.g. files to open, ` +
      `logs/queries to check, what to reproduce, what to change).`
    : `This is a FEATURE SUGGESTION. Your "summary" should be a solid multi-sentence paragraph ` +
      `describing the request, where it fits in the codebase, and the main considerations. Your ` +
      `"recommendation" should outline a sensible approach. Your "nextSteps" should be a short ` +
      `actionable list of how a human would scope and implement it.`;

  const reassessGuidance = isReassessment
    ? `\n\nThis item was triaged before and may have since been fixed — assess whether it now ` +
      `appears already resolved in the current codebase; if so set likelyAlreadyFixed=true and ` +
      `explain in the summary.`
    : "";

  // Optional agentic path (TRIAGE_AGENTIC=1): give the model tools
  // (code_search / read_file / grep) + turns to read the code, then assess.
  // Off by default — kimi-for-coding is slow/flaky in a multi-turn loop; the
  // single-shot GROUNDED path below (real code fed in) is the reliable default.
  if (process.env.TRIAGE_AGENTIC === "1") {
    try {
      const { investigate } = require("./triage-agent");
      const agentic = await investigate(contextStr, kind, { tagSet: TAG_SET, depthGuidance });
      if (agentic && agentic.assessment) {
        console.log(`[triage] agentic assessment (${agentic.trail.join(" → ")})`);
        return { content: JSON.stringify(agentic.assessment), model: "kimi-agentic", provider: "kimi", imagesIncluded: 0 };
      }
    } catch (e) { console.warn("[triage] agentic path failed → single-shot:", e.message); }
  }

  // Ground the assessment in the ACTUAL codebase (reuses the Ask retrieval).
  let codeContext = "";
  try {
    const cc = await fetch(`http://127.0.0.1:${process.env.PORT || 9724}/api/code-context`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-ask-secret": process.env.ASK_API_SECRET || "" },
      body: JSON.stringify({
        query: (retrievalQuery || String(contextStr)).slice(0, 400),
        limit: CODE_CONTEXT_FILES,
        maxChars: CODE_CONTEXT_MAX_CHARS,
        maxFileChars: CODE_CONTEXT_MAX_FILE_CHARS,
      }), signal: AbortSignal.timeout(60000),
    });
    if (cc.ok) codeContext = (await cc.json()).context || "";
  } catch { /* retrieval down → ungrounded fallback */ }

  const prompt =
    `You are a senior engineer triaging an incoming bug report / feature suggestion for ` +
    `"A House Divided", a Next.js + TypeScript + MongoDB web game. ` +
    `Produce a STRICTLY READ-ONLY assessment — do NOT propose to edit, branch, or run anything; ` +
    `just analyse.` +
    (codeContext
      ? ` GROUND your assessment in the ACTUAL SOURCE CODE provided at the end — name the real files and functions you see and what they do; do NOT invent file paths or speculate about behavior the code already settles. Only hypothesize where the provided code genuinely doesn't show the answer.\n\n`
      : ` Based on the report below, estimate which areas of the codebase are likely involved and how hard a fix would be.\n\n`) +
    depthGuidance +
    reassessGuidance +
    `\n\nFor "tags", choose 1–4 tags ONLY from this exact set (no others): ` +
    `[${TAG_SET.join(", ")}].\n` +
    `\nRespond with ONLY a single JSON object (no prose, no code fences) of this exact shape:\n` +
    `{\n` +
    `  "summary": string,            // detailed plain-English analysis paragraph (see guidance above)\n` +
    `  "tags": string[],             // 1–4 tags chosen ONLY from the allowed set above\n` +
    `  "affectedFiles": string[],    // best-guess source paths/areas likely involved (may be empty)\n` +
    `  "complexity": "trivial"|"small"|"medium"|"large",\n` +
    `  "risk": "low"|"medium"|"high",\n` +
    `  "recommendedAction": "quick_implement"|"decline"|"standard"|"needs_info", // your verdict on how to clear this item: quick_implement = small & clearly worth doing now; decline = recommend NOT implementing / out of scope; standard = normal backlog; needs_info = can't tell yet\n` +
    `  "likelyAlreadyFixed": boolean, // true only if this appears already resolved in the current codebase\n` +
    `  "recommendation": string,     // recommended approach / what a human should verify first\n` +
    `  "nextSteps": string[],        // ordered, short, actionable next steps (may be empty)\n` +
    `  "confidence": number          // 0..1, your confidence in this assessment\n` +
    `}\n\n` +
    `Report:\n${contextStr.slice(0, MAX_CONTEXT_CHARS)}` +
    (codeContext ? `\n\n=== RELEVANT SOURCE CODE (retrieved from the live repo — use this to ground your analysis) ===\n${codeContext}` : "");

  // Build the user message. When the ticket carries images, download + inline
  // them as base64 data URLs (Kimi rejects remote URLs) so the vision model can
  // see them. Images that fail to fetch are skipped.
  const candidateUrls = Array.isArray(imageUrls)
    ? imageUrls.filter(Boolean).slice(0, MAX_TRIAGE_IMAGES)
    : [];
  const dataUrls = (await Promise.all(candidateUrls.map(imageUrlToDataUrl))).filter(Boolean);
  const userContent = dataUrls.length
    ? [
        { type: "text", text: prompt },
        ...dataUrls.map((u) => ({ type: "image_url", image_url: { url: u } })),
      ]
    : prompt;

  try {
    const { content, model, provider } = await callChat({
      messages: [{ role: "user", content: userContent }],
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 1,
    });
    return { content, model, provider, imagesIncluded: dataUrls.length };
  } catch (e) {
    // If the failure looks vision/image related (e.g. HTTP 400), retry once
    // text-only with the image URLs already listed in the context.
    if (dataUrls.length && /\b400\b|image|vision|multimodal/i.test(String(e.message || ""))) {
      const { content, model, provider } = await callChat({
        messages: [{ role: "user", content: prompt }],
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 1,
        });
      return { content, model, provider, imagesIncluded: 0 };
    }
    throw e;
  }
}

// Lenient JSON extraction: strip code fences, grab the outermost {...}.
function parseAssessment(raw) {
  if (!raw) throw new Error("empty LLM response");
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) throw new Error("no JSON object found");
  const obj = JSON.parse(s.slice(first, last + 1));
  const enumOr = (v, allowed, fallback) =>
    typeof v === "string" && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : fallback;
  let conf = Number(obj.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.max(0, Math.min(1, conf));
  // Tags: lowercase, keep only allowed values, dedupe, cap 4.
  const tags = Array.isArray(obj.tags)
    ? [...new Set(obj.tags.map((t) => String(t).trim().toLowerCase()).filter((t) => TAG_SET.includes(t)))].slice(0, 4)
    : [];
  return {
    summary: String(obj.summary || "").slice(0, 4000) || "(no summary)",
    tags,
    likelyAlreadyFixed: obj.likelyAlreadyFixed === true,
    affectedFiles: Array.isArray(obj.affectedFiles)
      ? obj.affectedFiles.map((f) => String(f)).filter(Boolean).slice(0, 40)
      : [],
    complexity: enumOr(obj.complexity, ["trivial", "small", "medium", "large"], "medium"),
    risk: enumOr(obj.risk, ["low", "medium", "high"], "medium"),
    recommendedAction: enumOr(
      obj.recommendedAction,
      ["quick_implement", "decline", "standard", "needs_info"],
      "standard"
    ),
    recommendation: String(obj.recommendation || "").slice(0, 4000),
    nextSteps: Array.isArray(obj.nextSteps)
      ? obj.nextSteps.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
      : [],
    confidence: conf,
  };
}

function buildTicketContext(t) {
  const parts = [];
  parts.push(`TYPE: bug ticket #${t.ticketNumber}`);
  if (t.category) parts.push(`CATEGORY: ${t.category}`);
  if (t.title) parts.push(`TITLE: ${t.title}`);
  if (t.description) parts.push(`DESCRIPTION:\n${t.description}`);
  if (Array.isArray(t.messages) && t.messages.length) {
    parts.push("CAPTURED MESSAGES:");
    for (const m of t.messages.slice(0, 30)) {
      parts.push(`- ${m.authorName || "user"}: ${m.content || ""}`);
      if (Array.isArray(m.imageUrls) && m.imageUrls.length) parts.push(`  [images: ${m.imageUrls.join(", ")}]`);
    }
  }
  if (Array.isArray(t.imageUrls) && t.imageUrls.length) parts.push(`ATTACHED IMAGES: ${t.imageUrls.join(", ")}`);
  if (t.reporter) {
    const r = t.reporter;
    parts.push(
      `REPORTER: ${r.username || "?"}${r.characterName ? " / " + r.characterName : ""}` +
        (r.corporationName ? ` (corp: ${r.corporationName}${r.corporationTicker ? " [" + r.corporationTicker + "]" : ""})` : "")
    );
  }
  return parts.join("\n");
}

// Collect a ticket's image URLs (top-level attachments + per-message images),
// deduped, for passing to a vision-capable model.
function collectTicketImages(t) {
  const urls = [];
  if (Array.isArray(t.imageUrls)) urls.push(...t.imageUrls);
  if (Array.isArray(t.messages)) {
    for (const m of t.messages) {
      if (Array.isArray(m.imageUrls)) urls.push(...m.imageUrls);
    }
  }
  return [...new Set(urls.filter(Boolean).map((u) => String(u)))];
}

function buildSuggestionContext(s) {
  const parts = [];
  parts.push(`TYPE: feature suggestion #${s.issueNumber}`);
  if (s.category) parts.push(`CATEGORY: ${s.category}`);
  if (s.gameSystem) parts.push(`GAME SYSTEM: ${s.gameSystem}`);
  if (s.title) parts.push(`TITLE: ${s.title}`);
  if (s.description) parts.push(`DESCRIPTION:\n${s.description}`);
  if (s.impact) parts.push(`IMPACT: ${s.impact}`);
  if (s.priority) parts.push(`PRIORITY: ${s.priority}`);
  return parts.join("\n");
}

// Post the assessment to Discord (best-effort). When `pingModerator` is set and
// DISCORD_MODERATOR_ROLE_ID is configured, the message pings the moderator role.
async function postAssessmentEmbed({ targetType, displayNumber, title, assessment, deepLink, pingModerator }) {
  const colorByRisk = { low: COLORS.green, medium: COLORS.yellow, high: COLORS.red };
  const label = targetType === "ticket" ? `Ticket #${displayNumber}` : `Suggestion #${displayNumber}`;
  const modRole = process.env.DISCORD_MODERATOR_ROLE_ID;
  const wantPing = pingModerator && modRole;

  // Description = the detailed analysis summary, plus the recommendation if it
  // fits. Discord caps descriptions at 4000 chars.
  let description = assessment.summary || "";
  if (assessment.likelyAlreadyFixed) {
    description = `⚠️ **Likely already fixed** — this item appears resolved in the current codebase.\n\n` + description;
  }
  if (assessment.recommendation) {
    const rec = `\n\n**Recommendation:** ${assessment.recommendation}`;
    if (description.length + rec.length <= 4000) description += rec;
  }
  description = description.slice(0, 4000);

  // Next steps: render as a numbered list, capped to Discord's 1024 field limit.
  const steps = Array.isArray(assessment.nextSteps) ? assessment.nextSteps : [];
  let nextStepsField = null;
  if (steps.length) {
    let val = "";
    let n = 0;
    for (const step of steps) {
      const line = `${n + 1}. ${step}\n`;
      if (val.length + line.length > 1024) break;
      val += line;
      n++;
    }
    if (val.trim()) nextStepsField = { name: "Next steps", value: val.trim().slice(0, 1024), inline: false };
  }

  return notifyDiscord({
    kind: "pr-review", // routes via DISCORD_OPS_WEBHOOK_URL fallback
    ...(wantPing ? { content: `<@&${modRole}> new ticket triaged`, mentionRoleIds: [modRole] } : {}),
    title: `🔎 ${label} triaged — ${title || ""}`.slice(0, 240),
    description,
    url: deepLink,
    color: colorByRisk[assessment.risk] || COLORS.blurple,
    fields: [
      { name: "Complexity", value: assessment.complexity, inline: true },
      { name: "Risk", value: assessment.risk, inline: true },
      { name: "Confidence", value: Math.round(assessment.confidence * 100) + "%", inline: true },
      ...(assessment.affectedFiles.length
        ? [{ name: "Likely areas", value: assessment.affectedFiles.slice(0, 8).join("\n").slice(0, 1000), inline: false }]
        : []),
      ...(nextStepsField ? [nextStepsField] : []),
    ],
    footer: "Automated triage · read-only · not a substitute for human review",
  });
}

// Claim + process a single item. `kind` is "ticket" | "suggestion".
async function processItem(db, kind, rawItem, { launchTicketFix } = {}) {
  if (kind === "ticket" && rawItem.category === "investigation") return { skipped: "staff-investigation" };
  const id = rawItem._id;
  const idStr = id.toHexString();
  if (inFlight.has(idStr)) return { skipped: "in-flight" };
  inFlight.add(idStr);
  try {
    const isTicket = kind === "ticket";
    const coll = db.collection(isTicket ? "tickets" : "suggestions");
    const now = new Date();

    // Re-assessment? If a prior assessment already exists for this target, this
    // is a re-triage — tell the model to check whether it's already been fixed.
    const priorAssessment = await db.collection("assessments").findOne({ targetType: kind, targetId: id });
    const isReassessment = !!priorAssessment;

    // Atomic claim: only proceed if still unassessed. We set triageStatus to
    // "triaging" and stamp lastTriageAttempt (doubles as a cross-tick backoff).
    const claimFilter = isTicket
      ? { _id: id, status: "open", $or: [{ assessmentId: { $exists: false } }, { assessmentId: null }] }
      : { _id: id, $or: [{ assessmentId: { $exists: false } }, { assessmentId: null }] };
    const claimSet = isTicket
      ? { status: "triaging", triageStatus: "triaging", lastTriageAttempt: now, updatedAt: now }
      : { triageStatus: "triaging", lastTriageAttempt: now };
    const claim = await coll.findOneAndUpdate(
      claimFilter,
      { $set: claimSet, $push: { statusHistory: { status: "triaging", at: now, by: "triage-worker", source: "triage" } } },
      { returnDocument: "after" }
    );
    const item = claim && (claim.value || claim); // driver version compat
    if (!item || !item._id) return { skipped: "not claimable" };

    const displayNumber = isTicket ? item.ticketNumber : item.issueNumber;
    const context = isTicket ? buildTicketContext(item) : buildSuggestionContext(item);
    const images = isTicket ? collectTicketImages(item) : [];

    // The legacy repair path is opt-in. By default tickets continue through the
    // read-only assessment path below, regardless of category or launcher.
    if (isTicket && ticketAutoRepairEnabled()) {
      const category = String(item.category || "").toLowerCase();
      // Real analysis for EVERY ticket, whatever the pipeline does with it next.
      const llm = await buildTicketAssessmentFields(context, images, isReassessment, item);
      const llmTags = (llm && llm.tags) || [];
      if (!CODING_TICKET_CATEGORIES.has(category)) {
        const skippedAt = new Date();
        const gateNote = `Skipped auto-repair: category "${category || "unknown"}" is not a coding defect (moderation / account / questions stay with humans).`;
        const assessmentDoc = {
          targetType: "ticket",
          targetId: id,
          displayNumber: displayNumber ?? null,
          status: "skipped",
          summary: llm ? `${gateNote}\n\n${llm.summary}` : gateNote,
          tags: llmTags,
          likelyAlreadyFixed: llm ? llm.likelyAlreadyFixed : false,
          affectedFiles: (llm && llm.affectedFiles) || [],
          complexity: (llm && llm.complexity) || "low",
          risk: (llm && llm.risk) || "low",
          recommendedAction: "human",
          recommendation: llm
            ? `No coding agent launched; handle via mods/support as appropriate. ${llm.recommendation}`
            : "No coding agent launched. Handle via mods/support as appropriate.",
          nextSteps: (llm && llm.nextSteps) || [],
          confidence: llm ? llm.confidence : 1,
          model: llm ? llm.model : "triage-gate",
          imagesIncluded: llm ? llm.imagesIncluded : images.length,
          createdAt: skippedAt,
        };
        const ins = await db.collection("assessments").insertOne(assessmentDoc);
        await coll.updateOne(
          { _id: id },
          {
            $set: {
              assessmentId: ins.insertedId,
              assessedAt: skippedAt,
              status: "open",
              triageStatus: "skipped_non_coding",
              tags: llmTags,
              updatedAt: skippedAt,
            },
            $push: {
              statusHistory: {
                status: "skipped_non_coding",
                at: skippedAt,
                by: "ticket-repair-agent",
                source: "triage",
                note: `category=${category || "unknown"}`,
              },
            },
          }
        );
        return { skipped: "non-coding", displayNumber, category };
      }

      // Repair-attempt cap: park the ticket for a human instead of relaunching
      // forever. A launch that throws AFTER cutting the worktree reopens the ticket
      // (status:"open"), which is re-eligible next backoff — unbounded without this.
      const priorAttempts = Number(item.repairAttempts || 0);
      if (priorAttempts >= MAX_REPAIR_ATTEMPTS) {
        await coll.updateOne(
          { _id: id },
          {
            $set: {
              status: "parked",
              triageStatus: "repair_exhausted",
              recheckStatus: "parked",
              parkedReason: `auto-repair exhausted after ${priorAttempts} attempts with no PR`,
              updatedAt: new Date(),
            },
            $push: { statusHistory: { status: "repair_exhausted", at: new Date(), by: "triage-worker", source: "triage", note: `parked after ${priorAttempts} attempts` } },
          }
        );
        return { skipped: "repair_exhausted", displayNumber, attempts: priorAttempts };
      }
      // Count this attempt up front so a launch that throws mid-flight still counts
      // toward the cap (the failure path only resets status, not the counter).
      await coll.updateOne({ _id: id }, { $inc: { repairAttempts: 1 } });

      try {
        if (typeof launchTicketFix !== "function") throw new Error("Ticket repair launcher is not configured");
        const launched = await launchTicketFix({ ticket: item, context, imageUrls: images });
        const launchedAt = new Date();
        const assessmentDoc = {
          targetType: "ticket",
          targetId: id,
          displayNumber: displayNumber ?? null,
          status: "launched",
          summary: llm
            ? llm.summary
            : "A fresh coding agent is investigating and attempting this fix in an isolated worktree.",
          tags: llmTags,
          likelyAlreadyFixed: llm ? llm.likelyAlreadyFixed : false,
          affectedFiles: (llm && llm.affectedFiles) || [],
          complexity: (llm && llm.complexity) || "medium",
          risk: (llm && llm.risk) || "medium",
          recommendedAction: "standard",
          recommendation:
            "A fresh coding agent is attempting this fix in an isolated worktree. It will inspect the complete ticket, including attachments, reproduce the issue, post findings to #operations (PR on the way), then open a development PR as soon as the fix is verified. Ops posts the PR-link TL;DR automatically and posts player-facing milestones when the fix reaches development or production. After verification, the agent records the durable receipt with support_resolve. Agents never reply in Discord ticket channels." +
            (llm && llm.recommendation ? `\n\n${llm.recommendation}` : ""),
          nextSteps: (llm && llm.nextSteps) || [],
          confidence: llm ? llm.confidence : 1,
          model: llm ? llm.model : (launched.provider || "cursor"),
          launchProvider: launched.provider || "cursor",
          tmuxName: launched.tmuxName || null,
          codeSessionId: launched.codeSessionId || null,
          imagesIncluded: images.length,
          createdAt: launchedAt,
        };
        const ins = await db.collection("assessments").insertOne(assessmentDoc);
        await coll.updateOne(
          { _id: id },
          {
            $set: {
              assessmentId: ins.insertedId,
              assessedAt: launchedAt,
              status: "fixing",
              triageStatus: "fixing",
              tags: llmTags,
              fixSessionId: launched.fixSessionId || null,
              // Anchor to launch time, not ticket createdAt: an older ticket had a
              // recheckAt already in the past, so the recheck fired every tick.
              recheckAt: new Date(launchedAt.getTime() + TICKET_RECHECK_DELAY_MS),
              recheckStatus: "pending",
              updatedAt: launchedAt,
            },
            $push: { statusHistory: { status: "fixing", at: launchedAt, by: "ticket-repair-agent", source: "triage" } },
          }
        );
        return { launched: true, displayNumber, tmuxName: launched.tmuxName, codeSessionId: launched.codeSessionId };
      } catch (e) {
        await coll.updateOne(
          { _id: id },
          {
            $set: { status: "open", triageStatus: "error", lastTriageError: String(e.message || e).slice(0, 300), updatedAt: new Date() },
            $push: { statusHistory: { status: "error", at: new Date(), by: "ticket-repair-agent", source: "triage", note: String(e.message || e).slice(0, 200) } },
          }
        );
        return { error: e.message, displayNumber };
      }
    }

    let assessment, model, imagesIncluded = 0;
    try {
      const retrievalQuery = [item.title, item.description].filter(Boolean).join(". ").slice(0, 300);
      const out = await callLlmAssessment(context, kind, { isReassessment, imageUrls: images, retrievalQuery });
      assessment = parseAssessment(out.content);
      model = out.model;
      imagesIncluded = out.imagesIncluded || 0;
    } catch (e) {
      // LLM/parse failure: store an error assessment for visibility, revert the
      // item so it becomes reviewable again after the backoff window.
      await db.collection("assessments").insertOne({
        targetType: kind,
        targetId: id,
        displayNumber: displayNumber ?? null,
        status: "error",
        error: String(e.message || e).slice(0, 500),
        model: process.env.LLM_MODEL || "kimi-for-coding",
        createdAt: new Date(),
      });
      const revert = isTicket
        ? { status: "open", triageStatus: "error", lastTriageError: String(e.message || e).slice(0, 300) }
        : { triageStatus: "error", lastTriageError: String(e.message || e).slice(0, 300) };
      await coll.updateOne(
        { _id: id },
        {
          $set: revert,
          $push: { statusHistory: { status: "error", at: new Date(), by: "triage-worker", source: "triage", note: String(e.message || e).slice(0, 200) } },
        }
      );
      return { error: e.message, displayNumber };
    }

    const assessmentDoc = {
      targetType: kind,
      targetId: id,
      displayNumber: displayNumber ?? null,
      summary: assessment.summary,
      tags: assessment.tags || [],
      likelyAlreadyFixed: assessment.likelyAlreadyFixed === true,
      affectedFiles: assessment.affectedFiles,
      complexity: assessment.complexity,
      risk: assessment.risk,
      recommendedAction: assessment.recommendedAction,
      recommendation: assessment.recommendation,
      nextSteps: assessment.nextSteps || [],
      confidence: assessment.confidence,
      imagesIncluded,
      isReassessment,
      model: model || "kimi-for-coding",
      status: "complete",
      createdAt: new Date(),
    };
    const ins = await db.collection("assessments").insertOne(assessmentDoc);

    const assessedAt = new Date();
    const itemSet = isTicket
      ? { assessmentId: ins.insertedId, assessedAt, status: "assessed", triageStatus: "assessed", tags: assessment.tags || [], updatedAt: assessedAt }
      : { assessmentId: ins.insertedId, assessedAt, triageStatus: "assessed", tags: assessment.tags || [] };
    await coll.updateOne(
      { _id: id },
      {
        $set: itemSet,
        $push: { statusHistory: { status: "assessed", at: assessedAt, by: "triage-worker", source: "triage" } },
      }
    );

    // Ask for missing player context as a separate, small decision. It is
    // persisted and posted through the same idempotent player-update ledger as
    // heal/development/resolution milestones; a model outage must not fail the
    // engineering assessment.
    if (isTicket) {
      ensureTicketContextRequest(db, { ...item, ...itemSet })
        .then((contextRequest) => maybePostTicketContextRequest(db, { ticketNumber: displayNumber, contextRequest }))
        .catch((error) => console.warn(`[ticket-context] ticket #${displayNumber}: ${error.message}`));
    }

    const deepLink = isTicket
      ? `${PUBLIC_BASE}/tickets/${displayNumber}`
      : `${PUBLIC_BASE}/suggestions/${displayNumber}`;
    return { assessed: true, displayNumber, assessmentId: ins.insertedId.toHexString() };
  } catch (e) {
    return { error: e.message };
  } finally {
    inFlight.delete(idStr);
  }
}

// At the thirty-minute mark (from ticket creation), nudge the repair agent to
// re-read the ticket and adjust/commit if the issue is still open. Persisted on
// the ticket so a dashboard restart cannot forget the scheduled recheck.
async function dispatchDueTicketRechecks(db, requestTicketRecheck) {
  if (typeof requestTicketRecheck !== "function") return [];
  const now = new Date();
  const due = await db.collection("tickets")
    .find({ status: "fixing", recheckStatus: "pending", recheckAt: { $lte: now } })
    .sort({ recheckAt: 1 })
    .limit(MAX_PER_TICK)
    .toArray();
  const results = [];
  for (const ticket of due) {
    const claimed = await db.collection("tickets").findOneAndUpdate(
      { _id: ticket._id, status: "fixing", recheckStatus: "pending" },
      { $set: { recheckStatus: "dispatching", updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!(claimed && (claimed.value || claimed)._id)) continue;
    try {
      await requestTicketRecheck(ticket);
      await db.collection("tickets").updateOne(
        { _id: ticket._id },
        { $set: { recheckStatus: "queued", recheckedAt: new Date(), updatedAt: new Date() } }
      );
      results.push({ recheckQueued: true, displayNumber: ticket.ticketNumber });
    } catch (e) {
      // Retry, but not forever. Resetting straight back to `pending` was an
      // unbounded loop: when the underlying Paseo agent is dead rather than
      // busy, `requestTicketRecheck` throws every single tick and the ticket
      // re-arms itself every single tick. Ticket #1207 sat in that loop for an
      // hour on 2026-08-27, one identical log line per minute, and nothing about
      // it would ever have changed on its own. The launch path has capped
      // attempts (MAX_REPAIR_ATTEMPTS) for exactly this reason; the recheck path
      // was the same hazard with no cap. Park it for a human instead.
      const attempts = (ticket.recheckAttempts || 0) + 1;
      const exhausted = attempts >= MAX_RECHECK_ATTEMPTS;
      await db.collection("tickets").updateOne(
        { _id: ticket._id },
        { $set: {
            recheckStatus: exhausted ? "recheck_exhausted" : "pending",
            recheckAttempts: attempts,
            lastTriageError: String(e.message || e).slice(0, 300),
            updatedAt: new Date(),
        } }
      );
      results.push({
        error: "recheck: " + e.message,
        displayNumber: ticket.ticketNumber,
        attempts,
        ...(exhausted ? { parked: "recheck_exhausted" } : {}),
      });
    }
  }
  return results;
}

// Produce the real LLM assessment fields for a ticket. Ticket triage used to
// return only a pipeline stub ("a repair agent is investigating" / "skipped:
// non-coding"), so every ticket on the dashboard had an empty analysis, no
// tags and no nextSteps — the deep BUG TICKET prompt in callLlmAssessment was
// dead code. This runs the assessment for every ticket regardless of which
// pipeline branch it then takes. Best-effort: a failure here must never stop a
// repair launch, so it returns null and the stub stands on its own.
async function buildTicketAssessmentFields(context, images, isReassessment, item) {
  try {
    const retrievalQuery = [item.title, item.description].filter(Boolean).join(". ").slice(0, 300);
    const out = await callLlmAssessment(context, "ticket", { isReassessment, imageUrls: images, retrievalQuery });
    const a = parseAssessment(out.content);
    return {
      summary: a.summary,
      tags: a.tags || [],
      likelyAlreadyFixed: a.likelyAlreadyFixed === true,
      affectedFiles: a.affectedFiles || [],
      complexity: a.complexity,
      risk: a.risk,
      recommendation: a.recommendation,
      nextSteps: a.nextSteps || [],
      confidence: a.confidence,
      imagesIncluded: out.imagesIncluded || 0,
      model: out.model || process.env.LLM_MODEL || "kimi-for-coding",
    };
  } catch (e) {
    console.warn("[triage] ticket assessment failed (stub only):", e.message);
    return null;
  }
}

// One scheduling tick: pick a few eligible items and process them.
async function runTriageTick(getDb, opts = {}) {
  if (!TRIAGE_ENABLED) return { disabled: true, processed: 0, results: [] };
  let db;
  try {
    db = await getDb();
  } catch (e) {
    return { error: "db: " + e.message };
  }
  const now = new Date();
  const backoffCutoff = new Date(now.getTime() - RETRY_BACKOFF_MS);
  const notRecentlyTried = { $or: [{ lastTriageAttempt: { $exists: false } }, { lastTriageAttempt: { $lte: backoffCutoff } }] };
  const unassessed = { $or: [{ assessmentId: { $exists: false } }, { assessmentId: null }] };

  const results = [];
  try {
    results.push(...await dispatchDueTicketRechecks(db, opts.requestTicketRecheck));
  } catch (e) {
    results.push({ error: "ticket rechecks: " + e.message });
  }
  try {
    // Suggestions: fresh (not_reviewed + unassessed) OR explicitly re-triaged
    // (triageStatus:"pending", regardless of status — that's what re-triage sets).
    const sugg = await db
      .collection("suggestions")
      .find({ $and: [notRecentlyTried, { $or: [{ $and: [{ status: "not_reviewed" }, unassessed] }, { triageStatus: "pending" }] }] })
      .sort({ createdAt: 1 })
      .limit(MAX_PER_TICK)
      .toArray();
    for (const s of sugg) results.push(await processItem(db, "suggestion", s, opts));
  } catch (e) {
    results.push({ error: "suggestions: " + e.message });
  }
  try {
    // Tickets: fresh (open + reviewAfter elapsed + old enough + unassessed) OR
    // explicitly re-triaged (triageStatus:"pending"). Min age enforces the
    // 5-minute post-open hold even if reviewAfter was stamped with an older value.
    const launchEligibleAt = new Date(now.getTime() - TICKET_LAUNCH_MIN_AGE_MS);
    // Repair floor excludes the backlog from auto-launch (applies to both fresh
    // and re-triaged tickets); new tickets created after the floor still flow.
    const repairFloor = { createdAt: { $gte: new Date(TICKET_REPAIR_MIN_CREATED_MS) } };
    const tix = await db
      .collection("tickets")
      .find({ $and: [{ category: { $ne: "investigation" } }, notRecentlyTried, repairFloor, { $or: [
        { $and: [
          { status: "open" },
          unassessed,
          { createdAt: { $lte: launchEligibleAt } },
          { $or: [{ reviewAfter: { $lte: now } }, { reviewAfter: { $exists: false } }] },
        ] },
        { triageStatus: "pending" },
      ] }] })
      .sort({ createdAt: 1 })
      .limit(MAX_PER_TICK)
      .toArray();
    for (const t of tix) results.push(await processItem(db, "ticket", t, opts));
  } catch (e) {
    results.push({ error: "tickets: " + e.message });
  }
  return { processed: results.filter((r) => r && (r.assessed || r.error)).length, results };
}

// ── GlitchTip new-issue poller ─────────────────────────────────────────
const GLITCHTIP_SEEN_FILE = path.join(__dirname, "data", "glitchtip-seen.json");
const GLITCHTIP_POLL_MS = parseInt(process.env.GLITCHTIP_POLL_MS || "300000", 10); // 5 min

function loadSeen(file) {
  try {
    return new Set(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}
function saveSeen(file, set) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...set].slice(-2000)));
  } catch {
    /* best-effort */
  }
}

async function pollGlitchtipOnce() {
  const url = process.env.GLITCHTIP_URL;
  const token = process.env.GLITCHTIP_API_TOKEN;
  const org = process.env.GLITCHTIP_ORG_SLUG || "ahd";
  // `url` is the INTERNAL API endpoint (e.g. http://localhost:8000) — never use
  // it to build user-facing links. The public GlitchTip UI is proxied here:
  const webBase = (process.env.GLITCHTIP_WEB_URL || process.env.GLITCHTIP_DOMAIN || "https://ops.lakesidegames.net/errors").replace(/\/+$/, "");
  if (!url || !token) return { skipped: "not configured" };
  let issues;
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/0/organizations/${org}/issues/?query=is:unresolved&limit=25`, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { error: "http " + r.status };
    issues = await r.json();
  } catch (e) {
    return { error: e.message };
  }
  if (!Array.isArray(issues)) return { error: "unexpected payload" };

  const seen = loadSeen(GLITCHTIP_SEEN_FILE);
  const isFirstRun = seen.size === 0;
  let posted = 0;
  for (const iss of issues) {
    const id = String(iss.id || iss.shortId || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // On the very first run, learn the baseline silently to avoid a flood.
    if (isFirstRun) continue;
    const link = `${webBase}/${org}/issues/${id}`;
    await notifyDiscord({
      kind: "glitchtip",
      title: `🐛 New error: ${iss.title || iss.culprit || id}`.slice(0, 240),
      description: (iss.culprit || iss.metadata?.value || "").slice(0, 1000),
      url: link,
      color: iss.level === "error" || iss.level === "fatal" ? COLORS.red : COLORS.yellow,
      fields: [
        { name: "Level", value: String(iss.level || "error"), inline: true },
        { name: "Events", value: String(iss.count ?? "?"), inline: true },
      ],
      footer: "GlitchTip",
    }).catch(() => {});
    posted++;
  }
  saveSeen(GLITCHTIP_SEEN_FILE, seen);
  return { posted, total: issues.length, baseline: isFirstRun };
}

// ── Public entry point ─────────────────────────────────────────────────
// ── New-backup watcher ────────────────────────────────────────────────
// Posts a brief success embed when a new mongodump snapshot folder appears in
// BACKUP_DIR. Decoupled from whatever triggers the backup. First run seeds the
// baseline silently so we don't announce pre-existing backups.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "data", "backups");
const BACKUP_SEEN_FILE = path.join(__dirname, "data", "backup-seen.json");
const BACKUP_POLL_MS = parseInt(process.env.BACKUP_POLL_MS || "300000", 10); // 5 min

function listBackupSnapshots() {
  try {
    return fs
      .readdirSync(BACKUP_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// Collections whose absence or emptiness means the dump is worthless. These are
// the ones a forensic restore actually needs; a snapshot missing any of them is
// not a backup regardless of how many other files it contains.
const BACKUP_CRITICAL_COLLECTIONS = [
  "corporations",
  "corporateSectors",
  "characters",
  "gameState",
];
const BACKUP_MIN_COLLECTIONS = parseInt(process.env.BACKUP_MIN_COLLECTIONS || "50", 10);
const BACKUP_MIN_BYTES = parseInt(process.env.BACKUP_MIN_BYTES || String(200 * 1024 * 1024), 10);

/**
 * Assert a snapshot directory actually contains a usable dump. Returns
 * `{ ok, problems[], collections, size, bytes }` — never throws, because a
 * verifier that dies silently is the same failure it exists to catch.
 */
function verifyBackupSnapshot(snapshot) {
  const problems = [];
  const root = path.join(BACKUP_DIR, snapshot);
  // mongodump nests under the db name; tolerate either layout.
  const dbDir = path.join(root, "a-house-divided");
  const dir = fs.existsSync(dbDir) ? dbDir : root;

  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return { ok: false, problems: [`cannot read ${dir}: ${e.message}`], collections: null, size: null, bytes: 0 };
  }

  const bsons = files.filter((f) => f.endsWith(".bson"));
  if (bsons.length < BACKUP_MIN_COLLECTIONS) {
    problems.push(`only ${bsons.length} .bson files (expected >= ${BACKUP_MIN_COLLECTIONS})`);
  }

  let bytes = 0;
  for (const f of bsons) {
    try {
      bytes += fs.statSync(path.join(dir, f)).size;
    } catch {
      /* counted as 0 */
    }
  }
  if (bytes < BACKUP_MIN_BYTES) {
    problems.push(`total bson ${(bytes / 1024 / 1024).toFixed(1)}MB below ${(BACKUP_MIN_BYTES / 1024 / 1024).toFixed(0)}MB floor`);
  }

  for (const name of BACKUP_CRITICAL_COLLECTIONS) {
    const p = path.join(dir, `${name}.bson`);
    let size = -1;
    try {
      size = fs.statSync(p).size;
    } catch {
      /* missing */
    }
    if (size < 0) problems.push(`${name}.bson missing`);
    else if (size === 0) problems.push(`${name}.bson is empty`);
  }

  return {
    ok: problems.length === 0,
    problems,
    collections: bsons.length,
    size: `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`,
    bytes,
  };
}

async function pollBackupsOnce() {
  const snaps = listBackupSnapshots();
  if (!snaps.length) return { skipped: "no backups" };
  const latest = snaps[snaps.length - 1];

  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(BACKUP_SEEN_FILE, "utf8")).latest;
  } catch {
    /* first run */
  }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(BACKUP_SEEN_FILE), { recursive: true });
      fs.writeFileSync(BACKUP_SEEN_FILE, JSON.stringify({ latest }));
    } catch {
      /* best-effort */
    }
  };

  if (seen == null) {
    save(); // seed baseline silently
    return { seeded: latest };
  }
  if (latest === seen) return { skipped: "no new backup" };

  // New snapshot — VERIFY CONTENT, do not just announce the directory name.
  // A green "completed successfully" posted off a bare mkdir is how the
  // 2026-07-23 → 08-13 outage stayed invisible for three weeks: the snapshot
  // dirs appeared on schedule and were empty. Everything below is a real
  // assertion; a failure posts red instead of green.
  const verdict = verifyBackupSnapshot(latest);

  const r = await notifyDiscord({
    kind: "backup",
    title: verdict.ok ? "🗄️ Backup created" : "🚨 Backup FAILED verification",
    description: verdict.ok
      ? "A new MongoDB snapshot completed and passed content checks."
      : `A new snapshot appeared but failed content verification: ${verdict.problems.join("; ")}`,
    color: verdict.ok ? COLORS.green : COLORS.red,
    fields: [
      { name: "Snapshot", value: latest, inline: true },
      ...(verdict.collections != null
        ? [{ name: "Collections", value: String(verdict.collections), inline: true }]
        : []),
      ...(verdict.size ? [{ name: "Size", value: verdict.size, inline: true }] : []),
      ...(verdict.ok
        ? []
        : [{ name: "Path", value: path.join(BACKUP_DIR, latest), inline: false }]),
    ],
    footer: "Automated backup",
  });
  save();
  return { posted: r.posted === true, latest };
}

function startCommunityWorkers({ getDb, launchTicketFix, requestTicketRecheck } = {}) {
  if (typeof getDb !== "function") throw new Error("startCommunityWorkers requires { getDb }");

  // Triage loop: kick once on startup, then on an interval. Skipped entirely
  // when the kill switch is off — the GlitchTip, backup and ops-TLDR pollers
  // below are unrelated to triage and keep running.
  if (TRIAGE_ENABLED) {
    const triageOnce = () =>
      runTriageTick(getDb, { launchTicketFix, requestTicketRecheck })
        .then((r) => {
          if (r && r.processed) console.log("[triage]", JSON.stringify(r.results));
        })
        .catch((e) => console.error("[triage] tick failed:", e.message));
    setTimeout(triageOnce, 8000); // small delay so DB/indexes settle on boot
    setInterval(triageOnce, TICK_MS);
  } else {
    console.log("[triage] DISABLED via TRIAGE_ENABLED=0 — no automated triage will run");
  }

  // GlitchTip poller.
  const glitchOnce = () =>
    pollGlitchtipOnce()
      .then((r) => {
        if (r && r.posted) console.log("[glitchtip]", JSON.stringify(r));
      })
      .catch((e) => console.error("[glitchtip] poll failed:", e.message));
  setTimeout(glitchOnce, 15000);
  setInterval(glitchOnce, GLITCHTIP_POLL_MS);

  // New-backup watcher.
  const backupOnce = () =>
    pollBackupsOnce()
      .then((r) => {
        if (r && (r.posted || r.seeded)) console.log("[backup]", JSON.stringify(r));
      })
      .catch((e) => console.error("[backup] poll failed:", e.message));
  setTimeout(backupOnce, 20000);
  setInterval(backupOnce, BACKUP_POLL_MS);

  // Ticket-repair ops TL;DR safety net — catches PRs when the GitHub webhook
  // misses an `opened` delivery (or was never configured on the game repo).
  const opsTldrOnce = () =>
    getDb()
      .then((db) => pollTicketPrOpsTldrs(db))
      .then((r) => {
        if (r && (r.posted || r.error)) console.log("[ticket-ship] poll", JSON.stringify(r));
      })
      .catch((e) => console.error("[ticket-ship] poll failed:", e.message));
  setTimeout(opsTldrOnce, 25000);
  setInterval(opsTldrOnce, OPS_TLDR_POLL_MS);

  console.log(
    `[triage] community workers started (tick ${
      TRIAGE_ENABLED ? `${TICK_MS}ms` : "DISABLED"
    }, glitchtip ${GLITCHTIP_POLL_MS}ms, backups ${BACKUP_POLL_MS}ms, ops-tldr ${OPS_TLDR_POLL_MS}ms)`
  );
}

module.exports = { startCommunityWorkers, runTriageTick, pollGlitchtipOnce, pollBackupsOnce, parseAssessment, ticketAutoRepairEnabled };
