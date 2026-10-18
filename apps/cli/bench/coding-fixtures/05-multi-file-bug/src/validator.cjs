"use strict";
function validateEntry(entry){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(entry.date))throw new Error('Invalid date '+entry.date);
 if(typeof entry.startMin!=='number'||typeof entry.endMin!=='number')throw new Error('Times must be numeric');
 if(!(entry.endMin>entry.startMin))throw new Error('Entry must end after it starts');
 if(entry.endMin-entry.startMin>1440)throw new Error('Entry longer than a day');
 if(typeof entry.project!=='string'||!entry.project.trim())throw new Error('Project is required');
 if(!Array.isArray(entry.tags))throw new Error('Tags must be a list');
 return entry;
}
module.exports={validateEntry};
