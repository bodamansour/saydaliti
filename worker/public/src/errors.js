// Errors on the app's screens are sent to the database (database update 013), so problems at any
// pharmacy show up on the admin page before anyone reports them. No patient or customer data is
// sent: only the error message, where it happened in the code, the page and the browser.
export const APP_VERSION = '2026.10.28';

const sent = new Set();
let count = 0;

// ctx() → { client, pharmacyId, local } or null while signed out.
export function watchErrors(page, ctx) {
  if (typeof window === 'undefined') return;
  const report = (message, stack) => {
    const c = ctx();
    if (!c?.client || c.local || count >= 10) return; // the desktop version has nowhere to send them
    const key = String(message).slice(0, 200);
    if (sent.has(key)) return;
    sent.add(key); count += 1;
    c.client.rpc('log_client_error', {
      p_pharmacy: c.pharmacyId ?? null, p_page: page, p_message: String(message).slice(0, 500),
      p_stack: stack ? String(stack).slice(0, 4000) : null, p_agent: navigator.userAgent.slice(0, 300), p_version: APP_VERSION,
    }).then(() => {}, () => {});
  };
  window.addEventListener('error', (e) => report(e.message || 'error', e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (/fetch|network|Load failed/i.test(String(r?.message ?? r))) return; // no connection is not a bug
    report(r?.message ?? String(r), r?.stack);
  });
}
