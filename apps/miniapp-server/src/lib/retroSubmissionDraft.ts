import { db, schema } from '@landscape/core';
import { and, eq } from 'drizzle-orm';
import { isBackdatedEntryEnabled } from './appFeatures.js';
import { ReservationConflictError } from './reservationErrors.js';

/** Bridge for the retro form, including already-open clients. Runs inside
 * the submission transaction; never adopts or overwrites a live trip. */
export async function prepareRetroSubmissionDraft(
  tx: Pick<typeof db, 'select' | 'insert'>,
  input: {owner:number;date:string;today:string;backdated?:boolean;draftId?:string;key:string|null;payload:Record<string,unknown>},
) {
  if (input.draftId || input.backdated !== true || input.date >= input.today) return null;
  if (!(await isBackdatedEntryEnabled(tx))) {
    throw new ReservationConflictError('Введення заднім числом вимкнено адміністратором. Введені дані залишилися у формі.');
  }
  if (!input.key) throw new ReservationConflictError('Не вдалося визначити спробу відправлення. Повторіть відправлення без закриття форми.');
  const owner = BigInt(input.owner);
  const id = `legacy:${owner}:retro:${input.date}:${input.key}`;
  const payload = JSON.stringify({...input.payload,recordId:id,step:'RETRO_REVIEW',plans:input.payload.objects,dayStash:null,fixingReturnedDate:null});
  const created = await tx.insert(schema.tripDrafts).values({id,foremanTgId:owner,revision:1,state:'open',payload})
    .onConflictDoNothing().returning({id:schema.tripDrafts.id});
  if (created.length) await tx.insert(schema.tripDraftHistory).values({tripId:id,foremanTgId:owner,revision:1,action:'retro_submission',payload});
  const [row] = await tx.select().from(schema.tripDrafts)
    .where(and(eq(schema.tripDrafts.id,id),eq(schema.tripDrafts.foremanTgId,owner))).limit(1);
  if (!row) throw new ReservationConflictError('Не вдалося підготувати звіт. Повторіть відправлення.');
  return {id,revision:row.revision};
}
