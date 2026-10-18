'use strict';
// Benchmark arms that run the real Keir brief and tool grant instead of the bench's own minimal prompt.
// keir-current: KEIR.md + lane skills + the full tool grant, as shipped before the lean context.
// keir-lean: the same job through briefprofile (trimmed brief, skill digests, deferred tool schemas).
const fs=require('node:fs'),path=require('node:path');
const AGENT=path.resolve(__dirname,'../../agent');
const {TOOLS,TOOL_NOTE}=require(AGENT+'/lib/operator/agent');
const skills=require(AGENT+'/lib/operator/skills'),bp=require(AGENT+'/lib/operator/briefprofile'),{childTools}=require(AGENT+'/lib/operator/delegation');
const KEIR=fs.readFileSync(AGENT+'/KEIR.md','utf8'),CORE=fs.readFileSync(AGENT+'/KEIR-CORE.md','utf8');
const OWNER_ONLY=['edit_verify','finish_patch','owner_updates','computer','present_choices'];
const SHAPES={
 investigation:{job:{kind:'command',role:'owner'},quick:false,tools:()=>TOOLS.filter(t=>!OWNER_ONLY.includes(t.name))},
 support:{job:{kind:'ticket',role:'support',ticket:1},quick:false,tools:()=>TOOLS.filter(t=>!OWNER_ONLY.includes(t.name)&&!['request_heal','execute_action','request_action','support_directive'].includes(t.name))},
 coding:{job:{kind:'coding',role:'owner',codingParent:'bench-parent',codingContract:{allowCompleteOnPass:true}},quick:false,tools:job=>TOOLS.filter(t=>childTools(job).includes(t.name))},
};
function build(profile,shape){
 const spec=SHAPES[shape],job={...spec.job},tools=spec.tools(job),lane=skills.laneOf(job,spec.quick),prep=skills.prepare(lane);
 if(profile==='keir-current')return{tools,deferred:null,brief:KEIR+TOOL_NOTE+prep.text,stats:{briefChars:(KEIR+TOOL_NOTE+prep.text).length,toolSchemaChars:JSON.stringify(tools).length,tools:tools.length}};
 const hybrid=profile==='keir-hybrid',ctx=bp.lean({job,quick:spec.quick,briefText:KEIR,tools:hybrid?tools.filter(t=>!['finish_patch','edit_verify'].includes(t.name)):tools,skills,skillLane:lane,skillNames:prep.names,...(hybrid?{coreText:CORE,hybrid:true}:{})});
 const brief=ctx.brief+TOOL_NOTE+ctx.skillDigest(prep.names),direct=ctx.session.tools;
 return{tools:direct,deferred:ctx.session,brief,stats:{briefChars:brief.length,toolSchemaChars:JSON.stringify(direct).length,tools:direct.length,profile:ctx.profile,omitted:ctx.omitted.length,deferredTools:ctx.deferredNames.length}};
}
const isArm=p=>['keir-current','keir-lean','keir-hybrid'].includes(p);
module.exports={build,isArm};
