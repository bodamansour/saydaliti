// Tablix Pharma on Cloudflare: one Worker serves the app's pages (static assets), the data API on D1,
// sign-in, uploads (kept in R2), and the daily WhatsApp jobs. Replaces Vercel + Supabase.
//   GET  /api/config                → tells the pages to use this server
//   POST /api/auth/{signup,signin,signout,password}, GET /api/auth/user
//   POST /api/db                    → { op, table, cols, filters, order, range, limit, rows, patch, ignoreDuplicates }
//   POST /api/rpc/<name>            → the database functions
//   POST /rest/v1/rpc/upload_snapshot (the pharmacy connector, same address shape as before)
import { ApiError, select, insert, update, remove } from './db.js';
import { signUp, signIn, signOut, userOf, changePassword, sessionCookie, clearCookie, mfaSetup, mfaEnable, mfaDisable, forgotPassword, resetPassword, emailReady, mfaOf, tooMany, note } from './auth.js';
import { RPC, rpcNamed, checkPosSale, reportFeed, remindersFeed, markRemindersSent, storeSnapshotText, branchOf } from './rpc.js';
import { requireRole } from './db.js';
import { aiChat, aiInvoice } from './ai.js';
import { payStart, payWebhook, payReady } from './pay.js';
import { googleStart, googleCallback, googleReady } from './google.js';
import { backupAll } from './backup.js';
import { sealAll, sealBudget } from './audit-seal.js';
import { isolateEnv, guardedFetch } from './egress.js';
import { runMorning } from '../../src/morning-job.js';
import { runReminders } from '../../src/reminders-job.js';

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // API answers are data, never a page: nothing in them may run or be framed.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY },
});
// A new sign-in: the token goes in the HttpOnly cookie, and in the answer only when asked for
// (X-Want-Token: 1: scripts and tests; the app never asks).
const signedIn = (req, data) => {
  if (!data?.access_token) return json({ data, error: null });
  const { access_token, ...rest } = data;
  const r = json({ data: req.headers.get('X-Want-Token') === '1' ? data : rest, error: null });
  r.headers.append('Set-Cookie', sessionCookie(access_token, data.expires_at));
  return r;
};
const fail = (e) => {
  if (e instanceof ApiError) return json({ data: null, error: { message: e.message, code: e.code } }, e.status);
  console.error(e);
  return json({ data: null, error: { message: 'server error', code: '500' } }, 500);
};

async function contextOf(env, req) {
  const user = await userOf(env, req);
  const roles = new Map();
  const branchScopes = new Map(), mainBranches = new Map();
  if (user) for (const m of (await env.DB.prepare(`SELECT pharmacy_id, role, branch_ids,
    (SELECT id FROM branches WHERE pharmacy_id = members.pharmacy_id ORDER BY created_at, id LIMIT 1) AS main_branch_id
    FROM members WHERE user_id = ?`).bind(user.id).all()).results) {
    roles.set(m.pharmacy_id, m.role);
    try { const ids = JSON.parse(m.branch_ids || '[]'); branchScopes.set(m.pharmacy_id, Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []); } catch { branchScopes.set(m.pharmacy_id, []); }
    mainBranches.set(m.pharmacy_id, m.main_branch_id ?? null);
  }
  return { user, roles, branchScopes, mainBranches };
}
async function body(req, max = 25 * 1024 * 1024) {
  const n = +(req.headers.get('Content-Length') || 0);
  if (n > max) throw new ApiError('request too large', '413', 413);
  try { return await req.json(); } catch { throw new ApiError('bad json', 'PGRST102'); }
}

// Rows as JSON; uploaded data read from R2 is put in as it is, without parsing it here.
function rowsJson(rows, blob) {
  if (!blob) return JSON.stringify({ data: rows, error: null });
  const parts = rows.map((r, i) => {
    const s = JSON.stringify(r);
    return `${s.slice(0, -1)}${s.length > 2 ? ',' : ''}${JSON.stringify(blob.col)}:${blob.raws[i]}}`;
  });
  return `{"data":[${parts.join(',')}],"error":null}`;
}

