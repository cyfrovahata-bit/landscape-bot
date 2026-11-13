import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyDeductions,validateDeductions,deductionGroupsForTrips} from '../src/deductions.js';
import {buildAccountingRows,accountingCellValues} from '../src/accountingRows.js';
const items=[{id:'rent',reason:'Оренда техніки',amount:600},{id:'fine',reason:'Штраф',amount:300}];
const packs=[{objectId:'o',objectName:'Рікка',objectTotal:4500,companyPay:0,rows:['b','w1','w2'].map(employeeId=>({employeeId,employeeName:employeeId,pay:1500,hours:8}))}];
test('all participants including brigadier receive equal deductions; source is unchanged',()=>{
 const before=structuredClone(packs);const r=applyDeductions(packs,['b','w1','w2'],items);
 assert.deepEqual(packs,before);assert.deepEqual(r.salaryPacks[0].rows.map(x=>x.pay),[1200,1200,1200]);assert.equal(r.salaryPacks[0].objectTotal,3600);assert.equal(r.deductions.total,900);assert.deepEqual(r.deductions.perEmployee.map(x=>x.amount),[300,300,300]);
});
test('no deductions is byte-for-byte the previous result',()=>assert.deepEqual(applyDeductions(packs,['b','w1','w2'],[]).salaryPacks,packs));
test('kopecks reconcile for each reason and for overall net, independent of participant ordering',()=>{
 const ds=[{id:'a',reason:'a',amount:1},{id:'c',reason:'c',amount:0.01}];const a=applyDeductions(packs,['w2','b','w1'],ds),b=applyDeductions(packs,['w1','w2','b'],ds);assert.deepEqual(a,b);assert.equal(a.deductions.perEmployee.reduce((s,r)=>s+Math.round(r.amount*100),0),101);assert.equal(Math.round(a.salaryPacks[0].objectTotal*100),449899);
 for(const d of a.deductions.shares)assert.equal(d.employees.reduce((s,r)=>s+Math.round(r.amount*100),0),Math.round(d.amount*100));
});
test('one person, editing and deleting deductions',()=>{
 const p=[{objectId:'o',objectTotal:100,rows:[{employeeId:'b',employeeName:'b',pay:100}]}];const d={id:'x',reason:'x',amount:100};assert.equal(applyDeductions(p,['b'],[d]).salaryPacks[0].rows[0].pay,0);assert.equal(applyDeductions(p,['b'],[{...d,amount:50}]).salaryPacks[0].rows[0].pay,50);assert.deepEqual(applyDeductions(p,['b'],[]).salaryPacks,p);
});
test('a cut never creates negative pay, even if overall fund is large enough',()=>{
 const p=[{objectId:'o',objectTotal:100,rows:[{employeeId:'b',employeeName:'b',pay:99},{employeeId:'w',employeeName:'w',pay:1}]}];assert.throws(()=>applyDeductions(p,['b','w'],[{id:'d',reason:'d',amount:10}]),/перевищує/);assert.throws(()=>applyDeductions(p,['missing'],items),/перевищує/);
});
test('multiple objects: equal per-person cut, apportioned over own work, company untouched',()=>{
 const p=[{objectId:'a',objectTotal:100,companyPay:10,rows:[{employeeId:'b',employeeName:'b',pay:90}]},{objectId:'z',objectTotal:210,companyPay:10,rows:[{employeeId:'b',employeeName:'b',pay:100},{employeeId:'w',employeeName:'w',pay:100}]}];const r=applyDeductions(p,['b','w'],[{id:'d',reason:'d',amount:40}]);assert.equal(r.salaryPacks[0].companyPay,10);assert.equal(r.salaryPacks[1].companyPay,10);assert.equal(r.salaryPacks.reduce((a,p)=>a+p.objectTotal,0),270);assert.equal(r.salaryPacks.flatMap(p=>p.rows).filter(r=>r.employeeId==='b').reduce((a,r)=>a+r.pay,0),170);assert.equal(r.salaryPacks[1].rows[1].pay,80);
});
test('approved earlier group never deducts new unrelated trip or another owner',()=>{
 const doc={revision:1,groups:[{eventIds:['old'],employeeIds:['b'],sourceRevision:'r',items}]};assert.equal(deductionGroupsForTrips(doc,['new']).length,0);assert.equal(deductionGroupsForTrips(doc,['old','new']).length,1);assert.equal(deductionGroupsForTrips({...doc,groups:[{...doc.groups[0],eventIds:['a','b']}]},['a']).length,0);
});
test('validation rejects blanks, negative/nonfinite/overprecise amounts, duplicates and oversized bot block',()=>{
 for(const amount of [0,-1,NaN,Infinity,1.001,'10',null])assert.throws(()=>validateDeductions([{id:'x',reason:'x',amount}]));assert.throws(()=>validateDeductions([{id:'x',reason:' ',amount:1}]));assert.throws(()=>validateDeductions([items[0],items[0]]));assert.throws(()=>validateDeductions(Array.from({length:10},(_,i)=>({id:String(i),reason:'x'.repeat(300),amount:1}))));assert.equal(validateDeductions([{id:'x',reason:' Штраф ',amount:10.25}])[0].reason,'Штраф');
});
test('accounting work rows total the same NET pay as the app, volumes and tariffs remain unchanged',()=>{
 const net=applyDeductions(packs,['b','w1','w2'],items).salaryPacks;
 const rows=buildAccountingRows({date:'2026-11-13',foremanName:'Бригадир',objects:[{objectId:'o',objectName:'Рікка',works:[{workId:'one',workName:'Робота',volume:10}]}],salaryPacks:net,roadAllowancePerPerson:0,unionEmployeeIds:['b','w1','w2'],employeeNameById:new Map(),tariffByWorkId:new Map([['one',450]]),unitByWorkId:new Map([['one','шт']])});assert.equal(rows.reduce((s,r)=>s+r.amount,0),3600);assert.equal(rows[0].volume,10);assert.equal(accountingCellValues(rows[0],1)[7],1200);
});
test('accounting deduction notes use employee IDs and survive a fully deducted work amount through hours rows',()=>{
 const rows=buildAccountingRows({date:'2026-11-13',foremanName:'Бригадир',objects:[],salaryPacks:[],roadAllowancePerPerson:0,unionEmployeeIds:[],employeeNameById:new Map([['one','Однакове ім’я'],['two','Однакове ім’я']]),tariffByWorkId:new Map(),unitByWorkId:new Map(),hoursByObject:new Map([['o',new Map([['one',8],['two',6]])]]),deductionNoteByEmployeeId:new Map([['one','Оренда: −100 грн (враховано)']])});
 assert.equal(rows[0].foremanName,'Бригадир · Оренда: −100 грн (враховано)');assert.equal(rows[1].foremanName,'Бригадир');assert.equal(rows[0].amount,0);assert.equal(rows[0].volume,8);
});
