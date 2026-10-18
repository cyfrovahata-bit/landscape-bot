import {api} from './api';
import {importLegacyDraft} from './draft';
import {TripDraftQueue} from './tripDraftQueue';
export type TripDraftSummary={id:string;owner:string;revision:number;state:string;updatedAt:string;date:string;step:string;carId:string;editingTripSeq:number|null;planEditing:boolean;objects:string[]};
const queue=new TripDraftQueue();
let pending=0;
let failure='';
const listeners=new Set<(value:{pending:number;error:string})=>void>();
const emit=()=>listeners.forEach(fn=>fn({pending,error:failure}));
export function subscribeDraftSave(fn:(value:{pending:number;error:string})=>void) {listeners.add(fn);emit();return()=>{listeners.delete(fn);};}
const latest=new Map<string,unknown>();
const fingerprints=new Map<string,string>();
export async function listTripDrafts(offset=0,all=false) {
  return api.get<{records:TripDraftSummary[];nextOffset:number|null}>(`/api/trip-drafts?offset=${offset}&all=${all}`);
}
export async function readTripDraft<T>(id:string) {
  const r=await api.get<{id:string;payload:T;revision:number;state:string;updatedAt:string}>(`/api/trip-drafts/${encodeURIComponent(id)}`);
  queue.remember(id,r.revision);
  return r;
}
export function mirrorDraft(snapshot:{payload:unknown;[key:string]:unknown}) {
  const p=snapshot.payload as Record<string,any>;
  const id=p.recordId as string;
  if(!id)return;
  const clean={...p,dayStash:null,fixingReturnedDate:null};
  const serialized=JSON.stringify(clean);
  if(fingerprints.get(id)===serialized)return;
  fingerprints.set(id,serialized);
  latest.set(id,clean);
  pending++;emit();
  void queue.enqueue(id,async base=> {
    const r=await api.put<{revision:number}>(`/api/trip-drafts/${encodeURIComponent(id)}`,{payload:clean,baseRevision:base});
    return r;
  }).catch(e=>{failure=(e as Error).message;fingerprints.delete(id);}).finally(()=>{pending--;emit();});
}
export async function flushTripDrafts(id?:string){await queue.flush(id);}
export async function retryTripDraft(id:string) {
  queue.retry(id);failure='';fingerprints.delete(id);emit();
  if(latest.has(id))mirrorDraft({payload:latest.get(id)});
  await flushTripDrafts(id);
}
export async function archiveTripDraft(id:string) {
  await flushTripDrafts(id);
  const r=await api.post<{revision:number}>(`/api/trip-drafts/${encodeURIComponent(id)}/archive`,{baseRevision:queue.revision(id)});
  queue.remember(id,r.revision);fingerprints.delete(id);
}
/** Retained call signature for old callers; never clears someone else's slot. */
export function clearMirroredDraft() { /* explicit archiveTripDraft(id) replaces destructive singleton delete */ }
export async function fetchMirroredDraft<T>() {
  await api.post('/api/trip-drafts/adopt',{});
  await importLegacyDraft(async(id,payload)=>{
    // Imports are separate records, never overwrites of server working data.
    const r=await api.put<{revision:number}>(`/api/trip-drafts/${encodeURIComponent(id)}`,{payload,baseRevision:0});
    queue.remember(id,r.revision);
  });
  const r=await api.get<{found:boolean;id:string;revision:number;payload:T;state:string;updatedAt:string}>("/api/trip-drafts/latest");
  if(!r.found)return null;
  queue.remember(r.id,r.revision);return r;
}

export const draftServerRevision=(id:string)=>queue.revision(id);

export async function acceptServerTrip<T>(id:string) {
  const r=await readTripDraft<T>(id);
  queue.retry(id);failure='';fingerprints.delete(id);latest.delete(id);emit();
  return r;
}
