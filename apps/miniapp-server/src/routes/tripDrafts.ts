import { callerHoldsCar, employeesHeldByCaller } from './roadTimesheet.js';
import { asyncRouter } from '../asyncRouter.js';
import { db as productionDb, schema, withLock as productionWithLock, writeEvent, makeEventId } from '@landscape/core';
import { and, eq, desc, sql } from 'drizzle-orm';
import { ownedTripId, reportDraftId, splitLegacyDraft, tripDraftConflict, validTripId } from '../lib/tripDraftIdentity.js';

export function createTripDraftsRouter(db:typeof productionDb, withLock:typeof productionWithLock) {
const tripDraftsRouter = asyncRouter();
const table = schema.tripDrafts;
const history = schema.tripDraftHistory;

// Explicit, idempotent adoption: serialize with old writers using their lock.
tripDraftsRouter.post('/adopt', async (req,res) => {
  const owner = BigInt(req.user!.tgId);
  await withLock(`draft:${owner}`, async tx => {
    const existing = await tx.select().from(schema.tripDraftOwners).where(eq(schema.tripDraftOwners.foremanTgId,owner)).limit(1);
    if (existing.length) return;
    await tx.insert(schema.tripDraftOwners).values({foremanTgId:owner});
    const [legacy] = await tx.select().from(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId,owner));
    if (!legacy) return;
    for (const part of splitLegacyDraft(String(owner),JSON.parse(legacy.payload))) {
      const payload = JSON.stringify(part.payload);
      if(part.payload.editingTripSeq==null&&!part.payload.planEditing&&!part.payload.odoEnd) {
        await tx.update(schema.tripDraftOwners).set({activeTripId:part.id}).where(eq(schema.tripDraftOwners.foremanTgId,owner));
      }
      const events=await tx.select().from(schema.events).where(and(eq(schema.events.foremanTgId,owner),eq(schema.events.date,part.payload.date??''),eq(schema.events.type,'RTS_SAVE'))).orderBy(desc(schema.events.ts));
      const submitted=events.some(e=>{
        const saved=JSON.parse(e.payload??'{}');
        if(e.ts<legacy.updatedAt || e.status==='СКАСОВАНО')return false;
        return part.payload.editingTripSeq!=null ? (saved.tripSeq??0)===part.payload.editingTripSeq
          : !!part.payload.odoEnd && e.carId===part.payload.carId && Number(saved.odoStart)===Number(part.payload.odoStart) && Number(saved.odoEnd)===Number(part.payload.odoEnd);
      });
      await tx.insert(table).values({id:part.id,foremanTgId:owner,revision:1,payload,state:submitted?'archived':'open',updatedAt:legacy.updatedAt}).onConflictDoNothing();
      await tx.insert(history).values({tripId:part.id,foremanTgId:owner,revision:1,action:'legacy_import',payload});
    }
  });
  res.json({ok:true});
});

// Opening a report is an explicit operation, separate from a stale autosave.
tripDraftsRouter.post('/open-report',async(req,res)=>{
  const owner=BigInt(req.user!.tgId),{date,tripSeq}=req.body;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||!Number.isSafeInteger(tripSeq)||tripSeq<0){res.status(400).json({error:'Некоректний звіт.'});return;}
  const events=await db.select().from(schema.events).where(and(eq(schema.events.foremanTgId,owner),eq(schema.events.date,date),eq(schema.events.type,'RTS_SAVE'))).orderBy(desc(schema.events.ts));
  const event=events.find(e=>(JSON.parse(e.payload??'{}').tripSeq??0)===tripSeq);
  if(!event||event.status==='СКАСОВАНО'||event.status==='ЗАТВЕРДЖЕНО'){res.status(409).json({error:'Звіт не доступний для редагування.'});return;}
  const id=reportDraftId(String(owner),date,tripSeq);
  const result=await withLock(`trip-draft:${id}`,async tx=>{
    const [row]=await tx.select().from(table).where(eq(table.id,id)).for("update");
    if(!row)return {id,revision:0,payload:null};
    if(row.state==='open')return {id,revision:row.revision,payload:JSON.parse(row.payload)};
    await tx.insert(history).values({tripId:id,foremanTgId:owner,revision:row.revision,action:'reopen',payload:row.payload});
    await tx.update(table).set({state:'open',revision:row.revision+1}).where(eq(table.id,id));
    return {id,revision:row.revision+1,payload:null};
  });res.json(result);
});

