// Staging can never reach real outside services (WhatsApp messages to patients, the AI provider), even if a
// credential for one were set on the staging Worker by mistake.
//
// A Worker counts as staging if EITHER signal says so (two independent signals, so one missing var can't turn
// the protection off): the DEPLOY_ENV var is "staging", or its SITE_URL is the staging workers.dev address.
// On staging:
//   - isolateEnv() removes every credential for an outside service from the env the code sees, so the morning
//     report, patient reminders and AI features report "not configured" and send nothing;
//   - guardedFetch() refuses every outbound request the scheduled jobs make (only internal:// calls, answered by
//     the Worker itself, are allowed).
// Production (neither signal) is unchanged: the same env object and the real fetch are used.
export const OUTSIDE_SERVICE_SECRETS = Object.freeze([
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TEMPLATE', 'WHATSAPP_DOSE_TEMPLATE', 'WHATSAPP_REFILL_TEMPLATE',
  'ANTHROPIC_API_KEY', 'AI_MODEL',
]);

export function isStaging(env) {
  return env?.DEPLOY_ENV === 'staging' || /^https:\/\/saydaliti-staging\./.test(String(env?.SITE_URL || ''));
}

export function isolateEnv(env) {
  if (!isStaging(env)) return env;
  const out = { ...env };
  for (const k of OUTSIDE_SERVICE_SECRETS) delete out[k];
  return out;
}

export function guardedFetch(env, fetchImpl = (u, init) => fetch(u, init)) {
  return async (u, init) => {
    if (isStaging(env)) {
      console.log('staging: outbound request refused', JSON.stringify({ host: (() => { try { return new URL(String(u)).host; } catch { return '?'; } })() }));
      return new Response(JSON.stringify({ error: 'staging: outbound requests are disabled' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return fetchImpl(u, init);
  };
}
