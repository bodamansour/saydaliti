# Saydaliti — Master Progress

**Source of truth for project progress.** Read this first at the start of every session, then check `git status`, the branch and the latest commit before trusting anything written here.

## Current state

| | |
|---|---|
| Current phase | **Phase 1 (approved 2026-11-03): isolated development/test environment only. In progress.** |
| Branch | `ccr-94719aa6-7k3i5e` |
| Base commit audited | `7d23b83` (= `main` at 2026-10-31) |
| Production | Not touched. Nothing deployed. No live database accessed. |
| Release decision | **NOT READY** (see MASTER_AUDIT §1) |

## Completed

| Task | Priority | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| Phase 0 repository audit | — | Done | `docs/audit/MASTER_AUDIT.md` | `npm test` 173/0/17 skipped; Worker API + Cloudflare e2e 27/0; `npm run e2e` 43/0; `npm audit` root/worker 0, desktop 15 moderate; local probes of the sale API | MASTER_AUDIT §2, §6.1 |
| E-Plus parity skeleton | P4 | Done (no evidence available) | `docs/audit/EPLUS_FEATURE_PARITY.md` | — | Repository search found no E-Plus material |

## Phase 1 milestones

| # | Milestone | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| M1 | Production-safety investigation; manual-only production release; Windows 7/8 unsupported | **Done** | `docs/deployment/DEPLOYMENT_AND_RELEASE.md`, `.github/workflows/{cloudflare,test,desktop}.yml`, `test/release-workflow.test.js` | `node --test test/release-workflow.test.js` 5/5 pass (includes running the guard script with right/wrong branch and confirmation); YAML parse of all 4 workflows OK. actionlint could not be downloaded (blocked in this environment). The workflows have not run on GitHub yet: they need a PR or a manual run, and I did not trigger a manual run because it targets production. | Production deploy evidence: Actions run 41218360186 |
| M2 | Server-side validation of sales and returns (P0-1) | **Done** | `src/sale-rules.js` (rules), `worker/src/rpc.js` `checkPosSale`, `worker/src/db.js` `guardedSaleInsert`, `src/local-db.js` (desktop offline mode uses the same rules), `src/supabase-store.js` (Arabic messages) | `test/sale-rules.test.js` 8/8 (incl. 2,000 random receipts built with the cashier's own functions); `worker/test/api.test.mjs` 21/21 on local Worker/D1/R2 | Probe before/after in the Phase 1 report |
| M3 | Durable unique receipt numbers (P0-2) + migration 0011 | **Done** | `src/pos.js`, `src/cashier.js`, `worker/migrations/0011_receipt_numbers.sql`, `worker/src/schema.js` | Migration applied, rolled back and re-applied on a local D1 that holds 3 legacy duplicate numbers (29 rows preserved); a direct SQL duplicate insert is refused by the index; API race test; browser test `receipt numbers stay unique across devices and after the saved counter is lost` | `e2e/cloudflare.e2e.mjs` 12/12 |
| M4 | Explicit errors when loading reaches a limit or fails (P0-3) | **Done** | `src/paged.js` (one reader), `src/app.js` `loadTable` + full backup, `src/cashier.js` loaders, `#dataAlert` in `index.html`/`cashier.html` | `test/paged.test.js` 4/4; browser test `a table too big to load whole is reported on screen` (server stubbed to always have more rows) on dashboard and cashier | The full backup now stops with the reason instead of saving a backup with a table missing. Caps are unchanged (50k dashboard; cashier raised from 20k to 50k), but are now explicit; Phase 2 removes them |
