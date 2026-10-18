// New working data is server-only. These functions only preserve compatibility
// with planner callers; they do not write browser storage.
import {getInitDataUser} from './telegram';
export function saveDraft<T>(_data:T) {}
export function clearDraft() { /* old copies are removed only by importLegacyDraft */ }
export async function importLegacyDraft(upload:(id:string,payload:Record<string,any>)=>Promise<void>) {
  const key=`roadTimesheetDraft:v1:${getInitDataUser()?.id??'anon'}`;
  let raw:string|null;
  try {raw=localStorage.getItem(key);} catch {return;}
  if(!raw)return;
  const stored=JSON.parse(raw);
  if(!stored.data||typeof stored.data!=='object')throw new Error('Стара локальна чернетка пошкоджена. Зверніться до адміністратора.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);
  const walk=async(p:Record<string,any>,suffix:string):Promise<void>=>{
    if(p.dayStash)await walk(p.dayStash,`${suffix}-stash`);
    if(!(p.carId||p.employeeIds?.length||p.plans?.length||p.tripStartedAt))return;
    const id=`import:${getInitDataUser()?.id}:${hash}:${suffix}`;
    await upload(id,{...p,recordId:id,legacySavedAt:stored.savedAt??0,dayStash:null,fixingReturnedDate:null});
  };
  await walk(stored.data,'current');
  // Do not clear if an old open tab changed the source during import.
  if(localStorage.getItem(key)===raw)localStorage.removeItem(key);
}
