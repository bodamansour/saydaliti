// Patient WhatsApp reminders (dose times and refills). Runs about once an hour.
// Pure apart from fetchFn, so it is tested without the network. Uses the same secret as the morning report.
import { dueReminders, advanceRefill, cairoClock } from './features.js';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'REPORT_SECRET', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'];
const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';

// Templates to submit in Meta (Arabic, Utility):
//   saydaliti_dose:   أهلاً {{1}}، تذكير من {{2}}: ده ميعاد {{3}}. ألف سلامة عليك.
//   saydaliti_refill: أهلاً {{1}}، {{3}} قرب يخلص. تحب {{2}} تجهزهولك؟ رد على الرسالة دي ونجهزه.
export function reminderParams(r) {
  return [r.patient_name, r.pharmacy_name, r.medicine].map(oneLine);
}

export async function runReminders({ env, fetchFn = fetch, now = new Date() }) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) return { sent: 0, skipped: `not configured: ${missing.join(', ')}` };
  const rpc = (name, body) => fetchFn(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: env.REPORT_SECRET, ...body }),
  });

  const feed = await rpc('reminders_feed', {});
  if (!feed.ok) return { sent: 0, error: `feed ${feed.status}` };
  const due = dueReminders(await feed.json(), now);
  const today = cairoClock(now).date;
  const done = [];
  const results = [];
  for (const r of due) {
    const template = r.kind === 'dose' ? (env.WHATSAPP_DOSE_TEMPLATE || 'saydaliti_dose') : (env.WHATSAPP_REFILL_TEMPLATE || 'saydaliti_refill');
    const res = await fetchFn(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: r.phone, type: 'template',
        template: { name: template, language: { code: env.WHATSAPP_LANG || 'ar' }, components: [{ type: 'body', parameters: reminderParams(r).map((text) => ({ type: 'text', text })) }] },
      }),
    });
    results.push({ kind: r.kind, to: `…${String(r.phone).slice(-4)}`, ok: res.ok, status: res.status });
    if (!res.ok) continue;
    const next = r.kind === 'refill' ? advanceRefill(r.next_refill, r.refill_every_days, new Date(`${today}T00:00:00`)) : null;
    done.push({ id: r.id, next_refill: next ? `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}` : null });
  }
  if (done.length) {
    const m = await rpc('mark_reminders_sent', { p_items: done });
    if (!m.ok) return { sent: done.length, results, error: `mark ${m.status}` };
  }
  return { sent: done.length, due: due.length, results };
}
