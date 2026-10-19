"use strict";
// Owner guidance crosses surfaces as a durable inbox delivery, never as new
// approval authority. The original owner message and immutable action IDs stay
// authoritative; a model's paraphrase cannot approve an external effect.
const crypto = require("node:crypto");
const { hold } = require("./admission");
const { isAppJob } = require("./appchannel");
const { ticketOf } = require("./workrecord");
const { ticketClaim } = require("./ticketClaim");
const CLOSED = ["closed", "resolved", "merged"];
const categoryOf = (category) => ["moderation", "investigation", "incident", "bug", "suggestion"].includes(category) ? category : "mechanics";
function createSupportDirectives({ ledger, config, mcp, discord, now = () => Date.now() }) {
 const d = ledger.data;
 let flight = Promise.resolve();
 function ownerInvestigation(receipt, job) {
  // The hold belongs to the public support coordinator. It does not revoke the
  // authenticated app task's existing reviewed read tools or transfer a claim.
  if (receipt.outcome === "held" && receipt.remainingBlockers.length && receipt.remainingBlockers.every(b => ["staff-category", "staff-owned", "staff-active", "support-deferred"].includes(b))) {
   receipt.ownerInvestigation = { taskId: job.id, replyChannel: "app", mode: "read-only",
    instruction: "Continue the owner's requested private investigation in this app task using read_tool for reviewed game, ledger and support reads. The coordinator hold does not block these existing read capabilities. Read the evidence and report findings here. Do not finish merely because the support handoff is held. Staff ownership and moderation classification remain in place; this does not approve repairs, moderation actions or public replies." };
  } else delete receipt.ownerInvestigation;
 }
 function mirror(receipt) {
  const effect=d.jobs[receipt.sourceTaskId]?.effects?.[`support-directive:${receipt.id}`];
  if (effect) effect.result=receipt;
 }
 function sourceOf(job, messageId) {
  if (!isAppJob(job) || job.role !== "owner" || job.actorId !== config.ownerId || job.source?.authorId !== config.ownerId) throw new Error("support directives require an authenticated owner app task");
  const belongs = (m) => m.role === "owner" && (m.jobId === job.id || job.source?.messageId === m.id || [...(job.inbox || []), ...(job.requestInbox || [])].some((r) => r.messageId === m.id));
  const message = messageId ? d.appThread?.messages?.find((m) => m.id === messageId && belongs(m)) : [...(d.appThread?.messages || [])].reverse().find(belongs);
  const bound = message && (message.jobId === job.id || job.source?.messageId === message.id || [...(job.inbox || []), ...(job.requestInbox || [])].some((m) => m.messageId === message.id));
  if (!bound) throw new Error("source message does not belong to this owner task");
  return message;
 }
 function references(input, ticket) {
  const refs = [];
  for (const ref of input.approvals || []) {
   const x = ref.kind === "action" ? d.actions?.[ref.id] : ref.kind === "decision" ? d.decisions?.[ref.id] : null;
   if (!x || !d.jobs[x.jobId] || Number(ticketOf(d.jobs[x.jobId])) !== ticket) throw new Error("approval reference does not belong to this ticket");
   if (ref.kind === "action" && (!ref.digest || ref.digest !== x.digest)) throw new Error("action digest does not match the immutable approval");
   refs.push({kind:ref.kind,id:x.id,...(x.digest ? {digest:x.digest} : {}),state:x.state});
  }
  return refs;
 }
 function blockers(job, ticket) {
  const out = [];
  if (d.paused) out.push("paused");
  if (["moderation", "investigation", "incident"].includes(d.channels[job.channelId]?.category) && !(d.channels[job.channelId]?.ownerDirectedAt && !d.channels[job.channelId]?.claimedBy)) out.push("staff-category");
  if (job.resolutionReadyAt) out.push("closure-grace");
  if (job.channelClosed || job.resolved || CLOSED.includes(ticket.status)) out.push("closed-ticket");
  const reason = hold(job,{now:now(),supportDeferred:config.supportDeferred || false,claimedBy:(id)=>d.channels[id]?.claimedBy});
  if (reason) out.push(reason);
  if (job.state === "cancelled" || job.state === "dismissed") out.push(job.state);
  if (Object.values(job.effects || {}).some((e)=>e.state === "started")) out.push("uncertain-effect");
  if (Object.values(d.decisions || {}).some((x)=>x.jobId === job.id && x.state === "pending")) out.push("pending-decision");
  if (Object.values(d.actions || {}).some((x)=>x.jobId === job.id && ["pending","executing"].includes(x.state))) out.push("pending-action");
  if (job.waitingFor && job.waitingFor.kind !== "developer_reply") out.push(job.waitingFor.kind);
  return [...new Set(out)];
 }
 function recipient(input, number, channelId) {
  if (!input.recipientTaskId) return null;
  const target = d.jobs[input.recipientTaskId];
  if (!target || target.kind !== "command" || target.replyChannel === "app" || Number(ticketOf(target)) !== number || target.channelId !== channelId || ![config.ownerId, ...(config.staffIds || [])].includes(target.actorId) || target.source?.authorId !== target.actorId || ["done", "cancelled", "dismissed"].includes(target.state)) throw new Error("Recipient must be the existing authenticated staff command for this ticket.");
  require("./supporttakeover").assertCanAct(d, target);
  return target;
 }
 function routeRecipient(receipt, target, row) {
  if (!target || (receipt.recipientTaskIds || []).includes(target.id)) return;
  (target.inbox ||= []).push({ ...row });
  (receipt.recipientTaskIds ||= []).push(target.id);
  // Do not wake a command waiting for its coder or alter the held coordinator.
  mirror(receipt); ledger.audit("support_directive_routed", { directive: receipt.id, recipient: target.id });
 }
 async function deliver(job, input, signal) {
  const number = Number(input.ticket);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("ticket number required");
  const message = sourceOf(job,input.sourceMessageId);
  const approvals = references(input,number).sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const id = crypto.createHash("sha256").update(JSON.stringify([number,message.id,approvals.map(({kind,id,digest})=>({kind,id,digest}))])).digest("hex").slice(0,24);
  const prior = d.supportDirectives?.[id];
  // Read the canonical category, status and conversation before mutating intake.
  const ticket = await mcp.call("support","support_get",{kind:"ticket",number},false,signal);
  if (Number(ticket?.number) !== number) throw new Error("support ticket receipt does not match");
  const channelId = ticket.conversation?.channelId;
  if (!channelId || CLOSED.includes(ticket.status)) throw new Error("ticket has no open support conversation; use the verified reopen flow");
  const channel = await discord("GET",`/channels/${channelId}`);
  if (channel.id !== channelId || channel.guild_id !== config.guildId || !channel.name?.endsWith(`-${number}`)) throw new Error("support conversation does not match its Discord ticket");
  const rows = await discord("GET",`/channels/${channelId}/messages?limit=100`);
  let claimant = (Array.isArray(rows) ? rows : []).map((m)=>ticketClaim(m,config,d.channels[channelId]?.claimReleasedAt)).find(Boolean);
  // Keir 5.7.1 (owner, 2026-10-16): the owner directing Keir on a ticket the
  // owner claimed is a handback. Release the owner's own claim the same way the
  // ticket bot does (claimReleasedAt), so every claim check agrees. Staff
  // claims are never released here.
  d.channels[channelId] = {...d.channels[channelId], ownerDirectedAt: now()};
  if (claimant && claimant === config.ownerId) {
    d.channels[channelId] = {...d.channels[channelId], claimReleasedAt: now()};
    delete d.channels[channelId].claimedBy;
    ledger.audit("owner_claim_released", { ticket: number, by: "owner-directive", message: message.id });
    claimant = null;
  }
  const recipientJob = recipient(input, number, channelId);
  let target = d.jobs[d.seen[`ticket:${number}`]];
  if (target && (target.channelClosed || target.resolved || target.channelId && target.channelId !== channelId)) throw new Error("ticket needs verified conversation reopening before accepting guidance");
  const created = !target;
  if (!target) target = ledger.createJob(`ticket:${number}`,{kind:"ticket",role:"support",ticket:number,channelId,source:{channelId,channelName:channel.name,content:"Owner app directive adopted this support ticket. Read the ticket and directive before acting.",at:new Date(now()).toISOString()},deadline:now()+(config.taskLifetimeMs || 86400000)});
  target.channelId = channelId;
  d.channels[channelId] = {...d.channels[channelId],category:categoryOf(ticket.category),ticket:number,...(claimant ? {claimedBy:claimant} : {})};
  const previousState = target.state;
  const remainingBlockers = blockers(target,ticket);
  if (prior) {
   prior.remainingBlockers=remainingBlockers;prior.category=ticket.category;
   if (!remainingBlockers.length && !prior.incorporatedAt && (target.inbox || []).some((r)=>r.directiveId === id)) {
    if (target.waitingFor?.kind === "developer_reply") delete target.waitingFor;
    if (target.state !== "running") {target.state="queued";target.wakeAt=0;}
    prior.outcome=target.state === "running" ? "pending" : "woken";
   }
   const savedRow = [...(target.inbox || []), ...(target.requestInbox || [])].find(r => r.directiveId === id);
   if (input.recipientTaskId && !savedRow) throw new Error("Saved directive content is unavailable.");
   routeRecipient(prior, recipientJob, savedRow);
   ownerInvestigation(prior, job);
   prior.state=target.state;mirror(prior);ledger.save();return {...prior,duplicate:true,currentState:target.state};
  }
  const row = {directiveId:id,authorId:config.ownerId,role:"owner",at:new Date(now()).toISOString(),sourceMessageId:message.id,sourceTaskId:job.id,
   content:`Owner instruction from the Ops app (message ${message.id}):\n${message.text}\n${input.context ? `Routing context (not approval authority): ${String(input.context).slice(0,2000)}\n` : ""}Verify the current ticket and act under existing holds and approval IDs. This delivery grants no external-action approval.`,approvalReferences:approvals};
  (target.inbox ||= []).push(row);
  if (!remainingBlockers.length) {
   if (target.waitingFor?.kind === "developer_reply") delete target.waitingFor;
   if (target.state !== "running") {target.state="queued"; target.wakeAt=0;}
  }
  const outcome = remainingBlockers.length ? "held" : target.state === "running" ? "pending" : created ? "created" : previousState === "queued" ? "reused" : "woken";
  const receipt = {id,directiveId:id,ticket:number,coordinatorTaskId:target.id,sourceTaskId:job.id,sourceMessageId:message.id,sourceThread:message.thread || "main",at:now(),outcome,previousState,state:target.state,remainingBlockers,approvalReferences:approvals,category:ticket.category};
  ownerInvestigation(receipt, job);
  (d.supportDirectives ||= {})[id]=receipt;
  routeRecipient(receipt, recipientJob, row);
  (target.history ||= []).push({at:row.at,kind:"support_directive",directiveId:id,summary:`Owner app instruction accepted (${outcome}); source task ${job.id}, message ${message.id}.`});
  job.effects[`support-directive:${id}`]={state:"done",at:now(),result:receipt};
  ledger.audit("support_directive",receipt); ledger.save();
  return receipt;
 }
 function send(job,input,signal) {
  require("./ownermuse-policy").guard(ledger, config, job, "support_directive", input);
  // Keep canonical coordinator adoption and duplicate delivery atomic across
  // simultaneous owner app tasks, including the remote verification reads.
  const result=flight.then(()=>deliver(job,input,signal));
  flight=result.catch(()=>{}); return result;
 }
 function updates(job) {
  const canonical = job.kind === "ticket" && job.role !== "player" && d.seen[`ticket:${job.ticket}`] === job.id;
  const routed = job.kind === "command" && Object.values(d.supportDirectives || {}).some(r => (r.recipientTaskIds || []).includes(job.id));
  if (!canonical && !routed) throw new Error("support updates belong to the canonical coordinator or its existing staff command");
  const rows=(job.inbox || []).filter((r)=>r.directiveId);
  job.inbox=(job.inbox || []).filter((r)=>!r.directiveId);
  for (const row of rows) {
   const receipt=d.supportDirectives?.[row.directiveId];
   if (receipt) {receipt.incorporatedAt=now(); receipt.incorporatedBy=job.id; receipt.currentState=job.state;mirror(receipt);}
  }
  (job.requestInbox ||= []).push(...rows);
  if (rows.length) {ledger.audit("support_directives_incorporated",{job:job.id,directives:rows.map((r)=>r.directiveId)});ledger.save();}
  return rows;
 }
 function tick() {
  for (const receipt of Object.values(d.supportDirectives || {})) {
   if (!receipt.incorporatedAt) {
    const recipient = (receipt.recipientTaskIds || []).map(id => d.jobs[id]).find(j => j && (j.requestInbox || []).some(r => r.directiveId === receipt.id));
    if (recipient) { receipt.incorporatedAt=now(); receipt.incorporatedBy=recipient.id; receipt.currentState=recipient.state; mirror(receipt); ledger.audit("support_directives_incorporated", {job:recipient.id,directives:[receipt.id]}); ledger.save(); }
   }
   const job=d.jobs[receipt.coordinatorTaskId];
   if (job && !receipt.incorporatedAt && (job.requestInbox || []).some((r)=>r.directiveId === receipt.id)) {receipt.incorporatedAt=now();receipt.currentState=job.state;mirror(receipt);ledger.save();}
   if (!job || receipt.outcome !== "held") continue;
   const remaining=blockers(job,{status:"open"});
   if (JSON.stringify(receipt.remainingBlockers) !== JSON.stringify(remaining)) {receipt.remainingBlockers=remaining;mirror(receipt);ledger.save();}
   if (!remaining.length) {
    if (job.waitingFor?.kind === "developer_reply") delete job.waitingFor;
    if (job.state !== "running") {job.state="queued";job.wakeAt=0;}
    receipt.state=job.state;receipt.outcome=job.state === "running" ? "pending" : "woken";receipt.releasedAt=now();
    mirror(receipt);ledger.audit("support_directive_released",{directive:receipt.id,job:job.id});ledger.save();
   }
  }
 }
 function held(job) {
  return Object.values(d.supportDirectives || {}).some((r)=>r.coordinatorTaskId === job.id && r.outcome === "held" && blockers(job,{status:"open"}).length);
 }
 return {send,updates,tick,held};
}
module.exports={createSupportDirectives,categoryOf};
