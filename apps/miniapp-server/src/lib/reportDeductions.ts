import { createHash, randomUUID } from 'node:crypto';
import { db, schema, writeEvent, type LockedTx } from '@landscape/core';
import { eq } from 'drizzle-orm';
import type { DeductionDocument } from '@landscape/core';
export const deductionStateId = (date:string, owner:number) => `RTSDED_${date}_${owner}`;
export const reportRevision = (trips: unknown) => createHash('sha256').update(JSON.stringify(trips)).digest('hex');
export async function readReportDeductions(date:string,owner:number,executor:typeof db|LockedTx=db):Promise<DeductionDocument> {
  const [row]=await executor.select().from(schema.events).where(eq(schema.events.eventId,deductionStateId(date,owner))).limit(1);
  return row?.payload ? JSON.parse(row.payload) : {revision:0,groups:[]};
}
export async function saveReportDeductions(tx:LockedTx,date:string,owner:number,actor:number,before:DeductionDocument,after:DeductionDocument) {
  // Full before+after snapshots are written atomically BEFORE the current state is replaced.
  await writeEvent({eventId:`RTSDEDH_${randomUUID()}`,type:'RTS_DEDUCTIONS_HISTORY',status:'АКТИВНА',date,foremanTgId:owner,payload:JSON.stringify({actor,before,after})},tx);
  await writeEvent({eventId:deductionStateId(date,owner),type:'RTS_DEDUCTIONS',status:'АКТИВНА',date,foremanTgId:owner,payload:JSON.stringify(after)},tx);
}
