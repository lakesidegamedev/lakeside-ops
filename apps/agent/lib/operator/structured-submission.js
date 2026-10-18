'use strict';
// Compute and insert exact figures in one submission. This checks arithmetic,
// not the choice of formula, surrounding reasoning or a proposed policy change.
const {calculateBatch}=require('./knowledge');
const REFERENCE='^\\$(?:calc\\.)?[A-Za-z_][A-Za-z0-9_]{0,39}$';
function calculationInputSchema(schema){
 if(!schema||typeof schema!=='object')return schema;
 if(['number','integer'].includes(schema.type))return{anyOf:[schema,{type:'string',pattern:REFERENCE}]};
 const result={...schema};
 if(schema.properties)result.properties=Object.fromEntries(Object.entries(schema.properties).map(([key,value])=>[key,calculationInputSchema(value)]));
 if(schema.items)result.items=calculationInputSchema(schema.items);
 if(schema.additionalProperties&&typeof schema.additionalProperties==='object')result.additionalProperties=calculationInputSchema(schema.additionalProperties);
 for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(schema[key]))result[key]=schema[key].map(calculationInputSchema);
 return result;
}
async function prepareStructuredSubmission(job,input,{allowCalculations=false,calculate=steps=>calculateBatch(steps,job.evidence||[])}={}){
 if(input.calculations===undefined)return{result:input.result,summary:input.summary};
 if(!allowCalculations)throw Error('Inline calculations require the calculate tool granted to this task');
 const calculations=await calculate(input.calculations);
 if(!Array.isArray(calculations)||calculations.length!==input.calculations.length||calculations.some((step,index)=>step.id!==input.calculations[index].id||step.expression!==input.calculations[index].expression||!Number.isFinite(step.value)))throw Error('Calculator returned an invalid calculation trace');
 const values=new Map(calculations.map(step=>[step.id,step.value]));
 let nodes=0,bytes=0;
 function value(id){if(!values.has(id))throw Error('Unknown inline calculation '+id);return values.get(id);}
 function expand(item,depth=0){
  if(++nodes>10000||depth>24)throw Error('Calculated report exceeds structural limits');
  if(typeof item==='string'){
   if(item.length>32000)throw Error('Calculated report text exceeds 32000 characters');
   const exact=/^\$(?:calc\.)?([A-Za-z_][A-Za-z0-9_]{0,39})$/.exec(item);
   if(exact)return value(exact[1]);
   const rendered=item.replace(/\{\{(?:calc\.)?([A-Za-z_][A-Za-z0-9_]{0,39})(?::(\d{1,2}))?\}\}/g,(_all,id,digits)=>{
    const number=value(id);if(digits===undefined)return String(number);
    const precision=Number(digits);if(precision>10)throw Error('Calculation display precision must be 0-10');
    return number.toFixed(precision);
   });
   if(rendered.includes('{{calc.'))throw Error('Malformed calculation placeholder; use {{calc.id}} or {{calc.id:2}}');
   bytes+=Buffer.byteLength(rendered);if(bytes>1000000||rendered.length>32000)throw Error('Calculated report exceeds text limits');
   return rendered;
  }
  if(Array.isArray(item))return item.map(value=>expand(value,depth+1));
  if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,value])=>[key,expand(value,depth+1)]));
  return item;
 }
 const result=expand(input.result),summary=typeof input.summary==='string'?expand(input.summary):input.summary;
 return{result,summary,calculations};
}
module.exports={calculationInputSchema,prepareStructuredSubmission};
