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
| Deploy credential | GitHub `CLOUDFLARE_API_TOKEN` (manual release only) | GitHub `CLOUDFLARE_STAGING_API_TOKEN` (separate token, revocable on its own) |
| Throwaway | — | D1 `saydaliti-staging-sqlcheck`, `20c6fee5-0723-4a70-b328-c58734473c1b`: used once to run the Worker's exact SQL on real D1 (synthetic rows). Can be deleted at any time; I didn't delete it without your say-so. |

Unrelated resources on the same account (`mosaed-cloud*` Workers, `mosaed-files*` buckets) are not used or touched.

## 2. How isolation is enforced

- `worker/wrangler.toml` `[env.staging]` defines its own Worker name, D1 and R2 bindings. Wrangler doesn't inherit bindings per environment, so staging can't silently fall back to production's.
- `test/staging-isolation.test.js` (it runs in `npm test` and first in the staging workflow) fails if:
  - any staging binding equals a production one;
  - production's bindings change;
  - the staging workflow references the production token;
  - any remote `wrangler` command in it lacks `--env staging`;
  - it could run on a schedule or a pull request.
- The workflow checks that the D1 it will migrate has the staging UUID before doing anything.
- The test suites and the backup check create **synthetic** accounts and pharmacies only. The backup check refuses to run against any URL that isn't `saydaliti-staging.*`.

## 3. Owner setup (one time)

1. **Cloudflare API token:** My Profile → API Tokens → Create Token → Custom.
   - Permissions: Account · Workers Scripts · Edit; Account · D1 · Edit; Account · Workers R2 Storage · Edit; Account · Account Settings · Read; User · User Details · Read.
   - Account resources: your account. Optional expiry.
2. **The staging backup key, made on your own computer:**
   - `openssl rand -base64 48` (macOS/Linux), or in PowerShell: `[Convert]::ToBase64String((1..48|%{Get-Random -Max 256}))`.
   - **Keep an offline copy:** your password manager, plus a printed or written copy in a sealed envelope stored separately from the computer. Without it, staging backups can't be opened (by design).
3. **GitHub secrets:** `CLOUDFLARE_STAGING_API_TOKEN`, `CLOUDFLARE_STAGING_ACCOUNT_ID`, `STAGING_BACKUP_KEY`.

**Key rotation:** make a new key, put the new one in `STAGING_BACKUP_KEY` and the old one in a Worker secret `BACKUP_KEYS_OLD` (comma-separated). Old backups stay readable (tested). Keep the old key's offline copy until its backups have expired (14 per pharmacy).

## 4. Running it

Change `.github/staging-run` on the working branch and push: that runs **Cloudflare staging validation**. (The "Run workflow" button in Actions appears only once the workflow file is on `main`, after PR #51 is merged.)

Steps:
1. Secrets check.
2. Isolation tests.
3. Staging D1 identity check.
4. Migrations.
5. Deploy.
6. Staging secrets.
7. Health check.
8. Real-D1 checks: trigger and tables.
9. All API, stock, backup and browser suites against the staging Worker.
10. The backup check on Cloudflare: make a backup → download it from R2 → open it → refuse wrong key, wrong pharmacy and a changed byte → restore into a separate empty database → verify.

Reports are uploaded as the `staging-reports` artifact.

## 5. Cleaning up (when staging is no longer needed; needs your approval)

Delete the `saydaliti-staging` Worker, the D1 databases `saydaliti-staging` and `saydaliti-staging-sqlcheck`, the R2 bucket `saydaliti-files-staging` (empty it first), the GitHub secrets, and the Cloudflare token.
