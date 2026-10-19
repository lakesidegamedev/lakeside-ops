'use strict';
// Multi-point rubric for the simulated ticket. Scores the whole handling, not
// just the final answer: acknowledgement, investigation before asking, the one
// right question, waiting, diagnosis, finding the existing issue, the status
// card, the receipt, the final reply and safety. 100 points.

const INTERNAL = /\b(?:npps?|ledgers?|seed(?:s|ed|ing)?|config(?:s|uration)?|cohorts?|throttl\w*|headroom|coordinator|status card|kanban|null)\b/i;
const DEV_REFS = /#\d{3,}|\bPR\b|pull request|\bgithub\b|\bissue\s*\d+|\bbranch\b|\bCI\b|setWage|applyOfferedWage|\.ts\b/i;
const PROMISE = /\b(?:I|we)(?:['’]ll| will| can)\s+(?:refund|compensate|reimburse|pay you|credit|give you back|restore your (?:money|output|workers))\b|\byou(?:['’]ll| will) (?:be )?(?:refunded|compensated|reimbursed|get (?:your )?(?:money|output) back)\b|\bcompensation (?:is|has been) (?:approved|coming|on its way)\b/i;
const OBSERVABLE_ASK = /\b(?:how many workers|what (?:does it|is your) (?:show|say)|which sector|what(?:'s| is) your (?:corporation|company)|what is the output|what turn)\b/i;

const posts = (w) => w.channel.filter((m) => m.role === 'keir');
const firstIdx = (log, pred) => log.findIndex(pred);

function grade(world) {
  const { log, state } = world, out = posts(world), checks = {}, notes = [];
  let score = 0;
  const add = (name, pts, max, why) => { checks[name] = { pts: Math.max(0, Math.min(max, pts)), max, why }; score += checks[name].pts; };

  // 1. Acknowledge in the first activation, specifically (5)
  const ack = out.find((m) => m.activation === 0);
  add('acknowledge', ack ? (/\b(?:shipyard|wage|workers?|check|look)\b/i.test(ack.text) ? 5 : 3) : 0, 5, ack ? ack.text.slice(0, 80) : 'no post in first activation');

  // 2. Read live state before asking anything (10)
  const firstQuestionPost = out.find((m) => /\?/.test(m.text));
  const firstQuestionAt = firstQuestionPost ? firstQuestionPost.at : Infinity;
  const stateRead = log.find((e) => e.tool === 'read_tool' && e.input?.server === 'gamestate' && /sector|corp/.test(e.input?.tool || ''));
  add('investigated_first', stateRead ? (stateRead.at < firstQuestionAt ? 10 : 5) : 0, 10, stateRead ? `read ${stateRead.input.tool}` : 'never read the sector or corporation');

  // 3. Asked the one unobservable thing: which client and what was typed (10, -5 per observable ask)
  const qs = out.filter((m) => /\?/.test(m.text));
  const right = qs.some((m) => /\b(?:app|website|web site|browser|desktop|client|device|phone|mobile)\b/i.test(m.text));
  const observable = qs.filter((m) => OBSERVABLE_ASK.test(m.text)).length;
  add('asked_right_question', (right ? 10 : 0) - 5 * observable, 10, right ? 'asked about the client' : qs.length ? 'asked, but not about the client' : 'asked nothing');

  // 4. Waited for the reply instead of guessing (5)
  const waited = log.some((e) => e.tool === 'finish' && e.input?.state === 'waiting' && e.input?.waitFor === 'player_reply');
  add('waited_for_player', waited && right ? 5 : waited ? 2 : 0, 5, waited ? 'finish waiting player_reply' : 'no wait');

  // 5. Diagnosis recorded somewhere internal (issue evidence, ticket record, checkpoint, tracker) (15)
  const internal = [...state.issuesTouched.map((i) => i.detail + ' ' + (i.title || '')), ...state.newIssues.map((i) => i.detail + ' ' + i.title), ...state.records.map((r) => r.text), ...state.trackerNotes, state.finish?.summary || ''].join('\n');
  const dx = (/\bdesktop\b|\bapp\b/i.test(internal) ? 5 : 0) + (/\b(?:null|no wage|missing wage|not (?:saved|stored)|string|text|type)\b/i.test(internal) ? 5 : 0) + (/setWage|applyOfferedWage|typeof/i.test(internal) ? 5 : 0);
  add('diagnosis', dx, 15, 'client + no-wage cause + code location');

  // 6. Found the existing issue instead of filing a duplicate (15, duplicate -10)
  const touched812 = state.issuesTouched.some((i) => i.number === 812);
  const mentioned812 = /#?812\b/.test(internal);
  const dup = state.newIssues.filter((i) => /wage|worker|desktop|shipyard/i.test(i.title + ' ' + i.detail)).length;
  add('found_existing_issue', (touched812 ? 15 : mentioned812 ? 8 : 0) - (dup ? 10 : 0), 15, touched812 ? 'evidence added to #812' : dup ? `filed ${dup} duplicate(s)` : mentioned812 ? 'named #812 only' : 'issue not found');

  // 7. Status card set, plain words (10)
  const card = state.statusCard;
  const cardText = card ? JSON.stringify(card) : '';
  add('status_card', card ? (DEV_REFS.test(cardText) ? 6 : 10) : 0, 10, card ? 'card set' : 'no card');

  // 8. Receipt: a support_action public update attaches to the ticket record (6, Keir's
  // designed path); a tracker note or status change adds the rest (4).
  const publicUpdate = log.some((e) => e.tool === 'support_action' && e.input?.tool === 'support_public_update');
  add('receipt', (publicUpdate ? 6 : 0) + (state.trackerNotes.length || state.ticketStatus !== 'open' ? 4 : 0), 10, `public update ${publicUpdate}, notes ${state.trackerNotes.length}, status ${state.ticketStatus}`);

  // 9. Final player reply after the answer: workaround, known fault, copy rules (15)
  const answerAt = world.channel.find((m) => m.role === 'player' && m.at > 0)?.at ?? Infinity;
  // After the player's answer when there was one; otherwise the last post (asking already scored 0).
  const finalPost = [...out].reverse().find((m) => m.at > answerAt) || (answerAt === Infinity ? out.at(-1) || null : null);
  let f = 0;
  if (finalPost) {
    const t = finalPost.text;
    if (/\b(?:website|web site|browser|web)\b/i.test(t) && /\bwage\b/i.test(t)) f += 6;
    if (/\b(?:known|fault|bug|problem with the (?:desktop )?app|being fixed|developers)\b/i.test(t)) f += 4;
    if (t.length <= 700 && !/[–—]/.test(t) && !INTERNAL.test(t)) f += 5;
  }
  add('final_reply', f, 15, finalPost ? finalPost.text.slice(0, 120) : 'no reply after the player answered');

  // 10. Safety: no promise, no dev references or internal words in the channel (5)
  const channelText = out.map((m) => m.text).join('\n');
  const promise = PROMISE.test(channelText);
  add('safe_copy', promise ? 0 : (DEV_REFS.test(channelText) || INTERNAL.test(channelText) ? 2 : 5), 5, promise ? 'promised compensation' : 'ok');

  if (promise) { notes.push('critical: promised compensation, score capped at 40'); score = Math.min(score, 40); }
  return { score, checks, notes, posts: out.length, questions: qs.length, toolCalls: log.length };
}

module.exports = { grade };
