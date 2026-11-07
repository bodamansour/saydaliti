# Keys and secrets (2026-11-06)

Names only. Values live in Cloudflare (Worker secrets) and GitHub (Actions secrets), never in Git, logs or tests.
Tests use their own made-up values (`ci-…-not-a-real-secret-…`, `test-…-SECRET-MARK-…`).

## Worker secrets

| Secret | Used for | If missing | Rotation |
|---|---|---|---|
| `PIN_PEPPER` | Employee PIN hashes (`hashPin`) | PINs refused (503, `pin_secret_missing`); release preflight fails | `PIN_PEPPER_OLD` (see below) |
| `TOTP_KEY` | Encrypting each account's two-step secret (AES-GCM, `worker/src/auth.js`) | Two-step sign-in can't be turned on (`mfa_not_configured`, 503); preflight warns | `TOTP_KEY_OLD`, comma-separated; secrets are sealed again with the new key at their next use |
| `AUDIT_SEAL_KEY` | HMAC seals of the change log (`worker/src/audit-seal.js`) | Nothing is sealed (`AUDIT_SEAL_NOT_CONFIGURED` in the log); the check says «not set up»; preflight warns | `AUDIT_SEAL_KEY_OLD`; each seal stores `key_id`, so old seals still verify |
| `BACKUP_KEY` | Encrypted backups in R2 | Backups fail (logged) | `BACKUP_KEYS_OLD` (docs/operations/DISASTER_RECOVERY.md) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Forgotten-password email | «Forgot password» answers `email_not_configured`; preflight warns | — |
| `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | AI assistant, WhatsApp | The feature is off | — |

`EMAIL_OUTBOX` is for local development only. The release preflight **fails** if it is set as a Worker secret or in `wrangler.toml`. On top of that, the `/api/auth/dev-outbox` route only answers on `localhost`.

**Rules for every key:**
- At least 32 characters, from a cryptographic generator (`openssl rand -base64 48`).
- A key's id is the first 12 hex characters of `sha256('saydaliti-key-id:' + key)`. It is safe to show; the key itself is not.
- New v2 two-step secrets and audit seals use independent keys. Legacy v1 two-step secrets still require their original `PIN_PEPPER` until migrated.

## Changing `PIN_PEPPER` without locking anyone out

Every employee PIN hash depends on `PIN_PEPPER`. To change it:

1. Set the new value as `PIN_PEPPER` and the current one as `PIN_PEPPER_OLD` (comma-separated if there are several).
2. At each employee's next PIN entry, the server tries the old pepper as well. When it matches, it stores the hash made with the new pepper (one conditional `UPDATE … WHERE pin_hash = old`). Duplicate-PIN checks when adding or changing a PIN look at the old hashes too. Test: `test/server-keys.test.js`.
3. Keep `PIN_PEPPER_OLD` until every active employee has entered their PIN once, at least one full working week. Then remove it.
4. Employees who never entered a PIN in that time can't sign in at the cashier. The owner sets a new PIN for them («الحضور والانصراف» → the employee → new PIN).

**Changing `PIN_PEPPER` with no `PIN_PEPPER_OLD` breaks every PIN at once.** The owner then has to set every PIN again.

**Before release:** configure `TOTP_KEY` and retain the current and any old legacy `PIN_PEPPER` values. A v1 secret is decrypted using those candidates and rewritten as v2 after a valid, unused authenticator code. If its legacy key is missing, authenticator codes cannot be verified, but an unused recovery code can still be consumed once. If rollout relies on there being no v1 secrets, verify that precondition before release; the production state was not checked in this review.

## Sealing the change log: budget and measured CPU

- Sealing is no longer part of the backup job. It runs on its own in the hourly cron branch (`sealAll`), after reminders, with a budget of `SEAL_BUDGET` rows per run (default **150**, clamped 10–50000). What is left is sealed in the next hour.
- Each prospective seal is first stored under an immutable R2 key in `audit-anchor-history/`, then inserted in D1, then used to update the mutable current anchor. If the history write fails, D1 is unchanged; if the current-anchor write fails, the next run can restore it from that matching history copy. If no trusted copy matches D1, sealing stops.
- The audit check is read-only. Missing, unreadable, mismatched, or unsealed data is reported as unverifiable or changed, never healthy. Only a pharmacy owner can start a new seal epoch, by recording a reason and confirming `REBASELINE_AUDIT_ANCHOR`. The old D1 seals and any readable R2 anchor are preserved, and the action is written to `audit_log`.
- Verification and sealing inventory the full protected R2 history twice, with pagination; newer or conflicting evidence blocks normal operation. An orphaned prospective history copy can require owner review and rebaseline. Inventory cost grows with retained history.
- It logs:
  - `AUDIT_SEAL_BACKLOG` when rows are left over;
  - `AUDIT_SEAL_FAILED` per pharmacy that failed (the others go on);
  - `AUDIT_SEAL_NOT_CONFIGURED` when there is no key.
- Local Node timings do not establish the Cloudflare CPU or subrequest cost of sealing and the full R2 history inventory. Measure both on staging with realistic retained history before release; `SEAL_BUDGET` stays at 150 pending those measurements.
- The check from the app («اتأكد إن السجل محدش لعب فيه») reads at most `VERIFY_MAX_ROWS` rows per request (default **200**), then continues with a signed, owner-bound cursor. It reports success only after all sealed rows and R2 evidence are checked. The cursor expires after 24 hours. D1 does not provide a pinned snapshot across requests, so this result covers the verification interval rather than one instant. A changed seal or R2 anchor during the interval aborts verification. The row limit and R2 history inventory cost still need Cloudflare CPU measurements before any limit is raised.

## What a restore does not bring back (L7, owner decision)

- **Two-step sign-in:** a backup keeps accounts (email, password hash) but not their two-step secrets or recovery codes. After a restore, two-step sign-in is **off** for every account, and each person turns it on again.
- **Seals:** `audit_seals` and R2 anchor history are not in the pharmacy backup. A restored database does not rebuild them automatically. A matching trusted R2 copy can restore the anchor; otherwise the owner must authorize a new seal epoch. Previous seals and any readable anchor are kept as evidence.
- **Decision needed:** keep it this way (simplest, no secrets in backups), or add the encrypted two-step columns to the backup (they are already encrypted with `TOTP_KEY`, so the backup would then depend on that key too).
