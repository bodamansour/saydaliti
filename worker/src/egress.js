// Staging can never reach the internet: no WhatsApp message to a patient, no AI call, nothing else — from the
// scheduled jobs or from ordinary requests, even if a credential for an outside service were set on the staging
// Worker by mistake.
//
// A Worker counts as staging if EITHER signal says so (two independent signals, so one missing var can't turn
// the protection off): the DEPLOY_ENV var is "staging", or its SITE_URL is the staging workers.dev address.
// On staging, isolateEnv():
//   1. returns a copy of env holding ONLY the keys in STAGING_ENV_ALLOWLIST (bindings, plain settings and the
//      staging-only secrets). Any other key — a known outside-service credential or one with a new name — never
//      reaches the code;
//   2. replaces the global fetch of this Worker's isolate with one that refuses every request (STAGING_FETCH).
//      A Workers isolate runs one script only, so this never touches the production Worker. Bindings (D1, R2,
//      ASSETS) are not affected: they are objects on env, not the global fetch.
// guardedFetch() refuses every outbound request on staging; the scheduled jobs and the AI routes get it
// explicitly, so they are refused even without (2).
// Production (neither signal) is unchanged: the same env object and the real global fetch are used.

// Every key the Worker code needs on staging. test/staging-egress.test.js fails if the code reads a key that is in
// neither this list nor OUTSIDE_SERVICE_SECRETS, so this list can't silently drop something the app needs.
export const STAGING_ENV_ALLOWLIST = Object.freeze([
  // bindings
  'DB', 'FILES', 'ASSETS',
  // plain settings (wrangler.toml [env.staging.vars])
  'DEPLOY_ENV', 'SITE_URL', 'MORNING_CRON', 'BACKUP_CRON', 'PBKDF2_ITER', 'SIGNUP_PER_HOUR', 'SEAL_BUDGET', 'VERIFY_MAX_ROWS',
  // staging-only secrets set by .github/workflows/staging.yml (BACKUP_KEYS_OLD: key rotation, worker/src/backup.js)
  'PIN_PEPPER', 'PIN_PEPPER_OLD', 'BACKUP_KEY', 'BACKUP_KEYS_OLD', 'TOTP_KEY', 'TOTP_KEY_OLD', 'AUDIT_SEAL_KEY', 'AUDIT_SEAL_KEY_OLD',
]);

// Credentials for real outside services that the code knows about. They are not on the allowlist (so they are
// removed); the list is kept because the staging guard refuses them in the staging config, and a test keeps the
// two lists equal.
export const OUTSIDE_SERVICE_SECRETS = Object.freeze([
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TEMPLATE', 'WHATSAPP_DOSE_TEMPLATE', 'WHATSAPP_REFILL_TEMPLATE',
  'ANTHROPIC_API_KEY', 'AI_MODEL',
  // forgotten-password emails (Resend); EMAIL_OUTBOX=dev keeps them in the database on a development machine
  'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_OUTBOX',
]);

export function isStaging(env) {
  return env?.DEPLOY_ENV === 'staging' || /^https:\/\/saydaliti-staging\./.test(String(env?.SITE_URL || ''));
}

const hostOf = (u) => { try { return new URL(String(u instanceof Request ? u.url : u)).host; } catch { return '?'; } };
const refused = (u) => {
  console.log('staging: outbound request refused', JSON.stringify({ host: hostOf(u) }));
  return new Response(JSON.stringify({ error: 'staging: outbound requests are disabled' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
};

// The global fetch used inside a staging Worker. It never calls the real fetch.
export const STAGING_FETCH = async (u) => refused(u);

export function isolateEnv(env) {
  if (!isStaging(env)) return env;
  // Re-installed whenever something replaced it (idempotent; tests restore the real fetch between cases).
  if (globalThis.fetch !== STAGING_FETCH) globalThis.fetch = STAGING_FETCH;
  const out = {};
  for (const k of STAGING_ENV_ALLOWLIST) if (k in env) out[k] = env[k];
  return out;
}

export function guardedFetch(env, fetchImpl = (u, init) => fetch(u, init)) {
  return async (u, init) => (isStaging(env) ? refused(u) : fetchImpl(u, init));
}
