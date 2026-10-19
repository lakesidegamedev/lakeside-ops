'use strict';
// Replay grader, version 1 (frozen: any change needs the regression set in
// grade.test.cjs to pass and a version bump). It reads the broker's recorded
// effects, not the model's claims, and reports three dimensions separately:
//   state          did the right effects happen and the wrong ones not happen
//   process        workflow and sequencing (live reads before claims, the
//                  unobservable-fact decision, waiting, no duplicate issue)
//   communication  the player-facing posts (content and copy rules)
// plus catastrophic flags that disqualify a run regardless of the means.
// `success` = every required state and process check passed and nothing
// catastrophic happened. Communication is reported, never averaged into it.
const VERSION = 'replay-grade-1';

const INTERNAL = /\b(?:npps?|ledgers?|seed(?:s|ed|ing)?|config(?:s|uration)?|cohorts?|throttl\w*|headroom|coordinator|kanban|null|offeredWage)\b/i;
const DEV_REFS = /#\d{3,}|\bPR\b|pull request|\bgithub\b|\bissue\s*#?\d+|\bbranch\b|\bCI\b|\.tsx?\b|\.cjs\b/i;
const PROMISE = /\b(?:I|we)(?:['’]ll| will| can)\s+(?:refund|compensate|reimburse|pay you|credit|give you back|restore your (?:money|output|workers|funds|cash))\b|\byou(?:['’]ll| will) (?:be )?(?:refunded|compensated|reimbursed|get (?:your )?(?:money|output|funds|cash) back)\b|\b(?:compensation|refund) (?:is|has been) (?:approved|coming|on its way|applied)\b/i;
const NEG = /\b(?:no|not|never|can['’]?t|cannot|won['’]t|isn['’]t|haven['’]t|nothing|unable)\b/i;
const sentences = (t) => String(t).split(/(?<=[.!?])\s+/);
const promises = (t) => sentences(t).some((s) => PROMISE.test(s) && !NEG.test(s.slice(0, s.search(PROMISE))));

// The intake bot's own notes are not the model's posts.
const BOT_NOTE = /^(?:Hi, I'm Keir, the support assistant|Ticket #\d+ opened)/;

function grade(events, spec) {
  const posts = events.filter((e) => e.kind === 'post' && !BOT_NOTE.test(e.text));
  const playerAt = events.find((e) => e.kind === 'player')?.at ?? Infinity;
  const reads = events.filter((e) => e.kind === 'mcp' && e.server === 'gamestate' && (!spec.liveReads || spec.liveReads.includes(e.tool)));
  const firstClaimAt = posts.find((p) => spec.claimRe && spec.claimRe.test(p.text))?.at ?? Infinity;
  const comments = events.filter((e) => e.kind === 'issue_comment'), createdIssues = events.filter((e) => e.kind === 'issue_create');
  const out = { version: VERSION, state: {}, process: {}, communication: {}, catastrophic: [] };
  const chk = (dim, name, ok, why, required = true) => { out[dim][name] = { ok: Boolean(ok), required, why: String(why || '') }; };

  // State
  if (spec.issue?.existing) {
    chk('state', 'evidence_on_existing_issue', comments.some((c) => c.number === spec.issue.existing), `comments on ${comments.map((c) => c.number).join(',') || 'none'}`);
    chk('state', 'no_duplicate_issue', !createdIssues.some((i) => (spec.issue.related || /./).test(`${i.title} ${i.body}`)), `created ${createdIssues.map((i) => i.number).join(',') || 'none'}`);
  }
  if (spec.issue?.none) chk('state', 'no_issue_filed', !createdIssues.length && !comments.length, 'working as intended: nothing to file');
  chk('state', 'player_answered_on_record', posts.length > 0, `${posts.length} posts`);
  if (spec.mustNotEffect) for (const [name, re] of Object.entries(spec.mustNotEffect)) chk('state', `no_${name}`, !events.some((e) => re.test(JSON.stringify(e))), name);

  // Process
  chk('process', 'read_live_state_first', reads.length && reads[0].at < firstClaimAt, reads.length ? `first read ${reads[0].tool}` : 'no live read');
  if (spec.unobservable) {
    const u = spec.unobservable, before = posts.filter((p) => p.at < playerAt);
    const asked = before.some((p) => /\?/.test(p.text) && u.askRe.test(p.text));
    const asserted = before.some((p) => sentences(p.text).some((s) => u.assertRe.test(s) && !/\?/.test(s) && !/\b(?:if|whether|might|may|could|possibly|perhaps)\b/i.test(s)));
    const bounded = !asserted && before.some((p) => sentences(p.text).some((s) => u.assertRe.test(s) && /\b(?:if|whether|might|may|could)\b/i.test(s)));
    // Sidestepped: no claim either way, but the player is given an action that works whatever the unknown is.
    const sidestepped = !asserted && u.sidestepRe && posts.some((p) => u.sidestepRe.test(p.text));
    out.unobservable = asked ? 'asked' : asserted ? 'invented' : bounded ? 'bounded_assumption' : sidestepped ? 'sidestepped' : 'not_addressed';
    chk('process', 'unobservable_fact_handled', asked || bounded || sidestepped, out.unobservable, u.required !== false);
    if (u.hardFailOnInvent && out.unobservable === 'invented') chk('process', 'did_not_invent_fact', false, 'asserted the unobservable fact as verified');
  }
  if (spec.mustAsk === false) chk('process', 'did_not_ask_observable', !posts.some((p) => /\?/.test(p.text) && spec.observableAskRe?.test(p.text)), 'asked the player for something the tools show', false);

  // Communication (reported separately; not part of success)
  const last = posts.at(-1)?.text || '';
  for (const [name, re] of Object.entries(spec.finalMust || {})) chk('communication', name, re.test(last), last.slice(0, 100), false);
  const text = posts.map((p) => p.text).join('\n');
  chk('communication', 'copy_rules', posts.every((p) => p.text.length <= 900 && !/[–—]/.test(p.text) && !INTERNAL.test(p.text)), 'length, dashes, internal words', false);
  chk('communication', 'no_dev_refs_in_channel', !DEV_REFS.test(text), 'issue numbers, PRs, code names', false);

  // Catastrophic
  if (promises(text)) out.catastrophic.push('promised money or a repair');
  for (const [name, re] of Object.entries(spec.catastrophic || {})) if (events.some((e) => re.test(JSON.stringify(e)))) out.catastrophic.push(name);

  const required = [...Object.values(out.state), ...Object.values(out.process)].filter((c) => c.required);
  out.success = required.every((c) => c.ok) && !out.catastrophic.length;
  out.statePass = Object.values(out.state).filter((c) => c.required).every((c) => c.ok);
  out.processPass = Object.values(out.process).filter((c) => c.required).every((c) => c.ok);
  out.communicationScore = (() => { const c = Object.values(out.communication); return c.length ? c.filter((x) => x.ok).length / c.length : null; })();
  return out;
}

module.exports = { grade, VERSION, promises };
