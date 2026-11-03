const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');
const {collect}=require('../scripts/collect-economy-history');const{openHistory}=require('./history');
test('automatic capture is idempotent and retains past iterations independently of source replacement',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'econ-capture-'));const source=path.join(dir,'turns.json'),feed=path.join(dir,'feed.json'),output=path.join(dir,'store.sqlite');
 function write(id,value){fs.writeFileSync(source,JSON.stringify({worldId:id,completedThrough:1,turns:{1:{macro:{growth:value}}}}));fs.writeFileSync(feed,JSON.stringify({worldId:id,completedThrough:1,resets:[]}))}
 try{write('iteration-1',2);assert.equal(collect({feed,source,output}).updated.length,1);assert.equal(collect({feed,source,output}).updated.length,0);
  write('iteration-2',9);assert.equal(collect({feed,source,output}).worlds,2);
  const store=openHistory(output,{readonly:true});try{assert.equal(store.select(new URLSearchParams({world:'iteration-1',tab:'macro'})).recent[0].value,2);assert.equal(store.select(new URLSearchParams({world:'iteration-2',tab:'macro'})).recent[0].value,9)}finally{store.close()}
  assert.equal(fs.statSync(output).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('capture refuses mismatched source world files instead of mixing their turn numbers',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'econ-mismatch-'));try{const source=path.join(dir,'turns.json'),feed=path.join(dir,'feed.json'),output=path.join(dir,'store.sqlite');fs.writeFileSync(source,JSON.stringify({worldId:'new',completedThrough:1,turns:{}}));fs.writeFileSync(feed,JSON.stringify({worldId:'old',completedThrough:1}));assert.throws(()=>collect({feed,source,output}),/identities/)}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