tripDraftsRouter.get('/reports',async(req,res)=>{
  const owner=BigInt(req.user!.tgId),offset=Math.max(0,Math.min(1000000,Number(req.query.offset)||0));
  const e=schema.events, seq=sql<number>`coalesce((${e.payload}::jsonb->>'tripSeq')::integer,0)`;
  const rows=await db.selectDistinctOn([e.date,seq],{date:e.date,tripSeq:seq,eventId:e.eventId,status:e.status,carId:e.carId})
    .from(e).where(and(eq(e.foremanTgId,owner),eq(e.type,'RTS_SAVE')))
    .orderBy(desc(e.date),seq,desc(e.ts)).limit(51).offset(offset);
  res.json({records:rows.slice(0,50).filter(r=>r.status!=='СКАСОВАНО'),nextOffset:rows.length>50?offset+50:null});
});

tripDraftsRouter.get('/', async (req,res) => {
  const admin = req.user!.role === 'ADMIN' && req.query.all === 'true';
  const offset = Math.max(0,Math.min(1000000,Number(req.query.offset)||0));
  const rows = await db.select().from(table).where(admin ? undefined : and(eq(table.foremanTgId,BigInt(req.user!.tgId)),eq(table.state,"open")))
    .orderBy(desc(table.updatedAt),desc(table.id)).limit(51).offset(offset);
  res.set('Cache-Control','no-store');
  res.json({records:rows.slice(0,50).map(r => {
    const p=JSON.parse(r.payload);
    return {id:r.id,owner:String(r.foremanTgId),revision:r.revision,state:r.state,updatedAt:r.updatedAt,
      date:p.date,step:p.step,carId:p.carId,editingTripSeq:p.editingTripSeq,planEditing:!!p.planEditing,
      objects:(p.plans??[]).map((x:any)=>x.objectName)};
  }),nextOffset:rows.length>50?offset+50:null});
});
tripDraftsRouter.get('/latest',async(req,res)=>{
  const [row]=await db.select().from(table).where(and(eq(table.foremanTgId,BigInt(req.user!.tgId)),eq(table.state,'open'),
    sql`${table.id} not like 'import:%'`,sql`coalesce((${table.payload}::jsonb->>'planEditing')::boolean,false)=false`))
    .orderBy(desc(table.updatedAt),desc(table.id)).limit(1);
  res.set('Cache-Control','no-store');
  res.json(row?{found:true,id:row.id,revision:row.revision,payload:JSON.parse(row.payload),state:row.state,updatedAt:row.updatedAt}:{found:false});
});
tripDraftsRouter.get('/:id', async (req,res) => {
  const [row] = await db.select().from(table).where(eq(table.id,req.params.id));
  if (!row || (String(row.foremanTgId)!==String(req.user!.tgId) && req.user!.role!=='ADMIN')) {
    res.status(404).json({error:'Поїздку не знайдено.'}); return;
  }
  res.set('Cache-Control','no-store');
  res.json({id:row.id,revision:row.revision,state:row.state,payload:JSON.parse(row.payload),updatedAt:row.updatedAt});
});
tripDraftsRouter.get('/:id/history', async (req,res) => {
  const [row] = await db.select().from(table).where(eq(table.id,req.params.id));
  if (!row || (String(row.foremanTgId)!==String(req.user!.tgId) && req.user!.role!=='ADMIN')) {
    res.status(404).json({error:'Поїздку не знайдено.'}); return;
  }
  const before = Number(req.query.before)||2147483647;
  const {lt} = await import('drizzle-orm');
  const rows=await db.select().from(history).where(and(eq(history.tripId,row.id),lt(history.id,before))).orderBy(desc(history.id)).limit(50);
  res.json({records:rows.map(r=>({...r,foremanTgId:String(r.foremanTgId),payload:JSON.parse(r.payload)}))});
});
tripDraftsRouter.put('/:id', async (req,res) => {
  const owner=BigInt(req.user!.tgId), id=req.params.id, p=req.body?.payload;
  if (!validTripId(id) || !ownedTripId(id,String(owner)) || !p || typeof p!=='object' || Array.isArray(p) || p.recordId!==id
      || !/^\d{4}-\d{2}-\d{2}$/.test(p.date??'') || !Array.isArray(p.plans) || !Array.isArray(p.employeeIds)
      || JSON.stringify(p).length>400000) {
    res.status(400).json({error:'Некоректна чернетка поїздки.'});return;
  }
  const result=await withLock(`trip-draft:${id}`,async tx=> {
    const [row]=await tx.select().from(table).where(eq(table.id,id)).for("update");
    if (row && row.foremanTgId!==owner) return {status:404,error:'Поїздку не знайдено.'};
    const payload=JSON.stringify({...p,dayStash:null,fixingReturnedDate:null});
    // Lost acknowledgements may be retried without creating a new revision.
    if (row && (row.state==='open'||id.startsWith('import:')) && row.payload===payload) return {status:200,revision:row.revision};
    const conflict = row?.state==='archived' ? 'archived' : tripDraftConflict(row?JSON.parse(row.payload):null,p,row?.revision??0,req.body.baseRevision);
    await tx.insert(history).values({tripId:id,foremanTgId:owner,revision:row?.revision??0,action:conflict?`rejected:${conflict}`:'before_write',payload:row?.payload??'null'});
    await tx.insert(history).values({tripId:id,foremanTgId:owner,revision:(row?.revision??0)+(conflict?0:1),action:conflict?'rejected_incoming':'write',payload});
    if (conflict) return {status:409,error:'Захист поїздки: версія змінилася. Ваш варіант збережено в історії. Відкрийте список поїздок для перевірки.',revision:row?.revision??0};
    const revision=(row?.revision??0)+1;
    let state='open';
    // Old completed local copies must never be offered as a new payable trip.
    if(!row&&id.startsWith('import:')){
      const events=await tx.select().from(schema.events).where(and(eq(schema.events.foremanTgId,owner),eq(schema.events.date,p.date),eq(schema.events.type,'RTS_SAVE')));
      if(events.some(e=>{
        const saved=JSON.parse(e.payload??'{}');
        if(e.ts.getTime()<Number(p.legacySavedAt??0))return false;
        return p.editingTripSeq!=null?(saved.tripSeq??0)===p.editingTripSeq:
          !!p.odoEnd&&e.carId===p.carId&&Number(saved.odoStart)===Number(p.odoStart)&&Number(saved.odoEnd)===Number(p.odoEnd);
      }))state='archived';
    }
    await tx.insert(table).values({id,foremanTgId:owner,revision,payload,state,updatedAt:new Date()})
      .onConflictDoUpdate({target:table.id,set:{payload,revision,updatedAt:new Date()}});
    return {status:200,revision};
  });
  res.status(result.status).json(result);
});
// Explicit admin recovery, version checked and fully audited. No payroll writes.
tripDraftsRouter.post('/:id/restore',async(req,res)=>{
  if(req.user!.role!=="ADMIN"){res.status(403).json({error:"Тільки адміністратор може відновити версію."});return;}
  const id=req.params.id;
  const result=await withLock(`trip-draft:${id}`,async tx=>{
    const [row]=await tx.select().from(table).where(eq(table.id,id)).for("update");
    if(!row)return {status:404,error:"Запис не знайдено."};
    if(row.state!=="open"||req.body.baseRevision!==row.revision)return {status:409,error:"Запис змінився або вже в архіві. Відновлення скасовано."};
    const [version]=await tx.select().from(history).where(and(eq(history.id,Number(req.body.historyId)||0),eq(history.tripId,id)));
    if(!version)return {status:404,error:"Версію не знайдено."};
    const payload=JSON.parse(version.payload);
    if(!payload||tripDraftConflict(JSON.parse(row.payload),payload,row.revision,row.revision))return {status:409,error:"Версія належить іншій поїздці або не містить даних."};
    await tx.insert(history).values({tripId:id,foremanTgId:row.foremanTgId,revision:row.revision,action:`before_admin_restore:${req.user!.tgId}`,payload:row.payload});
    await tx.update(table).set({payload:version.payload,revision:row.revision+1,updatedAt:new Date()}).where(eq(table.id,id));
    await tx.insert(history).values({tripId:id,foremanTgId:row.foremanTgId,revision:row.revision+1,action:`admin_restore:${req.user!.tgId}:${version.id}`,payload:version.payload});
    return {status:200,revision:row.revision+1};
  });res.status(result.status).json(result);
});

