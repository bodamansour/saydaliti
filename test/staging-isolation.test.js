// Staging can never bind to production: different Worker, database and bucket, and the staging
// workflow uses only staging credentials and only --env staging for anything remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
const [prod, stagingPart] = toml.split(/^\[env\.staging\]\s*$/m);
const val = (src, key) => [...src.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'gm'))].map((m) => m[1]);
const PROD = { name: 'saydaliti', db: '3cf7edd2-1642-428b-bf1b-973f71d93529', bucket: 'saydaliti-files' };

test('production bindings are unchanged', () => {
  assert.equal(val(prod, 'name')[0], PROD.name);
  assert.deepEqual(val(prod, 'database_id'), [PROD.db]);
  assert.deepEqual(val(prod, 'bucket_name'), [PROD.bucket]);
});

test('staging has its own Worker, database and bucket — none of them production\'s', () => {
  assert.ok(stagingPart, 'an [env.staging] section');
  assert.equal(val(stagingPart, 'name')[0], 'saydaliti-staging');
  const ids = val(stagingPart, 'database_id'), buckets = val(stagingPart, 'bucket_name');
  assert.deepEqual(ids, ['0ba7c0dd-645e-453e-9999-a316a828e175']);
  assert.deepEqual(buckets, ['saydaliti-files-staging']);
  assert.ok(!stagingPart.includes(PROD.db) && !buckets.includes(PROD.bucket));
  assert.doesNotMatch(stagingPart, /^\s*(routes|route)\s*=/m, 'no custom routes');
  assert.match(val(stagingPart, 'SITE_URL')[0], /saydaliti-staging\./);
  // Every binding production has, staging defines itself (wrangler does not inherit these per environment).
  assert.match(stagingPart, /\[\[env\.staging\.d1_databases\]\][\s\S]*binding = "DB"/);
  assert.match(stagingPart, /\[\[env\.staging\.r2_buckets\]\][\s\S]*binding = "FILES"/);
});

test('the staging workflow uses only staging credentials and only --env staging remotely', () => {
  const wf = readFileSync(new URL('../.github/workflows/staging.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /secrets\.CLOUDFLARE_API_TOKEN\b|secrets\.CLOUDFLARE_ACCOUNT_ID\b/, 'not the production token');
  assert.match(wf, /secrets\.CLOUDFLARE_STAGING_API_TOKEN/);
  for (const line of wf.split('\n').filter((l) => /wrangler (deploy|d1 |r2 |secret)/.test(l))) assert.match(line, /--env staging/, `remote command without --env staging: ${line.trim()}`);
  assert.doesNotMatch(wf, /saydaliti-files[^-]|3cf7edd2/, 'no production resource named');
  assert.doesNotMatch(wf, /^\s{2}(pull_request|schedule):/m);
});
