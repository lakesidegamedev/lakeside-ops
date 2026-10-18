"use strict";
// Money helpers used by settlement. Amounts are carried as cents.
function parseAmount(text){
 const value=parseFloat(text);
 if(Number.isNaN(value))throw new RangeError('Invalid amount '+text);
 return Math.floor(value*100);
}
function formatAmount(cents){
 return (cents/100).toFixed(2);
}
function splitEven(totalCents,n){
 const part=Math.floor(totalCents/n);
 return Array.from({length:n},()=>part);
}
function allocate(totalCents,weights){
 const sum=weights.reduce((a,b)=>a+b,0);
 return weights.map(w=>Math.round(totalCents*w/sum));
}
function totalOf(texts){
 let sum=0;
 for(const t of texts)sum+=parseFloat(t);
 return Math.floor(sum*100);
}
module.exports={parseAmount,formatAmount,splitEven,allocate,totalOf};
