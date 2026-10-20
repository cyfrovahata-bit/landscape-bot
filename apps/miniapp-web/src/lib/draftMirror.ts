import {api} from './api';
import {importLegacyDraft} from './draft';
import {TripDraftQueue} from './tripDraftQueue';
import {ApiError, retryableWriteError} from './requestErrors';
export type TripDraftSummary={id:string;owner:string;revision:number;state:string;updatedAt:string;date:string;step:string;carId:string;editingTripSeq:number|null;planEditing:boolean;objects:string[]};
const queue=new TripDraftQueue();
let pending=0;
const failures=new Map<string,unknown>();
const recordPending=new Map<string,number>();
const generations=new Map<string,number>();
const acknowledged=new Map<string,string>();
const failedWrites=new Map<string,Record<string,any>>();
const retrying=new Map<string,Promise<void>>();
const listeners=new Set<(value:{pending:number;error:string;failedId:string})=>void>();
const emit=()=>{const [id,error]=[...failures.entries()][0]??['',null];listeners.forEach(fn=>fn({pending,error:error instanceof Error?error.message:'',failedId:id}));};
export function subscribeDraftSave(fn:(value:{pending:number;error:string;failedId:string})=>void) {listeners.add(fn);emit();return()=>{listeners.delete(fn);};}
const latest=new Map<string,unknown>();
const fingerprints=new Map<string,string>();
function enqueueSnapshot(id:string,clean:Record<string,any>,serialized=JSON.stringify(clean)) {
  recordPending.set(id,(recordPending.get(id)??0)+1);
  pending++;emit();
  return queue.enqueue(id,async base=> {
    try {
      const r=await api.put<{revision:number}>(`/api/trip-drafts/${encodeURIComponent(id)}`,{payload:clean,baseRevision:base});
      acknowledged.set(id,serialized);failedWrites.delete(id);failures.delete(id);
      if(JSON.stringify(latest.get(id))===serialized)fingerprints.set(id,serialized);
      return r;
    }catch(error){if(!failedWrites.has(id))failedWrites.set(id,clean);throw error;}
  }).catch(error=>{failures.set(id,error);fingerprints.delete(id);throw error;})
    .finally(()=>{pending--;recordPending.set(id,(recordPending.get(id)??1)-1);emit();});
}
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
  generations.set(id,(generations.get(id)??0)+1);
  void enqueueSnapshot(id,clean,serialized).catch(()=>{});
}
export async function flushTripDrafts(id?:string){await queue.flush(id);}
export async function retryTripDraft(id:string) {
  if(retrying.has(id))return retrying.get(id)!;
  const task=(async()=>{
    // Drain earlier rejected jobs before removing their failure barrier.
    await queue.flush(id).catch(()=>{});
    queue.retry(id);failures.delete(id);fingerprints.delete(id);emit();
    // Recover an ambiguous acknowledgement using that exact snapshot first.
    // The server recognizes an identical saved payload without overwriting it.
    const failed=failedWrites.get(id);
    if(failed)await enqueueSnapshot(id,failed);
    if(latest.has(id))mirrorDraft({payload:latest.get(id)});
    await flushTripDrafts(id);
  })();
  retrying.set(id,task);
  try{await task;}finally{retrying.delete(id);}
}

export async function retryTransientTripDrafts() {
  const ids=[...failures.entries()].filter(([id,error])=>retryableWriteError(error)&&!(recordPending.get(id)??0)).map(([id])=>id);
  await Promise.all(ids.map(id=>retryTripDraft(id).catch(()=>{})));
}
/** Retry an authentication failure only after /me has confirmed the session again. */
export async function retryAuthenticatedTripDrafts() {
  const ids=[...failures.entries()].filter(([id,error])=>error instanceof ApiError&&error.status===401&&!(recordPending.get(id)??0)).map(([id])=>id);
  await Promise.all(ids.map(id=>retryTripDraft(id).catch(()=>{})));
}

/** Called only when the app is mounted. No persistent browser storage. */
export function startAutomaticDraftRetry() {
  const retry=()=>{if(navigator.onLine!==false)void retryTransientTripDrafts();};
  window.addEventListener('online',retry);window.addEventListener('focus',retry);
  const visible=()=>{if(document.visibilityState==='visible')retry();};
  document.addEventListener('visibilitychange',visible);
  const timer=window.setInterval(retry,10000);
  return()=>{window.removeEventListener('online',retry);window.removeEventListener('focus',retry);document.removeEventListener('visibilitychange',visible);window.clearInterval(timer);};
}

export function tripDraftGeneration(id:string) {return generations.get(id)??0;}
export function tripDraftHasUnsavedChanges(id:string) {
  return !!failures.has(id)||!!recordPending.get(id)||
    (fingerprints.has(id)&&fingerprints.get(id)!==acknowledged.get(id));
}

/** Do not advance the write revision if a user edited while this read was in flight. */
export async function refreshCleanTripDraft<T>(id:string) {
  if(tripDraftHasUnsavedChanges(id))return null;
  const generation=tripDraftGeneration(id);
  let r: {id:string;payload:T;revision:number;state:string;updatedAt:string};
  try {r=await api.get(`/api/trip-drafts/${encodeURIComponent(id)}`);}
  catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
  if(generation!==tripDraftGeneration(id)||tripDraftHasUnsavedChanges(id))return null;
  return r.revision!==queue.revision(id)?{...r,generation}:null;
}

export function adoptRefreshedTrip<T>(record:{id:string;revision:number;payload:T;generation:number}) {
  if(record.generation!==tripDraftGeneration(record.id)||tripDraftHasUnsavedChanges(record.id))return false;
  queue.remember(record.id,record.revision);
  const serialized=JSON.stringify(record.payload);
  fingerprints.set(record.id,serialized);acknowledged.set(record.id,serialized);latest.set(record.id,record.payload);
  return true;
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
  queue.retry(id);failures.delete(id);failedWrites.delete(id);fingerprints.delete(id);latest.delete(id);acknowledged.delete(id);emit();
  return r;
}
