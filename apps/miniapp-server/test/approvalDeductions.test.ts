import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApprovalReport} from '../src/lib/approvalReport.js';
const combined={salaryPacks:[{objectName:'Рікка',objectTotal:4500,rows:[{employeeName:'Бригадир',pay:1500},{employeeName:'Робітник 1',pay:1500},{employeeName:'Робітник 2',pay:1500}]}],roadAllowance:{perPerson:0},deductions:{items:[] as {reason:string;amount:number}[],total:0}};
test('legacy bot message without deductions remains exact',()=>{
 assert.equal(buildApprovalReport('2026-11-13',{combined}),'✅ *День затверджено*\n📅 2026-11-13\n\n📍 *Рікка*\n  • Бригадир — 1500 грн\n  • Робітник 1 — 1500 грн\n  • Робітник 2 — 1500 грн\n\n➕ Доплата за виїзд: 0 грн/особу\n💰 *Загальний фонд: 4500 грн*');
});
test('net amounts and escaped deduction reasons appear in bot footer; footer survives a large crew',()=>{
 const net={...combined,salaryPacks:[{...combined.salaryPacks[0],objectTotal:3600,rows:combined.salaryPacks[0].rows.map(r=>({...r,pay:1200}))}],deductions:{items:[{reason:'Оренда _техніки_',amount:600},{reason:'Штраф',amount:300}],total:900}};
 const text=buildApprovalReport('2026-11-13',{combined:net});assert.match(text,/Бригадир — 1200 грн/);assert.match(text,/Фонд після відрахувань: 3600 грн/);assert.ok(text.includes('Оренда \\_техніки\\_ — −600 грн'));assert.match(text,/Разом: −900 грн/);
 const huge=buildApprovalReport('2026-11-13',{combined:{...net,salaryPacks:[{...net.salaryPacks[0],rows:Array.from({length:200},()=>({employeeName:'Довге ім’я працівника',pay:1}))}]}});assert.ok(huge.length<3901);assert.match(huge,/Разом: −900 грн/);
});
