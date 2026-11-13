import {useEffect, useState} from 'react';
import {confirmDialog} from '../lib/telegram';
export type DeductionItem = {id:string;reason:string;amount:number};
type Draft = {id:string;reason:string;amount:string};
export function DeductionEditor({items,onSave,onDirty,busy,onRefresh}:{items:DeductionItem[];onSave:(items:DeductionItem[])=>Promise<void>;onDirty:(dirty:boolean)=>void;busy:boolean;onRefresh:()=>void}) {
  const [drafts,setDrafts]=useState<Draft[]>(()=>items.map(d=>({...d,amount:String(d.amount)})));
  const [error,setError]=useState('');
  const dirty=JSON.stringify(drafts.map(d=>({...d,amount:Number(d.amount.replace(',','.'))})))!==JSON.stringify(items);
  useEffect(()=>{onDirty(dirty);},[dirty]);
  async function save(next=drafts) {
    setError('');
    if(next.some(d=>!d.reason.trim()||!d.amount.trim()||!Number.isFinite(Number(d.amount.replace(',','.')))||Number(d.amount.replace(',','.'))<=0)) {setError('Вкажіть причину та додатну суму кожного відрахування.');return;}
    try {await onSave(next.map(d=>({id:d.id,reason:d.reason.trim(),amount:Number(d.amount.replace(',','.'))})));}
    catch(e){setError((e as Error).message);}
  }
  return <div className="approval-object" style={{marginTop:12}}>
    <div className="approval-sub">➖ Відрахування</div>
    {drafts.map((d,i)=><div key={d.id} style={{padding:'8px 0',borderBottom:'1px solid var(--tg-theme-section-separator-color, #ddd)'}}>
      <label>За що<input aria-label={`Причина відрахування ${i+1}`} className="search-box" maxLength={300} value={d.reason} disabled={busy} placeholder="Наприклад, оренда техніки" onChange={e=>setDrafts(drafts.map(x=>x.id===d.id?{...x,reason:e.target.value}:x))}/></label>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <label style={{flex:1,minWidth:0}}>Сума, грн<input aria-label={`Сума відрахування ${i+1}`} className="search-box" inputMode="decimal" value={d.amount} disabled={busy} placeholder="0.00" onChange={e=>setDrafts(drafts.map(x=>x.id===d.id?{...x,amount:e.target.value}:x))}/></label>
        <button className="chip" aria-label={`Зберегти відрахування ${i+1}`} disabled={busy} onClick={()=>save()}>💾</button>
        <button className="chip danger-btn" aria-label={`Видалити відрахування ${i+1}`} disabled={busy} onClick={async()=>{
          if(items.some(x=>x.id===d.id)&&!(await confirmDialog('Видалити відрахування та перерахувати нарахування?')))return;
          const next=drafts.filter(x=>x.id!==d.id);
          if(items.some(x=>x.id===d.id))await save(next);else setDrafts(next);
        }}>🗑</button>
      </div>
    </div>)}
    <button className="chip" style={{marginTop:8}} disabled={busy||drafts.length>=50} onClick={()=>setDrafts([...drafts,{id:crypto.randomUUID(),reason:'',amount:''}])}>Додати відрахування +</button>
    {!!items.length&&<div className="hint" style={{marginTop:8}}>Збережено відрахувань: {(items.reduce((a,d)=>a+Math.round(d.amount*100),0)/100).toFixed(2)} грн. Порівну між усіма, включно з бригадиром. Нарахування вище вже з відрахуваннями.</div>}
    {dirty&&<div className="hint" role="status">Є незбережені зміни. Натисніть 💾 перед затвердженням.</div>}
    {error&&<div role="alert">⚠️ {error} <button className="chip" disabled={busy} onClick={onRefresh}>Оновити звіт</button></div>}
  </div>;
}
