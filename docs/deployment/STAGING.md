# Staging Environment (isolated, synthetic data only)

Created 2026-11-03 with the owner's approval (staging only; no production deploy, secrets, migrations or backups).

## 1. Resource inventory

The staging resources live on the **same Cloudflare account** as production; that is the only thing they share.

| | Production (not touched) | Staging |
|---|---|---|
| Worker | `saydaliti` (`https://saydaliti.mosaedapp.workers.dev`) | `saydaliti-staging` (`https://saydaliti-staging.mosaedapp.workers.dev`) |
| D1 | `saydaliti`, `3cf7edd2-1642-428b-bf1b-973f71d93529` | `saydaliti-staging`, `0ba7c0dd-645e-453e-9999-a316a828e175` (EEUR) |
| R2 | `saydaliti-files` | `saydaliti-files-staging` |
| Secrets | `PIN_PEPPER`, … (unchanged) | `BACKUP_KEY` (from GitHub `STAGING_BACKUP_KEY`); `PIN_PEPPER` (random, staging only) |
| Cron | `0 6 * * *`, `15 * * * *`, `30 1 * * *` (the last only once released) | `*/30 * * * *` (backups only) |
| Deploy credential | GitHub `CLOUDFLARE_API_TOKEN` (manual release only) | GitHub `CLOUDFLARE_STAGING_API_TOKEN` (separate token, revocable on its own; to live in the `staging` environment) |
| Throwaway | — | D1 `saydaliti-staging-sqlcheck`, `20c6fee5-0723-4a70-b328-c58734473c1b`: used once to run the Worker's exact SQL on real D1 (synthetic rows). Can be deleted at any time; I didn't delete it without your say-so. |

Unrelated resources on the same account (`mosaed-cloud*` Workers, `mosaed-files*` buckets) are not used or touched.

## 2. How isolation is enforced

**Configuration.** `worker/wrangler.toml` `[env.staging]` defines its own Worker name, D1 and R2 bindings. Wrangler doesn't inherit bindings per environment, so staging can't silently fall back to production's.

**The guard** (`worker/scripts/staging-guard.mjs`). It fails closed: any doubt stops the job before wrangler runs. Production's identifiers are fixed inside the guard, so editing `wrangler.toml` can't move the target.

| Mode | What it checks |
|---|---|
| `config` (no credentials) | `[env.staging]`:<br>• Worker `saydaliti-staging`, `workers_dev` only, no routes;<br>• exactly one D1 (`saydaliti-staging` / `0ba7c0dd-…`) and one R2 (`saydaliti-files-staging`);<br>• no preview ids;<br>• no unreviewed binding kinds;<br>• a staging `SITE_URL`;<br>• no production id, name, bucket or URL anywhere in the section;<br>• production's own bindings unchanged. |
| `remote` (read-only, before any write) | • The token is active (its expiry is printed; a warning if it has none).<br>• The account in `CLOUDFLARE_STAGING_ACCOUNT_ID` holds D1 `0ba7c0dd-…` named `saydaliti-staging` and the bucket `saydaliti-files-staging`.<br>• Wrangler resolves the `DB` binding to that same UUID.<br>• It then writes a marker for this commit (no secrets in it). |
| `run -- <args>` (every wrangler call) | • Adds `--env staging` itself.<br>• Refuses `--env`, `--config`, `--name`, `--account-id` and any argument naming a production resource.<br>• Allows only: `d1 info / migrations list / migrations apply / execute` (one `SELECT` only), `secret list`, `secret put BACKUP_KEY or PIN_PEPPER`, `r2 object get` and `r2 bucket info` in the staging bucket, `deploy`, `deployments list`, `whoami`.<br>• Never `create`, `delete`, `rollback` or `r2 object put`.<br>• Writes (deploy, migrations apply, secret put) are refused unless the `remote` check passed for the same commit. |
| `schedules` | Reads the staging Worker's cron schedules. |

The guard never reads the production token, and it never sends a request about a production resource.

