import {useState} from 'react';
import {api} from '../lib/api';
import {confirmDialog} from '../lib/telegram';
import {listTripDrafts,type TripDraftSummary} from '../lib/draftMirror';
/** Read/export only. Existing payroll approval/editing remains in its own UI. */
export function DraftDatabase(){
  const [rows,setRows]=useState<TripDraftSummary[]>([]);
  const [next,setNext]=useState<number|null>(0);
  const [error,setError]=useState('');
  const [detail,setDetail]=useState<any>(null);
  const [selected,setSelected]=useState<TripDraftSummary|null>(null);
  const [opened,setOpened]=useState(false);
  const [filter,setFilter]=useState('');
  async function load(offset:number){try{
    const r=await listTripDrafts(offset,true);setRows(v=>offset?[...v,...r.records]:r.records);setNext(r.nextOffset);setError('');setOpened(true);
  }catch(e){setError((e as Error).message);}}
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(detail,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='greenhand-record-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section>
    <button className="bulk-select-btn" onClick={()=>load(0)}>🗄 База поїздок: записи та історія</button>
    {error&&<p>{error}</p>}
    {opened&&<>
      <p className="hint">Перегляд і вивантаження окремих записів. Робочі дані та нарахування тут не змінюються.</p>
      <input placeholder="Дата, ID або бригадир" value={filter} onChange={e=>setFilter(e.target.value)}/>
      {rows.filter(r=>JSON.stringify(r).toLowerCase().includes(filter.toLowerCase())).map(r=><div key={r.id} className="cell">
        <span>{r.date} · {r.owner} · {r.carId} · {r.state==='open'?'Чернетка':'Архів'}<small style={{display:'block'}}>{r.id}</small></span>
        <button onClick={async()=>{try{setSelected(r);setDetail(await api.get(`/api/trip-drafts/${encodeURIComponent(r.id)}`));}catch(e){setError((e as Error).message);}}}>Дані</button>
        <button onClick={async()=>{try{setSelected(r);setDetail(await api.get(`/api/trip-drafts/${encodeURIComponent(r.id)}/history`));}catch(e){setError((e as Error).message);}}}>Історія (50)</button>
      </div>)}
      {next!==null&&<button onClick={()=>load(next)}>Завантажити ще</button>}
      {detail!==null&&<><button onClick={download}>Завантажити JSON</button><button onClick={()=>setDetail(null)}>Закрити</button>{selected&&detail?.records&&selected.state==='open'&&detail.records.filter((v:any)=>v.payload?.recordId===selected.id).map((v:any)=><button key={v.id} onClick={async()=>{
          if(!(await confirmDialog(`Відновити версію ${v.id} запису ${selected.id}?\nДата: ${v.payload.date}.\nПоточна версія залишиться в історії. Здані звіти й нарахування не зміняться. Відкритий редактор отримає конфлікт версій.`)))return;
          try{await api.post(`/api/trip-drafts/${encodeURIComponent(selected.id)}/restore`,{historyId:v.id,baseRevision:selected.revision});setDetail(null);await load(0);}catch(e){setError((e as Error).message);}
        }}>Відновити версію {v.id} · {v.action}</button>)}<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:400,overflow:'auto'}}>{JSON.stringify(detail,null,2)}</pre></>}
    </>}
  </section>;
}
