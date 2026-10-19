'use strict';
// A simulated support ticket behind Keir's real tool names and schemas. It plays
// the broker: the model's tool calls land here, every call is logged for the
// rubric, and a scripted player answers questions between activations.
// Hidden solution: the desktop app sends the wage as text, the server stores no
// wage, hiring stops and the shipyard loses every worker. Issue #812 already
// tracks it; the workaround is to set the wage again on the website.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');

const TICKET = 4242, PLAYER = 'harbour_ops';
const OPENING = "My shipyard has built nothing for two turns. I changed the wage a couple of days ago and now it says 0 workers. Was there a strike? Please fix it fast, I'm losing money every turn.";
const CLIENT_ANSWER = 'I did it in the desktop app, version 2.4.0. I typed 14.50 into the wage box.';
const OBSERVABLE_ANSWER = "Can't you see that on your side? It just says 0 workers and nothing is being built.";

const GAME = {
  game_overview: { turn: 213, year: 1956 },
  trace_corp: { corporation: { name: 'Tyneside Shipworks', currency: 'GBP', liquidCapital: 6420000, region: 'UK-NE' }, sectors: ['Shipbuilding'] },
  trace_sector: { corporation: 'Tyneside Shipworks', sector: 'Shipbuilding', region: 'UK-NE', currency: 'GBP',
    turns: [
      { turn: 210, workers: 4180, targetWorkers: 4200, offeredWage: 13.4, output: 12, strike: false },
      { turn: 211, workers: 0, targetWorkers: 4200, offeredWage: null, output: 0, strike: false, note: 'offered wage changed this turn' },
      { turn: 212, workers: 0, targetWorkers: 4200, offeredWage: null, output: 0, strike: false },
    ], regionalMinimumWage: 13.1, activeStrikes: [] },
  character: { name: 'M. Ferris', country: 'United Kingdom', region: 'North East England', office: null, corporation: 'Tyneside Shipworks' },
};
const ISSUES = [
  { number: 812, state: 'open', title: 'Desktop app wage change stores no wage, sector loses all workers', labels: ['bug', 'AHDClient'], body: 'Setting a wage from the desktop app leaves the sector with no offered wage; hiring stops next turn.' },
  { number: 790, state: 'open', title: 'Minimum wage notifications arrive a turn late', labels: ['bug'], body: 'Notification timing only.' },
  { number: 805, state: 'open', title: 'Workers leave after a strike even when wages are raised', labels: ['bug'], body: 'Post-strike attrition.' },
  { number: 820, state: 'open', title: 'Wage slider layout broken on small mobile screens', labels: ['bug', 'ui'], body: 'Layout only.' },
  { number: 771, state: 'closed', title: 'Shipyards produce nothing when steel is short', labels: ['bug'], body: 'Fixed in 1.11.' },
];
const SIMILAR = [{ ticket: 4198, resolvedAt: '2026-10-02', summary: 'Sector showed 0 workers after a wage change. Reporter used the desktop app. Linked to the open issue about desktop wage changes; told to set the wage again on the website.' }];
const SUPPORT_TOOLS = ['support_public_update', 'support_set_status', 'support_tracker_note', 'support_resolve'];

