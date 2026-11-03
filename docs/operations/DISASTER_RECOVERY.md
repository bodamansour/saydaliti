# Backup and Disaster Recovery

Last updated: 2026-11-03 (Phase 2 M2). Implemented and drilled **only locally** (a copy of the local test database, test data only). Nothing has been configured on Cloudflare or run against production data, and no real pharmacy data was sent to any service.

## 1. What existed before (inspected)

| Capability | Status |
|---|---|
| Owner downloads a full JSON export from the browser | Exists; manual and **unencrypted** (it includes patients' names and phones) |
| Import that export into a **new, empty** pharmacy (`import_backup`) | Exists; gives every row a new id (a tenant move, not disaster recovery); tested |
| Desktop offline mode: a daily local JSON backup and restore with a fingerprint check | Exists; tested in `e2e/local.e2e.mjs` |
| Automatic server backups | **Did not exist** |
| Restore with the same ids into an empty database, verified | **Did not exist** |
| Cloudflare D1 Time Travel (whole-database point-in-time) | A platform feature; **not configured or tested** by this project. Retention depends on the Cloudflare plan; check the current Cloudflare docs before relying on it. |

## 2. What was added (Phase 2 M2)

- **Encrypted server backups per pharmacy** (`worker/src/backup.js`):
  - **Content:** every tenant table (including the stock ledger, approvals and audit log), the pharmacy's member accounts (sign-in hashes only, no sessions), and the uploaded files (snapshots) from R2.
  - **Encryption:** AES-256-GCM. The key comes from **HKDF-SHA256(`BACKUP_KEY` secret, salt = pharmacy id)**, so every pharmacy has its own key and a file can't be opened as another pharmacy's. The file has a magic header plus a random IV; any change to it is detected.
  - **Without the secret, no backup is made**; nothing is ever stored unencrypted.
- **Storage:** the existing R2 bucket, under `backups/<pharmacy>/<time>.sdbk`. No new service. The list is in D1 (`backups`, migration **0014**): time, size, SHA-256 of the plain data, row counts and money totals, status, and errors.
- **Each backup is read back and decrypted before it is listed as good.** A file that was only written is not a backup.
- **Retention:** the newest **14** good backups per pharmacy. Older files are deleted from R2 and marked `expired`.
- **Daily job:** cron `30 1 * * *` (03:30 Cairo), one pharmacy at a time. A failure is listed (`status = failed`, with the error) and the others continue. It only runs once the `BACKUP_KEY` secret is set.
- **Access:**
  - The owner can make a backup (at most 6 an hour) and see the list (times, sizes, totals). The owner cannot download the files, and the file locations are not shown.
  - The `backups` table can't be reached through the data API.
  - Partners, devices, staff and other pharmacies are refused (tested).
- **Exact restore** (`restoreInto`), for disaster recovery: every row goes back with the same ids, **only into an empty database**. It refuses if the pharmacy or any of its accounts already exists, and it never merges. The stock levels are rebuilt by the ledger trigger.
- **Verification** (`verifyRestore`):
  - rows and a checksum per table;
  - money totals (sales, returns, purchases, supplier returns, payments, expenses, amounts on account);
  - stock per item and branch (rebuilt levels = the backup's ledger sums);
  - 14 kinds of links (receipt → branch, customer, employee, shift, returned receipt, approval; …);
  - the uploaded files.

## 3. Restore drill (local, 2026-11-03)

`node worker/scripts/restore-drill.mjs <local state dir> <report.json>` copies the local test database as the source, creates a **separate, empty** target database with migrations 0001–0014, and runs the steps below. Result: **PASS**.

| Step | Result |
|---|---|
| Pharmacy chosen (most receipts plus ledger rows) | 41 receipts, 46 ledger rows; 177 rows in total |
| Backup (dump + encrypt + write + read back + decrypt + check) | 758 ms, 88,846 bytes, SHA-256 recorded |
| Restore into the empty target | 652 ms |
| Verification | **0 problems:** rows, checksums, money, stock, links and files all equal |
| Tamper check (one receipt deleted, one amount +1, one ledger row deleted in the target) | **Detected:** `pos_sales 41 vs 40`, `stock_ledger 46 vs 45`, `money sales 2755 vs 2656`, `money on_account 180 vs 80`, `1 pos_sales.return_of pointing nowhere` |
| Restore again into the target | refused (already exists) |
| Restore into the source | refused (already exists) |
| Open the file as another pharmacy, or with another key | refused |
| Retention after 17 backups | 14 kept (files present), 3 expired (files deleted) |

These timings come from a small test pharmacy on a local machine. They are **not** production RTO figures.

## 4. Recovery objectives (proposed, not yet validated)

| Objective | Proposal | Basis | Status |
|---|---|---|---|
| RPO, server backups | ≤ 24 h (daily job) | cron 01:30 UTC | Proposal; production job not enabled |
| RPO, whole database | Time Travel point in time, within the plan's retention | Cloudflare platform | Not configured or tested here |
| RTO, one pharmacy from a server backup | Minutes for small pharmacies (drill: under 2 s for 177 rows) | Local drill | Needs a drill with realistic volume on staging |
| Retention | 14 daily backups per pharmacy | `RETAIN` in `backup.js` | Implemented; owner to confirm |

## 5. Recovery procedures

**A. A wrong change or a bad release, whole database:** D1 Time Travel restore to a bookmark taken before the release. This rolls back **everything** after that point, so use it only by explicit decision. Record the bookmark at every release (`DEPLOYMENT_AND_RELEASE.md` §5).

**B. One pharmacy lost or damaged:**
1. Create an **empty** recovery database (separate D1 and R2). Never restore into production on top of existing data.
2. Apply all migrations.
3. With the `BACKUP_KEY` secret, read the chosen `.sdbk` from R2, decrypt it (`decryptBackup`), restore it (`restoreInto`) and verify it (`verifyRestore`). This is the same code the drill uses.
4. Compare totals with the pharmacy owner, then decide how to switch over. This is an operator procedure that needs the owner's approval.

**C. Moving a pharmacy to a new account or pharmacy:** the existing owner export → `import_backup` (new ids).

## 6. Before this goes to production (needs owner approval)

1. Create the `BACKUP_KEY` Worker secret: a long random value, at least 32 characters. **Store a copy offline: without it the backups cannot be opened.** The release workflow warns if it is missing.
2. Apply migration 0014 (with the release).
3. Run the drill on **staging** with a realistic volume, then record RTO.
4. Check the Worker CPU and memory limits of the current Cloudflare plan against the size of the largest pharmacy. The daily job reads the whole pharmacy and the uploaded files, so it may need the paid plan.
5. Decide alerting: today a failure is listed for the owner and in the log. There is no push or e-mail alert.

## 7. Key rotation and key loss (tested 2026-11-03)

- New files carry the id of the key that made them (`SDBK2`). To rotate, set the new key in `BACKUP_KEY` and the retired keys in `BACKUP_KEYS_OLD` (comma-separated). **Old backups stay readable** (unit tests, plus the local drill end to end), and new ones use the new key.
- **If a key is lost** and not kept in `BACKUP_KEYS_OLD`, the backups made with it can't be opened by anyone. The error names the key id. The live database is not affected, and backups made after a new key is set are fine (tested). This is why an **offline copy of every key** is required until its backups have expired (14 per pharmacy).
- Files from before key ids (`SDBK1`) are tried with every available key.

## 8. Failure monitoring

| Signal | Where | Status |
|---|---|---|
| A backup that fails is listed (`status = failed`, the error) | `backups` table | Implemented, tested |
| After each daily run, `backupHealth`: a pharmacy with no good backup, a last good one older than 36 h, or a failure after the last good one | Logged as `BACKUP_ALERT {…}` (Cloudflare Workers observability) | Implemented; the local drill confirms a failure and a missing backup are flagged |
| App admin view | RPC `admin_backup_health` | Implemented |
| Owner view | Dashboard → النسخ: last backup time; red when older than 36 h or the last attempt failed | Implemented |
| Push / e-mail alert | — | **Plan:** a Cloudflare notification or Logpush filter on `BACKUP_ALERT` sent to the support e-mail, or a small Worker alerting through WhatsApp Business (already used for the morning report). Needs the owner to choose the channel and an account. |

## 9. What a backup does NOT contain

| Not included | Why / what to do |
|---|---|
| Item photos (`images/<pharmacy>/…` in R2) | Size; re-upload after a disaster, or copy the R2 prefix separately |
| Older uploaded files beyond what the `snapshots` rows point to | The app keeps the newest 10 per branch anyway |
| Sign-in sessions, sign-in/PIN/invite attempt counters | Short-lived; people sign in again |
| `client_errors` (app error reports), `app_config` and `app_admins` (whole-app settings) | Not pharmacy data; app-level settings are re-entered by the app owner |
| Other pharmacies' rows | Each backup is one pharmacy |
| Worker secrets (`PIN_PEPPER`, `BACKUP_KEY`, WhatsApp, AI) | Kept outside the database; they must be stored separately (offline) |
| `stock_levels` | Rebuilt from the ledger on restore (checked) |

## 10. Limits

- Item photos (`images/` in R2) are not in the backup.
- Auto-increment ids (`snapshots`, `attendance`, `audit_log`) are restored as-is. A restore into a database that already holds other pharmacies could collide, which is why restoring is only into an empty database.
- The backup includes members' password hashes. They are protected by the encryption, and the key must be guarded accordingly.
- The production D1 trigger used by the stock ledger, and the job's CPU use on the production plan, are untested.
