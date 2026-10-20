/** Telegram can suspend a WebView without unmounting React. */
export function onAppResume(callback: () => void) {
  const resume = () => { if (document.visibilityState !== 'hidden') callback(); };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', resume);
  return () => {
    window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', resume);
  };
}
