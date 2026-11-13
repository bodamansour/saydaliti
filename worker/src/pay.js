// Paying the subscription online through Paymob (cards and mobile wallets).
//   POST /api/pay/start   {pharmacy, months: 1 | 12}  → { url } of Paymob's checkout page (owner only)
//   POST /api/pay/webhook ?hmac=…                      ← Paymob tells us a payment went through
// The amount is worked out here from the pharmacy's plan and prices, never taken from the page. A payment
// adds its months only after Paymob's signed message says it succeeded, and only once (the payment row moves
// from 'pending' to 'paid' once). Off unless the server has the four PAYMOB_* secrets; refused on staging
// (guardedFetch). Paymob's own docs: https://developers.paymob.com
import { ApiError, nowIso, uuid } from './db.js';
import { payAmount, extendPaid } from '../../src/subscription.js';

const API = 'https://accept.paymob.com';
const REQUIRED = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_IDS', 'PAYMOB_HMAC'];
export const payReady = (env) => !REQUIRED.filter((k) => !env[k]).length;

const one = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) ?? null;

export async function payStart(env, ctx, b, { fetchImpl = fetch, site = '' } = {}) {
  if (!payReady(env)) throw new ApiError('payments not configured', '501', 501);
  if (!b || typeof b.pharmacy !== 'string' || ![1, 12].includes(+b.months)) throw new ApiError('bad request', '400', 400);
  if (ctx.roles.get(b.pharmacy) !== 'owner') throw new ApiError('not allowed', '42501', 403);
  const months = +b.months;
  const sub = await one(env, 'SELECT status, paid_until, price_month, plan FROM subscriptions WHERE pharmacy_id = ?', b.pharmacy);
  if (sub?.status === 'free') throw new ApiError('nothing to pay', '400', 400);
  const cfg = await one(env, 'SELECT price_month, price_branch, plans FROM app_config WHERE id = 1');
  const branches = (await one(env, 'SELECT COUNT(*) AS n FROM branches WHERE pharmacy_id = ?', b.pharmacy))?.n || 1;
  const amount = payAmount({ sub, cfg, branches, months });
  if (!(amount > 0)) throw new ApiError('no price set', '400', 400);
  const ph = await one(env, 'SELECT name FROM pharmacies WHERE id = ?', b.pharmacy);
  const id = uuid();
  const cents = Math.round(amount * 100);
  await env.DB.prepare("INSERT INTO payments (id, pharmacy_id, user_id, months, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
    .bind(id, b.pharmacy, ctx.user.id, months, cents, nowIso()).run();
  const ids = String(env.PAYMOB_INTEGRATION_IDS).split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  const res = await fetchImpl(`${API}/v1/intention/`, {
    method: 'POST',
    headers: { Authorization: `Token ${env.PAYMOB_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: cents, currency: 'EGP', payment_methods: ids,
      items: [{ name: `Tablix Pharma ${months === 12 ? '12 months' : '1 month'}`, amount: cents, quantity: 1, description: String(ph?.name || '').slice(0, 100) || 'subscription' }],
      // Paymob asks for a name and a phone; the receipt goes to the owner's email.
      billing_data: { first_name: 'Tablix', last_name: 'Customer', email: ctx.user.email || 'na@example.com', phone_number: 'NA', country: 'EG' },
      special_reference: id,
      notification_url: `${site}/api/pay/webhook`,
      redirection_url: `${site}/?paid=1`,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.client_secret) {
    await env.DB.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").bind(id).run();
    throw new ApiError(`payment error: ${res.status}`, '502', 502);
  }
  return { url: `${API}/unifiedcheckout/?publicKey=${encodeURIComponent(env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(out.client_secret)}`, amount, months };
}

// Paymob's signature on a transaction: HMAC-SHA512 over these fields' values, in this order.
const FIELDS = ['amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
  'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan',
  'source_data.sub_type', 'source_data.type', 'success'];
const pick = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
export async function paymobHmac(obj, key) {
  const text = FIELDS.map((f) => { const v = pick(obj, f); return v === undefined || v === null ? '' : String(v); }).join('');
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function payWebhook(env, req, url, { today } = {}) {
  if (!payReady(env)) throw new ApiError('payments not configured', '501', 501);
  const b = await req.json().catch(() => null);
  const obj = b?.obj;
  if (!obj || b.type !== 'TRANSACTION') return { ignored: true };
  const given = String(url.searchParams.get('hmac') || '').toLowerCase();
  if (!given || !same(given, await paymobHmac(obj, env.PAYMOB_HMAC))) throw new ApiError('bad signature', '401', 401);
  const id = obj.order?.merchant_order_id || obj.special_reference || obj.payment_key_claims?.extra?.special_reference;
  const p = id ? await one(env, 'SELECT * FROM payments WHERE id = ?', String(id)) : null;
  if (!p) return { ignored: true };
  const ok = obj.success === true && obj.pending === false && obj.is_voided !== true && obj.is_refunded !== true && obj.currency === 'EGP' && +obj.amount_cents === +p.amount_cents;
  if (!ok) {
    if (obj.pending !== true) await env.DB.prepare("UPDATE payments SET status = 'failed', paymob_id = ? WHERE id = ? AND status = 'pending'").bind(String(obj.id ?? ''), p.id).run();
    return { paid: false };
  }
  // Once only: a second message about the same payment changes nothing.
  const r = await env.DB.prepare("UPDATE payments SET status = 'paid', paymob_id = ?, paid_at = ? WHERE id = ? AND status IN ('pending', 'failed')").bind(String(obj.id ?? ''), nowIso(), p.id).run();
  if (!r.meta?.changes) return { paid: true, again: true };
  // The months start after what is already paid, or after the free trial still running, else today. A
  // suspended pharmacy stays suspended (the admin decides); the months are still added.
  const sub = await one(env, 'SELECT status, trial_ends, paid_until FROM subscriptions WHERE pharmacy_id = ?', p.pharmacy_id);
  const from = sub?.status === 'trial' ? sub.trial_ends : sub?.paid_until;
  const until = extendPaid(from || null, p.months, today);
  await env.DB.prepare(`INSERT INTO subscriptions (pharmacy_id, status, paid_until, note, updated_at) VALUES (?, 'active', ?, ?, ?)
    ON CONFLICT(pharmacy_id) DO UPDATE SET status = CASE WHEN subscriptions.status = 'suspended' THEN 'suspended' ELSE 'active' END,
      paid_until = excluded.paid_until, updated_at = excluded.updated_at`)
    .bind(p.pharmacy_id, until, 'Paymob', nowIso()).run();
  return { paid: true, until };
}
