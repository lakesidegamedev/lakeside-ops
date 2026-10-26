"use strict";
const crypto=require("node:crypto");
const policy=require("./ownermuse-policy");
const JARGON=/(?:\b(?:src|content|lib|apps)\/|\b[\w.-]+\.(?:tsx?|jsx?|rs|md)\b|\b[a-f0-9]{10,40}\b|\b(?:staging|development|multipliers?|limiter|fundamental|clampedPrice|post-multiplier|high-impact code|CI|runtime|pipeline)\b|\bPR\s*#?\d+)/i;
function headOf(args) {return args.head || crypto.createHash("sha256").update(JSON.stringify(args.prs||[])).digest("hex");}
function explanation(value,args) {
  if(!value || value.reviewedHead!==headOf(args)) throw new Error("Read this exact change and provide explanation with reviewedHead, change, impact and risk before asking the owner. Explain what changes for players in ordinary language, not file names, formulas or release jargon.");
  const result={reviewedHead:value.reviewedHead};
  for(const key of ["change","impact","risk"]) {
    const s=String(value[key]||"").trim();
    if(s.length<15 || s.length>350 || JARGON.test(s) || policy.hasCredentials(s) || /\*\*Decision:\*\*|<@|@everyone|@here/.test(s)) throw new Error(`explanation.${key} must be 15 to 350 characters of ordinary language: what changes, who notices, and the real risk or uncertainty. Do not use file paths, code identifiers, formulas, PR numbers or release jargon.`);
    result[key]=s.replace(/[\u2013\u2014]/g,",");
  }
  return result;
}
function review(args,human) {
  if (/(?:^|\/)AHDClient$/.test(args.repository||"")) return {title:"Include this change in the next desktop app update?",where:"This prepares a desktop app update. People receive it only after a new app version is published and installed.",approve:"Include this version in the desktop app changes being prepared.",decline:"Leave this change out of the desktop app update.",human};
  const target=args.action==="promote" ? args.to : args.to || "development";
  if(target==="staging") return {title:"Put this change on the test server?",where:"This affects the test server only. The live game stays as it is.",approve:"Put this version on the test server after its checks pass.",decline:"Leave the test server as it is.",human};
  if(target==="main") return {title:"Release this change to players?",where:"This updates the live game. Players receive the change when the release is running.",approve:"Release this version to players after its checks pass.",decline:"Keep the current live version.",human};
  return {title:"Include this change in the next test version?",where:"This prepares the next test version. It does not update the test server or the live game yet.",approve:"Include this version in the changes being prepared for testing.",decline:"Leave this change out of the next test version.",human};
}
function body(r) {return `${r.human.change}\n\nWhat players will notice: ${r.human.impact}\n\n${r.where}\n\nRisk or uncertainty: ${r.human.risk}`;}
function prepare(explanationValue,args) {const human=explanation(explanationValue,args);return review(args,human);}
module.exports={explanation,review,prepare,body,headOf,JARGON};
