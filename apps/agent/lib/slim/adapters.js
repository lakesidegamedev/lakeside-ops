"use strict";
// Outside effects for the slim Keir tools. Live adapters reach the support
// service, GitHub and the owner. Replay adapters read real data but capture
// every write, and hide anything that happened after the replay point.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function run(cmd, args, { cwd, timeoutMs = 60000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8e6, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args[0]} failed: ${String(stderr || err.message).slice(-600)}`));
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const REQUIRED_CHECKS = ["verify", "dependency-review", "custom-rules"];

function shared({ mcp }) {
  return {
    mcpList: (server) => mcp.list(server),
    mcpCall: (server, tool, args) => mcp.call(server, tool, args, false),
    historySearch: (args) => mcp.call("support", "support_history_search", args, false),
    historyRead: (args) => mcp.call("support", "support_history_get", args, false),
  };
}

/** Live: real posts, real PRs, real approval requests. Used only in live mode. */
async function discordApi(method, route, body) {
  const r = await fetch(`https://discord.com/api/v10${route}`, { method, headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`discord ${method} ${r.status}`);
  return r.status === 204 ? null : r.json();
}

function createLiveAdapters({ mcp, cfg, ticketCheckout, notifyOwner, gh = (args, o) => run("gh", args, o), git = (args, o) => run("git", args, o) }) {
  return {
    ...shared({ mcp }),
    async readTicket(n) {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: Number(n) }, false);
      const count = (t._images || []).length;
      return { ...t, ...(count ? { screenshots: `${count} screenshot(s) on this ticket; they are attached to your conversation as images` } : {}) };
    },
    /** The ticket's screenshots, as support_get returns them: [{ data (base64), mimeType }]. */
    async ticketImages(n) {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: Number(n) }, false);
      return t._images || [];
    },
    async githubGet(apiPath) {
      if (!/^repos\/[A-Za-z0-9._/?=&,-]+$/.test(apiPath)) throw new Error("GET paths under repos/ only");
      return JSON.parse(await gh(["api", "-X", "GET", apiPath], { timeoutMs: 30000 }));
    },
    async post({ ticket, text }) {
      const r = await mcp.call("support", "support_public_update", { kind: "ticket", number: Number(ticket), message: text, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true);
      const d = r?.delivery?.delivery || r?.delivery || {};
      const parts = Array.isArray(d.parts) ? d.parts.map((p) => p.id).filter(Boolean) : [];
      return { delivered: r?.delivery?.status !== "failed", status: r?.delivery?.status || null, channelId: d.channelId || d.channel || null, messageIds: parts.length ? parts : (d.messageId ? [d.messageId] : []) };
    },
    /** Rewrite one of Keir's own posted messages in place. Extra parts of a split post are removed. */
    async editPost({ channelId, messageIds, text }) {
      if (!channelId || !messageIds?.length) throw new Error("That post has no message on record to edit.");
      await discordApi("PATCH", `/channels/${channelId}/messages/${messageIds[0]}`, { content: String(text).slice(0, 1990) });
      for (const id of messageIds.slice(1)) await discordApi("DELETE", `/channels/${channelId}/messages/${id}`).catch(() => {});
      return { edited: true };
    },
    /** Delete one of Keir's own posted messages (every part). */
    async deletePost({ channelId, messageIds }) {
      if (!channelId || !messageIds?.length) throw new Error("That post has no message on record to delete.");
      for (const id of messageIds) await discordApi("DELETE", `/channels/${channelId}/messages/${id}`).catch((e) => { if (!/404/.test(e.message)) throw e; });
      return { deleted: true };
    },
    async resolve({ ticket, message, actions, followUp }) {
      const r = await mcp.call("support", "support_resolve", { number: Number(ticket), message, actions, ...(followUp ? { followUp } : {}), source: "agent", attribution: { agent: "keir", evidence: "slim Keir session" } }, true);
      return { delivered: r?.notification?.status !== "failed", status: r?.ticket_status || null };
    },
    async approval({ ticket, kind, id, payload }) {
      // Durable first, then the owner is told. The owner's answer comes back as an event.
      const dir = path.join(cfg.stateDir, "approvals");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ticket, kind, id, payload, at: new Date().toISOString(), status: "pending" }, null, 2), { mode: 0o600 });
      const sent = notifyOwner ? await notifyOwner({ ticket, kind, id, payload }) : { sent: false, reason: "no owner channel configured" };
      return { recorded: true, ...sent };
    },
    async openPr({ ticket, title, body, tests }) {
      const cwd = ticketCheckout(ticket);
      const branch = `keir/ticket-${Number(ticket)}`;
      await git(["-C", cwd, "checkout", "-B", branch]);
      // node_modules is a link to the shared install and gitignored; it is never part of a fix.
      await git(["-C", cwd, "add", "-A"]);
      const staged = (await git(["-C", cwd, "diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
      if (!staged.length) throw new Error("Nothing to commit: the checkout has no changes.");
      if (staged.some((f) => f === "node_modules" || f.startsWith("node_modules/"))) throw new Error("node_modules must not be committed.");
      await git(["-C", cwd, "commit", "-m", `${title}\n\n${body}\n\nTests: ${tests}`]);
      await git(["-C", cwd, "push", "-u", "origin", branch, "--force-with-lease"]);
      const url = (await gh(["pr", "create", "-R", cfg.gameRepoSlug, "--base", "development", "--head", branch, "--title", title, "--body", `${body}\n\nTests: ${tests}`], { cwd })).trim().split("\n").pop();
      return { opened: true, url };
    },
    /**
     * Where a merged game fix is on its way to players, and whether the
     * auto-promoter (development -> staging -> main on green) is held for it.
     */
    async promotionStatus({ pr }) {
      const R = cfg.gameRepoSlug;
      const n = Number(String(pr).match(/\/pull\/(\d+)/)?.[1] || pr);
      if (!n) throw new Error("Give the fix's pull request url or number");
      const fix = JSON.parse(await gh(["api", `repos/${R}/pulls/${n}`]));
      const out = { pr: n, merged: Boolean(fix.merged), mergeSha: fix.merge_commit_sha || null, base: fix.base?.ref, inDevelopment: false, inStaging: false, inMain: false, autoPromote: { enabled: true, reasons: [] }, promotePrs: [], holds: [] };
      const off = fs.existsSync(cfg.autoPromoteOffFile);
      let timer = "unknown"; try { timer = (await run("systemctl", ["is-active", cfg.autoPromoteTimer])).trim(); } catch (e) { timer = "inactive"; }
      if (off) out.autoPromote.reasons.push("the auto-promote off switch is set");
      if (timer !== "active") out.autoPromote.reasons.push(`the auto-promote timer is ${timer}`);
      out.autoPromote.enabled = out.autoPromote.reasons.length === 0;
      if (!fix.merged) { out.note = "The fix is not merged yet; promotion starts after it merges into development."; return out; }
      const contains = async (branch) => {
        try { const c = JSON.parse(await gh(["api", `repos/${R}/compare/${branch}...${fix.merge_commit_sha}`, "--jq", "{status: .status}"])); return ["behind", "identical"].includes(c.status); } catch { return false; }
      };
      [out.inDevelopment, out.inStaging, out.inMain] = [await contains("development"), await contains("staging"), await contains("main")];
      if (out.inMain) {
        out.deploy = await require("./deploy").liveStatus({ repo: cfg.gameRepo, releasesFile: cfg.deployReleasesFile, mergeSha: fix.merge_commit_sha });
        out.live = out.deploy.live;
        out.note = out.live
          ? "The fix is live on the game (web and worker both contain it). Read the player's own data now, record the receipt, then tell them."
          : "The fix is on main and waits for the next deploy. You will be woken the moment it is live.";
        return out;
      }
      const hop = out.inStaging ? { base: "main", head: "staging" } : { base: "staging", head: "development" };
      const open = JSON.parse(await gh(["api", `repos/${R}/pulls?state=open&base=${hop.base}&head=${R.split("/")[0]}:${hop.head}`]));
      let heldCards = [];
      try { heldCards = ((await mcp.call("ops-knowledge", "kanban_list", { product: "ahd", q: "Auto-promote held", limit: 50 }, false)).items || []).map((c) => String(c.title || "")); } catch { /* board unreadable */ }
      for (const p of open) {
        const full = JSON.parse(await gh(["api", `repos/${R}/pulls/${p.number}`]));
        const runs = JSON.parse(await gh(["api", `repos/${R}/commits/${full.head.sha}/check-runs?per_page=100`])).check_runs || [];
        const failed = REQUIRED_CHECKS.filter((c) => runs.some((r) => r.name === c && r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion)));
        const reasons = [];
        if (full.draft) reasons.push("draft");
        if ((full.labels || []).some((l) => l.name === "hold")) reasons.push("labelled hold");
        if (full.mergeable_state === "dirty") reasons.push("has conflicts");
        if (failed.length) reasons.push(`required checks failed: ${failed.join(", ")}`);
        const card = heldCards.find((t) => t.includes(full.head.sha.slice(0, 12)));
        if (card) reasons.push(`held card: ${card}`);
        out.promotePrs.push({ number: p.number, from: hop.head, to: hop.base, url: full.html_url, reasons });
        out.holds.push(...reasons.map((r) => `${hop.head} to ${hop.base} #${p.number}: ${r}`));
      }
      if (!out.autoPromote.enabled) out.holds.unshift(...out.autoPromote.reasons);
      out.held = out.holds.length > 0;
      out.note = out.held ? "The promotion is held; the owner can release it with request_promote." : "Auto-promote will ship this by itself once the required checks are green. Track it with promotion_status and a reminder; do not ask the owner.";
      return out;
    },
    /** Files this ticket's checkout changes against development. */
    async changedFiles(ticket) {
      const cwd = ticketCheckout(ticket);
      const diff = await git(["-C", cwd, "diff", "--name-only", "origin/development"]);
      const untracked = await git(["-C", cwd, "ls-files", "--others", "--exclude-standard"]);
      return [...new Set([...diff.split("\n"), ...untracked.split("\n")].map((f) => f.trim()).filter((f) => f && f !== "node_modules"))];
    },
    /**
     * Open or merged pull requests from the last 48 hours that may already fix this: { strong, related }.
     * strong: mentions the ticket, or shares most of its code files (overlap over the union of both
     * PRs' code files at least 0.4; tests and notes ignored). related: shares any code file.
     * Release promotions (from development or staging) are not fixes and are skipped.
     */
    async duplicatePrs({ ticket, files, now = Date.now() }) {
      const R = cfg.gameRepoSlug;
      const since = now - 48 * 3600000;
      const code = (list) => list.filter((f) => !/(?:\.test\.|\.spec\.|(?:^|\/)__tests__\/|\.md$|^content\/changelog\/)/.test(f));
      const mine = code(files || []);
      const pulls = JSON.parse(await gh(["api", `repos/${R}/pulls?state=all&sort=updated&direction=desc&per_page=60`]));
      const mention = new RegExp(`(?:#|ticket\\s*)${Number(ticket)}\\b`, "i");
      const strong = [], related = [];
      for (const p of pulls) {
        if (Date.parse(p.updated_at) < since) break;
        if (["development", "staging", `keir/ticket-${Number(ticket)}`].includes(p.head?.ref)) continue;
        const merged = Boolean(p.merged_at);
        if (p.state === "closed" && !merged) continue;
        const entry = { number: p.number, url: p.html_url, state: merged ? "merged" : "open", title: p.title, why: [] };
        if (mention.test(`${p.title}\n${p.body || ""}`)) entry.why.push("mentions this ticket");
        let share = 0;
        if (mine.length) {
          const theirs = code(JSON.parse(await gh(["api", `repos/${R}/pulls/${p.number}/files?per_page=100`, "--jq", "[.[].filename]"])));
          const same = theirs.filter((f) => mine.includes(f));
          share = same.length / new Set([...mine, ...theirs]).size;
          if (same.length) entry.why.push(`changes the same code: ${same.slice(0, 5).join(", ")}`);
        }
        if (entry.why.includes("mentions this ticket") || share >= 0.4) strong.push(entry);
        else if (entry.why.length) related.push(entry);
      }
      return { strong, related };
    },
    /** Is a merged game fix live on production (web and worker)? */
    async deployStatus({ pr }) {
      const R = cfg.gameRepoSlug;
      const n = Number(String(pr).match(/\/pull\/(\d+)/)?.[1] || pr);
      const fix = JSON.parse(await gh(["api", `repos/${R}/pulls/${n}`]));
      if (!fix.merged) return { pr: n, merged: false, live: false, note: "Not merged yet." };
      return { pr: n, merged: true, ...(await require("./deploy").liveStatus({ repo: cfg.gameRepo, releasesFile: cfg.deployReleasesFile, mergeSha: fix.merge_commit_sha })) };
    },
    /** A public game page as a logged-out visitor sees it, rendered on the host (old Keir's page viewer). */
    async siteRead(input) {
      const r = await require("../operator/pageview").render(input);
      return { title: r.title, url: r.url, device: r.device, text: r.text, note: r.note };
    },
    /** A summary for the moderators' channel. */
    async modPost({ text }) {
      if (!cfg.modChannel) throw new Error("The moderators' channel is not configured.");
      await mcp.call("discord", "discord_send", { channel: cfg.modChannel, content: text.slice(0, 1900) }, true);
      return { posted: true };
    },
    /**
     * A character's party roles: national party (chair, vice chair, treasurer, committee, campaigner), state party
     * (chair, vice chair, treasurer, campaigner) and caucus (chair, vice chair). Fixed read-only queries through
     * heal_query on Keir's read token; nothing else of the database is reachable from here.
     */
    async partyRoles({ character }) {
      const q = (collection, filter, projection, limit = 50) => mcp.call("heal-ops", "heal_query", { env: "prod", collection, filter, projection, limit }, false);
      return partyRolesFrom(q, character);
    },
    async mergeToDevelopment({ pr }) {
      const n = Number(String(pr).match(/\/pull\/(\d+)/)?.[1]);
      if (!n) throw new Error("Not a pull request url");
      const info = JSON.parse(await gh(["api", `repos/${cfg.gameRepoSlug}/pulls/${n}`]));
      if (info.base?.ref !== "development") throw new Error("Only pull requests into development can be merged here.");
      const runs = JSON.parse(await gh(["api", `repos/${cfg.gameRepoSlug}/commits/${info.head.sha}/check-runs?per_page=100`])).check_runs || [];
      const missing = REQUIRED_CHECKS.filter((c) => !runs.some((r) => r.name === c && r.status === "completed" && r.conclusion === "success"));
      if (missing.length) return { merged: false, waiting: missing, note: "Required checks are not green yet. Set a reminder and come back." };
      await gh(["api", "-X", "PUT", `repos/${cfg.gameRepoSlug}/pulls/${n}/merge`, "-f", "merge_method=squash", "-f", `sha=${info.head.sha}`]);
      return { merged: true };
    },
  };
}

