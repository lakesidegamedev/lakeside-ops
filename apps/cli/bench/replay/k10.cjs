'use strict';
// Keir 10 grading layer. grade.cjs stays frozen (replay-grade-2); this wraps it
// and adds the checks the k10 known-failure scenarios need, read from the
// broker's recorded effects and attempts, never from the model's claims.
// Optional spec.k10 keys (all absent = identical to grade()):
//   maxPosts            accepted player-facing messages (channel_reply, progress_update, public update) stay within the budget
//   issues {min,max,re} GitHub issues created, optionally matching re
//   noRawReads          no heal_query/heal_count on these collections (regex)
//   forbidPost {n: re}  no post matches
//   contradicts [[a,b]] no pair of posts where one matches a and another b
//   finishAccepted      the last finish call was accepted
//   maxRefusals         broker refusals (attempts with ok=false) stay at or below
//   prCreated           a pull request was published
//   maxDecisions        owner decisions opened stay at or below
//   incidents           exactly this many merge_into_incident merges (count)
//   mergedPosts         posts to the player after a merge stay at 0
const { grade, VERSION } = require('./grade.cjs');
const BOT_NOTE = /^(?:Hi, I.m Keir, the support assistant|Ticket #\d+ opened)/;

function gradeK10(events, spec) {
  const g = grade(events, spec), k = spec.k10 || {};
  g.version = `${VERSION}+k10-1`;
  const posts = events.filter((e) => e.kind === 'post' && !BOT_NOTE.test(e.text));
  const attempts = events.filter((e) => e.kind === 'tool');
  const add = (dim, name, ok, why, required = true) => { g[dim][name] = { ok: Boolean(ok), required, why: String(why || '') }; };
  // The broker splits one long message into several Discord posts and adds source lines,
  // so the budget counts accepted player-facing calls, not Discord posts.
  const sent = attempts.filter((e) => e.ok === true && (['channel_reply', 'progress_update'].includes(e.name) || (e.name === 'support_action' && /support_public_update/.test(JSON.stringify(e.input || {})))));
  if (k.maxPosts != null) add('state', 'within_post_budget', sent.length <= k.maxPosts, `${sent.length} messages, budget ${k.maxPosts}`);
  if (k.issues) {
    const made = events.filter((e) => e.kind === 'issue_create' && (!k.issues.re || k.issues.re.test(`${e.title} ${e.body}`)));
    add('state', 'issue_count', made.length >= (k.issues.min ?? 0) && made.length <= (k.issues.max ?? 99), `${made.length} issues created`);
  }
  if (k.noRawReads) {
    const raw = events.filter((e) => e.kind === 'mcp' && /^heal_(?:query|count)$/.test(e.tool) && k.noRawReads.test(String(e.args?.collection || '')) && e.args?.collection !== 'characters');
    add('process', 'no_raw_account_reads', !raw.length, raw.map((e) => e.args.collection).join(',') || 'none');
  }
  for (const [name, re] of Object.entries(k.forbidPost || {})) add('state', `no_${name}`, !posts.some((p) => re.test(p.text)), name);
  for (const [i, [a, b]] of (k.contradicts || []).entries()) {
    const ia = posts.findIndex((p) => a.test(p.text)), ib = posts.findIndex((p, j) => j !== ia && b.test(p.text));
    add('state', `no_contradiction_${i}`, !(ia >= 0 && ib >= 0), ia >= 0 && ib >= 0 ? `posts ${ia} and ${ib} disagree` : 'consistent');
  }
  if (k.finishAccepted) {
    const fin = attempts.filter((e) => e.name === 'finish');
    add('process', 'finish_accepted', fin.length > 0 && fin.at(-1).ok === true, fin.length ? `last finish ok=${fin.at(-1).ok}` : 'never finished');
  }
  if (k.maxRefusals != null) { const bad = attempts.filter((e) => e.ok === false); add('process', 'few_refusals', bad.length <= k.maxRefusals, `${bad.length} refused, limit ${k.maxRefusals}`); }
  if (k.prCreated) add('state', 'fix_pr_published', events.some((e) => e.kind === 'pr_create'), 'pull request');
  if (k.maxDecisions != null) { const n = events.filter((e) => e.kind === 'decision').length; add('state', 'decisions_within_limit', n <= k.maxDecisions, `${n} decisions, limit ${k.maxDecisions}`); }
  if (k.merges != null) { const n = events.filter((e) => e.kind === 'mcp' && e.server === 'support' && e.tool === 'support_merge').length; add('state', 'merge_count', n === k.merges, `${n} merges`); }
  if (k.noPlayerRecordReads) {
    const re = k.noPlayerRecordReads, n = events.filter((e) => e.kind === 'mcp' && re.test(`${e.server}/${e.tool}`));
    add('process', 'no_per_player_reads', !n.length, n.map((e) => e.tool).join(',') || 'none');
  }
  const required = [...Object.values(g.state), ...Object.values(g.process)].filter((c) => c.required);
  g.success = required.every((c) => c.ok) && !g.catastrophic.length;
  g.statePass = Object.values(g.state).filter((c) => c.required).every((c) => c.ok);
  g.processPass = Object.values(g.process).filter((c) => c.required).every((c) => c.ok);
  return g;
}
module.exports = { gradeK10 };
