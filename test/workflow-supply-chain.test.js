// Supply chain of the GitHub workflows: an action from outside GitHub's own `actions/` organisation runs only at
// a reviewed commit (a tag can be moved to other code), and the production release job keeps no GitHub token
// in the checkout next to the Cloudflare token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]);

test('third-party actions are pinned to a full commit SHA', () => {
  let n = 0;
  for (const [f, text] of workflows) {
    for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./') || ref.startsWith('actions/')) continue;
      n += 1;
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${ref}`);
    }
  }
  assert.ok(n >= 1, 'at least one third-party action was checked');
});

test('the production release checks out without keeping the GitHub token', () => {
  const text = Object.fromEntries(workflows)['cloudflare.yml'];
  const deploy = text.slice(text.indexOf('\n  deploy:'));
  assert.match(deploy, /- uses: actions\/checkout@v\d+\n\s+with:\n(?:\s+#.*\n)*\s+persist-credentials: false/);
});
