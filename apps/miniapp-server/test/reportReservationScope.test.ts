import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import * as schema from '../../../packages/core/src/schema.js';

test('server-owned report context leaves another live trip claim and all draft revisions unchanged',async()=>{
  process.env.GOOGLE_SHEET_ID='test-only';
  process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';
  const {reservationRequestIsLive}=await import('../src/routes/roadTimesheet.js');
  const pg=new PGlite();
  try {
    await pg.exec(await readFile('packages/core/drizzle/0018_independent_trip_drafts.sql','utf8'));
    const db=drizzle(pg,{schema});
    const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Kyiv'});
    const liveId=randomUUID(), otherOwnerId=randomUUID(), legacyReportId=randomUUID(), archivedId=randomUUID();
    const reports=[`report:7:${today}:0`,'report:7:2026-01-01:0',legacyReportId];
    for(const id of [liveId,otherOwnerId,archivedId,...reports]) {
      const isReport=reports.includes(id);
      await db.insert(schema.tripDrafts).values({id,foremanTgId:id===otherOwnerId?8n:7n,state:id===archivedId?'archived':'open',revision:4,
        payload:JSON.stringify({recordId:id,date:id==='report:7:2026-01-01:0'?'2026-01-01':today,editingTripSeq:isReport?0:null,employeeIds:['E1'],carId:'CAR_2'})});
    }
    await db.insert(schema.tripDraftOwners).values({foremanTgId:7n,activeTripId:liveId});
    const before=await pg.query('SELECT id,revision,state,payload FROM trip_drafts ORDER BY id');
    for(const id of [...reports,archivedId]) {
      assert.equal(await reservationRequestIsLive(db as any,7,id,id==='report:7:2026-01-01:0'?'2026-01-01':today),false);
    }
    assert.equal(await reservationRequestIsLive(db as any,7,liveId,today),true);
    assert.equal(await reservationRequestIsLive(db as any,7,liveId,'2026-01-01'),false);
    await assert.rejects(()=>reservationRequestIsLive(db as any,7,otherOwnerId,today),/немає доступу/);
    const claim=await pg.query<{active_trip_id:string}>('SELECT active_trip_id FROM trip_draft_owners WHERE foreman_tg_id=7');
    assert.equal(claim.rows[0].active_trip_id,liveId);
    assert.deepEqual((await pg.query('SELECT id,revision,state,payload FROM trip_drafts ORDER BY id')).rows,before.rows);
  } finally {await pg.close();}
});
