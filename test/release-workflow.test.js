// Production safety: publishing to the live site and changing the live database must stay a manual,
// confirmed step. These checks fail if the release workflow is ever set to run on push or merge again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const wf = readFileSync(new URL('../.github/workflows/cloudflare.yml', import.meta.url), 'utf8');
const onBlock = wf.split(/^on:\s*$/m)[1].split(/^\S/m)[0];

test('the production release runs only by hand (no push, pull request or schedule)', () => {
  assert.match(onBlock, /^\s{2}workflow_dispatch:/m);
  for (const t of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'release']) {
    assert.doesNotMatch(onBlock, new RegExp(`^\\s{2}${t}:`, 'm'), `${t} must not trigger a production release`);
  }
});

test('the live database and Worker are touched only after the guard, the tests and the environment', () => {
  const deploy = wf.slice(wf.indexOf('\n  deploy:'));
  assert.match(deploy, /needs: tests/);
  assert.match(deploy, /environment: production/);
  assert.match(wf, /\n  tests:\n\s+needs: guard\n\s+uses: \.\/\.github\/workflows\/test\.yml/);
  // Every remote step is inside the deploy job.
  const beforeDeploy = wf.slice(0, wf.indexOf('\n  deploy:'));
  assert.doesNotMatch(beforeDeploy, /--remote|wrangler deploy|npm run deploy/);
  assert.ok(deploy.indexOf('PIN_PEPPER') < deploy.indexOf('migrations apply'), 'preflight before migrations');
  assert.ok(deploy.indexOf('migrations apply') < deploy.indexOf('npm run deploy'));
});

test('the guard refuses another branch or a missing confirmation', () => {
  const script = wf.split('- name: Only from main, only when confirmed')[1].split('run: |')[1].split('\n\n')[0]
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const run = (REF, CONFIRM) => { try { execFileSync('bash', ['-c', script], { env: { REF, CONFIRM, PATH: process.env.PATH }, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run('refs/heads/main', 'DEPLOY-PRODUCTION'), 0);
  assert.notEqual(run('refs/heads/feature', 'DEPLOY-PRODUCTION'), 0);
  assert.notEqual(run('refs/heads/main', 'yes'), 0);
  assert.notEqual(run('refs/heads/main', ''), 0);
  assert.notEqual(run('refs/heads/main', 'deploy-production'), 0);
});

test('the test workflow can be called by the release and still runs on pull requests', () => {
  const t = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(t, /^\s{2}workflow_call:/m);
  assert.match(t, /^\s{2}pull_request:/m);
});

test('no installer is built on the end-of-life Electron 22 (Windows 7/8 unsupported)', () => {
  const d = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(d, /electron@22|electronVersion=22|build-win7/);
});
