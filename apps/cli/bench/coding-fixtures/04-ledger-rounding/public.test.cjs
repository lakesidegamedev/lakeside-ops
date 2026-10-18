const {test}=require('node:test'),assert=require('node:assert/strict');const {parseAmount,splitEven,allocate,totalOf}=require('./src/ledger.cjs');
test('three-way split conserves the total',()=>{assert.deepEqual(splitEven(10000,3),[3334,3333,3333]);});
test('weighted allocation conserves the total',()=>{const parts=allocate(100,[1,1,1]);assert.equal(parts.reduce((a,b)=>a+b,0),100);assert.deepEqual(parts,[34,33,33]);});
test('parsed amounts are exact',()=>{assert.equal(parseAmount('0.29'),29);assert.equal(totalOf(['0.10','0.20','0.29']),59);});
