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

test('the staging workflow: staging credentials only, protected, guarded, never from a pull request', () => {
  const wf = readFileSync(new URL('../.github/workflows/staging.yml', import.meta.url), 'utf8');
  // Never the production token or account, not even as a fallback (`||`).
  assert.doesNotMatch(wf, /CLOUDFLARE_API_TOKEN\s*\}\}|secrets\.CLOUDFLARE_API_TOKEN\b|secrets\.CLOUDFLARE_ACCOUNT_ID\b|vars\.CLOUDFLARE_ACCOUNT_ID\b/, 'not the production token');
  assert.doesNotMatch(wf, /\|\|\s*secrets\./, 'no secret fallbacks');
  assert.equal([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).filter((n) => !['CLOUDFLARE_STAGING_API_TOKEN', 'STAGING_BACKUP_KEY'].includes(n)).length, 0, 'only the staging secrets');
  assert.match(wf, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_STAGING_API_TOKEN \}\}/);
  // Triggers: by hand (typed confirmation) or the request file on the working branch. Nothing else.
  const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort(), ['push', 'workflow_dispatch']);
  assert.match(on, /paths: \['\.github\/staging-run'\]/);
  assert.doesNotMatch(wf, /pull_request|workflow_run|schedule:|repository_dispatch/);
  assert.match(wf, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(wf, /contents: write|id-token: write/);
  // The preflight job has no secrets; the deploy job needs it, is owner-only, and runs in the protected environment.
  const pre = wf.slice(wf.indexOf('\n  preflight:'), wf.indexOf('\n  deploy:'));
  const dep = wf.slice(wf.indexOf('\n  deploy:'));
  assert.doesNotMatch(pre, /secrets\./);
  assert.match(dep, /needs: preflight/);
  assert.match(dep, /environment: staging/);
  assert.match(dep, /if: github\.event_name == 'workflow_dispatch' && github\.actor == github\.repository_owner && \(github\.ref == 'refs\/heads\/ccr-94719aa6-7k3i5e' \|\| github\.ref == 'refs\/heads\/main'\)/);
  assert.ok(dep.indexOf('$GUARD remote') > 0 && dep.indexOf('$GUARD remote') < dep.indexOf('migrations apply'), 'the remote check comes before any write');
  // Every wrangler call goes through the guard; no direct `wrangler` / `npx wrangler` in the workflow.
  assert.doesNotMatch(wf, /npx wrangler|^\s*wrangler /m);
  for (const line of wf.split('\n').filter((l) => /\b(deploy|d1 |r2 |secret (put|list))\b/.test(l) && /\$GUARD/.test(l))) assert.match(line, /\$GUARD run -- /, line.trim());
  assert.doesNotMatch(wf.replace(/^\s*#.*$/gm, ''), /--env\b/, 'the guard alone chooses the environment');
  assert.doesNotMatch(wf, /saydaliti-files[^-]|3cf7edd2|saydaliti\.mosaedapp/, 'no production resource named');
  assert.doesNotMatch(wf, /api\.cloudflare\.com/, 'Cloudflare API calls only through the guard');
  // Untrusted input is never pasted into a shell line.
  assert.doesNotMatch(wf, /run:.*\$\{\{\s*(inputs|github\.event)\./);
  assert.match(wf, /persist-credentials: false/);
});
