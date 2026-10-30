// «اسأل صيدليتي» with an AI model: POST /api/ai {pharmacy, messages, tools}.
// The model never touches the database. It gets the conversation and the list of tools the page may
// run for this user; when it wants numbers it asks for a tool, the page runs it locally (the same
// tested calculations as the screens) and sends back the result. Off unless the server has an
// ANTHROPIC_API_KEY secret. Owners and partners only, a limit per user per hour, and the system
// prompt (rules: only numbers from tools, no medical advice) is fixed here, not sent by the page.
import { ApiError } from './db.js';

const SYSTEM = `أنت «اسأل صيدليتي»، مساعد لصاحب صيدلية في مصر. بترد بالعامية المصرية (أو بالإنجليزي لو السؤال إنجليزي)، باختصار.
قواعد لازم تمشي عليها:
- أي رقم (مبيعات، ربح، رصيد، صلاحية…) لازم ييجي من أداة. ما تخمنش ولا تألف أرقام. لو مفيش أداة تجاوب، قول كده.
- قول الفترة اللي الأرقام بتغطيها، وفرّق بين الرقم الفعلي والتوقع.
- ما تشخصش أمراض، ما توصفش أدوية، وما تحلش محل الصيدلي. لو السؤال طبي، قول إن ده مش دورك.
- ما تتهمش أي موظف. الأرقام الغريبة بتتعرض كحاجة تستاهل نظرة بس.
- أي حاجة بتغيّر بيانات (طلبية، تعديل سعر أو رصيد) بتبقى مسودة، وصاحب الصيدلية هو اللي يوافق عليها من الشاشة.`;

const LIMIT_PER_HOUR = 60;
const MAX_TURNS = 12;

const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

export async function aiChat(env, ctx, req, { fetchImpl = fetch } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new ApiError('ai not configured', '501', 501);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.pharmacy !== 'string' || !Array.isArray(b.messages) || !Array.isArray(b.tools)) throw new ApiError('bad request', '400', 400);
  const role = ctx.roles.get(b.pharmacy);
  if (!['owner', 'partner'].includes(role)) throw new ApiError('not allowed', '42501', 403);
  if (b.messages.length > MAX_TURNS * 2 || JSON.stringify(b.messages).length > 60000 || b.tools.length > 30) throw new ApiError('too large', '413', 413);
  // At most LIMIT_PER_HOUR model calls per user per hour (the tool round trips count too).
  const k = `ai:${ctx.user.id}`;
  const since = new Date(Date.now() - 3600000).toISOString();
  const n = (await all(env, 'SELECT COUNT(*) AS n FROM auth_attempts WHERE k = ? AND at > ?', k, since))[0]?.n || 0;
  if (n >= LIMIT_PER_HOUR) throw new ApiError('too many requests', '429', 429);
  await run(env, 'INSERT INTO auth_attempts (k, at) VALUES (?, ?)', k, new Date().toISOString());
  // Only plain tool definitions go to the model (name, description, input schema).
  const tools = b.tools.map((t) => ({ name: String(t.name).slice(0, 64), description: String(t.description || '').slice(0, 500), input_schema: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} } }));
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system: SYSTEM, tools, messages: b.messages }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(`ai error: ${out?.error?.message || res.status}`, '502', 502);
  return { content: out.content || [], stop_reason: out.stop_reason || null };
}

// Reading a supplier's invoice from a photo or PDF: POST /api/ai/invoice {pharmacy, media_type, data}.
// The model only reads what is printed; the page matches the lines to items and shows them in
// «طلبية وصلت» for the owner to check and save. Nothing is recorded from here.
const INVOICE_PROMPT = `دي صورة فاتورة مورد أدوية في مصر. اقرا المكتوب بس، ومتخمنش أي رقم مش واضح (سيبه null).
رجّع JSON بس، من غير أي كلام قبله أو بعده، بالشكل ده:
{"supplier": string|null, "invoice_no": string|null, "date": "YYYY-MM-DD"|null, "lines": [{"name": string, "qty": number|null, "bonus": number|null, "cost": number|null, "price": number|null, "expiry": "YYYY-MM"|null}], "total": number|null}
cost = سعر الشراء للعلبة الواحدة، price = سعر الجمهور لو مكتوب.`;
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export async function aiInvoice(env, ctx, req, { fetchImpl = fetch } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new ApiError('ai not configured', '501', 501);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.pharmacy !== 'string' || !MEDIA.has(b.media_type) || typeof b.data !== 'string') throw new ApiError('bad request', '400', 400);
  if (ctx.roles.get(b.pharmacy) !== 'owner') throw new ApiError('not allowed', '42501', 403);
  if (b.data.length > 7_000_000) throw new ApiError('file too large', '413', 413);
  const k = `ai:${ctx.user.id}`;
  const n = (await all(env, 'SELECT COUNT(*) AS n FROM auth_attempts WHERE k = ? AND at > ?', k, new Date(Date.now() - 3600000).toISOString()))[0]?.n || 0;
  if (n >= LIMIT_PER_HOUR) throw new ApiError('too many requests', '429', 429);
  await run(env, 'INSERT INTO auth_attempts (k, at) VALUES (?, ?)', k, new Date().toISOString());
  const part = b.media_type === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: b.media_type, data: b.data } } : { type: 'image', source: { type: 'base64', media_type: b.media_type, data: b.data } };
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 4000, messages: [{ role: 'user', content: [part, { type: 'text', text: INVOICE_PROMPT }] }] }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(`ai error: ${out?.error?.message || res.status}`, '502', 502);
  const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let inv;
  try { inv = JSON.parse(m ? m[0] : text); } catch { throw new ApiError('could not read the invoice', '422', 422); }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? v : null);
  const str = (v, n = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return {
    supplier: str(inv.supplier, 120), invoice_no: str(inv.invoice_no, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(inv.date || '') ? inv.date : null, total: num(inv.total),
    lines: (Array.isArray(inv.lines) ? inv.lines : []).slice(0, 300).map((l) => ({ name: str(l?.name) || '', qty: num(l?.qty), bonus: num(l?.bonus), cost: num(l?.cost), price: num(l?.price), expiry: /^\d{4}-\d{2}$/.test(l?.expiry || '') ? l.expiry : null })).filter((l) => l.name),
  };
}
