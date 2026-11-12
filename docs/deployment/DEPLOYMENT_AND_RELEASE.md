# Deployment and Release

Last updated: 2026-11-03 (Phase 1). This document supersedes the deployment parts of `docs/DEPLOYMENT_GUIDE.md` and `worker/README.md`.

## 1. Production environment: what we know

| Item | Finding | Evidence |
|---|---|---|
| Production Worker | `saydaliti`, served at `https://tablix.tablixpharma.workers.dev` | `worker/wrangler.toml` (`name`, `SITE_URL`) |
| Production D1 | `saydaliti`, id `3cf7edd2-…3529` | `worker/wrangler.toml` |
| Production R2 | `saydaliti-files` | `worker/wrangler.toml` |
| Is production actively deployed? | **Yes.** All 26 runs of the old `cloudflare.yml` (through 2026-10-31, `7d23b83`) succeeded. In the latest run, the remote-migration step (2 s) and the publish step (9 s) actually ran rather than being skipped. Migrations 0009 and 0010 are therefore applied to the live D1. | GitHub Actions run 41218360186, job steps 6–7 |
| Does it serve real pharmacies? | **Unconfirmed; treat as YES.** The Cloudflare account and its analytics are not accessible from this environment, and I did not contact the live site. The project log records the owner's real United backup (`11.gen`). The auth code migrates real accounts from the earlier Supabase deployment (bcrypt to PBKDF2). | `docs/DEVELOPMENT_LOG.md:9`, `worker/src/auth.js` |
| Desktop / Android releases | `desktop-latest` (2026-10-27) and `android-latest` (2026-10-27) are public GitHub releases | GitHub releases |

**Rule until the owner confirms otherwise:** production D1 and R2 may contain real pharmacy, customer and patient data. Nothing in this repository may read from, write to, migrate or deploy to them without the owner's separate explicit approval.

## 2. How production was deployed before 2026-11-03

`.github/workflows/cloudflare.yml` ran on **every push to `main`**:

1. Skip if the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets are missing.
2. `wrangler d1 migrations apply saydaliti --remote`: apply pending migrations to the **live** D1.
3. `npm run deploy` (`wrangler deploy`): publish the Worker and the static site.

Protections at that time:
- D1 migrations are tracked by Wrangler (`d1_migrations` table), so a migration is applied once.
- A `concurrency` group prevented two deploys at the same time.
- Merging to `main` normally went through a PR, with the tests workflow running on the PR.
- **Missing:** no manual approval, no requirement that tests pass on the merged commit before deploying, no check of required Worker secrets, no environment protection, no backup before migrating.

## 3. How production is deployed now

`.github/workflows/cloudflare.yml` is **manual only** (`workflow_dispatch`). Pushing or merging to `main` publishes nothing and changes no database.

Release steps:
1. Actions → **Cloudflare production release** → Run workflow → branch **main** → type `DEPLOY-PRODUCTION`.
2. `guard` job: refuses any ref other than `refs/heads/main`, and any confirmation text other than the exact string.
3. `tests` job: calls `test.yml` on the same commit. That covers unit tests, browser tests, the Worker on a **local** D1/R2 (the non-production test deployment), and the United sync on a Windows runner with SQL Server.
4. `deploy` job, in the `production` GitHub Environment:
   - credentials check;
   - **preflight:** `wrangler secret list` must show `PIN_PEPPER` (names only, values are never printed), and `wrangler d1 migrations list --remote` prints the pending migrations;
   - apply pending migrations;
   - publish.

**Recommended owner action (GitHub settings, not code):** Settings → Environments → `production` → add yourself as a required reviewer. The `deploy` job will then also wait for an approval click, which shows the commit and the run. The environment is created automatically on the first run if it does not exist; without reviewers, step 1 (manual run + typed confirmation) is the approval.

Regression guard: `test/release-workflow.test.js` fails if the release workflow ever regains a push/PR/schedule trigger, or if remote steps move out of the gated job.

## 4. Non-production environments

| Environment | Status |
|---|---|
| Local / CI Worker (Miniflare, local D1/R2) | Exists. Used by `test.yml` on every PR and by every release. This is the isolated test environment used for Phase 1. |
| Hosted staging (separate Worker + D1 + R2) | **Does not exist.** Creating it needs Cloudflare resources on the owner's account: `wrangler d1 create saydaliti-staging`, `wrangler r2 bucket create saydaliti-files-staging`, then an `[env.staging]` block in `wrangler.toml` with **its own** `database_id`, bucket and `SITE_URL`, plus a staging `PIN_PEPPER` secret. Not created without approval. |

Never use `wrangler versions upload` or preview URLs of the production Worker as a "staging": they share the production D1 and R2 bindings.

## 5. Migration rules

- Never edit an applied migration; add a new numbered file and mark the columns `{ added: N }` in `worker/src/schema.js`.
- Migrations must be additive and safe on the existing data. A migration that could fail on existing rows (e.g. a UNIQUE index over legacy data) must be written so that it cannot fail. Example: 0011 indexes only rows that carry the new `receipt_device` column.
- Test every migration locally on a populated local D1 before release: apply, run the API tests, run the rollback SQL, re-apply.
- Before applying a migration to production, take a D1 Time Travel bookmark (`wrangler d1 time-travel info saydaliti`) and record it in the release notes. Restoring a bookmark rolls back the **whole** database (later writes are lost), so it is a last resort.

## 6. Code rollback

Re-run the release workflow on a known-good commit, but only after checking that the commit is compatible with the migrations already applied (migrations only add columns and indexes, so older code keeps working with them).

## 7. Windows 7 / 8 / 32-bit

Unsupported (owner decision, 2026-11-03). The only Electron that runs there (22.x) is end-of-life and receives no security fixes. `desktop.yml` no longer builds it. An older `Saydaliti-Setup-Win7.exe` may remain attached to the `desktop-latest` release as a legacy file. The next release text marks it unsupported and unpatched, and it is not rebuilt. Supported: Windows 10/11 x64 (Electron 45), or a current, supported browser for the web app.
