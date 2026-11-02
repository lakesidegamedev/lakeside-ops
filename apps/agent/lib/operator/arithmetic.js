'use strict';
// Deliberately small arithmetic grammar: no JavaScript evaluation, properties,
// statements, external functions or access to the task's files and services.
const FUNCTIONS=new Map(['min','max','floor','ceil','round','sqrt','abs'].map(name=>[name,Math[name]]));
// The clock is a reading, not a fact: elapsed-time arithmetic needs a current
// time, and a model has no other way to obtain one.
const CLOCK='now';
function evaluateArithmetic(expression,{literal=()=>{},reference=()=>{throw Error('Unknown calculation reference')},clock=()=>Date.now()}={}){
 const raw=String(expression||'');
 const invalid=()=>new Error('calculation may use only numbers, prior $step references, now, + - * / ( ) %, and min/max/floor/ceil/round/sqrt/abs');
 if(!raw||raw.length>200)throw invalid();
 // Preserve legacy grouped numerals in plain arithmetic. In function calls,
 // commas separate arguments; callers must use ungrouped numbers there.
 const text=/[A-Za-z_]\w*\s*\(/.test(raw)?raw:raw.replace(/,/g,'');
 const tokens=[];let at=0;
 while(at<text.length){
  if(/\s/.test(text[at])){at++;continue;}
  const rest=text.slice(at),number=/^(?:\d+(?:\.\d*)?|\.\d+)/.exec(rest),ref=/^\$([A-Za-z_][A-Za-z0-9_]{0,39})/.exec(rest),name=/^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if(number){tokens.push({type:'number',raw:number[0]});at+=number[0].length;}
  else if(ref){tokens.push({type:'reference',id:ref[1]});at+=ref[0].length;}
  else if(name){
   // Bare identifiers are aliases for prior batch references, never globals.
   if(/^\s*\(/.test(rest.slice(name[0].length))){if(name[0]!==CLOCK&&!FUNCTIONS.has(name[0]))throw invalid();tokens.push({type:'function',name:name[0]});}
   else tokens.push({type:'reference',id:name[0]});
   at+=name[0].length;
  }
  else if(rest.startsWith('**')){tokens.push({type:'**'});at+=2;}
  else if('+-*/(),%'.includes(text[at]))tokens.push({type:text[at++]});
  else throw invalid();
 }
 let position=0;
 const take=type=>tokens[position]?.type===type?(position++,true):false;
 const expect=type=>{if(!take(type))throw invalid();};
 const finite=value=>{if(!Number.isFinite(value))throw Error('calculation did not produce a number');return value;};
 function primary(){
  const token=tokens[position++];if(!token)throw invalid();
  let value;
  if(token.type==='number'){
   value=Number(token.raw);literal({raw:token.raw,value,decimals:(token.raw.split('.')[1]||'').length});
  }else if(token.type==='reference')value=reference(token.id);
  else if(token.type==='('){value=sum();expect(')');}
  else if(token.type==='function'){
   expect('(');
   if(token.name===CLOCK){expect(')');value=clock();}
   else{
    const args=[sum()];while(take(','))args.push(sum());expect(')');
    if(!['min','max'].includes(token.name)&&args.length!==1)throw invalid();
    value=FUNCTIONS.get(token.name)(...args);
   }
  }else throw invalid();
  value=finite(value);while(take('%'))value/=100;return finite(value);
 }
 function power(){const left=primary();return take('**')?finite(left**unary()):left;}
 function unary(){return take('+')?unary():take('-')?-unary():power();}
 function product(){let value=unary();for(;;){if(take('*'))value=finite(value*unary());else if(take('/'))value=finite(value/unary());else return value;}}
 function sum(){let value=product();for(;;){if(take('+'))value=finite(value+product());else if(take('-'))value=finite(value-product());else return value;}}
 const value=sum();if(position!==tokens.length)throw invalid();return finite(value);
}
module.exports={evaluateArithmetic};
