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
      <button className="theme-toggle admin-feature-toggle" type="button" role="switch"
        aria-label="Введення заднім числом для бригадирів" aria-checked={enabled} disabled={saving}
        onClick={() => {void toggle();}}>
        <span className="admin-feature-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2" />
          </svg>
        </span>
        <span className="admin-feature-label"><span>Заднім числом</span>
          <span className="admin-feature-status">Для бригадирів · {saving ? 'Зберігаємо…' : enabled ? 'Увімкнено' : 'Вимкнено'}</span>
        </span>
        <span className="theme-toggle-track" aria-hidden="true"><span /></span>
      </button>
    </div>
    {error && <div className="hint" role="alert" style={{padding:'4px 16px'}}>{error}</div>}
  </>;
}
