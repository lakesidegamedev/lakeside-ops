"use strict";
// Money helpers used by settlement. Amounts are carried as exact integer cents.
const AMOUNT=/^(-?)(\d+)(?:\.(\d{1,2}))?$/;
function parseAmount(text){
 const m=typeof text==='string'&&AMOUNT.exec(text);
 if(!m)throw new RangeError('Invalid amount '+text);
 const cents=BigInt(m[2])*100n+BigInt((m[3]||'').padEnd(2,'0'));
 const value=Number(m[1]?-cents:cents);
 if(!Number.isSafeInteger(value))throw new RangeError('Amount out of range '+text);
 return value===0?0:value;
}
function formatAmount(cents){
 if(!Number.isSafeInteger(cents))throw new RangeError('Invalid cents '+cents);
 const abs=String(Math.abs(cents)).padStart(3,'0');
 return (cents<0?'-':'')+abs.slice(0,-2)+'.'+abs.slice(-2);
}
function checkTotal(totalCents){if(!Number.isSafeInteger(totalCents)||totalCents<0)throw new RangeError('Invalid total '+totalCents);}
function splitEven(totalCents,n){
 checkTotal(totalCents);
 if(!Number.isSafeInteger(n)||n<1)throw new RangeError('Invalid part count '+n);
 const base=Math.floor(totalCents/n),extra=totalCents-base*n;
 return Array.from({length:n},(_,i)=>base+(i<extra?1:0));
}
function allocate(totalCents,weights){
 checkTotal(totalCents);
 if(!Array.isArray(weights)||!weights.length||weights.some(w=>!Number.isSafeInteger(w)||w<0))throw new RangeError('Invalid weights');
 const sum=weights.reduce((a,w)=>a+BigInt(w),0n);
 if(sum===0n)throw new RangeError('Weights must have a positive sum');
 const total=BigInt(totalCents);
 const parts=weights.map((w,i)=>{const p=total*BigInt(w);return{i,base:p/sum,rem:p%sum};});
 let left=total-parts.reduce((a,p)=>a+p.base,0n);
 const order=[...parts].sort((a,b)=>a.rem===b.rem?a.i-b.i:(a.rem>b.rem?-1:1));
 for(const p of order){if(left===0n)break;p.base+=1n;left-=1n;}
 return parts.map(p=>Number(p.base));
}
function totalOf(texts){
 let sum=0n;
 for(const t of texts)sum+=BigInt(parseAmount(t));
 const value=Number(sum);
 if(!Number.isSafeInteger(value))throw new RangeError('Total out of range');
 return value;
}
module.exports={parseAmount,formatAmount,splitEven,allocate,totalOf};
