import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {eq} from 'drizzle-orm';
import * as schema from '../../../packages/core/src/schema.js';
import {submissionDraftConflict} from '../src/lib/tripDraftSubmission.js';

test('retro submission gets an isolated identity, preserves data and live trips, and retries safely',async()=>{
  process.env.GOOGLE_SHEET_ID='test-only';
  process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';
  const {prepareRetroSubmissionDraft}=await import('../src/lib/retroSubmissionDraft.js');
  const pg=new PGlite();const db=drizzle(pg,{schema});
  await pg.exec(await readFile('packages/core/drizzle/0018_independent_trip_drafts.sql','utf8'));
  await pg.exec(await readFile('packages/core/drizzle/0019_app_features.sql','utf8'));
  const input={owner:7,date:'2026-11-09',today:'2026-11-10',backdated:true,key:'attempt_123456',payload:{date:'2026-11-09',employeeIds:['E1'],objects:[{objectId:'O1',sessions:[{employeeId:'E1',droppedAt:'2026-11-09T08:00:00Z',pickedUpAt:'2026-11-09T10:00:00Z'}],works:[{workId:'W1',volume:'7,5'}]}]}};
  try {
    assert.equal(await prepareRetroSubmissionDraft(db as any,{...input,backdated:false}),null);
    assert.equal(await prepareRetroSubmissionDraft(db as any,{...input,date:input.today}),null);
    assert.equal(await prepareRetroSubmissionDraft(db as any,{...input,draftId:'existing'}),null);
    await assert.rejects(prepareRetroSubmissionDraft(db as any,input),/вимкнено адміністратором/);
    await db.insert(schema.appFeatures).values({key:'backdatedEntry',enabled:true,updatedBy:1n});
    await db.insert(schema.tripDrafts).values({id:'live',foremanTgId:7n,revision:9,payload:'{"date":"2026-11-10"}'});
    await db.insert(schema.tripDraftOwners).values({foremanTgId:7n,activeTripId:'live'});
    const before=await db.select().from(schema.tripDrafts);
    const result=await db.transaction(tx=>prepareRetroSubmissionDraft(tx as any,input));
    assert.ok(result);
    const [draft]=await db.select().from(schema.tripDrafts).where(eq(schema.tripDrafts.id,result.id));
    assert.deepEqual(JSON.parse(draft.payload).objects,input.payload.objects);
    assert.equal(submissionDraftConflict(draft,input.date,undefined,result.revision,undefined,'RTS_'+input.key),null);
    assert.deepEqual(await db.select().from(schema.tripDrafts).where(eq(schema.tripDrafts.id,'live')),before);
    assert.equal((await db.select().from(schema.tripDraftOwners))[0].activeTripId,'live');
    assert.deepEqual(await prepareRetroSubmissionDraft(db as any,input),result);
    assert.equal((await db.select().from(schema.tripDraftHistory)).length,1);
    await db.update(schema.tripDrafts).set({state:'archived',revision:2}).where(eq(schema.tripDrafts.id,result.id));
    const retry=await prepareRetroSubmissionDraft(db as any,input);
    assert.equal(retry!.id,result.id);
    const [archived]=await db.select().from(schema.tripDrafts).where(eq(schema.tripDrafts.id,result.id));
    assert.equal(archived.state,'archived');
    assert.equal(submissionDraftConflict(archived,input.date,undefined,retry!.revision,'RTS_'+input.key,'RTS_'+input.key),null);
    await assert.rejects(db.transaction(async tx=>{await prepareRetroSubmissionDraft(tx as any,{...input,key:'rollback_123456'});throw Error('abort');}),/abort/);
    assert.equal((await db.select().from(schema.tripDrafts)).length,2);
    const other=await prepareRetroSubmissionDraft(db as any,{...input,owner:8});
    assert.notEqual(other!.id,result.id);
  } finally {await pg.close();}
});
