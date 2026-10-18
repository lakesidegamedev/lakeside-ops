"use strict";
// Parses one timesheet log line: DATE START-END PROJECT [#tag ...]
function toMinutes(text,line){
 const m=/^(\d{2}):(\d{2})$/.exec(text);
 if(!m||Number(m[1])>23||Number(m[2])>59)throw new SyntaxError('Invalid time '+text+' in: '+line);
 return Number(m[1])*60+Number(m[2]);
}
function parseEntry(line){
 if(typeof line!=='string')throw new SyntaxError('Entry must be a string');
 const words=line.trim().split(/[ \t]+/).filter(Boolean);
 const [date,range,...rest]=words;
 const times=range&&/^([^-]+)-([^-]+)$/.exec(range);
 if(!date||!times)throw new SyntaxError('Malformed entry: '+line);
 const startMin=toMinutes(times[1],line);
 let endMin=toMinutes(times[2],line);
 if(endMin<=startMin)endMin+=1440;
 const first=rest.findIndex(w=>w.startsWith('#'));
 const projectWords=first<0?rest:rest.slice(0,first),tagWords=first<0?[]:rest.slice(first);
 if(!projectWords.length)throw new SyntaxError('Project is required: '+line);
 const tags=[];
 for(const w of tagWords){
  if(!w.startsWith('#')||w.length<2)throw new SyntaxError('Invalid tag '+w+' in: '+line);
  const t=w.slice(1).toLowerCase();
  if(!tags.includes(t))tags.push(t);
 }
 return {date,startMin,endMin,project:projectWords.join(' '),tags};
}
module.exports={parseEntry};
