import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import * as schema from '../../../packages/core/src/schema.js';

test('backdated entry defaults off, only admin toggles it, and the choice persists', async () => {
  process.env.GOOGLE_SHEET_ID='test-only';
  process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';
  const {createAppFeaturesRouter}=await import('../src/routes/appFeatures.js');
  const {isBackdatedEntryEnabled}=await import('../src/lib/appFeatures.js');
  const pg=new PGlite();const db=drizzle(pg,{schema});
  await pg.exec(await readFile('packages/core/drizzle/0019_app_features.sql','utf8'));
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{(req as any).user={tgId:7,role:req.headers['x-test-admin']==='yes'?'ADMIN':'BRIGADIER'};next();});
  app.use(createAppFeaturesRouter(db as any));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const set=(enabled:unknown,admin=false)=>fetch(url+'/backdated-entry',{method:'PUT',headers:{'content-type':'application/json','x-test-admin':admin?'yes':'no'},body:JSON.stringify({enabled})});
  try {
    assert.equal((await (await fetch(url)).json()).backdatedEntryEnabled,false);
    assert.equal((await set(true)).status,403);
    assert.equal(await isBackdatedEntryEnabled(db as any),false);
    assert.equal((await set('true',true)).status,400);
    assert.equal((await set(true,true)).status,200);
    // A fresh DB wrapper (as on a new process) sees the same setting.
    assert.equal(await isBackdatedEntryEnabled(drizzle(pg,{schema}) as any),true);
    assert.equal((await (await fetch(url)).json()).backdatedEntryEnabled,true);
    const [row]=await db.select().from(schema.appFeatures);
    assert.equal(row.updatedBy,7n);
    assert.equal((await set(false,true)).status,200);
    assert.equal(await isBackdatedEntryEnabled(db as any),false);
  } finally {await new Promise<void>(r=>server.close(()=>r()));await pg.close();}
});
