# Saydaliti — Master Progress

**Source of truth for project progress.** Read this first at the start of every session, then check `git status`, the branch and the latest commit before trusting anything written here.

## Current state

| | |
|---|---|
| Current phase | **Phase 1 follow-ups done; PR opened for CI; Phase 2 (M1 inventory, M2 backup) authorized for isolated implementation only.** |
| Branch | `ccr-94719aa6-7k3i5e` (not merged) |
| Base commit | `7d23b83` (= `main` at 2026-10-31) |
| Production | **Not modified.** No deploy, no remote migration, no live database or Cloudflare account access, and no request to the production site. GitHub Actions run history was read (metadata only). |
| Release decision | **NOT READY** (Phase 2 items: server-side stock, cloud backup with a restore drill) |

## Completed

| Task | Priority | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| Phase 0 repository audit | — | Done | `docs/audit/MASTER_AUDIT.md` | `npm test` 173/0/17 skipped; Worker API + Cloudflare e2e 27/0; `npm run e2e` 43/0; local API probes | MASTER_AUDIT §2, §6.1 |
| E-Plus parity skeleton | P4 | Done (no evidence available) | `docs/audit/EPLUS_FEATURE_PARITY.md` | — | Repository search found no E-Plus material |

## Phase 1 milestones

| # | Milestone | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| M1 | Production-safety investigation; manual-only production release; Windows 7/8 unsupported | **Done** | `docs/deployment/DEPLOYMENT_AND_RELEASE.md`, `.github/workflows/{cloudflare,test,desktop}.yml`, `test/release-workflow.test.js` | `test/release-workflow.test.js` 5/5 (includes running the guard script with a right/wrong branch and confirmation); YAML parse of all workflows OK. actionlint could not be downloaded here. The workflows have **not** run on GitHub (that needs a PR; a manual run would target production). | Production deploy evidence: Actions run 41218360186 |
| M2 | Server-side validation of sales and returns (P0-1) | **Done** | `src/sale-rules.js`, `worker/src/rpc.js` `checkPosSale`, `worker/src/db.js` `guardedSaleInsert`, `src/local-db.js`, `src/supabase-store.js` | `test/sale-rules.test.js` 8/8 (incl. 2,000 random cashier receipts); API tests on local Worker/D1/R2 | Before/after table below |
| M3 | Durable unique receipt numbers (P0-2) + migration 0011 | **Done** | `src/pos.js`, `src/cashier.js`, `worker/migrations/0011_receipt_numbers.sql`, `worker/src/schema.js` | Migration applied, rolled back and re-applied on a local D1 holding 3 legacy duplicate numbers (29 rows preserved); a direct SQL duplicate is refused by the index; API race test; browser numbering test | See "Database migration impact" |
| M4 | Explicit errors when loading reaches a limit or fails (P0-3) | **Done** | `src/paged.js`, `src/app.js` (`loadTable`, full backup), `src/cashier.js`, `#dataAlert` in `index.html`/`cashier.html` | `test/paged.test.js` 4/4; browser test with a server that always has more rows (dashboard + cashier) | The full backup now stops with the reason instead of saving a backup with a table missing |
| M5 | PIN secret fail-closed; endpoint authorization review; CSP and browser security headers (P0-7) | **Done** | `worker/src/auth.js`, `worker/src/index.js`, `worker/public-headers`, `docs/security/SECURITY_AUDIT.md` | `test/pin-secret.test.js` 2/2; e2e CSP sweep of every tab and page (0 violations) with a negative control | `docs/security/SECURITY_AUDIT.md` "Phase 1" |

## Phase 1 follow-ups (owner decisions of 2026-11-03)

