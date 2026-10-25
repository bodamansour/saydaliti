import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore, arabicError } from '../src/supabase-store.js';

function fakeClient(rpcResult) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => { calls.push([fn, args]); return rpcResult(fn, args); },
  };
}

test('clock maps the database reply', async () => {
  const c = fakeClient(() => ({ data: [{ employee_name: 'سارة', action: 'in', at: '2026-10-25T07:03:00Z' }], error: null }));
  const r = await createSupabaseStore(c, 'p1').clock(1234);
  assert.deepEqual([r.name, r.action, r.at.toISOString()], ['سارة', 'in', '2026-10-25T07:03:00.000Z']);
  assert.deepEqual(c.calls[0], ['clock', { p_pharmacy: 'p1', p_pin: '1234' }]);
});

test('database errors become clear Arabic messages', async () => {
  const c = fakeClient(() => ({ data: null, error: { message: 'wrong pin' } }));
  await assert.rejects(createSupabaseStore(c, 'p1').clock('0000'), /الكود غلط/);
  assert.match(arabicError({ message: 'PIN already used' }).message, /مستخدم/);
  assert.match(arabicError({ message: 'TypeError: Failed to fetch' }).message, /مفيش اتصال/);
  assert.match(arabicError({ message: 'weird internal thing' }).message, /حصلت مشكلة/);
});
