'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
// Keep large HTML payloads out of OS argv (Linux limits each argument to128KiB).
function publishReport(payload,out){payload={library_category:'keir',report_type:'Benchmark',takeaway:'Open the leaderboard for each model\'s accuracy, speed, tokens and cost on the same task set.',...payload};const file=path.join(out,'report-publish.json');fs.writeFileSync(file,JSON.stringify(payload),{mode:0o600});const boot='const fs=require("node:fs");const payload=fs.readFileSync(process.argv[1],"utf8");process.argv=[process.execPath,"/root/bin/mcpcall","report-publish","publish_report",payload];require("/root/bin/mcpcall");';return cp.execFileSync(process.execPath,['-e',boot,file],{encoding:'utf8',maxBuffer:2e6});}
module.exports={publishReport};
