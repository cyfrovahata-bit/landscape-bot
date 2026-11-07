import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { onAppResume } from './resume';
type Features = {backdatedEntryEnabled:boolean};
export function useAppFeatures() {
  const [backdatedEntryEnabled, setEnabled] = useState(false);
  const refreshFeatures = useCallback(async () => {
    try { setEnabled((await api.get<Features>('/api/app-features')).backdatedEntryEnabled); }
    catch { /* Server checks permission when saving. */ }
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {void refreshFeatures();}, 15000);
    const stop = onAppResume(() => {void refreshFeatures();});
    return () => {clearInterval(timer); stop();};
  }, [refreshFeatures]);
  const setBackdatedEntryEnabled = async (enabled:boolean) => {
    const saved = await api.put<Features>('/api/app-features/backdated-entry', {enabled});
    setEnabled(saved.backdatedEntryEnabled);
  };
  return {backdatedEntryEnabled, refreshFeatures, setBackdatedEntryEnabled};
}
