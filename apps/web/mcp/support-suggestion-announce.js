"use strict";

// Completing a suggestion posts it to the suggestions channel. The game owns
// the post (card, reporter, tally) and its once-only claim; this asks the game
// to run its announcement sweep now instead of on the next turn.

const DONE_STATUSES = new Set(["completed", "implemented"]);

function isSuggestionDone(status) {
  return DONE_STATUSES.has(status);
}

/**
 * Returns { posted } from the game, or { error } without throwing. A failure
 * here never undoes the status change: the post-turn sweep is the backstop.
 */
async function requestSuggestionAnnouncement({
  fetchImpl = fetch,
  gameApi = process.env.AHD_GAME_API_URL || "https://ahousedividedgame.com",
  botApiKey = process.env.DISCORD_BOT_API_KEY,
} = {}) {
  if (!botApiKey) return { error: "DISCORD_BOT_API_KEY is not configured" };
  try {
    const res = await fetchImpl(`${gameApi}/api/discord-bot/suggestions/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Token": botApiKey },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { error: `game returned ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { posted: Number(data.posted) || 0 };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = { isSuggestionDone, requestSuggestionAnnouncement };
