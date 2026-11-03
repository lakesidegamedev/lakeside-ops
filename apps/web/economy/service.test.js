const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openHistory}=require('./history');
const {exportEconomyCsv}=require('./service');
test('CSV exports exact readings despite coarse charts and bounds the real selected series',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'econ-csv-')),file=path.join(dir,'history.sqlite'),previous=process.env.ECONOMY_HISTORY_DB;
 const store=openHistory(file);
 try{
  store.ingest({history:{worldId:'export',completedThrough:10000,turns:{0:{macro:{growth:0}},10000:{macro:{growth:10000}}}}});
  const put=store.db.prepare('INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?)');
  store.db.transaction(()=>{for(let t=0;t<=10000;t++)put.run('export','macro','world','growth',t,t)})();
  process.env.ECONOMY_HISTORY_DB=file;
  const result=exportEconomyCsv(new URLSearchParams({tab:'macro',range:'all',from:'1',to:'3',step:'4'}));
  assert.equal(result.status,200);assert.equal(result.csv,'turn,value\r\n1,1\r\n2,2\r\n3,3\r\n');
  assert.equal(exportEconomyCsv(new URLSearchParams({tab:'macro',range:'all'})).status,413);
 }finally{store.close();if(previous===undefined)delete process.env.ECONOMY_HISTORY_DB;else process.env.ECONOMY_HISTORY_DB=previous;fs.rmSync(dir,{recursive:true,force:true})}
});