async function api(req, env, url, ctx) {
  const path = url.pathname;
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (path === '/api/config') return json({ configured: true, backend: 'cloudflare' });
  if (path.startsWith('/api/auth/')) {
    const what = path.slice('/api/auth/'.length);
    // Every change here comes from the app itself: JSON with the app's header. A form on another site can
    // send neither (a custom header needs CORS, which this server never allows), so it can't sign someone
    // in to another account (login CSRF), sign them out, or start a password reset in their name.
    if (req.method !== 'GET' && req.method !== 'HEAD' && (req.headers.get('X-Saydaliti') !== '1' || !/^application\/json\b/i.test(req.headers.get('Content-Type') || ''))) {
      throw new ApiError('request refused', 'csrf', 403);
    }
    if (what === 'user') { const u = await userOf(env, req); return json({ data: { user: u ? { id: u.id, email: u.email, mfa: await mfaOf(env, u.id) } : null, expires_at: u?.expires_at ?? null, email: emailReady(env), google: googleReady(env) }, error: null }); }
    // Sign in with Google: two GET steps (a redirect to Google and back), see google.js.
    if (what === 'google/start' && req.method === 'GET') return googleStart(env, url);
    if (what === 'google/callback' && req.method === 'GET') return googleCallback(env, req, url, { fetchImpl: guardedFetch(env), ip, tooMany, note });
    // Local development and tests only: the last email written for an address.
    // Only on a development machine: EMAIL_OUTBOX=dev and a request to localhost itself. Never in production
    // (the release refuses EMAIL_OUTBOX, and a public address never matches).
    if (what === 'dev-outbox' && env.EMAIL_OUTBOX === 'dev' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return json({ data: await env.DB.prepare('SELECT subject, body FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1').bind(String(url.searchParams.get('email') || '').toLowerCase()).first(), error: null });
    if (req.method !== 'POST') throw new ApiError('method not allowed', '405', 405);
    if (what === 'signup') return signedIn(req, await signUp(env, await body(req, 10000), ip));
    if (what === 'signin') return signedIn(req, await signIn(env, await body(req, 10000), ip));
    if (what === 'signout') { const u = await userOf(env, req).catch(() => null); await signOut(env, u?.token); const r = json({ data: null, error: null }); r.headers.append('Set-Cookie', clearCookie()); return r; }
    // An app that still keeps its token in the page's storage (from before the cookie): the same session moves into the cookie.
    if (what === 'adopt') { const u = await userOf(env, req); if (!u || u.via !== 'bearer') throw new ApiError('not signed in', '42501', 401); return signedIn(req, { access_token: u.token, expires_at: u.expires_at, user: { id: u.id, email: u.email } }); }
    if (what === 'forgot') return json({ data: await forgotPassword(env, await body(req, 10000), ip, url.origin, ctx?.waitUntil ? (p) => ctx.waitUntil(p) : null), error: null });
    if (what === 'reset') return signedIn(req, await resetPassword(env, await body(req, 10000), ip));
    if (what.startsWith('mfa/')) {
      const u = await userOf(env, req); if (!u) throw new ApiError('not signed in', '42501', 401);
      const f = { 'mfa/setup': mfaSetup, 'mfa/enable': mfaEnable, 'mfa/disable': mfaDisable }[what];
      if (!f) throw new ApiError('not found', '404', 404);
      return json({ data: await f(env, u, await body(req, 10000), ip), error: null });
    }
    if (what === 'password') { const u = await userOf(env, req); if (!u) throw new ApiError('not signed in', '42501', 401); return signedIn(req, await changePassword(env, u, await body(req, 10000), ip)); }
    throw new ApiError('not found', '404', 404);
  }
  if (path === '/api/ai/status') return json({ data: { enabled: !!env.ANTHROPIC_API_KEY }, error: null });
  if (path === '/api/pay/status') return json({ data: { enabled: payReady(env) }, error: null });
  // An item's photo (R2: images/<pharmacy>/<code>): anyone in the pharmacy reads it; the owner and the
  // stock manager put a small picture (made small on the device, at most 300 KB).
  if (path === '/api/item-image') {
    const ctx = await contextOf(env, req);
    const p = url.searchParams.get('pharmacy') || '', code = url.searchParams.get('code') || '';
    if (!/^[\w-]{1,80}$/.test(p) || !code || code.length > 60) throw new ApiError('bad request', '400', 400);
    const k = `images/${p}/${encodeURIComponent(code)}`;
    if (req.method === 'GET') {
      requireRole(ctx, p, ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock']);
      const obj = await env.FILES.get(k);
      if (!obj) throw new ApiError('not found', '404', 404);
      return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...SECURITY } });
    }
    requireRole(ctx, p, ['owner', 'stock']);
    if (req.method === 'DELETE') { await env.FILES.delete(k); return json({ data: null, error: null }); }
    if (req.method !== 'POST') throw new ApiError('method not allowed', '405', 405);
    const type = req.headers.get('Content-Type') || '';
    if (!['image/jpeg', 'image/webp', 'image/png'].includes(type)) throw new ApiError('bad image', '400', 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 300 * 1024) throw new ApiError('image too large', '413', 413);
    await env.FILES.put(k, buf, { httpMetadata: { contentType: type } });
    return json({ data: null, error: null });
  }
  if (req.method !== 'POST') throw new ApiError('method not allowed', '405', 405);
  // The AI calls go through guardedFetch: refused on staging (egress.js), the real fetch on production.
  if (path === '/api/ai') return json({ data: await aiChat(env, await contextOf(env, req), req, { fetchImpl: guardedFetch(env) }), error: null });
  // Subscription payments (Paymob): the checkout goes out through guardedFetch (refused on staging); the
  // webhook is Paymob's signed message, so it needs no sign-in.
  if (path === '/api/pay/start') return json({ data: await payStart(env, await contextOf(env, req), await body(req, 10000), { fetchImpl: guardedFetch(env), site: (env.SITE_URL || url.origin).replace(/\/$/, '') }), error: null });
  if (path === '/api/pay/webhook') return json({ data: await payWebhook(env, req, url), error: null });
  if (path === '/api/ai/invoice') return json({ data: await aiInvoice(env, await contextOf(env, req), req, { fetchImpl: guardedFetch(env) }), error: null });
  if (path === '/api/db') {
    const q = await body(req);
    const ctx = await contextOf(env, req);
    if (q.op === 'select') { const r = await select(ctx, env, q); return json(rowsJson(r.rows, r.blob)); }
    if (q.op === 'insert' || q.op === 'upsert') {
      await insert(ctx, env, q, { beforeInsert: async (table, row) => {
        if (table === 'pos_sales') return checkPosSale(ctx, env, row);
        // The cashier device records only money taken out of the drawer; other expenses are the owner's.
        if (table === 'expenses' && !['owner', 'accountant'].includes(ctx.roles.get(row.pharmacy_id)) && row.kind !== 'withdrawal') throw new ApiError('not allowed', '42501', 403);
        // Treasury moves: only a correction may be negative; a count, a trip to the bank and back are amounts.
        if (table === 'cash_moves' && row.kind !== 'adjust' && !(+row.amount >= 0)) throw new ApiError('amount must not be negative', '23514');
      } });
      return json({ data: null, error: null }, 201);
    }
    if (q.op === 'update') { await update(ctx, env, q); return json({ data: null, error: null }); }
    if (q.op === 'delete') { await remove(ctx, env, q); return json({ data: null, error: null }); }
    throw new ApiError('bad op');
  }
  // An upload from the app: the data is the body, as text (not parsed here, see storeSnapshotText).
  //   POST /api/snapshot?pharmacy=<id>&branch=<id>&items=<count>&at=<time>
  if (path === '/api/snapshot') {
    const ctx = await contextOf(env, req);
    const p = url.searchParams.get('pharmacy');
    requireRole(ctx, p, ['owner']);
    if (+(req.headers.get('Content-Length') || 0) > 20 * 1024 * 1024) throw new ApiError('snapshot too large', '413', 413);
    const id = await storeSnapshotText(env, p, await branchOf(env, p, url.searchParams.get('branch') || null), ctx.user.id, await req.text(), url.searchParams.get('items'), url.searchParams.get('at'));
    return json({ data: id, error: null });
  }
  // The connector sends {"p_token":"…","p_data":<the data>}: the data is taken out as text.
  if (/^\/(?:api\/rpc|rest\/v1\/rpc)\/upload_snapshot$/.test(path)) {
    const text = await req.text();
    const head = /^\s*\{\s*"p_token"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"p_data"\s*:/.exec(text.slice(0, 400));
    const args = head ? { p_token: JSON.parse(head[1]), p_data_text: text.slice(head[0].length, text.lastIndexOf('}')) } : JSON.parse(text);
    return json({ data: await RPC.upload_snapshot(env, { user: null, roles: new Map() }, args), error: null });
  }
  const m = /^\/(?:api\/rpc|rest\/v1\/rpc)\/([a-z_]+)$/.exec(path);
  if (m) {
    const fn = rpcNamed(m[1]); // own functions only (never `constructor` and the like)
    if (!fn) throw new ApiError(`Could not find the function public.${m[1]} in the schema cache`, 'PGRST202', 404);
    const ctx = await contextOf(env, req);
    return json({ data: await fn(env, ctx, await body(req)), error: null });
  }
  throw new ApiError('not found', '404', 404);
}

