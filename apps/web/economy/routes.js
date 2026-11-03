"use strict";
const {canReadDeveloperView}=require("../ops-staff-role");
const {readFeed,makeEconomyBody}=require("../economy-page");
const {readEconomyView,exportEconomyCsv}=require("./service");
const {makeExplorerBody}=require("./explorer");
async function handleEconomyRoute(req,res,pathname,ctx) {
  if(!["/economy","/economy.csv"].includes(pathname))return false;
  const {resolveSession,addSecurityHeaders,renderShell,denyHtml,json,
    readView=readEconomyView,readSnapshot=readFeed,exportCsv=exportEconomyCsv}=ctx;
  const session=await resolveSession(req);
  if(!canReadDeveloperView(session,pathname)) {denyHtml();return true;}
  if(!["GET","HEAD"].includes(req.method)) {json(res,405,{error:"Economy views are read-only"});return true;}
  const params=new URL(req.url,"http://localhost").searchParams;
  addSecurityHeaders(res);
  res.setHeader("Cache-Control","no-store");
  if(pathname==="/economy.csv") {
    let result;
    try {result=exportCsv(params);} catch(error) {
      console.error("[economy-history] export unavailable:",error.message);
      json(res,503,{error:"Economy history is temporarily unavailable"});return true;
    }
    if(!result) {json(res,503,{error:"History is not indexed yet"});return true;}
    if(result.status!==200) {json(res,result.status,{error:result.error});return true;}
    res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Cache-Control":"no-store","Content-Disposition":'attachment; filename="economy-series.csv"'});
    res.end(req.method==="HEAD"?"":result.csv);return true;
  }
  let model;
  try {model=readView(params);} catch(error) {
    console.error("[economy-history] index unavailable:",error.message);
    res.writeHead(503,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
    res.end(req.method==="HEAD"?"":renderShell({title:"Economy",active:"/economy",role:session.role,body:'<section style="padding:24px"><h1>Economy history is temporarily unavailable</h1><p>The collector retains the source records. Please retry shortly.</p></section>'}));return true;
  }
  const page=model?makeExplorerBody(model):makeEconomyBody({...readSnapshot(),tab:params.get("tab")||"overview",range:params.get("range")||"reset"});
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
  res.end(req.method==="HEAD"?"":renderShell({title:"Economy",active:"/economy",role:session.role,...page}));return true;
}
module.exports={handleEconomyRoute};
