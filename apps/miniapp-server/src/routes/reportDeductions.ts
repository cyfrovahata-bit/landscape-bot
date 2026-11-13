import {asyncRouter} from '../asyncRouter.js';
import {applyDeductions,validateDeductions,type ObjectSalaryPack,type LockedTx} from '@landscape/core';
import {readReportDeductions,saveReportDeductions,reportRevision} from '../lib/reportDeductions.js';
import {ReservationConflictError} from '../lib/reservationErrors.js';

type Trip={eventId:string;status:string;employeeIds:string[]};
export function createReportDeductionsRouter<T extends Trip>(deps:{
  withLock:<R>(key:string,fn:(tx:LockedTx)=>Promise<R>)=>Promise<R>;
  fetchTrips:(date:string,owner:number,tx:LockedTx)=>Promise<T[]>;
  gross:(trips:T[],owner:number)=>Promise<{salaryPacks:ObjectSalaryPack[];employeeIds:string[]}>;
}) {
  const router=asyncRouter();
  router.post('/',async(req,res)=>{
    if(req.user?.role!=='ADMIN'){res.status(403).json({error:'Доступно лише адміністратору.'});return;}
    const {date,foremanTgId,revision,reportRevision:expectedReport}=req.body;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(foremanTgId)||foremanTgId<=0||!Number.isSafeInteger(revision)||revision<0){res.status(400).json({error:'Некоректний звіт.'});return;}
    let items;
    try{items=validateDeductions(req.body.items);}catch(e){res.status(400).json({error:(e as Error).message});return;}
    await deps.withLock(`reserve:${date}`,async tx=>{
      const all=await deps.fetchTrips(date,foremanTgId,tx);
      const pending=all.filter(t=>t.status!=='ЗАТВЕРДЖЕНО');
      if(!pending.length||pending.some(t=>t.status!=='АКТИВНА'))throw new ReservationConflictError('Звіт уже змінено або затверджено. Оновіть список.');
      const before=await readReportDeductions(date,foremanTgId,tx);
      if(before.revision!==revision||reportRevision(pending)!==expectedReport)throw new ReservationConflictError('Звіт або відрахування змінилися в іншій вкладці. Оновіть список.');
      const gross=await deps.gross(pending,foremanTgId);
      const employeeIds=[...new Set([...gross.employeeIds,...gross.salaryPacks.flatMap(p=>p.rows.map(r=>r.employeeId))])];
      try{applyDeductions(gross.salaryPacks,employeeIds,items);}catch(e){throw new ReservationConflictError((e as Error).message);}
      const approvedIds=new Set(all.filter(t=>t.status==='ЗАТВЕРДЖЕНО').map(t=>t.eventId));
      const groups=before.groups.filter(g=>g.eventIds.every(id=>approvedIds.has(id)));
      const after={revision:before.revision+1,groups:[...groups,{eventIds:pending.map(t=>t.eventId),employeeIds,items,sourceRevision:reportRevision(pending)}]};
      await saveReportDeductions(tx,date,foremanTgId,req.user!.tgId,before,after);
    });
    res.json({ok:true});
  });
  return router;
}
