import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import * as schema from '../../../packages/core/src/schema.js';

test('HTTP deductions: admin-only, snapshot history, owner isolation, stale tabs, edit/delete, atomic rollback and approved protection',async()=>{
 process.env.GOOGLE_SHEET_ID='test-only';process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';
 const {createReportDeductionsRouter}=await import('../src/routes/reportDeductions.js');
 const {readReportDeductions,reportRevision}=await import('../src/lib/reportDeductions.js');
 const {reservationConflictHandler}=await import('../src/lib/reservationErrors.js');
 const pg=new PGlite();const db=drizzle(pg,{schema});
 const migration=await readFile('packages/core/drizzle/0000_productive_daimon_hellstrom.sql','utf8');await pg.exec(migration.slice(migration.indexOf('CREATE TABLE "events"'),migration.indexOf('--> statement-breakpoint',migration.indexOf('CREATE TABLE "events"'))));
 const date='2026-11-13';let approved=false,fail=false;let changed=false;
 const trips=(owner:number)=>[{eventId:`trip-${owner}`,status:approved?'ЗАТВЕРДЖЕНО':'АКТИВНА',employeeIds:['b','w'],objects:changed?['changed']:[]}];
 const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={tgId:77,role:req.headers['x-admin']==='yes'?'ADMIN':'BRIGADIER'};next();});
 app.use('/deductions',createReportDeductionsRouter({withLock:async(_key,fn)=>db.transaction(async tx=>{const r=await fn(tx as any);if(fail)throw new Error('rollback test');return r;}),fetchTrips:async(_date,owner)=>trips(owner),gross:async()=>({salaryPacks:[{objectId:'o',objectName:'Рікка',objectTotal:2000,sumPoints:1,companyPay:0,rows:['b','w'].map(employeeId=>({employeeId,employeeName:employeeId,hours:8,points:1,coefTotal:1,pay:1000}))}],employeeIds:['b','w']})}));app.use(reservationConflictHandler);app.use((err:any,_req:any,res:any,_next:any)=>res.status(500).json({error:err.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${(server.address() as any).port}/deductions`;
 const send=(revision:number,items:unknown,owner=1,admin=true,rev=reportRevision(trips(owner)))=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-admin':admin?'yes':'no'},body:JSON.stringify({date,foremanTgId:owner,revision,items,reportRevision:rev})});const d={id:'rent',reason:'Оренда техніки',amount:600};
 try{
  assert.equal((await send(0,[d],1,false)).status,403);assert.equal((await db.select().from(schema.events)).length,0);
  assert.equal((await send(0,[{...d,amount:-1}])).status,400);
  assert.equal((await send(0,[d])).status,200);const saved=await readReportDeductions(date,1,db as any);assert.equal(saved.revision,1);
  assert.equal((await readReportDeductions(date,2,db as any)).revision,0);
  assert.equal((await send(0,[d])).status,409);assert.deepEqual(await readReportDeductions(date,1,db as any),saved);
  assert.equal((await send(1,[{...d,amount:5000}])).status,409);
  const oldReport=reportRevision(trips(1));changed=true;assert.equal((await send(1,[d],1,true,oldReport)).status,409);changed=false;
  assert.equal((await send(1,[{...d,amount:300}])).status,200);
  fail=true;assert.equal((await send(2,[])).status,500);fail=false;assert.equal((await readReportDeductions(date,1,db as any)).revision,2);
  assert.equal((await send(2,[])).status,200);assert.equal((await readReportDeductions(date,1,db as any)).groups[0].items.length,0);
  const records=await db.select().from(schema.events);const history=records.filter(e=>e.type==='RTS_DEDUCTIONS_HISTORY').map(e=>JSON.parse(e.payload!));assert.equal(history.length,3);assert.equal(history[0].actor,77);assert.equal(history[1].before.groups[0].items[0].amount,600);
  approved=true;assert.equal((await send(3,[d])).status,409);assert.equal((await readReportDeductions(date,1,db as any)).revision,3);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await pg.close();}
});