// The morning report and patient reminders run here; their database calls are answered directly.
function internalFetch(env) {
  return async (u, init) => {
    if (String(u).startsWith('internal://')) {
      const name = String(u).split('/rpc/')[1];
      const args = JSON.parse(init?.body || '{}');
      const data = name === 'report_feed' ? await reportFeed(env) : name === 'reminders_feed' ? await remindersFeed(env)
        : name === 'mark_reminders_sent' ? await markRemindersSent(env, args.p_items) : null;
      return new Response(JSON.stringify(data), { status: 200 });
    }
    return guardedFetch(env)(u, init);
  };
}
const jobEnv = (env) => ({ ...env, SUPABASE_URL: 'internal://db', SUPABASE_PUBLISHABLE_KEY: 'internal', REPORT_SECRET: 'internal' });

export default {
  async fetch(req, env, ctx) {
    env = isolateEnv(env); // staging: only allowlisted keys, and no request leaves the Worker (egress.js)
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) {
      try { return await api(req, env, url, ctx); } catch (e) { return fail(e); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    env = isolateEnv(env); // staging: only allowlisted keys, and no request leaves the Worker (egress.js)
    const e = jobEnv(env);
    // The daily encrypted backups (only with the BACKUP_KEY secret set; see backup.js).
    if (event.cron === env.BACKUP_CRON) { ctx.waitUntil(backupAll(env).then((r) => console.log('backups', JSON.stringify(r)))); return; }
    if (event.cron === env.MORNING_CRON) ctx.waitUntil(runMorning({ env: e, fetchFn: internalFetch(env) }).then((r) => console.log('morning', JSON.stringify(r))));
    else {
      ctx.waitUntil(runReminders({ env: e, fetchFn: internalFetch(env) }).then((r) => console.log('reminders', JSON.stringify(r))));
      // The log's fingerprints, every hour in their own run (never in the backup run, so a long first seal
      // can't stop the backups), in a bounded batch: a long log is sealed over several hours.
      ctx.waitUntil(sealAll(env, { budget: sealBudget(env) }).then((r) => console.log('audit seals', JSON.stringify(r))).catch((err) => console.error('AUDIT_SEAL_FAILED', err?.message)));
    }
  },
};