// Archive only this working copy; never delete payroll events or other trips.
tripDraftsRouter.post('/:id/archive',async(req,res)=>{
  const id=req.params.id,owner=BigInt(req.user!.tgId);
  const [initial]=await db.select().from(table).where(and(eq(table.id,id),req.user!.role==='ADMIN'?undefined:eq(table.foremanTgId,owner)));
  if(!initial){res.status(404).json({error:'Поїздку не знайдено.'});return;}
  const initialDate=JSON.parse(initial.payload).date;
  // Same lock order as reservations: date, owner row, then draft row.
  const result=await withLock(`reserve:${initialDate}`,async tx=>{
    const [claim]=await tx.select().from(schema.tripDraftOwners).where(eq(schema.tripDraftOwners.foremanTgId,initial.foremanTgId)).for("update");
    const [row]=await tx.select().from(table).where(and(eq(table.id,id),req.user!.role==='ADMIN'?undefined:eq(table.foremanTgId,owner))).for("update");
    if(!row)return {status:404,error:'Поїздку не знайдено.'};
    if(row.state==='archived')return {status:200,revision:row.revision};
    if(req.body.baseRevision!==row.revision)return {status:409,error:'Поїздка змінилася. Архівування скасовано.'};
    const p=JSON.parse(row.payload);
    if(p.date!==initialDate)return {status:409,error:'Поїздка змінилася. Архівування скасовано.'};
    if(claim?.activeTripId===id && req.user!.role!=='ADMIN')return {status:409,error:'Ця поїздка має чинні бронювання. Спочатку завершіть або скиньте її через робочий екран.'};
    await tx.insert(history).values({tripId:id,foremanTgId:row.foremanTgId,revision:row.revision,action:`before_archive:${owner}`,payload:row.payload});
    if(claim?.activeTripId===id){
      // Keep the entire previous claim alongside the full draft for recovery.
      await tx.insert(history).values({tripId:id,foremanTgId:row.foremanTgId,revision:row.revision,action:`before_admin_release:${owner}`,payload:JSON.stringify({claim:{...claim,foremanTgId:String(claim.foremanTgId)}})});
      const foreman=Number(row.foremanTgId);
      const carId=p.carId && await callerHoldsCar(tx,p.date,p.carId,foreman) ? p.carId : undefined;
      const employeeIds=await employeesHeldByCaller(tx,p.date,p.employeeIds??[],foreman);
      if(carId || employeeIds.length)await writeEvent({eventId:makeEventId('RTSRSV'),status:'АКТИВНА',date:p.date,foremanTgId:foreman,type:'RTS_RESERVE_CANCEL',carId,employeeIds:JSON.stringify(employeeIds),payload:JSON.stringify({draftId:id,adminTgId:String(owner),reason:'admin_archive'})},tx);
      await tx.update(schema.tripDraftOwners).set({activeTripId:null}).where(and(eq(schema.tripDraftOwners.foremanTgId,row.foremanTgId),eq(schema.tripDraftOwners.activeTripId,id)));
    }
    await tx.update(table).set({state:'archived',revision:row.revision+1,updatedAt:new Date()}).where(eq(table.id,id));
    return {status:200,revision:row.revision+1};
  });
  res.status(result.status).json(result);
});

return tripDraftsRouter;
}
export const tripDraftsRouter=createTripDraftsRouter(productionDb,productionWithLock);
