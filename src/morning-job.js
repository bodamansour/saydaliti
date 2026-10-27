// Daily job: for each pharmacy with WhatsApp numbers, build the morning summary from the latest snapshot
// and send the approved template. Pure apart from fetchFn, so it is tested without the network.
import { analyze, fromExport, settingsFromSaved, startOfDay } from './core.js';
import { mergeBranches } from './branches-expenses.js';
import { morningTemplateParams, parsePhones } from './report.js';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'REPORT_SECRET', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'];
const STALE_HOURS = 36;

export async function runMorning({ env, fetchFn = fetch, now = new Date() }) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) return { sent: 0, skipped: `not configured: ${missing.join(', ')}` };

  const feed = await fetchFn(`${env.SUPABASE_URL}/rest/v1/rpc/report_feed`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: env.REPORT_SECRET }),
  });
  if (!feed.ok) return { sent: 0, error: `feed ${feed.status}` };
  const rows = await feed.json();

  const site = (env.SITE_URL || 'https://saydaliti-ivory.vercel.app').replace(/\/$/, '');
  const template = env.WHATSAPP_TEMPLATE || 'saydaliti_morning';
  const lang = env.WHATSAPP_LANG || 'ar';
  const results = [];
  for (const p of rows) {
    const ageH = (now - new Date(p.snapshot_at)) / 3600000;
    if (ageH > STALE_HOURS) { results.push({ pharmacy: p.pharmacy_name, skipped: `data is ${Math.round(ageH)}h old` }); continue; }
    // Every branch's latest data, merged (migration 008); older databases send one snapshot in `data`.
    const parts = Array.isArray(p.branch_data) && p.branch_data.length ? p.branch_data.map((b) => fromExport(b.data)) : [fromExport(p.data)];
    const A = analyze(mergeBranches(parts), settingsFromSaved(p.settings || {}), startOfDay(now));
    const params = morningTemplateParams(A, { pharmacyName: p.pharmacy_name, link: site });
    for (const to of parsePhones(p.settings?.waNumbers)) {
      const r = await fetchFn(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
        }),
      });
      results.push({ pharmacy: p.pharmacy_name, to: `…${to.slice(-4)}`, ok: r.ok, status: r.status });
    }
  }
  return { sent: results.filter((x) => x.ok).length, results };
}
