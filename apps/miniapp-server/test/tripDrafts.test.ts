import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import express from 'express';
import {randomUUID} from 'node:crypto';
import * as schema from '../../../packages/core/src/schema.js';
import {splitLegacyDraft,tripDraftConflict} from '../src/lib/tripDraftIdentity.js';

test('legacy migration separates parked trip and report without changing sessions or volumes',()=>{
 const trip={date:'2026-10-16',carId:'CAR_2',plans:[{sessions:[{employeeId:'E1',startedAt:'08:00',endedAt:'09:00'}],works:[{volume:'2,5'}]}]};
 const report={...trip,date:'2026-10-15',editingTripSeq:0,dayStash:trip};
 const before=JSON.stringify(report),parts=splitLegacyDraft('7',report);
 assert.equal(parts.length,2);assert.notEqual(parts[0].id,parts[1].id);
 assert.deepEqual(parts[0].payload.plans,trip.plans);assert.equal(JSON.stringify(report),before);
 assert.equal(tripDraftConflict(parts[0].payload,{...parts[1].payload,recordId:parts[0].id},1,1),'identity');
});

test('HTTP server and real PostgreSQL engine: isolation, ownership, stale versions, archive and history',async()=>{
 process.env.GOOGLE_SHEET_ID='test-only';
 process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';
 const {createTripDraftsRouter}=await import('../src/routes/tripDrafts.js');
 const pg=new PGlite();const database=drizzle(pg,{schema});
 await pg.exec(await readFile('packages/core/drizzle/0018_independent_trip_drafts.sql','utf8'));
 await pg.exec('CREATE TABLE day_drafts (foreman_tg_id bigint primary key,date text,step text,car_id text,employee_ids text,object_names text,trip_started_at timestamp,payload text,updated_at timestamp);');
 await pg.exec("CREATE TABLE events (event_id text primary key,status text,ref_event_id text,chat_id bigint,ts timestamp,date text,foreman_tg_id bigint,type text,object_id text,car_id text,employee_ids text,payload text,msg_id integer,updated_at timestamp);");
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{(req as any).user={tgId:Number(req.headers['x-test-owner']??7),role:req.headers['x-test-admin']==='yes'?'ADMIN':'BRIGADIER'};next();});
 // PGlite serializes transactions; production uses PostgreSQL advisory locks.
 app.use('/api/trip-drafts',createTripDraftsRouter(database as any,((_key:string,fn:any)=>database.transaction(fn)) as any));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const port=(server.address() as any).port;
 const request=async(path:string,method='GET',body?:unknown,owner=7,admin=false)=>{
  const r=await fetch(`http://127.0.0.1:${port}/api/trip-drafts${path}`,{method,headers:{'content-type':'application/json','x-test-owner':String(owner),'x-test-admin':admin?'yes':'no'},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json() as any};
 };
 try{
  const a=randomUUID(),b=randomUUID();
  const payload=(recordId:string,date='2026-10-18')=>({recordId,date,carId:'CAR_2',plans:[{sessions:[{employeeId:'E1',startedAt:'08:00'}],works:[{volume:'12'}]}],employeeIds:['E1'],step:'AT_OBJECT'});
  assert.equal((await request(`/${a}`,'PUT',{payload:payload(a),baseRevision:0})).status,200);
  assert.equal((await request(`/${b}`,'PUT',{payload:payload(b),baseRevision:0})).status,200);
  assert.equal((await request(`/${a}`,'PUT',{payload:{...payload(a),step:'RETURN'},baseRevision:1})).status,200);
  assert.equal((await request(`/${a}`,'PUT',{payload:{...payload(a),step:'HUB'},baseRevision:1})).status,409);
  assert.equal((await request(`/${b}`)).body.revision,1);
  assert.equal((await request(`/${a}`)).body.payload.step,'RETURN');
  assert.equal((await request(`/${a}`,'GET',undefined,8)).status,404);
  assert.equal((await request(`/${a}`,'PUT',{payload:payload(a),baseRevision:2},8)).status,404);
  assert.equal((await request(`/${a}/archive`,'POST',{baseRevision:1})).status,409);
  assert.equal((await request(`/${a}/archive`,'POST',{baseRevision:2})).status,200);
  assert.equal((await request(`/${a}`,'PUT',{payload:payload(a),baseRevision:3})).status,409);
  assert.equal((await request(`/${b}`)).body.state,'open');
  const bAudit=(await request(`/${b}/history`)).body.records;
  const bVersion=bAudit.find((r:any)=>r.action==='write');
  assert.equal((await request(`/${b}/restore`,'POST',{historyId:bVersion.id,baseRevision:1})).status,403);
  assert.equal((await request(`/${b}/restore`,'POST',{historyId:bVersion.id,baseRevision:0},8,true)).status,409);
  assert.equal((await request(`/${b}/restore`,'POST',{historyId:bVersion.id,baseRevision:1},8,true)).status,200);
  assert.equal((await request(`/${a}`)).body.state,'archived');
  assert.equal((await request('/latest')).body.id,b);

  const audit=(await request(`/${a}/history`)).body.records;
  assert.ok(audit.some((r:any)=>r.action==='rejected_incoming'&&r.payload.step==='HUB'));
  assert.equal((await request('?all=true','GET',undefined,8)).body.records.length,0);
  assert.equal((await request('?all=true','GET',undefined,8,true)).body.records.length,2);
  // Idempotent migration retains original source and separately preserves its stash.
  const old={date:'2026-10-15',carId:'CAR_2',editingTripSeq:0,plans:[],employeeIds:[],dayStash:payload(randomUUID())};
  await pg.query('INSERT INTO day_drafts(foreman_tg_id,payload,updated_at) VALUES (9,$1,now())',[JSON.stringify(old)]);
  assert.equal((await request('/adopt','POST',{},9)).status,200);
  assert.equal((await request('/adopt','POST',{},9)).status,200);
  assert.equal((await request('','GET',undefined,9)).body.records.length,2);
  const retained=await pg.query<{payload:string}>('SELECT payload FROM day_drafts WHERE foreman_tg_id=9');
  assert.deepEqual(JSON.parse(retained.rows[0].payload),old);
  // Pagination over 1000 independent drafts, not one monolithic browser blob.
  for(let start=0;start<1100;start+=100){
    const values=Array.from({length:100},(_,i)=>{const id=randomUUID();return {id,foremanTgId:11n,payload:JSON.stringify(payload(id))};});
    await database.insert(schema.tripDrafts).values(values);
  }
  const seen=new Set<string>();let offset:number|null=0;
  while(offset!==null){const page=(await request(`?offset=${offset}`,'GET',undefined,11)).body;for(const r of page.records){assert.ok(!seen.has(r.id));seen.add(r.id);}offset=page.nextOffset;}
  assert.equal(seen.size,1100);
  await pg.query("INSERT INTO events(event_id,status,ts,date,foreman_tg_id,type,car_id,payload) VALUES ('test-report','АКТИВНА',now(),'2026-10-15',7,'RTS_SAVE','CAR_2',$1)",[JSON.stringify({tripSeq:0})]);
  assert.equal((await request('/reports')).body.records.length,1);
  const opened=await request('/open-report','POST',{date:'2026-10-15',tripSeq:0});
  assert.equal(opened.status,200);assert.equal(opened.body.id,'report:7:2026-10-15:0');
  assert.equal((await request('/open-report','POST',{date:'2026-10-15',tripSeq:0},8)).status,409);

 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pg.close();}
});

test('only the owner namespace can create named records; report dates and identity cannot be reassigned',async()=>{
 const {ownedTripId}=await import('../src/lib/tripDraftIdentity.js');
 assert.equal(ownedTripId('report:7:2026-10-15:0','7'),true);
 assert.equal(ownedTripId('report:8:2026-10-15:0','7'),false);
 const report={recordId:'report:7:2026-10-15:0',date:'2026-10-15',editingTripSeq:0};
 assert.equal(tripDraftConflict(report,{...report,date:'2026-10-16'},2,2),'identity');
 assert.equal(tripDraftConflict(report,{...report,editingTripSeq:1},2,2),'identity');
 assert.equal(tripDraftConflict(report,report,2,1),'revision');
});
