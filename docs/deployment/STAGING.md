# Staging Environment (isolated, synthetic data only)

Created 2026-11-03 with the owner's approval (staging only; no production deploy, secrets, migrations or backups).

## 1. Resource inventory

The staging resources live on the **same Cloudflare account** as production; that is the only thing they share.

| | Production (not touched) | Staging |
|---|---|---|
| Worker | `saydaliti` (`https://tablix.tablixpharma.workers.dev`) | `saydaliti-staging` (`https://tablix-staging.tablixpharma.workers.dev`). **Not created yet:** the first staging deploy creates it. |
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

**One config file only.**
- Every Wrangler call the guard makes passes `--config <absolute path of worker/wrangler.toml>`. That path is worked out from the guard's own location, not the current folder. With an explicit `--config`, Wrangler doesn't search for a config file and doesn't follow redirects.
- The guard also refuses to run, in every mode, while any of these exists:
  - a `wrangler.json`, a `wrangler.jsonc` or a `.wrangler/deploy/config.json` in `worker/` or any parent folder;
  - a `.env` or `.env.local` in `worker/`.

  Without `--config`, Wrangler would prefer such a file over `worker/wrangler.toml` (reproduced with a root `wrangler.json` naming production's Worker, database and bucket).

**Schedules.**
- `[env.staging.triggers]` must exist (otherwise staging would inherit production's crons) and hold exactly `*/30 * * * *`.
- `BACKUP_CRON` must be that same value, and `MORNING_CRON` must differ from it.
- The Worker code's scheduled handler must send `BACKUP_CRON` to the backups and return before it can start the morning report or the patient reminders. `main`'s code before PR #51 fails this check: its handler would run the reminders on the staging cron.

| Mode | What it checks |
|---|---|
| `config` (no credentials) | `[env.staging]`:<br>• Worker `saydaliti-staging`, `workers_dev` only, no routes;<br>• exactly one D1 (`saydaliti-staging` / `0ba7c0dd-…`) and one R2 (`saydaliti-files-staging`);<br>• no preview ids;<br>• no unreviewed binding kinds;<br>• a staging `SITE_URL`;<br>• no production id, name, bucket or URL anywhere in the section;<br>• production's own bindings unchanged. |
| `remote` (read-only, before any write) | • The token is active (its expiry is printed; a warning if it has none).<br>• The token sees **exactly one** account, and it is `CLOUDFLARE_STAGING_ACCOUNT_ID`. D1 UUIDs are globally unique, so finding the staging UUID there pins the account.<br>• The account in `CLOUDFLARE_STAGING_ACCOUNT_ID` holds D1 `0ba7c0dd-…` named `saydaliti-staging` and the bucket `saydaliti-files-staging`.<br>• Wrangler resolves the `DB` binding to that same UUID.<br>• It then writes a marker for this commit (no secrets in it). |
| `run -- <args>` (every wrangler call) | • Checks `wrangler.toml` again first.<br>• Adds `--env staging` itself.<br>• Refuses `--env`, `--config`, `--name`, `--account-id`, `--route(s)`, `--domain(s)`, `--triggers`, `--var`, `--define`, `--assets`, `--persist-to`, `--preview` and any argument naming a production resource.<br>• Allows only: `d1 info / migrations list / migrations apply / execute` (one `SELECT` only), `secret list`, `secret put BACKUP_KEY or PIN_PEPPER`, `r2 object get` and `r2 bucket info` in the staging bucket, `deploy`, `deployments list`, `whoami`.<br>• Never `create`, `delete`, `rollback` or `r2 object put`.<br>• Writes are allowed only in their exact reviewed form: `deploy`, `d1 migrations apply DB --remote`, `secret put BACKUP_KEY`, `secret put PIN_PEPPER`. Any extra option is refused. They are refused unless the `remote` check passed for the same commit. |
| `schedules` | Reads the staging Worker's cron schedules and fails unless they are exactly `*/30 * * * *`. |

The guard never reads the production token, and it never sends a request about a production resource.

**Tests.** `test/staging-guard.test.js` (refusal cases) and `test/staging-isolation.test.js` run in `npm test` and in the staging workflow's `preflight` job. They fail if:
- the workflow names a secret other than the two staging ones, or falls back to another secret;
- it can be triggered by anything other than a manual run or the request file;
- the `deploy` job lacks `needs: preflight`, `environment: staging` or the owner/branch condition;
- any wrangler or Cloudflare API call bypasses the guard;
- untrusted input is pasted into a shell line.

**Data.** The test suites and the backup check create **synthetic** accounts and pharmacies only. The backup check refuses any URL that isn't `https://saydaliti-staging.<sub>.workers.dev`.

**What the guard cannot do.** A Cloudflare API token with Workers Scripts / D1 / R2 **Edit** applies to the whole account; Cloudflare doesn't scope those permissions to single resources. The staging token could therefore technically change production if it were used outside this workflow. The guard prevents that inside the workflow. Outside it, the protection is keeping the token only in the `staging` GitHub environment, giving it an expiry, and (strongest) a separate Cloudflare account for staging.

## 3. Owner setup (one time; done by the owner, by hand)

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
   - `openssl rand -base64 48` (macOS/Linux), or in PowerShell 7: `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))`. That gives 64 characters and 384 random bits. The Worker needs at least 32 characters; it uses the text as HKDF input.
   - Don't use `Get-Random`: it isn't a cryptographic generator. An earlier version of this page suggested it; a key made that way should be replaced.
   - Paste it **only** into GitHub's secret form (Settings → Environments → `staging` → Add secret, name `STAGING_BACKUP_KEY`). The workflow passes it to the Worker as `BACKUP_KEY` through standard input; it never appears in an argument or a log.
   - **Keep an offline copy:** your password manager, plus a printed or written copy in a sealed envelope stored separately from the computer. Without it, staging backups can't be opened (by design).

**Key rotation:** make a new key, put the new one in `STAGING_BACKUP_KEY` and the old one in a Worker secret `BACKUP_KEYS_OLD` (comma-separated). Old backups stay readable (tested). Keep the old key's offline copy until its backups have expired (14 per pharmacy).

## 4. Running it (only after the owner's approval)

**Deploy:** only from a manual run, Actions → Cloudflare staging validation → Run workflow (branch `ccr-94719aa6-7k3i5e`, type `STAGING`). GitHub shows that button only when a file named `.github/workflows/staging.yml` exists on the default branch (`main`); today it doesn't. Getting it there needs a decision by the owner (§5).

**Preflight only:** changing `.github/staging-run` on the working branch runs the credential-free `preflight` job; `deploy` is skipped.

**Job `preflight`** (no secrets): isolation and guard tests, then `staging-guard config`.

**Job `deploy`** (runs after `preflight`, waits for the `staging` environment reviewer; owner only; branch `ccr-94719aa6-7k3i5e` only, with `main` added back after PR #51 is merged).

**Secrets.** No secret is set for the whole job. `CLOUDFLARE_STAGING_API_TOKEN` is given only to the steps that run the guard: the settings check, the remote proof, migrations, deploy, Worker secrets, the D1 checks and the schedules check. It is never given to `npm ci`, the build, Playwright, the test suites or the backup-check script. `test/staging-isolation.test.js` enforces this.

**Backup check: three steps, so the script never holds the token.**
1. `staging-backup-check.mjs prepare` (no secrets): makes a synthetic pharmacy and a backup on the staging Worker, then writes the two ids to `worker/.staging-backup/request.json`.
2. `staging-guard.mjs fetch-backup` (the token, nothing else in the step):
   - reads that request, which must be exactly two UUIDs in a plain file inside a plain folder;
   - looks up the backup's R2 key with one `SELECT` on the staging D1;
   - accepts the key only in the exact form the Worker makes for that pharmacy and backup;
   - downloads it with the only R2 read the guard allows: that key, from the remote staging bucket, into the fixed file `worker/.staging-backup/backup.sdbk`;
   - checks the header and size, and records the SHA-256.
3. `staging-backup-check.mjs verify` (only `STAGING_BACKUP_KEY`):
   - reads only that fixed file; it must be a plain file whose SHA-256 matches what the guard recorded;
   - checks it can't be opened with the wrong key, as the wrong pharmacy or with a changed byte;
   - restores it into an empty **local** database and verifies the result.

   The script refuses to run at all if a Cloudflare token is in its environment.

Steps:
1. Settings present (names only).
2. `staging-guard remote` (read-only proof).
3. Migrations.
4. Deploy.
5. Staging Worker secrets.
6. Health check.
7. Real-D1 checks: trigger and tables.
8. Cron schedules.
9. All API, stock, backup and browser suites against the staging Worker.
10. The backup check on Cloudflare: make a backup (no secrets) → guarded download from R2 → open it → refuse wrong key, wrong pharmacy and a changed byte → restore into a separate, empty **local** database → verify (no Cloudflare access).

Reports are uploaded as the `staging-reports` artifact.

## 5. Verification status (2026-11-03)

| Check | How | Result |
|---|---|---|
| D1 `saydaliti-staging` = `0ba7c0dd-645e-453e-9999-a316a828e175`, empty (12,288 bytes); production `saydaliti` `3cf7edd2-…` 479,232 bytes (unchanged); throwaway `saydaliti-staging-sqlcheck` `20c6fee5-…` | Cloudflare read-only (connector) | Verified |
| R2 `saydaliti-files-staging` exists; production `saydaliti-files` exists | Cloudflare read-only | Verified |
| Worker `saydaliti-staging` | Cloudflare read-only | **Doesn't exist yet**; production `saydaliti` last modified 2026-10-31 |
| Account id | — | **Not verified:** the connector doesn't show it. The guard checks it at run time. |
| GitHub environment `staging`, its reviewers, branches, secrets and variable | — | **Not verified / not created:** this session has no GitHub tool for environments or secrets |
| `staging.yml` on `main` (needed for the Run workflow button) | GitHub read | **Absent** |
| Guard and isolation tests | Local + CI | Pass |
| Migrations 0001–0015 | Local review | Additive (0010 backfills a new column; every `DROP` is in rollback comments) |

**Decision needed: how to make the manual run possible.**
- **Option A (recommended):** a small separate PR to `main` that adds only `.github/workflows/staging.yml`, `worker/scripts/staging-guard.mjs` and the two guard tests.
  - It deploys nothing: `cloudflare.yml` is manual-only, the staging workflow has no `main` push trigger, and `desktop.yml` ignores these paths.
  - Merging is the owner's decision.
- **Option B:** wait until PR #51 is merged.

## 6. Cleaning up (when staging is no longer needed; needs your approval)

Delete the `saydaliti-staging` Worker, the D1 databases `saydaliti-staging` and `saydaliti-staging-sqlcheck`, the R2 bucket `saydaliti-files-staging` (empty it first), the GitHub secrets, and the Cloudflare token.
