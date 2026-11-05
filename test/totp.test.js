import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32, unbase32, totpAt, checkTotp, newSecret, otpauthUrl, newRecoveryCodes, normRecovery } from '../worker/src/totp.js';

// RFC 6238 appendix B: the SHA-1 secret "12345678901234567890", last 6 digits of the 8-digit values.
const RFC = base32(new TextEncoder().encode('12345678901234567890'));
test('TOTP matches the RFC 6238 test vectors', async () => {
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(await totpAt(RFC, Math.floor(t / 30)), code, `t=${t}`);
  }
});

test('base32 round trip; a code works once, within one step of the clock', async () => {
  const s = newSecret();
  assert.equal(s.length, 32);
  assert.deepEqual([...unbase32(base32(new Uint8Array([1, 2, 3, 250])))], [1, 2, 3, 250]);
  const now = 1_800_000_000_000, step = Math.floor(now / 30000);
  const code = await totpAt(s, step);
  assert.equal(await checkTotp(s, code, now), step);
  assert.equal(await checkTotp(s, code, now + 30000), step, 'one step late is accepted');
  assert.equal(await checkTotp(s, code, now + 90000), null, 'too late');
  assert.equal(await checkTotp(s, code, now, step), null, 'the same code twice');
  assert.equal(await checkTotp(s, '12345', now), null);
  assert.match(otpauthUrl(s, 'a@b.co'), /^otpauth:\/\/totp\/Saydaliti%3Aa%40b\.co\?secret=[A-Z2-7]{32}&issuer=Saydaliti/);
  const rc = newRecoveryCodes();
  assert.equal(rc.length, 8); assert.match(rc[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(normRecovery(' ABCDE-fghjk '), 'abcdefghjk');
});
