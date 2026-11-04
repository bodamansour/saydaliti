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
  // Only the Phase 2 branch until PR #51 is merged (main's code would run the reminders on the staging cron).
  assert.match(dep, /^ {4}if: github\.event_name == 'workflow_dispatch' && github\.actor == github\.repository_owner && github\.ref == 'refs\/heads\/ccr-94719aa6-7k3i5e'\n/m);
  assert.doesNotMatch(dep.split('\n').find((l) => /^ {4}if:/.test(l)), /main|\|\||\*|startsWith|contains/, 'no broader branch list');
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

// ---------- secret scoping in the deploy job ----------
function steps(job) {
  return job.split(/\n(?= {6}- (?:name|uses|run):)/).slice(1).map((t) => {
    const name = (t.match(/- name: (.*)/) || t.match(/- uses: (.*)/) || [, t.slice(0, 40)])[1];
    const env = (t.match(/\n {8}env:\n((?: {10}.*\n?)*)/) || [, ''])[1];
    const run = (t.match(/\n {8}run: \|\n((?: {10}.*\n?)*)/) || [, ''])[1] || (t.match(/\n {8}run: (.*)/) || [, ''])[1];
    return { name, text: t, env, run };
  });
}
const wfText = () => readFileSync(new URL('../.github/workflows/staging.yml', import.meta.url), 'utf8');

test('no secret at workflow or job level: each one is given to single steps', () => {
  const wf = wfText();
  const dep = wf.slice(wf.indexOf('\n  deploy:'));
  const jobEnv = (dep.match(/\n {4}env:\n((?: {6}.*\n)*)/) || [, ''])[1];
  assert.doesNotMatch(jobEnv, /secrets\./, 'job-level env holds no secret');
  assert.doesNotMatch(wf.slice(0, wf.indexOf('\njobs:')), /secrets\./, 'workflow-level env holds no secret');
  // Every secret reference sits in a step's env block.
  const inSteps = steps(dep).reduce((n, s) => n + (s.env.match(/secrets\./g) || []).length, 0);
  assert.equal(inSteps, (wf.match(/secrets\./g) || []).length);
});

test('the Cloudflare token reaches only steps that run the guard (never npm, the build, Playwright, tests or scripts)', () => {
  const dep = wfText().slice(wfText().indexOf('\n  deploy:'));
  const all = steps(dep);
  const withToken = all.filter((s) => /CLOUDFLARE_API_TOKEN:/.test(s.env));
  assert.ok(withToken.length >= 6, 'the guarded steps were found');
  // Commands allowed in a step that holds the token: the guard, shell built-ins, and short inline checks.
  const allowed = /^(\$GUARD (remote|schedules|fetch-backup|run -- .*)|set -o pipefail|missing=""|\[ .*|if .*|fi|then|else|url=\$\(grep .*\)|echo .*|rm -f [\w.]+|node -e "[^"]*"( > \S+)?|openssl rand -hex 32 \| tr -d '\\n' \| \$GUARD run -- secret put PIN_PEPPER >\/dev\/null|printf '%s' "\$STAGING_BACKUP_KEY" \| \$GUARD run -- secret put BACKUP_KEY >\/dev\/null|\$GUARD run -- .*)$/;
  for (const s of withToken) {
    const lines = s.run.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.length, `${s.name}: has commands`);
    assert.ok(!s.text.includes('- uses:'), `${s.name}: no action gets the token`);
    for (const l of lines) {
      assert.match(l, allowed, `${s.name}: "${l}" may not run with the token`);
      assert.doesNotMatch(l, /\b(npm|npx|yarn|pnpm|playwright|curl|wget)\b|node (?!-e)|GITHUB_ENV|GITHUB_OUTPUT/, `${s.name}: "${l}"`);
    }
  }
  // And the opposite: installs, build, browser, tests and scripts never hold it.
  for (const s of all.filter((s) => /npm |npx |playwright|node --test|node scripts\/(?!staging-guard)|curl /.test(s.run) || s.text.includes('- uses:'))) {
    assert.doesNotMatch(s.env, /CLOUDFLARE_API_TOKEN/, `${s.name} must not get the token`);
  }
  // The backup key goes only to the settings check, the secret upload and the backup check.
  for (const s of all.filter((s) => /STAGING_BACKUP_KEY:/.test(s.env))) assert.match(s.name, /settings are present|Staging secrets on the Worker|Backup on Cloudflare/, s.name);
});

test('backup check: the script steps have no Cloudflare credentials; the download step runs only the guard', () => {
  const dep = wfText().slice(wfText().indexOf('\n  deploy:'));
  const all = steps(dep);
  const scriptSteps = all.filter((s) => /staging-backup-check\.mjs/.test(s.run));
  assert.deepEqual(scriptSteps.map((s) => s.run.trim().split(' ').slice(0, 3).join(' ')), ['node scripts/staging-backup-check.mjs prepare', 'node scripts/staging-backup-check.mjs verify']);
  for (const s of scriptSteps) {
    assert.doesNotMatch(s.env, /CLOUDFLARE|secrets\.(?!STAGING_BACKUP_KEY\b)/, `${s.name}: no Cloudflare credential`);
    assert.doesNotMatch(s.run, /\$GUARD|wrangler|--file|\.sdbk/, `${s.name}: no guard call and no file path on the command line`);
  }
  assert.doesNotMatch(scriptSteps[0].env, /secrets\./, 'the prepare step holds no secret at all');
  const fetch = all.filter((s) => /fetch-backup/.test(s.run));
  assert.equal(fetch.length, 1);
  assert.equal(fetch[0].run.trim(), '$GUARD fetch-backup');
  assert.equal(fetch[0].env.trim(), 'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_STAGING_API_TOKEN }}');
  // Order: make → download → verify; verify only after a successful download.
  const idx = (re) => all.findIndex((s) => re.test(s.run));
  assert.ok(idx(/ prepare /) < idx(/fetch-backup/) && idx(/fetch-backup/) < idx(/ verify /));
  assert.match(all[idx(/ verify /)].text, /if: always\(\) && steps\.backup_fetch\.outcome == 'success'/);
});
