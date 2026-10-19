"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTicket } = require("./support-merge");

function fakeTickets(rows) {
  const db = Object.fromEntries(rows.map((r) => [r.ticketNumber, { ...r }]));
  const writes = [];
  return { db, writes, findOne: async (q) => (db[q.ticketNumber] ? { ...db[q.ticketNumber] } : null),
    updateOne: async (filter, update) => { writes.push([filter, update]); const t = db[filter.ticketNumber]; if (!t) return { matchedCount: 0 };
      if (filter["mergedTickets.ticketNumber"] && (t.mergedTickets || []).some((m) => m.ticketNumber === filter["mergedTickets.ticketNumber"].$ne)) return { matchedCount: 0 };
      Object.assign(t, update.$set || {}); for (const [k, v] of Object.entries(update.$push || {})) t[k] = [...(t[k] || []), v]; return { matchedCount: 1 }; } };
}
const calls = []; const discordImpl = async (path, init = {}) => { calls.push([init.method || "GET", path]); return {}; };

test("merges a repeat ticket into an open incident with access, announcement, link, pointer and channel close", async () => {
  calls.length = 0;
  const T = fakeTickets([{ ticketNumber: 1539, status: "open", category: "incident", discordChannelId: "c9" }, { ticketNumber: 1540, status: "open", category: "bug", discordUserId: "777", discordChannelId: "c0", title: "Turn stuck", description: "Turn 180 never ran" }]);
  const out = await mergeTicket({ Tickets: T, sourceNumber: 1540, targetNumber: 1539, reason: "same outage", mergedBy: "keir", discordImpl });
  assert.equal(out.ok, true); assert.deepEqual(out.steps, ["access", "announced", "linked", "pointer", "source-channel-deleted"]);
  assert.deepEqual(calls.map((c) => c.join(" ")), ["PUT /channels/c9/permissions/777", "POST /channels/c9/messages", "POST /channels/c0/messages", "DELETE /channels/c0"]);
  assert.equal(T.db[1540].status, "closed"); assert.equal(T.db[1540].mergedInto, 1539); assert.equal(T.db[1540].statusHistory[0].note, "merged into #1539: same outage");
  assert.deepEqual(T.db[1539].mergedTickets.map((m) => [m.ticketNumber, m.discordUserId, m.mergedBy]), [[1540, "777", "keir"]]);
  calls.length = 0;
  const again = await mergeTicket({ Tickets: T, sourceNumber: 1540, targetNumber: 1539, mergedBy: "keir", discordImpl });
  assert.equal(again.alreadyMerged, true); assert.equal(T.db[1539].mergedTickets.length, 1, "retry adds nothing");
  assert.deepEqual(calls.map((c) => c.join(" ")), ["PUT /channels/c9/permissions/777"], "a retry only re-grants access");
});

test("refuses non-incident targets by default, moderation sources, closed targets, self and re-merge", async () => {
  const T = fakeTickets([{ ticketNumber: 1, status: "open", category: "bug" }, { ticketNumber: 2, status: "open", category: "bug" }, { ticketNumber: 3, status: "closed", category: "incident" }, { ticketNumber: 4, status: "open", category: "moderation" }, { ticketNumber: 5, status: "open", category: "incident" }, { ticketNumber: 6, status: "open", category: "bug", mergedInto: 9 }]);
  assert.match((await mergeTicket({ Tickets: T, sourceNumber: 2, targetNumber: 1, discordImpl })).error, /not an incident/);
  assert.equal((await mergeTicket({ Tickets: T, sourceNumber: 2, targetNumber: 1, requireIncident: false, discordImpl })).ok, true, "staff-directed merge into any open ticket");
  assert.match((await mergeTicket({ Tickets: T, sourceNumber: 4, targetNumber: 5, discordImpl })).error, /moderation/);
  assert.match((await mergeTicket({ Tickets: T, sourceNumber: 1, targetNumber: 3, discordImpl })).error, /closed/);
  assert.match((await mergeTicket({ Tickets: T, sourceNumber: 5, targetNumber: 5, discordImpl })).error, /itself/);
  assert.match((await mergeTicket({ Tickets: T, sourceNumber: 6, targetNumber: 5, discordImpl })).error, /already merged/);
});

test("investigations cannot add a player to a staff channel or export evidence into support",async()=>{
 for(const side of ["source","target"]){
  calls.length=0;const T=fakeTickets([{ticketNumber:1,status:"open",category:side==="source"?"investigation":"bug",discordUserId:"player",discordChannelId:"source"},{ticketNumber:2,status:"open",category:side==="target"?"investigation":"bug",discordChannelId:"target"}]);
  const out=await mergeTicket({Tickets:T,sourceNumber:1,targetNumber:2,requireIncident:false,discordImpl});assert.match(out.error,/investigation/);assert.equal(calls.length,0);assert.equal(T.writes.length,0);
 }
});
