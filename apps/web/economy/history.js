"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { METRICS, VIEWS, human } = require("./metrics");
const finite = value => typeof value === "number" && Number.isFinite(value);

function observations(turn) {
  const rows = [];
  const add = (scope, entity, source) => {
    for (const spec of Object.values(METRICS).filter(m=>m.scope===scope)) {
      const value = source?.[spec.key];
      // 999 is the collector's no-burn sentinel, not a measured cash runway.
      if (finite(value) && !(scope === "corp" && spec.key === "runway" && value === 999)) rows.push([scope, entity, spec.key, value]);
    }
  };
  for (const scope of ["macro","corp","wealth","trades","index"]) add(scope,"world",turn[scope]);
  for (const [entity, country] of Object.entries(turn.macro?.countries || {})) add("country",entity,country);
  const macro = turn.macro || {};
  const commodities = new Set([...Object.keys(macro.prices||{}), ...Object.keys(macro.supplyDemand||{})]);
  for (const entity of commodities) add("commodity",entity,{price:macro.prices?.[entity],real:macro.realRel?.[entity],sd:macro.supplyDemand?.[entity]});
  for (const [scope, field] of [["family","byFam"],["industry","byType"],["owner","byOwner"],["company_country","byCountry"]]) {
    for (const [entity, group] of Object.entries(turn.corp?.[field] || {})) add(scope,entity,group);
  }
  for (const [entity, pair] of Object.entries(turn.flows || {})) {
    if (!Array.isArray(pair) || !pair.every(finite) || pair.length !== 2) continue;
    add("flow",entity,{in:pair[1],out:-pair[0],net:pair[0]+pair[1]});
  }
  return rows;
}

