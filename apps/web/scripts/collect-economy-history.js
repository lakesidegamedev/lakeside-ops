#!/usr/bin/env node
"use strict";
// Run after the existing read-only collector. Only local aggregate files are
// ingested here; no production database or application state is changed.
const fs=require("node:fs");
const path=require("node:path");
const {openHistory}=require("../economy/history");
const {historyFile,feedFile}=require("../economy/service");
function readStable(file) {
  const before=fs.statSync(file);
  const data=JSON.parse(fs.readFileSync(file,"utf8"));
  const after=fs.statSync(file);
  if(before.mtimeMs!==after.mtimeMs || before.size!==after.size) throw Error("Source changed during history capture; retry on the next collector run");
  return {data,fingerprint:`${after.mtimeMs}:${after.size}`};
}
function collect({feed=feedFile(),source=process.env.ECONOMY_SOURCE_HISTORY,output=historyFile(),eventsFile=process.env.ECONOMY_EVENTS_FILE}={}) {
  const previousUmask=process.umask(0o077);
  let store;
  try {
    store=openHistory(output);
    const current=readStable(feed);
    const sources=source?[...fs.readdirSync(path.dirname(source)).filter(f=>/^turns-.+\.json$/.test(f)).sort().map(f=>path.join(path.dirname(source),f)),source]:[];
    if(!source) sources.push(null);
    const summaries=[];
    for(const file of sources) {
      const snapshot=file?readStable(file):null;
      const active=!file || file===source;
      const fileKey=file || feed;
      const annotation=eventsFile?readStable(eventsFile):null;
      const fingerprint=`${snapshot?.fingerprint||"feed"}:${active?current.fingerprint:"archive"}:${annotation?.fingerprint||""}`;
      if(store.db.prepare("SELECT fingerprint FROM sources WHERE source=?").get(fileKey)?.fingerprint===fingerprint) continue;
      const history=snapshot?.data || {worldId:current.data.worldId,completedThrough:current.data.completedThrough};
      // Old exports may predate the completed-turn boundary. Keep the archive,
      // but never guess which of its turns were finished.
      if(!active && !Number.isSafeInteger(history.completedThrough)) {
        summaries.push({skipped:path.basename(file),reason:"Missing completed-turn boundary"});
        continue;
      }
      if(annotation) history.events=[...(history.events||[]),...(annotation.data.events||[]).filter(e=>e.worldId===history.worldId)];
      const summary=store.ingest({history,feed:active?current.data:null,active,provenance:active?"retained collector aggregates":"archived collector aggregates"});
      store.db.prepare("INSERT INTO sources VALUES (?,?) ON CONFLICT(source) DO UPDATE SET fingerprint=excluded.fingerprint").run(fileKey,fingerprint);
      summaries.push(summary);
    }
    if(output!==":memory:") fs.chmodSync(output,0o600);
    return {database:output,worlds:store.worlds().length,updated:summaries};
  } finally {store?.close();process.umask(previousUmask);}
}
if(require.main===module) {
  try { console.log(JSON.stringify(collect())); }
  catch(error) { console.error(`Economy history capture failed: ${error.message}`);process.exitCode=1; }
}
module.exports={collect,readStable};
