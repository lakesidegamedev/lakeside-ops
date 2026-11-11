"use strict";
const crypto=require("node:crypto");
const policy=require("./ownermuse-policy");
const JARGON=/(?:\b(?:src|content|lib|apps)\/|\b[\w.-]+\.(?:tsx?|jsx?|rs|md)\b|\b[a-f0-9]{10,40}\b|\b(?:staging|development|multipliers?|limiter|fundamental|clampedPrice|post-multiplier|high-impact code|CI|runtime|pipeline)\b|\bPR\s*#?\d+)/i;
function headOf(args) {return args.head || crypto.createHash("sha256").update(JSON.stringify(args.prs||[])).digest("hex");}
const MIN=15, MAX=350;
// A field can fail for several reasons at once, and a refusal that named only the first field
// left the model fixing them one round at a time: it shortened change, called again, and was
// refused for impact. Describe every problem in one message, with the measure that fixes it.
function faults(key,s) {
  const out=[];
  if(s.length<MIN) out.push(`${key} is ${s.length} characters and needs at least ${MIN}: one short sentence`);
  else if(s.length>MAX) out.push(`${key} is ${s.length} characters and the limit is ${MAX}: cut it to one or two sentences`);
  const term=s.match(JARGON);
  if(term) out.push(`${key} uses "${term[0]}", which is code or release jargon: rewrite that part in ordinary language`);
  if(policy.hasCredentials(s)) out.push(`${key} looks like it contains a credential: remove it`);
  if(/\*\*Decision:\*\*|<@|@everyone|@here/.test(s)) out.push(`${key} has a mention or a decision marker: write plain sentences`);
  return out;
}
function explanation(value,args) {
  if(!value || value.reviewedHead!==headOf(args)) throw new Error("Read this exact change and provide explanation with reviewedHead, change, impact and risk before asking the owner. Explain what changes for players in ordinary language, not file names, formulas or release jargon.");
  const result={reviewedHead:value.reviewedHead}, faultsFound=[];
  for(const key of ["change","impact","risk"]) {
    const s=String(value[key]||"").trim();
    const found=faults(key,s);
    if(found.length) {faultsFound.push(...found);continue;}
    result[key]=s.replace(/[\u2013\u2014]/g,",");
  }
  if(faultsFound.length) throw new Error(`Explanation not sent. Fix all of these in one call: ${faultsFound.join("; ")}. Each of change, impact and risk is ${MIN} to ${MAX} characters of ordinary language: what changes, who notices, and the real risk or uncertainty. Do not use file paths, code identifiers, formulas, PR numbers or release jargon.`);
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
