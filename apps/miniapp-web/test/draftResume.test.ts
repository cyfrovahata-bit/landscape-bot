import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ApiError,retryableWriteError,withRequestDeadline} from '../src/lib/requestErrors';
import {mirrorDraft,flushTripDrafts,readTripDraft,draftServerRevision,retryTransientTripDrafts,retryAuthenticatedTripDrafts,refreshCleanTripDraft,adoptRefreshedTrip,tripDraftHasUnsavedChanges,startAutomaticDraftRetry} from '../src/lib/draftMirror';

test('only temporary network/server failures qualify for automatic writes, never conflicts or denied sessions',()=>{
  for(const error of [new TypeError('offline'),new DOMException('timeout','AbortError'),new ApiError('restart',503)])assert.equal(retryableWriteError(error),true);
  for(const status of [400,401,403,404,409,413])assert.equal(retryableWriteError(new ApiError('blocked',status)),false);
});
test('hung requests abort instead of leaving the draft queue waiting forever',async()=>{
  await assert.rejects(withRequestDeadline(signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')))),5),{name:'AbortError'});
});

test('resume and automatic retry preserve the exact record, revision protection and edits made during reads',async t=>{
  const nativeFetch=globalThis.fetch;
  const windowEvents=new EventTarget(), documentEvents=new EventTarget();
  Object.assign(windowEvents,{setInterval:()=>1,clearInterval:()=>{}});
  Object.assign(documentEvents,{visibilityState:'visible'});
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  (globalThis as any).window=windowEvents;(globalThis as any).document=documentEvents;
  const a=randomUUID(),b=randomUUID(),c=randomUUID(),d=randomUUID();
  const payload=(recordId:string,volume='1')=>({recordId,date:'2026-10-20',employeeIds:['E1'],plans:[{works:[{volume}]}]});
  const rows=new Map([[a,{id:a,revision:3,state:'open',payload:payload(a)}],[b,{id:b,revision:8,state:'open',payload:payload(b)}],[c,{id:c,revision:1,state:'open',payload:payload(c)}]]);
  rows.set(d,{id:d,revision:4,state:'open',payload:payload(d)});
  let putCount=0,failStatus=0,loseAck=false,readGate:Promise<void>|null=null;
  globalThis.fetch=async(input,options)=>{
    const id=decodeURIComponent(String(input).split('/').at(-1)!);const row=rows.get(id)!;
    assert.equal(options?.credentials,'same-origin');
    assert.equal((options?.headers as any)['X-GreenHand-Client'],'miniapp');
    if(options?.method==='PUT'){
      putCount++;
      if(failStatus)return new Response(JSON.stringify({error:failStatus===409?'Захист поїздки: stale':'temporary outage'}),{status:failStatus});
      const body=JSON.parse(String(options.body));
      if(JSON.stringify(body.payload)===JSON.stringify(row.payload))return Response.json({revision:row.revision});
      assert.equal(body.baseRevision,row.revision);
      row.payload=body.payload;row.revision++;
      if(loseAck){loseAck=false;return new Response(JSON.stringify({error:'response lost after commit'}),{status:503});}
      return Response.json({revision:row.revision});
    }
    const snapshot=structuredClone(row);if(readGate)await readGate;
    return Response.json(snapshot);
  };
  const stop=startAutomaticDraftRetry();
  try {
    await readTripDraft(a);await readTripDraft(b);await readTripDraft(c);await readTripDraft(d);
    failStatus=503;mirrorDraft({payload:payload(a,'20')});await assert.rejects(flushTripDrafts(a));
    assert.equal(tripDraftHasUnsavedChanges(a),true);
    assert.equal(await refreshCleanTripDraft(a),null);
    failStatus=0;windowEvents.dispatchEvent(new Event('online'));await retryTransientTripDrafts();
    await flushTripDrafts(a);
    assert.equal(rows.get(a)!.payload.plans[0].works[0].volume,'20');assert.equal(rows.get(b)!.revision,8);
    assert.equal(tripDraftHasUnsavedChanges(a),false);
    // Read an update made in another tab, but never advance our revision before accepting it.
    rows.get(a)!.revision=9;rows.get(a)!.payload=payload(a,'30');
    const fresh=await refreshCleanTripDraft(a);assert.ok(fresh);assert.equal(draftServerRevision(a),4);
    assert.equal(adoptRefreshedTrip(fresh),true);assert.equal(draftServerRevision(a),9);
    // While a GET is suspended, a user makes and saves another edit.
    let release!:()=>void;readGate=new Promise<void>(resolve=>{release=resolve;});
    rows.get(a)!.revision=10;
    const pendingRead=refreshCleanTripDraft(a);
    await Promise.resolve();
    failStatus=409;mirrorDraft({payload:payload(a,'40')});await assert.rejects(flushTripDrafts(a));
    release();readGate=null;
    assert.equal(await pendingRead,null);assert.equal(draftServerRevision(a),9);
    const before=putCount;await retryTransientTripDrafts();assert.equal(putCount,before);
    // A conflict in A never prevents a separate trip B from saving.
    failStatus=0;mirrorDraft({payload:payload(b,'7')});await flushTripDrafts(b);
    assert.equal(rows.get(b)!.payload.plans[0].works[0].volume,'7');
    failStatus=401;mirrorDraft({payload:payload(c,'8')});await assert.rejects(flushTripDrafts(c));
    const deniedCount=putCount;await retryTransientTripDrafts();assert.equal(putCount,deniedCount);
    failStatus=0;await retryAuthenticatedTripDrafts();await flushTripDrafts(c);
    assert.equal(rows.get(c)!.payload.plans[0].works[0].volume,'8');
    const beforeArchiveRead=putCount;rows.get(b)!.state='archived';rows.get(b)!.revision++;
    const archived=await refreshCleanTripDraft(b);assert.equal(archived?.state,'archived');
    assert.equal(adoptRefreshedTrip(archived!),true);assert.equal(putCount,beforeArchiveRead);
    // The server commits one snapshot but its acknowledgement is lost; a newer
    // local snapshot is already queued. Recover the exact lost write, then save the newer one.
    loseAck=true;mirrorDraft({payload:payload(d,'10')});mirrorDraft({payload:payload(d,'11')});
    await assert.rejects(flushTripDrafts(d));assert.equal(rows.get(d)!.revision,5);
    await retryTransientTripDrafts();await flushTripDrafts(d);
    assert.equal(rows.get(d)!.revision,6);assert.equal(draftServerRevision(d),6);
    assert.equal(rows.get(d)!.payload.plans[0].works[0].volume,'11');
  }finally{stop();globalThis.fetch=nativeFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;}
});
