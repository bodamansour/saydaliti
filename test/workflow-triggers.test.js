// Nothing reaches Cloudflare automatically. Every job that holds a Cloudflare credential or runs a remote
// wrangler command must be started by hand (workflow_dispatch) — never by a push, a merge, a pull request,
// a schedule or another workflow. Also checks the manual production release keeps its gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const onBlock = (wf) => wf.split(/^on:\s*$/m)[1].split(/^\S/m)[0];
const triggers = (wf) => [...onBlock(wf).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
const jobs = (wf) => {
  const body = wf.slice(wf.search(/^jobs:\s*$/m));
  return body.split(/\n(?= {2}[A-Za-z0-9_-]+:[ \t]*\n)/).slice(1).map((t) => ({ name: t.match(/^ {2}([A-Za-z0-9_-]+):/)[1], text: t }));
};
const touchesCloudflare = (t) => /secrets\.CLOUDFLARE|CLOUDFLARE_API_TOKEN|wrangler (deploy|secret put)|--remote|npm run deploy|\$GUARD (run|remote|schedules)/.test(t);

test('no workflow can be started by pull_request_target or workflow_run (they expose secrets to untrusted code)', () => {
  for (const f of files) for (const t of ['pull_request_target', 'workflow_run']) assert.ok(!triggers(read(f)).includes(t), `${f}: ${t}`);
});

test('every job that can reach Cloudflare runs only from a manual run', () => {
  let found = 0;
  for (const f of files) {
    const wf = read(f);
    const manualOnly = triggers(wf).every((t) => t === 'workflow_dispatch');
    for (const j of jobs(wf).filter((j) => touchesCloudflare(j.text))) {
      found++;
      const gated = /^\s{4}if:.*github\.event_name == 'workflow_dispatch'/m.test(j.text);
      assert.ok(manualOnly || gated, `${f} job ${j.name} reaches Cloudflare but can start automatically (${triggers(wf).join(', ')})`);
      assert.match(j.text, /^\s{4}environment: (production|staging)\s*$/m, `${f} job ${j.name} must run in a protected environment`);
    }
  }
  assert.ok(found >= 2, 'the production and staging deploy jobs were found');
});

test('the production release: manual only, from main, typed confirmation, tests first, production environment', () => {
  const wf = read('cloudflare.yml');
  assert.deepEqual(triggers(wf), ['workflow_dispatch']);
  const deploy = wf.slice(wf.indexOf('\n  deploy:'));
  assert.match(deploy, /needs: tests/);
  assert.match(deploy, /environment: production/);
  assert.match(wf, /\n {2}tests:\n\s+needs: guard\n\s+uses: \.\/\.github\/workflows\/test\.yml/);
  assert.doesNotMatch(wf.slice(0, wf.indexOf('\n  deploy:')), /--remote|wrangler deploy|npm run deploy|secrets\./);
  assert.doesNotMatch(wf, /STAGING/, 'the release never uses staging credentials, and vice versa');
  const script = wf.split('- name: Only from main, only when confirmed')[1].split('run: |')[1].split('\n\n')[0]
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const run = (REF, CONFIRM) => { try { execFileSync('bash', ['-c', script], { env: { REF, CONFIRM, PATH: process.env.PATH }, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run('refs/heads/main', 'DEPLOY-PRODUCTION'), 0);
  assert.notEqual(run('refs/heads/feature', 'DEPLOY-PRODUCTION'), 0);
  assert.notEqual(run('refs/heads/main', 'yes'), 0);
  assert.notEqual(run('refs/heads/main', ''), 0);
});

test('the test workflow still runs on pull requests and can be called by the release', () => {
  const t = triggers(read('test.yml'));
  assert.ok(t.includes('pull_request') && t.includes('workflow_call'));
  assert.doesNotMatch(read('test.yml'), /secrets\.CLOUDFLARE|--remote|wrangler deploy/);
});
