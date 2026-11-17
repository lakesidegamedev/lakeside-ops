"use strict";
// Keir 10.3: what a corporation is building and how it is financed, per site.
//
// Support tasks kept falling back to a raw corporateSectors read (47 raw reads in four days) because
// trace_sector reports stakes, capacity and margins but not the build queue, the construction financing
// or the pending property transition, which are what "my expansion never finished" tickets turn on. This is
// that read, as a fixed projection of public game fields: no account, contact or ticket data is requested.

const HEX24 = /^[0-9a-f]{24}$/i;
const SITE_PROJECTION = { sectorType: 1, stateId: 1, forSale: 1, buildQueue: 1, constructionFinancing: 1, constructionPropertyTransition: 1, plantsStartTurn: 1 };
const LIMIT = 50;

function createSectorBuilds({ mcp }) {
  const read = (collection, filter, projection, limit, signal) => mcp.call("heal-ops", "heal_query", { env: "prod", collection, filter, projection, limit }, false, signal);

  async function resolveCorporation(ref, signal) {
    const text = String(ref ?? "").trim();
    if (!text) return { error: "corporation: pass the corporation's name, sequentialId or id" };
    const filter = HEX24.test(text) ? { $expr: { $eq: [{ $toString: "$_id" }, text.toLowerCase()] } }
      : /^\d{1,9}$/.test(text) ? { sequentialId: Number(text) } : { name: text };
    const res = await read("corporations", filter, { name: 1, sequentialId: 1 }, 3, signal);
    const docs = res?.docs || [];
    if (!docs.length) return { error: `no corporation matches "${text.slice(0, 80)}"; use trace_corp or corporation_rankings to find its exact name` };
    if (docs.length > 1) return { error: `"${text.slice(0, 80)}" matches several corporations: ${docs.map((c) => `${c.name} (${c.sequentialId})`).join(", ")}; pass the sequentialId` };
    return { corp: docs[0] };
  }

  async function call(job, input = {}, signal) {
    const found = await resolveCorporation(input.corporation, signal);
    if (found.error) return { found: false, note: found.error };
    const id = String(found.corp._id?.$oid || found.corp._id || "");
    const filter = { $expr: { $eq: [{ $toString: "$corporationId" }, id] } };
    if (input.state) filter.stateId = String(input.state).toUpperCase().slice(0, 12);
    if (input.sectorType) filter.sectorType = String(input.sectorType).slice(0, 60);
    const res = await read("corporateSectors", filter, SITE_PROJECTION, LIMIT, signal);
    const docs = res?.docs || [];
    const sites = docs.map((s) => ({
      state: s.stateId ?? null, sectorType: s.sectorType ?? null, forSale: s.forSale ?? null,
      buildQueue: Array.isArray(s.buildQueue) ? s.buildQueue.slice(0, 10) : (s.buildQueue ?? null),
      buildQueueLength: Array.isArray(s.buildQueue) ? s.buildQueue.length : null,
      constructionFinancing: s.constructionFinancing ?? null,
      constructionPropertyTransition: s.constructionPropertyTransition ?? null,
      plantsStartTurn: s.plantsStartTurn ?? null,
    }));
    return { found: true, corporation: { name: found.corp.name, sequentialId: found.corp.sequentialId }, returned: sites.length, truncated: Boolean(res?.truncated) || docs.length >= LIMIT, sites,
      instruction: sites.length ? "An empty buildQueue means nothing is waiting to build there. Quote constructionFinancing.status as stored; do not infer a cause the record does not state." : "No matching sites. Check the state and sectorType spelling, or call trace_sector with the corporation for its sector stakes." };
  }
  return { call };
}

module.exports = { createSectorBuilds, SITE_PROJECTION };