/**
 * Replay: the ticket as it was at `cursor` (an ISO time). Reads of this
 * ticket and of other tickets stop at the cursor; reads that only exist with
 * hindsight (the work board, notes, GitHub, the code index, which follow
 * today's code) are closed. Game data is today's, which the report says.
 * Every write is captured and answered as if it worked.
 */
function createReplayAdapters({ mcp, ticket, getCursor, history }) {
  const before = (at) => Date.parse(at) <= Date.parse(getCursor());
  const closed = (what) => async () => { throw new Error(`${what} is not available right now.`); };
  return {
    ...shared({ mcp }),
    async readTicket(n) {
      if (Number(n) !== Number(ticket)) throw new Error("Only this ticket");
      const events = (history.events || []).filter((e) => before(e.at));
      const talk = events.filter((e) => /_message$/.test(e.kind) && e.kind !== "system_message").map((e) => ({ at: e.at, who: e.who, text: e.text }));
      return { number: ticket, title: history.title, category: history.category, reporter: history.reporter, character: history.character, opened: history.opened, status: "open", conversation: talk };
    },
    async historySearch(args) {
      const cursorDay = String(getCursor()).slice(0, 10);
      const r = await mcp.call("support", "support_history_search", { ...args, until: args.until && args.until < cursorDay ? args.until : cursorDay, exclude: ticket }, false);
      // A ticket opened before the cursor may have closed after it: show what was known then.
      if (Array.isArray(r?.results)) for (const x of r.results) if (x.closed && !before(x.closed)) { x.closed = null; x.status = "open"; x.snippet = "(still open at this time)"; }
      return r;
    },
    async historyRead(args) {
      const r = await mcp.call("support", "support_history_get", args, false);
      if (r?.opened && !before(r.opened)) throw new Error(`ticket #${args.number} has no history`);
      if (Array.isArray(r?.events)) r.events = r.events.filter((e) => before(e.at));
      if (r?.closed && !before(r.closed)) { r.closed = null; r.status = "open"; }
      return r;
    },
    githubGet: closed("GitHub"),
    promotionStatus: closed("Promotion status"),
    ticketImages: async () => [],
    partyRoles: closed("Party roles"),
    modPost: async () => ({ posted: true, status: "captured" }),
    deployStatus: closed("Deploy status"),
    siteRead: closed("The public site"),
    changedFiles: async () => [],
    duplicatePrs: async () => ({ strong: [], related: [] }),
    mcpCall: async (server, tool, args) => {
      if (server === "ops-knowledge") throw new Error("That index is not available right now; read the code in your checkout with the shell instead.");
      return mcp.call(server, tool, args, false);
    },
    post: async () => ({ delivered: true, status: "captured", channelId: "replay", messageIds: ["replay"] }),
    editPost: async () => ({ edited: true, captured: true }),
    deletePost: async () => ({ deleted: true, captured: true }),
    resolve: async () => ({ delivered: true, status: "captured" }),
    approval: async () => ({ recorded: true, sent: false, captured: true }),
    openPr: async ({ ticket: n }) => ({ opened: true, url: `https://example.invalid/replay/ticket-${n}/pull`, captured: true }),
    mergeToDevelopment: async () => ({ merged: false, captured: true, note: "Recorded. The checks run on their own; set a reminder to come back." }),
  };
}

