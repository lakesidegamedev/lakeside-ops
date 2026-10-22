// ─── OPS DISCORD NOTIFIER ─────────────────────────────────────────────────
// Small, dependency-free helper for posting ops events (PR reviews, CI/CD,
// GlitchTip issues, status/downtime) to Discord via channel webhooks.
//
// Webhook URLs come from env. Each event `kind` resolves to its own URL with a
// fallback to a shared ops webhook, so you can route everything to one channel
// or split per concern:
//   pr-review  -> DISCORD_PR_REVIEW_WEBHOOK_URL  || DISCORD_OPS_WEBHOOK_URL
//   cicd       -> DISCORD_CICD_WEBHOOK_URL       || DISCORD_OPS_WEBHOOK_URL
//   glitchtip  -> DISCORD_GLITCHTIP_WEBHOOK_URL  || DISCORD_OPS_WEBHOOK_URL
//   status     -> DISCORD_STATUS_WEBHOOK_URL     || DISCORD_OPS_WEBHOOK_URL
//
// If no URL is configured the call is a no-op (returns {skipped:"no webhook"}),
// and it NEVER throws — notification failures must not break the caller.

const KIND_ENV = {
  "pr-review": "DISCORD_PR_REVIEW_WEBHOOK_URL",
  cicd: "DISCORD_CICD_WEBHOOK_URL",
  glitchtip: "DISCORD_GLITCHTIP_WEBHOOK_URL",
  status: "DISCORD_STATUS_WEBHOOK_URL",
  backup: "DISCORD_BACKUP_WEBHOOK_URL",
  security: "DISCORD_SECURITY_WEBHOOK_URL",
};

// Discord embed colors (decimal).
const COLORS = {
  blurple: 0x5865f2,
  green: 0x57f287,
  yellow: 0xfee75c,
  red: 0xed4245,
  grey: 0x99aab5,
};

function webhookUrlFor(kind) {
  const specific = KIND_ENV[kind] && process.env[KIND_ENV[kind]];
  return specific || process.env.DISCORD_OPS_WEBHOOK_URL || "";
}

// Discord embed description hard limit is 4096 chars; keep margin.
function clamp(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// Post one embed. Returns {posted:true} / {skipped} / {error} — never throws.
// `content` is an optional plain-text line above the embed (e.g. a role ping);
// `mentionRoleIds` whitelists which role IDs in `content` are allowed to ping.
async function notifyDiscord({
  kind,
  title,
  description,
  url,
  color,
  fields,
  footer,
  content,
  mentionRoleIds,
} = {}) {
  const webhook = webhookUrlFor(kind);
  if (!webhook) return { skipped: "no webhook" };

  const embed = {
    title: clamp(title, 256),
    description: clamp(description, 4000),
    color: typeof color === "number" ? color : COLORS.blurple,
  };
  if (url) embed.url = url;
  if (Array.isArray(fields) && fields.length) {
    embed.fields = fields.slice(0, 25).map((f) => ({
      name: clamp(String(f.name ?? ""), 256),
      value: clamp(String(f.value ?? ""), 1024),
      inline: !!f.inline,
    }));
  }
  if (footer) embed.footer = { text: clamp(String(footer), 2048) };
  embed.timestamp = new Date().toISOString();

  const payload = { embeds: [embed] };
  if (content) payload.content = clamp(String(content), 2000);
  // Only allow the explicitly-listed roles to actually ping (no @everyone/@here).
  payload.allowed_mentions = {
    parse: [],
    roles: Array.isArray(mentionRoleIds) ? mentionRoleIds.filter(Boolean).slice(0, 100) : [],
  };

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `discord ${r.status}: ${body.slice(0, 200)}` };
    }
    return { posted: true };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { notifyDiscord, COLORS, webhookUrlFor };
