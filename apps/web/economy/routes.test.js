const {test}=require('node:test');
const assert=require('node:assert/strict');
const {handleEconomyRoute}=require('./routes');
const {guardJuniorDeveloperRequest}=require('../ops-staff-role');
const {openHistory}=require('./history');
function response(){return{status:0,headers:{},body:'',setHeader(k,v){this.headers[k]=v},writeHead(code,headers={}){this.status=code;Object.assign(this.headers,headers)},end(body=''){this.body=body}}}
function context(role,extra={}){return{resolveSession:async()=>role?{role}:null,addSecurityHeaders:()=>{},renderShell:({role,body})=>`<main data-role="${role}">${body}</main>`,denyHtml:()=>{},json:(res,code,body)=>{res.writeHead(code);res.end(JSON.stringify(body))},...extra}}
test('real economy routes render the indexed view for Junior Developers and export only numeric CSV',async()=>{
 const store=openHistory(':memory:');
 try{store.ingest({history:{worldId:'world',completedThrough:2,turns:{1:{macro:{growth:2}},2:{macro:{growth:3}}}},feed:{worldId:'world',completedThrough:2}});
  const ctx=context('junior_dev',{readView:p=>store.select(p),exportCsv:()=>({status:200,csv:'turn,value\r\n1,2\r\n2,3\r\n'})});
  for(const pathname of ['/economy','/economy.csv'])for(const method of ['GET','HEAD']){
   const req={method,url:pathname+'?tab=macro'},res=response();
   assert.equal(await guardJuniorDeveloperRequest(req,res,pathname,ctx),false);
   assert.equal(await handleEconomyRoute(req,res,pathname,ctx),true);assert.equal(res.status,200);assert.equal(res.headers['Cache-Control'],'no-store');
   if(method==='HEAD')assert.equal(res.body,'');else if(pathname==='/economy')assert.match(res.body,/class="ex-chart"/);else assert.match(res.body,/turn,value/);
  }
 }finally{store.close()}
});
test('economy routes deny unrelated roles before loading data and keep writes denied',async()=>{
 for(const role of [null,'moderator']){const res=response(),ctx=context(role,{denyHtml:()=>{res.status=403},readView:()=>assert.fail('must not read')});await handleEconomyRoute({method:'GET',url:'/economy'},res,'/economy',ctx);assert.equal(res.status,403)}
 for(const pathname of ['/economy','/economy.csv']){const res=response(),req={method:'POST',url:pathname};assert.equal(await guardJuniorDeveloperRequest(req,res,pathname,context('junior_dev')),true);assert.equal(res.status,403)}
 const res=response();await handleEconomyRoute({method:'POST',url:'/economy'},res,'/economy',context('admin'));assert.equal(res.status,405);
});
test('CSV size limits and a broken history index have explicit failure responses',async()=>{
 let res=response();await handleEconomyRoute({method:'GET',url:'/economy.csv'},res,'/economy.csv',context('junior_dev',{exportCsv:()=>({status:413,error:'Narrow the window'})}));assert.equal(res.status,413);
 res=response();await handleEconomyRoute({method:'GET',url:'/economy'},res,'/economy',context('junior_dev',{readView:()=>{throw Error('test unavailable')}}));assert.equal(res.status,503);assert.match(res.body,/temporarily unavailable/);
});