**Tests.** `test/staging-guard.test.js` (refusal cases) and `test/staging-isolation.test.js` run in `npm test` and in the staging workflow's `preflight` job. They fail if:
- the workflow names a secret other than the two staging ones, or falls back to another secret;
- it can be triggered by anything other than a manual run or the request file;
- the `deploy` job lacks `needs: preflight`, `environment: staging` or the owner/branch condition;
- any wrangler or Cloudflare API call bypasses the guard;
- untrusted input is pasted into a shell line.

**Data.** The test suites and the backup check create **synthetic** accounts and pharmacies only. The backup check refuses any URL that isn't `https://saydaliti-staging.<sub>.workers.dev`.

**What the guard cannot do.** A Cloudflare API token with Workers Scripts / D1 / R2 **Edit** applies to the whole account; Cloudflare doesn't scope those permissions to single resources. The staging token could therefore technically change production if it were used outside this workflow. The guard prevents that inside the workflow. Outside it, the protection is keeping the token only in the `staging` GitHub environment, giving it an expiry, and (strongest) a separate Cloudflare account for staging.

## 3. Owner setup (one time; nothing here is done by Claude)

1. **Cloudflare API token** (done, per the owner): Custom token.
   - Permissions: Account · Workers Scripts · Edit; Account · D1 · Edit; Account · Workers R2 Storage · Edit; Account · Account Settings · Read; User · User Details · Read.
   - Account resources: **only** this account. Expiry: recommended (e.g. 30–90 days).
   - Optional: Client IP filtering is not practical with GitHub-hosted runners.
2. **GitHub environment `staging`:** Settings → Environments → New environment `staging`.
   - **Required reviewers:** yourself. Each run then waits for your click.
   - **Deployment branches:** selected branches, `ccr-94719aa6-7k3i5e` and `main`.
   - **Environment secrets:** move `CLOUDFLARE_STAGING_API_TOKEN` here and add `STAGING_BACKUP_KEY`. After that, delete the repository-level copy of the token: repository secrets can be read by workflows run from branches of this repository, including pull requests opened from them, while environment secrets are released only to a job that the environment admits.
   - **Environment variable:** `CLOUDFLARE_STAGING_ACCOUNT_ID`, the 32-character account id (Cloudflare dashboard → any page → Account ID). It isn't secret; the guard uses it to prove the token reaches the staging database in that account.
3. **The staging backup key, made on your own computer:**
   - `openssl rand -base64 48` (macOS/Linux), or in PowerShell: `[Convert]::ToBase64String((1..48|%{Get-Random -Max 256}))`.
   - **Keep an offline copy:** your password manager, plus a printed or written copy in a sealed envelope stored separately from the computer. Without it, staging backups can't be opened (by design).

**Key rotation:** make a new key, put the new one in `STAGING_BACKUP_KEY` and the old one in a Worker secret `BACKUP_KEYS_OLD` (comma-separated). Old backups stay readable (tested). Keep the old key's offline copy until its backups have expired (14 per pharmacy).

## 4. Running it (only after the owner's approval)

Change `.github/staging-run` on the working branch and push, or (once the workflow is on `main`) use Actions → Cloudflare staging validation → Run workflow, typing `STAGING`.

**Job `preflight`** (no secrets): isolation and guard tests, then `staging-guard config`.

**Job `deploy`** (runs after `preflight`, waits for the `staging` environment reviewer; owner only; working branch or `main` only):
1. Settings present (names only).
2. `staging-guard remote` (read-only proof).
3. Migrations.
4. Deploy.
5. Staging Worker secrets.
6. Health check.
7. Real-D1 checks: trigger and tables.
8. Cron schedules.
9. All API, stock, backup and browser suites against the staging Worker.
10. The backup check on Cloudflare: make a backup → download it from R2 → open it → refuse wrong key, wrong pharmacy and a changed byte → restore into a separate, empty **local** database → verify.

Reports are uploaded as the `staging-reports` artifact.

## 5. Cleaning up (when staging is no longer needed; needs your approval)

Delete the `saydaliti-staging` Worker, the D1 databases `saydaliti-staging` and `saydaliti-staging-sqlcheck`, the R2 bucket `saydaliti-files-staging` (empty it first), the GitHub secrets, and the Cloudflare token.
