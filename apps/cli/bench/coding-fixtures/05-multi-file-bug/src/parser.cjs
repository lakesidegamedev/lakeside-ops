"use strict";
// Parses one timesheet log line: DATE START-END PROJECT [#tag ...]
function toMinutes(text){
 const [h,m]=text.split(':');
 return parseInt(h,10)*60+m;
}
function parseEntry(line){
 const parts=line.split(' ');
 const date=parts[0],range=parts[1];
 if(!date||!range||!range.includes('-'))throw new SyntaxError('Malformed entry: '+line);
 const [start,end]=range.split('-');
 const rest=parts.slice(2).join(' ');
 const hash=rest.indexOf('#');
 const project=hash<0?rest:rest.slice(0,hash);
 const tags=hash<0?[]:rest.slice(hash).split(' ').map(t=>t.slice(1));
 return {date,startMin:toMinutes(start),endMin:toMinutes(end),project,tags};
}
module.exports={parseEntry};
