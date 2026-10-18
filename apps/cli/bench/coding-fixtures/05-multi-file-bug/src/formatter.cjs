"use strict";
const {parseEntry}=require('./parser.cjs'),{validateEntry}=require('./validator.cjs');
function duration(minutes){
 const h=Math.floor(minutes/60),m=minutes%60;
 return h+'h'+String(m).padStart(2,'0')+'m';
}
function formatEntry(line){
 const e=validateEntry(parseEntry(line));
 const tags=e.tags.length?' ['+e.tags.join(', ')+']':'';
 return e.date+' '+e.project+' '+duration(e.endMin-e.startMin)+tags;
}
module.exports={formatEntry,duration};