function openHistory(file, { readonly = false } = {}) {
  if (!readonly && file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
  const db = new Database(file, { readonly, fileMustExist:readonly, timeout:5000 });
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY, source_world TEXT NOT NULL, epoch TEXT, label TEXT NOT NULL,
      first_turn INTEGER, last_turn INTEGER, captured_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0, game TEXT NOT NULL DEFAULT '{}', feed TEXT);
    CREATE TABLE IF NOT EXISTS revisions (
      world TEXT NOT NULL, turn INTEGER NOT NULL, hash TEXT NOT NULL, captured_at TEXT NOT NULL,
      provenance TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,turn,hash));
    CREATE TABLE IF NOT EXISTS turn_heads (world TEXT NOT NULL, turn INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(world,turn));
    CREATE TABLE IF NOT EXISTS samples (
      world TEXT NOT NULL, scope TEXT NOT NULL, entity TEXT NOT NULL, metric TEXT NOT NULL,
      turn INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(world,scope,entity,metric,turn));
    CREATE TABLE IF NOT EXISTS events (
      world TEXT NOT NULL, turn INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      label TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY(world,kind,key));
    CREATE TABLE IF NOT EXISTS series_catalog (world TEXT NOT NULL, scope TEXT NOT NULL, entity TEXT NOT NULL, metric TEXT NOT NULL, PRIMARY KEY(world,scope,entity,metric));
    CREATE TABLE IF NOT EXISTS sources (source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS samples_turn ON samples(world,turn);
    `);
    if(!db.prepare("SELECT 1 FROM series_catalog LIMIT 1").get()) db.exec("INSERT OR IGNORE INTO series_catalog SELECT DISTINCT world,scope,entity,metric FROM samples");
  }
  function event(world, turn, kind, key, label, confidence) {
    if (Number.isSafeInteger(turn) && turn >= 0) db.prepare("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?)")
      .run(world,turn,kind,String(key),String(label).slice(0,240),confidence);
  }
  const ingest = db.transaction(({ history, feed = null, active = true, provenance = "retained aggregate history", epoch = null }) => {
    const sourceWorld = history?.worldId || feed?.worldId;
    if (!sourceWorld || (history?.worldId && feed?.worldId && history.worldId !== feed.worldId)) throw Error("History and feed world identities do not match");
    const completed = Number.isSafeInteger(history?.completedThrough) ? history.completedThrough : feed?.completedThrough;
    if (!Number.isSafeInteger(completed) || completed < 0) throw Error("Completed-turn boundary is required");
    epoch = epoch || history?.worldEpochId || feed?.game?.worldEpochId || null;
    if(epoch!==null && (typeof epoch!=="string" || !epoch.trim())) throw Error("World epoch must be a non-empty string");
    const now = new Date().toISOString();
    let id = epoch ? `${sourceWorld}@${epoch}` : String(sourceWorld);
    if (!epoch && active) {
      const current = db.prepare("SELECT * FROM worlds WHERE source_world=? AND active=1").get(sourceWorld);
      if (current && completed < current.last_turn) id = `${sourceWorld}@restart-${crypto.randomUUID()}`;
      else if (current) id = current.id;
    }
    const game = feed?.game || {};
    const iteration = game.iteration ? `${game.iteration.type || "Iteration"} ${game.iteration.number}` : sourceWorld;
    const label = `${game.startingYear ? game.startingYear + " / " : ""}${iteration}`;
    if (active) db.prepare("UPDATE worlds SET active=0 WHERE active=1 AND id<>?").run(id);
    db.prepare(`INSERT INTO worlds(id,source_world,epoch,label,captured_at,updated_at,active,game,feed) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, active=MAX(worlds.active,excluded.active),
      label=CASE WHEN excluded.feed IS NOT NULL THEN excluded.label ELSE worlds.label END,
      game=CASE WHEN excluded.feed IS NOT NULL THEN excluded.game ELSE worlds.game END,
      feed=COALESCE(excluded.feed,worlds.feed)`).run(id,String(sourceWorld),epoch,label,now,now,active?1:0,JSON.stringify(game),feed?JSON.stringify(feed):null);
    const revision = db.prepare("INSERT OR IGNORE INTO revisions VALUES (?,?,?,?,?,?)");
    const sample = db.prepare("INSERT INTO samples VALUES (?,?,?,?,?,?) ON CONFLICT(world,scope,entity,metric,turn) DO UPDATE SET value=excluded.value");
    let inserted = 0;
    for (const [key, snapshot] of Object.entries(history?.turns || {})) {
      const turn = Number(key);
      if (!Number.isSafeInteger(turn) || turn < 0 || turn > completed) continue;
      const rows = observations(snapshot);
      if (!rows.length) continue;
      rows.sort((a,b)=>String(a.slice(0,3)).localeCompare(String(b.slice(0,3))));
      const payload = JSON.stringify(rows);
      const hash = crypto.createHash("sha256").update(payload).digest("hex");
      if (db.prepare("SELECT hash FROM turn_heads WHERE world=? AND turn=?").get(id,turn)?.hash===hash) continue;
      revision.run(id,turn,hash,now,provenance,payload);
      db.prepare("INSERT INTO turn_heads VALUES (?,?,?) ON CONFLICT(world,turn) DO UPDATE SET hash=excluded.hash").run(id,turn,hash);
      for (const [scope,entity,metric,value] of rows) sample.run(id,scope,entity,metric,turn,value);
      inserted++;
    }
    // Scores and gate series are published derivations, retained alongside raw aggregates.
    for (const [metric, points] of Object.entries(feed?.scores || {})) {
      if (!METRICS[`score.${metric}`]) continue;
      for (const [turn,value] of points) if (Number.isSafeInteger(turn) && turn >= 0 && turn <= completed && finite(value)) sample.run(id,"score","world",metric,turn,value);
    }
    if (!history?.turns) {
      for (const [scope, series] of [["macro",feed?.macro],["wealth",feed?.wealth],["corp",feed?.corpSeries],["trades",feed?.trades]]) {
        for (const row of series?.rows || []) for (let i=0;i<series.fields.length;i++) {
          const metric=series.fields[i],value=row[i+1];
          if (METRICS[`${scope}.${metric}`] && row[0] <= completed && finite(value)) sample.run(id,scope,"world",metric,row[0],value);
        }
      }
    }
    db.prepare("INSERT OR IGNORE INTO series_catalog SELECT DISTINCT world,scope,entity,metric FROM samples WHERE world=?").run(id);
    const limits = db.prepare("SELECT MIN(turn) AS first,MAX(turn) AS last FROM samples WHERE world=?").get(id);
    db.prepare("UPDATE worlds SET first_turn=?,last_turn=? WHERE id=?").run(limits.first,limits.last,id);
    event(id,0,"iteration_start","start","Iteration start","recorded identity");
    let previousCount=null;
    for(const [t,row] of Object.entries(history?.turns||{}).sort((a,b)=>Number(a[0])-Number(b[0]))) {
      const count=row.corp?.nActive;
      if(Number(t)>completed || !finite(count))continue;
      if(previousCount>0 && count<previousCount*.5)event(id,Number(t),"economy_reset",t,"Detected economy reset","inferred from company-count discontinuity");
      previousCount=count;
    }
    for (const turn of feed?.resets || []) event(id,turn,"economy_reset",turn,"Detected economy reset","inferred from company-count discontinuity");
    for (const entry of [...(history?.events || []), ...(feed?.events || [])]) {
      if (entry.kind === "economy_reset" && entry.turn <= completed) event(id,entry.turn,entry.kind,entry.turn,entry.label || "Economy reset",entry.confidence || "recorded");
    }
    for (const entry of feed?.deploys || []) if (entry.t <= completed && /^[a-f\d]{7,40}$/i.test(entry.commit || ""))
      event(id,entry.t,"deployment",entry.commit,`Deployment ${entry.commit.slice(0,7)}`,"recorded deployment");
    return { id, inserted, first:limits.first, last:limits.last };
  });
  function worlds() {
    return db.prepare(`SELECT id,source_world,epoch,label,first_turn,last_turn,active,captured_at,updated_at,
      COALESCE(NULLIF((SELECT COUNT(*) FROM turn_heads WHERE world=worlds.id),0),
      (SELECT COUNT(DISTINCT turn) FROM samples WHERE world=worlds.id)) AS turns,
      (SELECT COUNT(*) FROM revisions WHERE world=worlds.id) AS revisions,
      (SELECT COUNT(*) FROM series_catalog WHERE world=worlds.id) AS series_count,
      (SELECT COUNT(*) FROM (SELECT DISTINCT scope,metric FROM series_catalog WHERE world=worlds.id)) AS metric_count FROM worlds WHERE last_turn IS NOT NULL ORDER BY active DESC,captured_at DESC,id`).all();
  }
  function select(params) {
    const list = worlds();
    const world = list.find(w=>w.id===params.get("world")) || list[0];
    if (!world) return null;
    const feed = JSON.parse(db.prepare("SELECT feed FROM worlds WHERE id=?").get(world.id).feed || "null");
    const tab = params.get("tab") === "explore" ? "macro" : params.get("tab");
    const view = VIEWS.find(v=>v.id===tab) || VIEWS[0];
    const scope = view.id === "companies" && ["corp","family","industry","owner","company_country","index","trades"].includes(params.get("scope")) ? params.get("scope") : view.scope;
    const specs = Object.values(METRICS).filter(m=>m.scope===scope);
    const spec = specs.find(m=>m.key===params.get("metric")) || specs.find(m=>m.key===view.metric) || specs[0];
    const entities = db.prepare("SELECT DISTINCT entity FROM series_catalog WHERE world=? AND scope=? ORDER BY entity").all(world.id,scope).map(r=>r.entity);
    const preferred={country:"US",commodity:"food",family:"Industry",industry:"manufacturing",owner:"Player",company_country:"US",flow:"corp_revenue"}[scope];
    const entity = entities.includes(params.get("entity")) ? params.get("entity") : entities.includes(preferred)?preferred:entities[0] || "world";
    const events = db.prepare("SELECT * FROM events WHERE world=? ORDER BY turn,kind").all(world.id);
    const resets = events.filter(e=>e.kind==="economy_reset");
    let from = resets.at(-1)?.turn ?? world.first_turn ?? 0;
    const toInput = Number(params.get("to"));
    const to = params.get("to") && Number.isSafeInteger(toInput) ? Math.max(world.first_turn,Math.min(world.last_turn,toInput)) : world.last_turn;
    from=resets.filter(e=>e.turn<=to).at(-1)?.turn ?? world.first_turn ?? 0;
    const range = params.get("range") || "reset";
    if (range === "all") from=world.first_turn;
    else if (["24","96","240"].includes(range)) from=Math.max(world.first_turn,to-Number(range)+1);
    const fromInput=Number(params.get("from"));
    if (params.get("from") && Number.isSafeInteger(fromInput)) from=Math.max(world.first_turn,Math.min(to,fromInput));
    from=Math.min(from,to);
    const resolution = [1,4,12,48].includes(Number(params.get("step"))) ? Number(params.get("step")) : 1;
    const step = Math.max(resolution,Math.ceil((to-from+1)/600));
    const points = series(world.id,scope,entity,spec,from,to,step,events);
    const recent = db.prepare("SELECT turn,value FROM samples WHERE world=? AND scope=? AND entity=? AND metric=? AND turn BETWEEN ? AND ? ORDER BY turn DESC LIMIT 100")
      .all(world.id,scope,entity,spec.key,from,to);
    const comparisonWorld = list.find(w=>w.id===params.get("compare") && w.id!==world.id);
    // Compare iteration age, or age since the most recent reset, rather than matching reused turn numbers blindly.
    let comparison=null;
    if (comparisonWorld) {
      const otherEvents=db.prepare("SELECT * FROM events WHERE world=? ORDER BY turn").all(comparisonWorld.id);
      const origin = range==="reset" ? (resets.filter(e=>e.turn<=to).at(-1)?.turn ?? 0) : 0;
      const otherOrigin=range==="reset" ? (otherEvents.filter(e=>e.kind==="economy_reset").at(-1)?.turn ?? 0) : 0;
      comparison={ world:comparisonWorld, origin, otherOrigin,
        points:series(comparisonWorld.id,scope,entity,spec,Math.max(otherOrigin,otherOrigin+from-origin),Math.min(comparisonWorld.last_turn,otherOrigin+to-origin),step,otherEvents)
          .map(p=>({...p,sourceTurn:p.turn,turn:p.turn-otherOrigin+origin,end:p.end-otherOrigin+origin})) };
    }
    const summaries=db.prepare(`SELECT s.entity,s.value,s.turn FROM samples s JOIN
      (SELECT entity,MAX(turn) turn FROM samples WHERE world=? AND scope=? AND metric=? AND turn BETWEEN ? AND ? GROUP BY entity) x
      ON s.entity=x.entity AND s.turn=x.turn WHERE s.world=? AND s.scope=? AND s.metric=? ORDER BY s.entity LIMIT 200`)
      .all(world.id,scope,spec.key,from,to,world.id,scope,spec.key);
    const firstReading=db.prepare("SELECT turn,value FROM samples WHERE world=? AND scope=? AND entity=? AND metric=? AND turn BETWEEN ? AND ? ORDER BY turn LIMIT 1").get(world.id,scope,entity,spec.key,from,to);
    return { world, worlds:list, feed, view, scope, specs, spec, entity, entities, events, from,to,step,range,points,recent,firstReading,comparison,summaries,customRange:params.has("from")||params.has("to") };
  }
  function series(world,scope,entity,spec,from,to,step,events=[]) {
    if (to<from) return [];
    const breaks=events.filter(e=>e.kind==="economy_reset").map(e=>e.turn);
    const rows=db.prepare(`SELECT turn,value FROM samples WHERE world=? AND scope=? AND entity=? AND metric=? AND turn BETWEEN ? AND ? ORDER BY turn`).iterate(world,scope,entity,spec.key,from,to);
    const buckets=[];
    let bucket=null,previous=null,segment=0;
    for (const row of rows) {
      const reset=previous!==null && breaks.some(t=>t>previous && t<=row.turn);
      const gap=previous!==null && row.turn>previous+1;
      if(reset) {segment++;bucket=null;}
      const slot=Math.floor((row.turn-from)/step);
      if (!bucket || bucket.slot!==slot) {
        if(gap)segment++;
        bucket={slot,turn:row.turn,end:row.turn,low:row.value,high:row.value,sum:0,count:0,segment};buckets.push(bucket);
      }
      if(gap) {bucket.gap=true;bucket.segment=++segment;}
      bucket.end=row.turn;bucket.low=Math.min(bucket.low,row.value);bucket.high=Math.max(bucket.high,row.value);bucket.sum+=row.value;bucket.count++;previous=row.turn;
    }
    return buckets.map(({sum,...b})=>({...b,value:spec.aggregation==="sum"?sum:sum/b.count}));
  }
  return { db, ingest, worlds, select, series, close:()=>db.close(), human };
}
module.exports = { openHistory, observations };