| # | Item | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| F1 | Returns without a receipt need a manager's approval: the owner flags employees; the approver types their own PIN; the server keeps an immutable approval bound to that return (id, amount, reason, cashier, approver, account) | **Done** | migration `0012_return_approvals.sql`, `worker/src/rpc.js` (`approve_no_receipt_return`, `checkApproval`), `src/cashier.js` (approval dialog), `src/attendance-app.js` (owner checkbox), `src/local-db.js` | API test (refusals: no approval, flag not set, device can't set it, wrong PIN, same person, no cashier, no reason, positive amount, reuse, other amount/cashier; record + audit; owner-only writes); browser tests on the local Worker and on the stub; migration apply/rollback/re-apply on a local D1 (237 receipts, 19 employees preserved) | commit 28a5529 |
| F2 | Delayed and offline receipts: inspected; reused id with other contents refused (409, kept on the device); odd times flagged, never refused; late-receipt policy **proposed, not enforced** | **Done** | `worker/src/db.js` (`sameReceipt`), `worker/src/rpc.js` (`timeFlags`), `src/app.js` (log labels), `docs/architecture/OFFLINE_SYNC.md` | API test for retries, conflicts, late-but-normal receipts and each flag | commit 9a33ad9 |

## Final Phase 1 test results (this environment, 2026-11-03)

| Suite | Result |
|---|---|
| `npm test` (unit) | **215 tests: 193 pass, 0 fail, 22 skipped.** The skipped ones are the Worker API tests; they need `WORKER_URL` and ran in the next row. |
| `WORKER_URL=… node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs` (local Worker, local D1/R2, migrations 0001–0011) | **35 pass, 0 fail** |
| `npm run e2e` (dashboard + offline desktop mode, Chromium) | **43 pass, 0 fail**, 5 consecutive runs after the test fix below |
| `git diff --check`, `node --check` on all `src/` and `worker/src/` files | Clean |
| Not executed | Electron app, Android APK, United SQL Server sync (need Windows/Flutter/SQL Server); GitHub Actions runs of the changed workflows |

Test changes that are not new tests:
- `worker/test/api.test.mjs`: existing fixtures now send `paid`, which the cashier always sends. One fixture had `total: 20` with `delivery_fee: 5`; the cashier puts the fee inside the total, so it is now 25.
- `e2e/dashboard.e2e.mjs` "English interface": it compared the whole section button text with `'Stock'`. The button also shows the urgent-items count (`Stock\n3`), and only passed when it read the text before the count appeared. The original commit shows the same count. It now reads the label element (`.sec .lbl`); the check itself is unchanged.
- `e2e/cloudflare.e2e.mjs`: the new numbering test runs after the backup test, which expects a fixed stock count.

## Before/after: every invalid request from the audit

Same request shape, sent as a `device` (cashier) member to a local Worker. "Before" = audit at `7d23b83`.

| Request | Before | After |
|---|---|---|
| Sale whose total (1) does not match its lines (100) | 201 stored | **400** `sale total does not match its lines` |
| Sale with total −500 | 201 stored | **400** `sale total must not be negative` |
| Return with no receipt and no reason (50 × 100) | 201 stored | **400** `a return without a receipt needs a reason`. With a reason: stored **and written to `audit_log`**. |
| Discount 99,999 on a 100 sale | 201 stored | **400** `sale discount more than the items` |
| Second receipt with an existing number | 201 stored | **409** `receipt number already used` (atomic, also under concurrency) |
| Sale dated tomorrow | 201 stored | **400** `sale time in the future` (10 minutes clock tolerance) |
| Sale dated 2020 | 201 stored | **201 stored (unchanged, open question)**. Offline receipts legitimately arrive late, and no limit is defined. `created_at` is now always the server's time, so late arrivals are visible. |
| Lines `[{foo:'bar'}]`, total 0 | 201 stored | **400** `bad sale line 1: code` |
| Return refunding 9,999 against a 10 sale | 201 stored | **400** `return price more than sold` |
| Return of a discounted item at full price | 201 stored | **400** `refund more than paid` |
| Replay of the same sale id | ignored | ignored (unchanged), also when the two requests arrive at the same time |

## Database migration impact

