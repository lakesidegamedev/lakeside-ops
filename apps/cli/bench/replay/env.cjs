'use strict';
// Replay environment: the REAL Keir broker, tool server and agent run a ticket
// against stubbed externals (support MCP, game state, ops-knowledge, Discord
// REST, gh). Production rules (authorization, post shaping, duplicate checks,
// number guards, receipts, effect journaling) run unmodified; only the outside
// world is a fixture. Every external call is recorded in `events` so grading
// reads what the broker actually did, not what the model claimed.
require('./guard.cjs');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const AGENT = path.resolve(__dirname, '../../../agent');
const { createLedger } = require(AGENT + '/lib/operator/store');
const { createBroker } = require(AGENT + '/lib/operator/broker');
const { createSandbox } = require(AGENT + '/lib/operator/sandbox');

const OWNER = '111111111111111111', STAFF = '222222222222222222', BOT = '333333333333333333', GUILD = '444444444444444444', PLAYER_ID = '777000000000000001';
const T0 = Date.parse('2026-10-19T09:00:00Z');

function createEnv({ scenario: sc, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const events = [], channelId = '9000000000' + String(sc.ticket).padStart(8, '0'), channelName = `ticket-${sc.category || 'bug'}-${sc.player}-${sc.ticket}`;
  const issues = JSON.parse(JSON.stringify(sc.issues || [])), created = [];
  let msgSeq = 1, clock = T0;
  const now = () => (clock += 1000);
  const CHARACTER_ID = 4242;
  const card = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: BOT, username: 'Keir', bot: true }, content: `Ticket #${sc.ticket} opened by ${sc.player}. Category: ${sc.category || 'bug'}.`, timestamp: new Date(T0 - 1000).toISOString(), channel_id: channelId };
  const messages = [card, { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: PLAYER_ID, username: sc.player, bot: false }, content: sc.opening, timestamp: new Date(T0).toISOString(), channel_id: channelId }];
  const record = (kind, detail) => { const e = { kind, at: clock, ...detail }; events.push(e); return e; };
  const post = (content, via) => { const m = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: BOT, username: 'Keir', bot: true }, content: String(content), timestamp: new Date(now()).toISOString(), channel_id: channelId }; messages.push(m); record('post', { via, text: m.content, messageId: m.id }); return m; };

  const ticketRecord = () => ({ ticket: { number: sc.ticket }, number: sc.ticket, kind: 'ticket', status: state.status, category: sc.category || 'bug', title: sc.title || sc.opening.slice(0, 80),
    channelId, receipt_url: `https://example.invalid/receipt/${sc.ticket}`, intake: { cardMessageId: card.id }, reporter: { discordId: PLAYER_ID, name: sc.player, characterName: sc.game?.character?.name, profileUrl: `https://www.ahousedividedgame.com/character/${CHARACTER_ID}`, corporationName: sc.game?.character?.corporation },
    supportRecentVisits: [], timeline: events.filter((e) => e.kind === 'ticket_update').map((e) => ({ message: e.message })), ...(sc.support?.record || {}) });
  const state = { status: 'open', trackerNotes: [], cards: [] };

  const SUPPORT_TOOLS = ['support_public_update', 'support_set_status', 'support_tracker_note', 'support_tracker_sync', 'support_resolve', 'support_get', 'support_search', 'support_list'];
  const mcp = {
    servers: () => ['gamestate', 'support', 'ops-knowledge', 'heal-ops'],
    identity: (server) => ({ server, endpoint: 'replay://' + server }),
    list: async (server) => (server === 'support' ? SUPPORT_TOOLS : server === 'gamestate' ? Object.keys(sc.game || {}).map((t) => (t === 'character' ? 'trace_character' : t)) : ['knowledge_query', 'kanban_add', 'kanban_list', 'work_report'])
      .map((name) => ({ name, description: `${server} ${name} (replay fixture)`, inputSchema: { type: 'object', additionalProperties: true } })),
    call: async (server, tool, args = {}) => {
      record('mcp', { server, tool, args });
      // Scenario overrides for tools it models specially (e.g. heal-ops planning).
      const own = sc.mcp?.[server]?.[tool];
      if (own) return own(args, { state, record });
      if (server === 'gamestate') {
        const t = tool === 'trace_character' ? 'character' : tool, v = sc.game?.[t];
        if (v === undefined) throw new Error(`gamestate ${tool}: unknown tool`);
        return typeof v === 'function' ? v(args) : JSON.parse(JSON.stringify(v));
      }
      if (server === 'support') {
        if (tool === 'support_get') return ticketRecord();
        if (tool === 'support_search' || tool === 'support_list') return { results: sc.support?.similar || [], count: 0 };
        if (tool === 'support_public_update') {
          record('ticket_update', { message: args.message, deliver: args.deliver !== false, update_kind: args.update_kind });
          if (args.deliver === false) return { ok: true, delivery: { status: 'recorded' } };
          const m = post(args.message, 'support_public_update');
          return { ok: true, delivery: { posted: true, status: 'posted', messageId: m.id } };
        }
        if (tool === 'support_set_status') { state.status = args.status || args.state || state.status; return { ok: true, status: state.status }; }
        if (tool === 'support_tracker_note') { state.trackerNotes.push(args.body || args.note || ''); return { ok: true }; }
        if (tool === 'support_tracker_sync') return { ok: true, tracker: `kanban-${sc.ticket}` };
        if (tool === 'support_resolve') { state.status = 'resolved'; return { ok: true, resolved: true }; }
        if (tool === 'support_merge') return { ok: true };
        throw new Error(`support ${tool}: not in replay`);
      }
      if (server === 'ops-knowledge') {
        if (tool === 'kanban_list') return { items: state.cards };
        if (tool === 'kanban_add') { const c = { id: 254000 + state.cards.length + 1, title: args.title, github: args.github, github_url: args.github_url, detail: args.detail }; state.cards.push(c); return c; }
        if (tool === 'work_report') return { ok: true };
        if (tool === 'knowledge_query') return { results: sc.knowledge || [] };
        if (tool === 'kanban_get') return state.cards.find((c) => c.id === Number(args.id)) || null;
        return { ok: true };
      }
      if (server === 'heal-ops' && ['heal_query', 'heal_count'].includes(tool)) {
        // The reporter's character, as reporter_state verifies it; anything else reads as empty.
        if (args.collection === 'characters' && args.filter?.sequentialId === CHARACTER_ID) { const c = sc.game?.character || {}; return { matched: 1, docs: [{ name: c.name, sequentialId: CHARACTER_ID, countryId: c.country, homeState: c.region, currentOffice: c.office ?? null }] }; }
        return { matched: 0, docs: [] };
      }
      throw new Error(`${server} is not available in replay`);
    },
  };

  // Discord REST for the ticket channel. Writes are recorded as posts/edits.
  const discord = async (method, route, body) => {
    record('discord', { method, route, body: body ? JSON.stringify(body).slice(0, 2000) : undefined });
    if (/^\/guilds\/[^/]+\/channels/.test(route)) return [{ id: channelId, name: channelName, type: 0, permission_overwrites: [] }];
    let m;
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route))) {
      const msg = messages.find((x) => x.id === m[2]);
      if (method === 'PATCH') { if (msg) msg.content = body?.content ?? msg.content; record('edit', { messageId: m[2], text: body?.content }); return msg || { id: m[2] }; }
      if (method === 'DELETE') return {};
      return msg || messages[0];
    }
    if ((m = /^\/channels\/(\d+)\/messages/.exec(route))) {
      if (method === 'POST') return post(body?.content || '', 'discord');
      return [...messages].reverse();
    }
    if (/^\/channels\/(\d+)$/.test(route)) return { id: channelId, name: channelName, type: 0, guild_id: GUILD };
    return {};
  };

  // gh and git. gh is answered from the scenario's issues; git runs for real on
  // the scenario snapshot when there is one.
  const exec = async (cmd, args = [], opts = {}) => {
    record('exec', { cmd, args: args.map((a) => String(a).slice(0, 300)) });
    if (/\/gh$/.test(cmd) || cmd === 'gh') {
      if (args[0] !== 'api') { if (args[0] === 'pr' && args[1] === 'create') { record('pr_create', { args }); return 'https://github.com/lakesidegamedev/AHDGame/pull/4321\n'; } return ''; }
      const rest = args.slice(1), isPost = rest.includes('POST'), url = rest.find((a) => /^(?:repos|search)\//.test(a)) || '';
      const field = (k) => { const i = rest.findIndex((a, j) => rest[j - 1] === '-f' && a.startsWith(k + '=')); return i >= 0 ? rest[i].slice(k.length + 1) : undefined; };
      let m;
      if (url.startsWith('search/issues')) {
        const q = decodeURIComponent(url.split('q=')[1] || '').toLowerCase(), words = q.split(/\W+/).filter((w) => w.length > 2 && !['repo', 'issue', 'open', 'lakesidegamedev', 'ahdgame'].includes(w));
        const items = [...issues, ...created].filter((i) => i.state === 'open' && words.some((w) => (i.title + ' ' + i.body).toLowerCase().includes(w)));
        return JSON.stringify({ total_count: items.length, items: items.map((i) => ({ number: i.number, title: i.title, body: i.body, html_url: `https://github.com/lakesidegamedev/AHDGame/issues/${i.number}`, state: i.state })) });
      }
      if ((m = /repos\/[^/]+\/AHDGame\/issues\/(\d+)\/comments$/.exec(url)) && isPost) { record('issue_comment', { number: Number(m[1]), body: field('body') }); return JSON.stringify({ id: Date.now(), html_url: `https://github.com/lakesidegamedev/AHDGame/issues/${m[1]}#comment` }); }
      if ((m = /repos\/[^/]+\/AHDGame\/issues\/(\d+)$/.exec(url))) {
        const i = [...issues, ...created].find((x) => x.number === Number(m[1]));
        if (!i) throw new Error('gh: Not Found (HTTP 404)');
        if (isPost || rest.includes('PATCH')) { record('issue_edit', { number: i.number, args: rest }); }
        return JSON.stringify({ number: i.number, title: i.title, body: i.body, state: i.state, html_url: `https://github.com/lakesidegamedev/AHDGame/issues/${i.number}`, labels: (i.labels || []).map((name) => ({ name })) });
      }
      if (/repos\/[^/]+\/AHDGame\/issues$/.test(url) && isPost) { const n = 900 + created.length; const i = { number: n, title: field('title'), body: field('body'), state: 'open', labels: [] }; created.push(i); record('issue_create', { number: n, title: i.title, body: i.body }); return JSON.stringify({ number: n, html_url: `https://github.com/lakesidegamedev/AHDGame/issues/${n}` }); }
      if (/\/pulls\/\d+$/.test(url)) return JSON.stringify({ state: 'closed', head: { ref: 'x' } });
      return 'null';
    }
    // git and tar run for real (snapshots are local); anything else is refused and recorded.
    if (/(?:^|\/)(?:git|tar|chmod)$/.test(cmd)) {
      const r = cp.spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 4 << 20 });
      if (r.status !== 0) throw new Error(String(r.stderr || `${cmd} failed`).slice(0, 2000));
      return r.stdout;
    }
    record('blocked_exec', { cmd });
    throw new Error(`${cmd} is not available in replay`);
  };

  const ledger = createLedger(path.join(dir, 'ledger.json'));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: GUILD, scanChannels: [], taskLifetimeMs: 7 * 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4,
    supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false, scanExclude: [] };
  // A scenario with code gets a real snapshot: a local origin with main, the
  // real sandbox (bwrap overlay) and the broker's own repository_snapshot path.
  let sandbox = { run: async () => ({ code: 1, output: 'No repository snapshot in this ticket replay.' }), capture: async () => ({ code: 1, output: '' }), deps: () => null, attach() {}, remove() {}, workspace: () => dir };
  if (sc.repo) {
    const src = path.isAbsolute(sc.repo) ? sc.repo : path.join(sc.dir || path.join(__dirname, 'scenarios'), sc.repo), origin = path.join(dir, 'origin.git'), clone = path.join(dir, 'AHDGame');
    const git = (...a) => cp.execFileSync('git', a, { encoding: 'utf8' });
    const seed = path.join(dir, 'seed'); fs.cpSync(src, seed, { recursive: true });
    git('init', '-q', '-b', 'main', seed); git('-C', seed, 'add', '-A'); git('-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'snapshot');
    git('clone', '-q', '--bare', seed, origin); git('clone', '-q', origin, clone);
    config.repositories = { AHDGame: clone };
    sandbox = createSandbox(path.join(dir, 'sandbox'));
  }
  const broker = createBroker({ ledger, config, mcp, discord, sandbox, exec, now });

  // The ticket task exactly as intake creates it.
  const job = ledger.createJob(`ticket:${sc.ticket}`, { kind: 'ticket', role: 'support', ticket: sc.ticket, channelId, replyChannel: channelId, actorId: PLAYER_ID, deadline: T0 + 7 * 86400000,
    source: { channelId, channelName, messageId: messages[0].id, authorId: PLAYER_ID, author: sc.player, content: sc.opening, at: new Date(T0).toISOString() } });
  ledger.data.seen ||= {}; ledger.data.seen[`ticket:${sc.ticket}`] = job.id;
  ledger.data.channels ||= {}; ledger.data.channels[channelId] = { ticket: sc.ticket, category: sc.category || 'bug', name: channelName };
  ledger.save();

  // The player answers a question between activations, the way the gateway queues a new message.
  function playerReply(text) {
    clock += 5 * 60000; // the player answers a few minutes later
    const m = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: PLAYER_ID, username: sc.player, bot: false }, content: text, timestamp: new Date(now()).toISOString(), channel_id: channelId };
    messages.push(m); record('player', { text });
    (job.inbox ||= []).push({ content: text, authorId: PLAYER_ID, author: sc.player, messageId: m.id, at: m.timestamp });
    job.lastPlayerAt = job.observedPlayerAt = Date.parse(m.timestamp); ledger.save();
    return m;
  }
  return { broker, ledger, config, job, mcp, discord, exec, events, messages, state, issues, created, playerReply, channelId, now };
}

module.exports = { createEnv, OWNER, PLAYER_ID };