function createWorld({ repoDir, stateDir }) {
  const log = [], channel = [{ role: 'player', author: PLAYER, text: OPENING, at: 0 }];
  const state = { cards: [], statusCard: null, ticketStatus: 'open', trackerNotes: [], issuesTouched: [], newIssues: [], records: [], finish: null, pendingReply: null, activation: 0 };
  let clock = 1;
  const post = (via, text) => { channel.push({ role: 'keir', via, text: String(text), at: clock++, activation: state.activation }); };
  const isQuestion = (t) => /\?/.test(t);
  const asksClient = (t) => /\b(?:app|website|web site|browser|desktop|client|device|phone|mobile|where did you|which (?:version|platform))\b/i.test(t);
  const asksTyped = (t) => /\b(?:what|which) (?:wage|amount|value|number)\b[^?]{0,40}\b(?:type|enter|put|set)/i.test(t) || /\b(?:typed|entered)\b/i.test(t);
  function considerQuestion(text) {
    if (!isQuestion(text)) return;
    state.pendingReply = asksClient(text) || asksTyped(text) ? CLIENT_ANSWER : OBSERVABLE_ANSWER;
  }
  async function tool(job, name, input = {}) {
    const entry = { activation: state.activation, at: clock++, tool: name, input };
    log.push(entry);
    try { const out = await handle(name, input); entry.ok = true; return out; }
    catch (e) { entry.error = e.message; throw e; }
  }
  async function handle(name, input) {
    switch (name) {
      case 'progress_update': case 'channel_reply': post(name, input.message); considerQuestion(input.message); return { posted: true };
      case 'ticket_history': return { ticket: TICKET, messages: channel.map((m) => ({ author: m.role === 'player' ? PLAYER : 'Keir', text: m.text })) };
      case 'reporter_state': return { ticket: TICKET, reporter: PLAYER, character: GAME.character };
      case 'read_servers': return { servers: ['gamestate', 'support', 'ops-knowledge'] };
      case 'read_tools': return { server: input.server, tools: input.server === 'gamestate' ? ['game_overview', 'trace_corp', 'trace_sector', 'trace_character'] : input.server === 'support' ? ['support_get', 'support_search'] : ['knowledge_query'] };
      case 'read_tool': {
        if (input.server === 'gamestate') { const t = input.tool === 'trace_character' ? 'character' : input.tool; if (GAME[t]) return GAME[t]; throw new Error(`gamestate has no tool ${input.tool}`); }
        if (input.server === 'support') return input.tool === 'support_search' ? { results: SIMILAR } : { ticket: TICKET, reporter: PLAYER, category: 'bug', status: state.ticketStatus, receipt: `https://example.invalid/receipt/${TICKET}`, trackerNotes: state.trackerNotes };
        return { results: [] };
      }
      case 'support_tools': return { tools: SUPPORT_TOOLS };
      case 'support_action': {
        const args = input.args || {};
        if (input.tool === 'support_public_update') { post('support_public_update', args.message || args.text || args.body || ''); considerQuestion(args.message || args.text || args.body || ''); return { delivered: true }; }
        if (input.tool === 'support_set_status') { state.ticketStatus = args.status || args.state || 'in_progress'; return { status: state.ticketStatus }; }
        if (input.tool === 'support_tracker_note') { if (!(args.body || args.note || args.text)) throw new Error('support_tracker_note requires body'); state.trackerNotes.push(args.body || args.note || args.text); return { noted: true, receipt: `https://example.invalid/receipt/${TICKET}` }; }
        if (input.tool === 'support_resolve') { state.ticketStatus = 'resolved'; return { resolved: true }; }
        throw new Error('Unknown support tool');
      }
      case 'status_card': state.statusCard = { items: input.items, status: input.status }; return { updated: true };
      case 'raise_to_developers': {
        const target = input.issueNumber || input.appendTo;
        if (target) { state.issuesTouched.push({ number: target, detail: input.detail, title: input.title }); return { added: true, issue: target, card: 'kanban-' + target }; }
        // Like the real broker: a bug or feature is checked against open GitHub
        // issues first and refused with candidates unless force is set.
        const isIssue = ['bug', 'enhancement'].includes(input.kind) || input.issue;
        if (!isIssue) { state.cards.push({ title: input.title, detail: input.detail, kind: input.kind || 'question' }); return { raised: true, id: 'kanban-' + state.cards.length, instruction: 'Filed on your work queue for the developers.' }; }
        if (!input.force) {
          const words = new Set(String(input.title + ' ' + input.detail).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
          const cand = ISSUES.filter((i) => i.state === 'open' && !(input.distinctFrom || []).includes(i.number)).map((i) => ({ number: i.number, title: i.title, hits: (i.title + ' ' + i.body).toLowerCase().split(/\W+/).filter((w) => words.has(w)).length })).filter((i) => i.hits >= 2).sort((a, b) => b.hits - a.hits).slice(0, 3);
          if (cand.length) return { raised: false, issueCandidates: cand.map(({ number, title }) => ({ number, title })), instruction: 'These open GitHub issues may be the same problem. If one is, call raise_to_developers again with issueNumber set to it and your evidence. If none is, call again with force: true.' };
        }
        const n = 900 + state.newIssues.length;
        state.newIssues.push({ number: n, title: input.title, detail: input.detail, kind: input.kind });
        return { raised: true, issue: n, card: 'kanban-' + n };
      }
      case 'github': {
        if (input.action === 'issues') {
          const q = String(input.query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
          const hits = ISSUES.filter((i) => i.state === 'open' && (!q.length || q.some((w) => (i.title + ' ' + i.body).toLowerCase().includes(w))));
          return { repository: input.repository || 'AHDGame', issues: hits };
        }
        if (input.action === 'history' || input.action === 'where' || input.action === 'status') return { note: 'No open fix for this yet.' };
        throw new Error(`github ${input.action} is not available in this simulation`);
      }
      case 'similar_reports': return { matches: SIMILAR };
      case 'recent_changes': return { changes: [{ date: '2026-10-11', summary: 'Desktop app 2.4.0 released: new wage form.' }] };
      case 'ticket_record': if (input.op === 'add') state.records.push({ kind: input.kind, text: input.text }); return { ok: true, record: state.records };
      case 'checkpoint': state.records.push({ kind: 'checkpoint', text: input.summary }); return { saved: true };
      case 'recall': return { notes: [] };
      case 'remember': return { saved: true };
      case 'repository_snapshot': return { repository: input.repository || 'AHDGame', ref: input.ref || 'main', commit: 'a1b2c3d', workspace: 'repo' };
      case 'evidence_batch': {
        const results = (input.queries || []).slice(0, 12).map((q) => {
          try {
            if (q.op === 'read') { const f = path.join(repoDir, String(q.path || '').replace(/^(?:\/workspace\/)?repo\//, '')); if (!f.startsWith(repoDir)) throw new Error('outside workspace'); const lines = fs.readFileSync(f, 'utf8').split('\n'), from = Math.max(1, q.line || 1); return { path: q.path, lines: lines.slice(from - 1, from - 1 + (q.lines || 200)).map((l, i) => `${from + i}| ${l}`).join('\n') }; }
            if (q.op === 'search') { const terms = [].concat(q.terms || q.query || []); const r = cp.spawnSync('grep', ['-rn', '-E', terms.map((t) => String(t).replace(/[^\w .-]/g, '')).join('|'), '.'], { cwd: repoDir, encoding: 'utf8' }); return { terms, matches: r.stdout.split('\n').filter(Boolean).slice(0, q.maxMatches || 40) }; }
            throw new Error('op must be read or search');
          } catch (e) { return { error: e.message }; }
        });
        return { results };
      }
      case 'publish_patch': return { pr: 4321, url: 'https://example.invalid/pull/4321', base: 'development' };
      case 'shell': {
        const command = String(input.command || '').replaceAll('/workspace/repo', repoDir).replace(/^cd repo\s*(&&|;)\s*/, '').replace(/^cd repo\//, 'cd ');
        const r = cp.spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd: repoDir, encoding: 'utf8', timeout: 10000, maxBuffer: 200000 });
        return { code: r.status, output: (r.stdout + r.stderr).slice(0, 20000) };
      }
      case 'calculate': { const e = String(input.expression || ''); if (!/^[\d\s+\-*/().]+$/.test(e)) throw new Error('numbers and + - * / ( ) only'); return { value: Function('return (' + e + ')')() }; }
      case 'finish': state.finish = { state: input.state, summary: input.summary, waitFor: input.waitFor, activation: state.activation }; return { state: input.state };
      case 'handoff': state.finish = { state: 'handoff', activation: state.activation }; return { state: 'handoff' };
      default: throw new Error(`${name} is not available in this simulation`);
    }
  }
  // Between activations: deliver the scripted player answer to a pending question.
  function nextInbox() {
    if (!state.pendingReply) return [];
    const msg = { role: 'player', author: PLAYER, text: state.pendingReply, at: clock++ };
    channel.push(msg); state.pendingReply = null;
    return [msg];
  }
  return { tool, log, channel, state, nextInbox, servers: () => ['gamestate', 'support', 'ops-knowledge'] };
}

module.exports = { createWorld, TICKET, PLAYER, OPENING, CLIENT_ANSWER, OBSERVABLE_ANSWER, ISSUES };