- **0011_receipt_numbers.sql** (new): `ALTER TABLE pos_sales ADD COLUMN receipt_device TEXT` plus `CREATE UNIQUE INDEX … (pharmacy_id, number) WHERE receipt_device IS NOT NULL`.
  - Additive. No existing row is changed or rewritten. It cannot fail on existing duplicate numbers, because only new rows carry the column.
  - Older app builds keep working (they don't send the column). All receipts are still checked for duplicate numbers by the guarded INSERT.
  - Tested locally: apply → rollback (`DROP INDEX …; ALTER TABLE pos_sales DROP COLUMN receipt_device;`) → re-apply. Row count and data identical.
  - **Not applied to production.** It will be applied by the next manual production release, after you approve it.
- **0012_return_approvals.sql** (new, F1): `employees.can_approve_returns` (default 0), `pos_sales.approval_id`, and the `return_approvals` table with a unique `return_id` index.
  - Additive. Existing employees can't approve until the owner flags them; existing rows are unchanged.
  - Tested locally: apply → rollback (`DROP TABLE return_approvals; ALTER TABLE pos_sales DROP COLUMN approval_id; ALTER TABLE employees DROP COLUMN can_approve_returns;`) → re-apply. 237 receipts and 19 employees preserved.
  - **Rollback limitation:** after rollback, approvals already recorded are lost. Take a D1 bookmark first.
  - **Not applied to production.**
- No other schema changes. Column checks were added in `schema.js` (bounds on `total`, `paid`, `credit` and `discount`); those run in the Worker, not in SQL.

## Deployment preconditions (for whenever the owner approves a release)

1. The `PIN_PEPPER` secret must exist on the production Worker; the release workflow refuses to deploy without it. If production never had it, existing cashier PINs were hashed with the old built-in value and must be re-entered once after the secret is set.
2. Receipts queued offline by an older app build that break the new rules are **not discarded**. They stay in the device's refused list with the reason and can be retried, saved or discarded by the owner. The old cashier always sent consistent totals and `paid`, so none are expected.
3. Take a D1 Time Travel bookmark before migrating (`docs/deployment/DEPLOYMENT_AND_RELEASE.md` §5).
4. Optional: add required reviewers to the `production` GitHub Environment.

## Blocked / waiting for the owner

1. Review Phase 1 and decide on the release (production deploy needs separate approval).
2. **Business rules not invented, waiting for a decision:**
   - ~~Should no-receipt returns need a manager approval?~~ **Decided 2026-11-03:** yes, an employee the owner flags, with their own PIN (F1).
   - Late receipts: the proposed policy in `docs/architecture/OFFLINE_SYNC.md` §3 (72 h / 30 days / closed day) needs the owner's decision **after** pilot lag measurements. Today: no limit; arrival time recorded; odd times flagged (F2).
3. E-Plus: version and authorised sample exports or screenshots (`EPLUS_FEATURE_PARITY.md`).
4. Hosted staging environment: needs Cloudflare resources created on the owner's account (`DEPLOYMENT_AND_RELEASE.md` §4).
5. Approval to start Phase 2 (server-side stock ledger, cloud backup and restore drill).

## Known bugs / limits (confirmed)

| Item | Status |
|---|---|
| Server accepted invalid sales and returns | **Fixed in Phase 1** (table above) |
| Duplicate receipt numbers | **Fixed for new receipts**; legacy duplicates in existing data are left untouched |
| Silent truncation of loaded data | **Fixed**: an explicit alert, never partial data. The 50,000-row cap itself remains until Phase 2. |
| Stock computed in each browser; the server cannot stop an oversell | Open: Phase 2 |
| No cloud backup or restore drill | Open: Phase 2 |
| Side rail does not reach full height on long pages | Open: UI phase |

## Known risks

- Changed workflows have not run on GitHub yet. The first PR will run `test.yml`; the release workflow runs only on a manual dispatch from `main`.
- Desktop (Electron) and Android builds were not run in this environment.
- Session token in `localStorage`; `style-src 'unsafe-inline'` (see the security doc).
- Production usage is unconfirmed; it is treated as holding real data.
- A return without a receipt now needs a connection and staff PINs set up (by design, F1). A pharmacy that has no employees can no longer make such returns until the owner adds staff and flags an approver.
- New Arabic strings (approval dialog, log flags) have no English translation yet; they show in Arabic in English mode.
- `local-db.js` (desktop offline mode) applies the approval rules, but only by code review: no automated test covers that path (it needs IndexedDB in a browser test).
- Intermittent test: 1 failure in about 11 runs of the combined Worker + Cloudflare browser suite, at the item-file upload step of the first browser test (not changed in this phase); not reproduced in the next 8 runs; cause unknown.

## Architectural decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-11-03 | Fix server-side integrity (Phases 1–2) before the UI/UX redesign | A redesigned UI on top of unguaranteed numbers would misrepresent readiness |
| 2026-11-03 | Evolutionary redesign on the existing token system rather than a rewrite | MASTER_AUDIT §8 |
| 2026-11-03 | Keep the existing `docs/*.md`; move or merge them into the spec's folders when each phase touches them (`SECURITY_AUDIT.md` moved to `docs/security/`) | Avoid duplicate documents |
| 2026-11-03 | Production release is manual-only from `main` (owner decision 3) | Merge ≠ deploy |
| 2026-11-03 | Windows 7/8/32-bit unsupported; no Electron 22 build (owner decision 4) | End-of-life runtime |
| 2026-11-03 | Receipt rules restate the cashier's existing arithmetic (`src/sale-rules.js`), shared by the Worker and the desktop offline database | No invented business rules; one implementation |
| 2026-11-03 | Receipt uniqueness via a guarded INSERT plus a partial unique index on the new `receipt_device` column | Cannot fail on legacy duplicates; atomic under concurrency |
| 2026-11-03 | The manager for a no-receipt return is an employee the owner flags (`can_approve_returns`), approving with their own PIN online (owner decision) | Uses the existing PIN check and roles; no PIN stored on devices |
| 2026-11-03 | Late receipts: detect and flag, don't refuse, until the owner sets a policy from measured lags | Owner decision 2: no arbitrary threshold |

## UI/UX redesign progress

Not started (by instruction). Audit findings: MASTER_AUDIT §8.

## Performance benchmarks

None measured yet.

## E-Plus integration status

No evidence. The pilot pharmacy uses E-Plus (owner, 2026-11-03), version unknown. The United/Genius connector is **not** an E-Plus connector and must not be pointed at E-Plus.

## How to reproduce the test runs

```bash
npm ci && npm test
(cd worker && npm ci && npm run build && printf 'PIN_PEPPER=ci-pepper\nSIGNUP_PER_HOUR=10000\n' > .dev.vars \
  && npx wrangler d1 migrations apply saydaliti --local && npx wrangler dev --local --port 8787) &
WORKER_URL=http://localhost:8787 node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs
npm run e2e
```
Restart `wrangler dev` after adding files under `src/` or changing `worker/public-headers`: it fixes its static files and headers when it starts.

## Next exact actions

1. Owner reviews Phase 1 and answers the questions in "Blocked".
2. If approved: open a PR for this branch so `test.yml` runs on GitHub (it doesn't deploy).
3. Phase 2 design document: server-side stock ledger (`docs/architecture/ARCHITECTURE.md`, `OFFLINE_SYNC.md`) and cloud backup with a restore drill.

## Session log

- **2026-11-03 (Phase 0):** Audit. Ran every suite runnable on Linux, probed the sale API locally, captured screenshots of all 32 tabs plus the cashier and phone layouts. No application code changed.
- **2026-11-03 (Phase 1):** Milestones M1–M5 above. Commits on `ccr-94719aa6-7k3i5e` after `0fc1522`. Production untouched.
- **2026-11-03 (Phase 1 follow-ups):** F1 manager approval (`28a5529`), F2 offline receipts (`9a33ad9`). Production untouched.