/** party_roles over a query function q(collection, filter, projection, limit) -> { docs }. */
async function partyRolesFrom(q, character) {
  const who = String(character || "").trim();
  if (!who) throw new Error("Give a character name or id.");
  const byId = /^[a-f0-9]{24}$/i.test(who);
  const found = await q("characters", byId ? { $expr: { $eq: [{ $toString: "$_id" }, who.toLowerCase()] } } : { name: who }, { name: 1, party: 1 }, 2);
  const ch = (found.docs || [])[0];
  if (!ch) return { found: false, note: `No character named ${who}.` };
  const id = String(ch._id);
  const is = (field) => ({ $eq: [{ $toString: `$${field}` }, id] });
  const inList = (field) => ({ $in: [id, { $map: { input: { $ifNull: [`$${field}`, []] }, as: "x", in: { $toString: "$$x" } } }] });
  const [national, state, caucus] = await Promise.all([
    q("politicalParties", { $expr: { $or: [is("chairId"), is("viceChairId"), is("treasurerId"), inList("committeeIds"), inList("campaignerIds")] } }, { name: 1, countryId: 1, chairId: 1, viceChairId: 1, treasurerId: 1, committeeIds: 1, campaignerIds: 1 }),
    q("statePartyOrg", { $expr: { $or: [is("chairId"), is("viceChairId"), is("treasurerId"), is("campaignerId")] } }, { stateId: 1, partyId: 1, chairId: 1, viceChairId: 1, treasurerId: 1, campaignerId: 1 }),
    q("caucuses", { $expr: { $or: [is("chairId"), is("viceChairId")] } }, { name: 1, partyId: 1, chairId: 1, viceChairId: 1, disbandedAt: 1 }),
  ]);
  const roleOf = (d, fields) => fields.filter(([f]) => (Array.isArray(d[f]) ? d[f].map(String).includes(id) : String(d[f]) === id)).map(([, label]) => label);
  const roles = [
    ...(national.docs || []).flatMap((d) => roleOf(d, [["chairId", "chair"], ["viceChairId", "vice chair"], ["treasurerId", "treasurer"], ["committeeIds", "committee member"], ["campaignerIds", "campaigner"]]).map((role) => ({ level: "national party", party: d.name, country: d.countryId, role }))),
    ...(state.docs || []).flatMap((d) => roleOf(d, [["chairId", "chair"], ["viceChairId", "vice chair"], ["treasurerId", "treasurer"], ["campaignerId", "campaigner"]]).map((role) => ({ level: "state party", state: d.stateId, party: d.partyId, role }))),
    ...(caucus.docs || []).filter((d) => !d.disbandedAt).flatMap((d) => roleOf(d, [["chairId", "chair"], ["viceChairId", "vice chair"]]).map((role) => ({ level: "caucus", caucus: d.name, party: d.partyId, role }))),
  ];
  return { found: true, character: ch.name, party: ch.party ?? null, roles, note: roles.length ? null : "No party, state party or caucus role." };
}

module.exports = { partyRolesFrom, createLiveAdapters, createReplayAdapters, REQUIRED_CHECKS, run };
