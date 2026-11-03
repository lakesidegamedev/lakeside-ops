"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { openHistory } = require("./history");
const feedFile = () => process.env.ECONOMY_FEED_FILE || "/var/lib/ahd-economy/economy.json";
const historyFile = () => process.env.ECONOMY_HISTORY_DB || path.join(path.dirname(feedFile()),"history.sqlite");
let reader=null, readerFile=null;
function readEconomyView(params) {
  const file=historyFile();
  if (!fs.existsSync(file)) return null;
  if (!reader || readerFile!==file) { reader?.close();reader=openHistory(file,{readonly:true});readerFile=file; }
  return reader.select(params);
}
function exportEconomyCsv(params) {
  const selection=readEconomyView(params);
  if (!selection) return null;
  const {world,scope,entity,spec,from,to}=selection;
  const count=reader.db.prepare("SELECT COUNT(*) n FROM samples WHERE world=? AND scope=? AND entity=? AND metric=? AND turn BETWEEN ? AND ?")
    .get(world.id,scope,entity,spec.key,from,to).n;
  if(count>10000) return {status:413,error:"Choose a smaller window to export at most 10,000 exact readings"};
  const rows=reader.db.prepare("SELECT turn,value FROM samples WHERE world=? AND scope=? AND entity=? AND metric=? AND turn BETWEEN ? AND ? ORDER BY turn")
    .all(world.id,scope,entity,spec.key,from,to);
  return {status:200,csv:"turn,value\r\n"+rows.map(r=>`${r.turn},${r.value}`).join("\r\n")+"\r\n"};
}
module.exports={readEconomyView,exportEconomyCsv,historyFile,feedFile};
