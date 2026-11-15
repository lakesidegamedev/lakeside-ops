'use strict';
// Replay environment: the REAL Keir broker, tool server and agent run a ticket
// against stubbed externals (support MCP, game state, ops-knowledge, Discord
// REST, gh). Production rules (authorization, post shaping, duplicate checks,
// number guards, receipts, effect journaling) run unmodified; only the outside
// world is a fixture. Every external call is recorded in `events` so grading
// reads what the broker actually did, not what the model claimed.
require('./guard.cjs');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
// KEIR_REPLAY_AGENT runs another release's agent tree (e.g. /opt/keir/releases/<id>) on this bench.
const AGENT = process.env.KEIR_REPLAY_AGENT || path.resolve(__dirname, '../../../agent');
const { createLedger } = require(AGENT + '/lib/operator/store');
const { createBroker } = require(AGENT + '/lib/operator/broker');
const { createSandbox } = require(AGENT + '/lib/operator/sandbox');

const OWNER = '111111111111111111', STAFF = '222222222222222222', BOT = '333333333333333333', GUILD = '444444444444444444', PLAYER_ID = '777000000000000001';
const T0 = Date.parse('2026-10-19T09:00:00Z');

function createEnv({ scenario: sc, dir, configOverrides = {}, clock: clk = { t: T0 } }) {
  // KBX5: a day simulation passes its own clock ({ t }) so replay time and scheduler time agree.
  fs.mkdirSync(dir, { recursive: true });
  // KBX3: non-ticket jobs (owner commands, findings) set sc.job; sc.actor 'owner' writes as the owner.
  const ticketJob = !sc.job, ACTOR = sc.actor === 'owner' ? OWNER : PLAYER_ID, ACTOR_NAME = sc.actor === 'owner' ? 'egg3901' : sc.player;
  const events = [], channelId = '9000000000' + String(sc.ticket || 9999).padStart(8, '0'), channelName = ticketJob ? `ticket-${sc.category || 'bug'}-${sc.player}-${sc.ticket}` : (sc.channelName || 'keir-ops');
  const issues = JSON.parse(JSON.stringify(sc.issues || [])), created = [];
  let msgSeq = 1;
  const now = () => (clk.t += 1000);
  // KBX5 world state: a deleted channel answers 404 like Discord does.
  const world = { channelGone: false };
  const CHARACTER_ID = 4242;
  const card = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: BOT, username: 'Keir', bot: true }, content: ticketJob ? `Ticket #${sc.ticket} opened by ${sc.player}. Category: ${sc.category || 'bug'}.` : 'Keir is online.', timestamp: new Date(T0 - 1000).toISOString(), channel_id: channelId };
  const messages = [card, { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: ACTOR, username: ACTOR_NAME, bot: false }, content: sc.opening, timestamp: new Date(T0).toISOString(), channel_id: channelId, ...(sc.openingAttachments ? { attachments: JSON.parse(JSON.stringify(sc.openingAttachments)) } : {}) }];
  const record = (kind, detail) => { const e = { kind, at: clk.t, ...detail }; events.push(e); return e; };
  const post = (content, via) => { const m = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: BOT, username: 'Keir', bot: true }, content: String(content), timestamp: new Date(now()).toISOString(), channel_id: channelId }; messages.push(m); record('post', { via, text: m.content, messageId: m.id }); return m; };

  const ticketRecord = () => ({ ticket: { number: sc.ticket }, number: sc.ticket, kind: 'ticket', status: state.status, category: sc.category || 'bug', title: sc.title || sc.opening.slice(0, 80),
    channelId, receipt_url: `https://example.invalid/receipt/${sc.ticket}`, intake: { cardMessageId: card.id }, reporter: { discordId: PLAYER_ID, name: sc.player, characterName: sc.game?.character?.name, profileUrl: `https://www.ahousedividedgame.com/character/${CHARACTER_ID}`, corporationName: sc.game?.character?.corporation },
    supportRecentVisits: [], timeline: events.filter((e) => e.kind === 'ticket_update').map((e) => ({ message: e.message })), ...(sc.support?.record || {}) });
  const state = { status: 'open', trackerNotes: [], cards: [] };

  // The support service's real input schema for the update tool (zod: message 1 to 1400 chars),
  // so the broker refuses a malformed update before the effect, as it does live.
  const SCHEMAS = { support_public_update: { type: 'object', required: ['kind', 'number', 'message'], properties: { kind: { type: 'string', enum: ['ticket'] }, number: { type: 'integer' }, update_kind: { type: 'string', enum: ['development', 'heal', 'production', 'progress', 'context'] }, message: { type: 'string', minLength: 1, maxLength: 1400 }, deliver: { type: 'boolean' } } } };
  const SUPPORT_TOOLS = ['support_public_update', 'support_set_status', 'support_tracker_note', 'support_tracker_sync', 'support_resolve', 'support_get', 'support_search', 'support_list', 'support_create_suggestion'];
  const mcp = {
    // k10: a scenario can model another read server (turndiag, engine) through sc.mcp.
    servers: () => [...new Set(['gamestate', 'support', 'ops-knowledge', 'heal-ops', ...Object.keys(sc.mcp || {})])],
    identity: (server) => ({ server, endpoint: 'replay://' + server }),
    list: async (server) => [...new Set([...(server === 'support' ? SUPPORT_TOOLS : server === 'gamestate' ? Object.keys(sc.game || {}).map((t) => (t === 'character' ? 'trace_character' : t)) : ['knowledge_query', 'kanban_add', 'kanban_list', 'work_report']), ...Object.keys(sc.mcp?.[server] || {})])]
      .map((name) => ({ name, description: `${server} ${name} (replay fixture)`, inputSchema: SCHEMAS[name] || { type: 'object', additionalProperties: true } })),
    call: async (server, tool, args = {}) => {
      // KBX4 grades claims against what was actually read, so the result is kept (capped).
      const ev = record('mcp', { server, tool, args });
      const r = await callInner(server, tool, args);
      try { ev.result = JSON.stringify(r).slice(0, 20000); } catch {}
      return r;
    },
  };
  async function callInner(server, tool, args) {
    {
      // Scenario overrides for tools it models specially (e.g. heal-ops planning).
      const own = sc.mcp?.[server]?.[tool];
      if (own) return own(args, { state, record });
      if (server === 'gamestate') {
        const t = tool === 'trace_character' ? 'character' : tool, v = sc.game?.[t];
        if (v === undefined) throw new Error(`gamestate ${tool}: unknown tool`);
        return typeof v === 'function' ? v(args, { state, events }) : JSON.parse(JSON.stringify(v));
      }
      if (server === 'support') {
        if (tool === 'support_get') {
          // Other tickets the scenario models (an open incident, an older report).
          const other = sc.support?.tickets?.[Number(args.number)];
          if (other && Number(args.number) !== sc.ticket) return JSON.parse(JSON.stringify({ ticket: { number: Number(args.number) }, number: Number(args.number), kind: 'ticket', ...other }));
          return ticketRecord();
        }
        if (tool === 'support_search' || tool === 'support_list') return { results: sc.support?.similar || [], count: 0 };
        if (tool === 'support_public_update') {
          // Like the real support service: an update needs a message.
          if (!String(args.message || '').trim()) throw Object.assign(new Error('MCP error -32602: Input validation error: message is required'), { code: 'MCP_ARGUMENT_REJECTED' });
          record('ticket_update', { message: args.message, deliver: args.deliver !== false, update_kind: args.update_kind });
          if (args.deliver === false) return { ok: true, delivery: { status: 'recorded' } };
          const m = post(args.message, 'support_public_update');
          return { ok: true, delivery: { posted: true, status: 'posted', messageId: m.id } };
        }
        if (tool === 'support_set_status') { state.status = args.status || args.state || state.status; return { ok: true, status: state.status }; }
        if (tool === 'support_tracker_note') { state.trackerNotes.push(args.body || args.note || ''); return { ok: true }; }
        if (tool === 'support_tracker_sync') return { ok: true, tracker: `kanban-${sc.ticket}` };
        if (tool === 'support_resolve') { state.status = 'resolved'; return { ok: true, resolved: true }; }
        if (tool === 'support_create_suggestion') { const n = 7000 + (state.suggestions = (state.suggestions || 0) + 1); record('suggestion_create', { number: n, args }); return { ok: true, kind: 'suggestion', number: n, receiptUrl: `https://example.invalid/suggestion/${n}` }; }
        if (tool === 'support_merge') { state.mergedInto = Number(args.target_number); state.status = 'merged'; return { ok: true, steps: ['moved reporter', 'closed source channel'] }; }
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
    }
  }

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
    if (world.channelGone && route.startsWith(`/channels/${channelId}`)) throw Object.assign(new Error('Discord 404: Unknown Channel'), { status: 404 });
    if (/^\/channels\/(\d+)$/.test(route)) return { id: channelId, name: channelName, type: 0, guild_id: GUILD };
    return {};
  };

  // gh and git. gh is answered from the scenario's issues; git runs for real on
  // the scenario snapshot when there is one.
  const exec = async (cmd, args = [], opts = {}) => {
    record('exec', { cmd, args: args.map((a) => String(a).slice(0, 300)) });
    if (/\/gh$/.test(cmd) || cmd === 'gh') {
      // KBX3: scenarios can script GitHub (pull state, checks, merges); undefined falls through.
      if (sc.gh) { const o = await sc.gh(args, { record, state }); if (o !== undefined) return typeof o === 'string' ? o : JSON.stringify(o); }
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
      // A real pull request shape (no PR exists in a replay unless the scenario adds one).
      if ((m = /\/pulls\/(\d+)$/.exec(url))) return JSON.stringify({ number: Number(m[1]), title: 'Unrelated closed pull request', state: 'closed', merged: false, base: { ref: 'development' }, head: { ref: 'x', sha: '0'.repeat(40) }, html_url: `https://github.com/lakesidegamedev/AHDGame/pull/${m[1]}` });
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
    const seed = path.join(dir, 'seed'); fs.cpSync(fs.realpathSync(src), seed, { recursive: true });
    // Like AHDGame: dependencies the sandbox mounts are never part of a change.
    if (!fs.existsSync(path.join(seed, '.gitignore'))) fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
    git('init', '-q', '-b', 'main', seed); git('-C', seed, 'add', '-A'); git('-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'snapshot');
    git('clone', '-q', '--bare', seed, origin);
    // Like AHDGame: patches publish against development, which matches main here.
    git('-C', origin, 'branch', 'development', 'main');
    git('clone', '-q', origin, clone);
    config.repositories = { AHDGame: clone };
    sandbox = createSandbox(path.join(dir, 'sandbox'));
  }
  // Production settings the broker reads at creation (child routes for delegation).
  Object.assign(config, configOverrides);
  // Keir 10: a scenario can model the HTTP services behind native tools (the Ask site). sc.http maps a path to a JSON body or a
  // function (body) => JSON; anything unmapped answers 404. Ask is then configured exactly as in production.
  if (sc.http) {
    config.askUrl = 'http://ask.replay.invalid'; config.askSecret = 'replay-secret';
    config.w3Fetch = async (url, opts = {}) => {
      const p = new URL(url).pathname, h = sc.http[p];
      if (h === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      const body = typeof h === 'function' ? h(opts.body ? JSON.parse(opts.body) : {}) : h;
      events.push({ kind: 'http', path: p });
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  }
  // Production passes a notebook (remember, recall, player notes); each trial gets its own, empty.
  const notebook = require(AGENT + '/lib/operator/knowledge').createNotebook({ file: path.join(dir, 'notebook.json') });
  // Optional seeded memory (KBX2 stale-note traps): notes exactly as an earlier task would have saved them.
  for (const n of sc.notebook || []) notebook.remember({ by: 'replay-seed', ...n });
  // Keir 10: production queues a coding worker for a filed bug (codingworkers.js, run by the operator loop). The replay
  // records the queued build as an event instead of running it, so a scenario can grade that the fix was set in motion.
  let workerRuns = 0;
  const codingWorkers = () => ({ dispatch: async (spec) => { const id = `cw-replay-${++workerRuns}`; events.push({ kind: 'coding_worker', run: id, issue: spec.issue || null, changeClass: spec.changeClass || null, title: spec.title }); return { run: { id } }; } });
  const broker = createBroker({ ledger, config, mcp, discord, sandbox, exec, now, notebook, codingWorkers });
  // Every broker tool call is recorded as an attempt ('tool', with ok/error), so
  // grading can see what was tried and refused, not only what took effect.
  // Owner decisions and privileged action requests the call opened are
  // recorded too ('decision', 'action'): they are DMs and approval cards.
  const innerTool = broker.tool;
  broker.tool = async (j, name, input, signal) => {
    const e = record('tool', { name, input: JSON.parse(JSON.stringify(input ?? {}, (k, v) => (typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) : v))) });
    const seenDecisions = new Set(Object.keys(ledger.data.decisions || {})), seenActions = new Set(Object.keys(ledger.data.actions || {}));
    try { const r = await innerTool(j, name, input, signal); e.ok = true; try { e.result = JSON.stringify(r).slice(0, name === 'calculate' ? 4000 : 3000); } catch {} return r; }
    catch (err) { e.ok = false; e.error = String(err?.message || err).slice(0, 600); throw err; }
    finally {
      // openDecision stamps the wall clock; the replay runs on its own clock, so
      // restamp it or every later post compares against a time from another day.
      for (const [id, x] of Object.entries(ledger.data.decisions || {})) if (!seenDecisions.has(id)) { x.at = clk.t; ledger.save(); record('decision', { id, question: x.question, actionId: x.actionId || null }); }
      for (const [id, a] of Object.entries(ledger.data.actions || {})) if (!seenActions.has(id)) record('action', { id, actionKind: a.kind, actionState: a.state, args: a.args });
    }
  };

  // The ticket task exactly as intake creates it.
  const source = { channelId, channelName, messageId: messages[ticketJob ? 0 : 1].id, authorId: ACTOR, author: ACTOR_NAME, content: sc.opening, at: new Date(T0).toISOString(), ...(sc.job?.source || {}) };
  const job = ticketJob
    ? ledger.createJob(`ticket:${sc.ticket}`, { kind: 'ticket', role: 'support', ticket: sc.ticket, channelId, replyChannel: channelId, actorId: PLAYER_ID, deadline: T0 + 7 * 86400000, source })
    : ledger.createJob(sc.job.key || `kbx:${sc.id}`, { role: 'owner', actorId: ACTOR, channelId, replyChannel: channelId, deadline: T0 + 7 * 86400000, ...sc.job, source });
  ledger.data.seen ||= {}; ledger.data.seen[ticketJob ? `ticket:${sc.ticket}` : (sc.job.key || `kbx:${sc.id}`)] = job.id;
  ledger.data.channels ||= {}; if (ticketJob) ledger.data.channels[channelId] = { ticket: sc.ticket, category: sc.category || 'bug', name: channelName };
  ledger.save();

  // The player answers a question between activations, the way the gateway queues a new message.
  function playerReply(text) {
    clk.t += 5 * 60000; // the player answers a few minutes later
    const m = { id: '5000000000000000' + String(msgSeq++).padStart(2, '0'), author: { id: ACTOR, username: ACTOR_NAME, bot: false }, content: text, timestamp: new Date(now()).toISOString(), channel_id: channelId };
    messages.push(m); record('player', { text });
    (job.inbox ||= []).push({ content: text, authorId: ACTOR, author: ACTOR_NAME, messageId: m.id, at: m.timestamp });
    job.lastPlayerAt = job.observedPlayerAt = Date.parse(m.timestamp); ledger.save();
    return m;
  }
  return { broker, ledger, config, job, mcp, discord, exec, events, messages, state, issues, created, playerReply, channelId, now, clock: clk, world, record, OWNER, STAFF, BOT, PLAYER_ID };
}

module.exports = { createEnv, OWNER, PLAYER_ID };
