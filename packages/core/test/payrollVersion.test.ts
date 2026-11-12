import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSalaryPacksWithRoles, payrollVersionForDay, MIN_PAID_HOURS} from '../src/payroll.js';

const row=(employeeId:string,hours:number)=>({employeeId,employeeName:employeeId,hours,disciplineCoef:1,productivityCoef:1});
const calc=(rows:ReturnType<typeof row>[],brigadiers=['b'],seniors:string[]=[],version:1|2=2,works?:Array<{workId:string;value:number;employeeIds?:string[]}>)=>buildSalaryPacksWithRoles({
  payrollVersion:version,brigadierEmployeeIds:brigadiers,seniorEmployeeIds:seniors,
  objects:[{objectId:'o',objectName:'Object',objectTotal:1200,rows,works}],
})[0];
const pay=(p:ReturnType<typeof calc>,id:string)=>p.rows.find(r=>r.employeeId===id)?.pay??0;

test('new 10% is by hours, excludes even a working brigadier, and leaves the original 70% intact',()=>{
  const rows=[row('b',4),row('w1',4),row('w2',2)];
  const old=calc(rows,['b'],[],1),p=calc(rows);
  assert.equal(pay(p,'b'),pay(old,'b'));
  assert.equal(pay(p,'w1')-pay(old,'w1'),80);
  assert.equal(pay(p,'w2')-pay(old,'w2'),40);
  assert.equal(p.companyPay,0);
  assert.equal(p.rows.reduce((a,r)=>a+r.pay,0),1200);
});
test('all brigadiers are excluded from the additional pot',()=>{
  const rows=[row('b1',8),row('b2',2),row('w',2)];
  const old=calc(rows,['b1','b2'],[],1),p=calc(rows,['b1','b2']);
  for(const id of ['b1','b2'])assert.equal(pay(p,id),pay(old,id));
  assert.equal(pay(p,'w')-pay(old,'w'),120);
});
test('with a senior, the whole result remains identical to the old formula',()=>{
  const rows=[row('b',2),row('s',0),row('w',6)];
  assert.deepEqual(calc(rows,['b'],['s'],2),calc(rows,['b'],['s'],1));
});
test('only brigadier worked: he receives the extra 10%, legacy stays unchanged',()=>{
  const p=calc([row('b',8)]);
  assert.equal(pay(p,'b'),1200);
  assert.equal(p.companyPay,0);
  assert.equal(calc([row('b',8)],['b'],[],1).companyPay,120);
});
test('multiple working brigadiers without workers do not trigger the sole-brigadier exception',()=>{
  assert.equal(calc([row('b1',8),row('b2',2)],['b1','b2']).companyPay,120);
});
test('brigadier without paid hours does not receive the additional 10%',()=>{
  assert.equal(calc([row('b',0)]).companyPay,120);
});
test('no paid worker: short sessions do not receive the 10%',()=>{
  const p=calc([row('b',8),row('w',MIN_PAID_HOURS-0.001)]);
  assert.equal(pay(p,'w'),0);assert.equal(p.companyPay,0);assert.equal(pay(p,'b'),1200);
});
test('exact paid-hours threshold qualifies, even when there is no brigadier',()=>{
  const p=calc([row('w',MIN_PAID_HOURS)],[]);
  assert.equal(pay(p,'w'),960);assert.equal(p.companyPay,240);
});
test('assigned work pots stay unchanged; the extra 10% is shared separately by workers hours',()=>{
  const rows=[row('b',0),row('w1',6),row('w2',2)];
  const works=[{workId:'shared',value:800},{workId:'own',value:400,employeeIds:['w2']}];
  const old=calc(rows,['b'],[],1,works),p=calc(rows,['b'],[],2,works);
  assert.equal(pay(p,'w1')-pay(old,'w1'),90);
  assert.equal(pay(p,'w2')-pay(old,'w2'),30);
  assert.equal(pay(p,'b'),240);
});
test('date and saved version protect historical reports, edits and later trips of the same day',()=>{
  assert.equal(payrollVersionForDay('2026-11-11'),1);
  assert.equal(payrollVersionForDay('2026-11-12'),2);
  assert.equal(payrollVersionForDay('2026-11-12',[undefined]),1);
  assert.equal(payrollVersionForDay('2026-11-12',[1,1]),1);
  assert.equal(payrollVersionForDay('2026-11-12',[2,2]),2);
  assert.equal(payrollVersionForDay('2026-11-12',[2,undefined]),1);
  assert.equal(payrollVersionForDay('',[2]),2);
});
test('additional pot is apportioned to the kopeck for awkward hours',()=>{
  const rows=[row('b',0),row('w1',3),row('w2',2),row('w3',2)];
  const old=calc(rows,['b'],[],1),p=calc(rows);
  const extra=rows.filter(r=>r.employeeId!=='b').reduce((a,r)=>a+Math.round((pay(p,r.employeeId)-pay(old,r.employeeId))*100),0);
  assert.equal(extra,12000);
});
