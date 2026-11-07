import { useState } from 'react';

export function BackdatedEntryToggle({enabled,onChange}:{enabled:boolean;onChange:(enabled:boolean)=>Promise<void>}) {
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  async function toggle() {
    if(saving)return;
    setSaving(true);setError('');
    try {await onChange(!enabled);}catch(e){setError((e as Error).message);}
    finally{setSaving(false);}
  }
  return <>
    <div className="theme-toolbar">
      <button className="theme-toggle" type="button" role="switch"
        aria-label="Введення заднім числом для бригадирів" aria-checked={enabled} disabled={saving}
        onClick={() => {void toggle();}}>
        <span aria-hidden="true">📅</span>
        <span>{saving ? 'Зберігаємо…' : 'Заднім числом для бригадирів'}</span>
        <span className="theme-toggle-track" aria-hidden="true"><span /></span>
      </button>
    </div>
    {error && <div className="hint" role="alert" style={{padding:'4px 16px'}}>{error}</div>}
  </>;
}
