'use strict';
// Per-trial transcript for the lead to read: the scripted conversation, every
// broker tool call with its input, result or refusal, every external effect,
// and whatever each model activation exposed (final text, thinking, usage).
const fs = require('node:fs'), path = require('node:path');
const clip = (v, n = 1500) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t == null ? '' : t.length > n ? t.slice(0, n) + ` ...[${t.length - n} more]` : t; };

// Muse writes no private reasoning; its trace holds the text it wrote between steps and its tool events, in order.
function narration(file) {
  let lines; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; }
  const out = []; let buf = '';
  const flush = () => { if (buf.trim()) out.push(`> ${buf.trim().replace(/\n/g, '\n> ')}`); buf = ''; };
  for (const e of lines) {
    const t = e.payload_type || '';
    if (t === 'run.output.delta') { buf += e.payload?.text || ''; continue; }
    if (/tool|mcp|function_call/i.test(t)) { flush(); out.push(`- [${t}] ${clip(e.payload?.name || e.payload?.tool || e.payload, 300)}`); }
    else if (/^run\.terminal/.test(t)) { flush(); out.push(`- [${t}] ${clip(e.payload?.terminal || e.payload, 200)}`); }
  }
  flush();
  return out.length ? out.join('\n') : null;
}

function activationBlocks(raw) {
  return raw.map((a, i) => {
    const r = a.result || {};
    // Runtimes differ in what they expose; keep any message/thinking/steps-shaped field.
    const extra = Object.keys(r).filter((k) => /thinking|reason|messages|transcript|steps|events|trace/i.test(k)).map((k) => `- ${k}: ${clip(r[k], 4000)}`);
    return [`### Activation ${i + 1} (${a.lane || 'worker'}, ${Math.round((a.ms || 0) / 1000)}s)`,
      a.error ? `Runner error: ${a.error}` : `Outcome: ${r.subtype || 'unknown'}${r.is_error ? ' (error)' : ''}${r.num_turns != null ? `, ${r.num_turns} turns` : ''}`,
      r.result ? `Model final text:\n\n> ${clip(r.result, 3000).replace(/\n/g, '\n> ')}` : 'Model final text: none',
      ...extra, ...(r.provenance?.trace ? [`Model narration in order (trace ${path.basename(r.provenance.trace)}):\n\n${narration(r.provenance.trace) || 'empty'}`] : [])].join('\n');
  }).join('\n\n');
}

function writeTranscript(dir, { scenario, result, events, messages, rawActivations }) {
  const L = [`# ${scenario.id}`, '', scenario.summary, '', `Route ${result.route}, arm ${result.arm}, final state ${result.finalState}, activations ${result.activations.length}.`,
    result.grade ? `Grade: ${result.grade.success ? 'PASS' : 'FAIL'} (${result.grade.version})` : '', ''];
  if (result.grade) {
    const bad = [...Object.entries(result.grade.state), ...Object.entries(result.grade.process)].filter(([, c]) => c.required && !c.ok);
    L.push(...(bad.length ? ['Failed checks:', ...bad.map(([n, c]) => `- ${n}: ${c.why}`)] : ['All required checks passed.']), ...(result.grade.catastrophic.length ? [`Catastrophic: ${result.grade.catastrophic.join(', ')}`] : []), '');
  }
  L.push('## Channel', '', ...messages.map((m) => `**${m.author?.bot ? 'Keir' : 'Player'}**: ${clip(m.content, 1200)}`), '', '## Model tool calls, results and refusals', '');
  let n = 0;
  for (const e of events) {
    if (e.kind === 'tool') { n++; L.push(`${n}. \`${e.name}\` ${clip(e.input, 600)}`, `   - ${e.ok === false ? 'REFUSED: ' + clip(e.error, 700) : 'result: ' + clip(e.result, 500)}`); }
    else if (e.kind === 'player') L.push(`   > player writes: ${clip(e.text, 300)}`);
    else if (e.kind === 'decision') L.push(`   > OWNER DECISION opened: ${clip(e.question, 300)}`);
    else if (e.kind === 'mcp' && !/^support_(?:get|search)$/.test(e.tool)) L.push(`   - mcp ${e.server}/${e.tool} ${clip(e.args, 200)}`);
    else if (['issue_create', 'issue_comment', 'pr_create', 'ticket_update'].includes(e.kind)) L.push(`   - effect ${e.kind} ${clip(e.title || e.message || e.args || e.number || '', 300)}`);
  }
  L.push('', '## Model activations (what the runtime exposed)', '', activationBlocks(rawActivations) || 'none');
  fs.writeFileSync(path.join(dir, 'transcript.md'), L.join('\n') + '\n');
}
module.exports = { writeTranscript };
