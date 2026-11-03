# Saydaliti — Master Audit (Phase 0)

| | |
|---|---|
| Audit date | 2026-11-03 |
| Branch | `ccr-94719aa6-7k3i5e` (identical to `main` at audit start) |
| Commit audited | `7d23b83a17f9be170a17ec9e288424ae6550f577` (Merge PR #49, 2026-10-31) |
| Working tree | Clean before the audit; the only changes are these new documents |
| Scope | Read-only review of the whole repository, plus test runs against **local** D1/R2 (Miniflare). No production system, live database, or pharmacy data was touched. Nothing was deployed. |

Evidence labels used in this document:
- **[RUN]**: I executed it in this session and saw the result.
- **[CODE]**: confirmed by reading the code at the commit above.
- **[PROBE]**: confirmed by sending requests to a local Worker on a throwaway local database.
- **[DOC]**: stated in the existing project docs; not re-verified by me.

---

## 1. Executive summary

Saydaliti is a real, working, multi-platform product. It is not a prototype. It has a Cloudflare Worker API, D1 (SQLite), R2 file storage, a web app and PWA, an Electron desktop app with a fully offline mode, a Flutter WebView Android wrapper, and an importer for United/Genius `.Gen` backups. It also has a fairly broad set of pharmacy features. Every automated test suite passes in this environment [RUN].

The product is **NOT READY** for commercial multi-pharmacy sale and **NOT READY** to replace the system of record at a pharmacy. The main reasons are architectural:

1. **The server trusts the cashier's money figures.** It stores whatever totals, prices, discounts and refunds the client sends. Returns with no receipt are accepted without any extra permission [PROBE].
2. **Stock is not stored anywhere authoritative.** The current stock is recalculated in each browser from: the last uploaded snapshot from the pharmacy program, plus all later purchases, sales and adjustments. As a result:
   - The server cannot stop an oversell or two terminals selling the same last box.
   - Stock can differ between devices.
   - The client loaders stop silently at 20,000–50,000 rows, so large or long-running pharmacies will get stock and finance figures that are wrong without warning [CODE].
3. **There is no automated cloud backup or restore drill for D1.** Backup today means the user exports a file manually, plus a daily local JSON file in the desktop offline mode [CODE].
4. **Any merge to `main` deploys to production and applies D1 migrations to the remote database automatically** [CODE]. That conflicts with the rule "no deploy without explicit approval".

The UI is better than a typical internal tool. It already has a token-based design system, dark mode, an RTL-first layout, a phone layout with a bottom navigation bar, and an Arabic/English toggle. Its problem is information architecture: 7 sections hold 32 tabs, and the same chrome repeats at the top of every screen. A complete rewrite is not justified; a structured redesign on top of the existing tokens is.

There is **no E-Plus code, data sample, or documentation** in the repository. The only pharmacy-program integration is United/Genius. Nothing about E-Plus can be claimed (see `EPLUS_FEATURE_PARITY.md`).

---

## 2. Test evidence (this session)

Environment: Linux container, Node 22.23.4, Playwright Chromium (pre-installed), Wrangler 4.156.0 running `wrangler dev --local` with local D1/R2 and all 10 migrations applied locally.

| Command | Result | Notes |
|---|---|---|
| `npm test` | **173 pass, 0 fail, 17 skipped** (190) [RUN] | The 17 skipped are the Worker tests; they need `WORKER_URL`. They ran separately in the next row. |
| `WORKER_URL=http://localhost:8787 node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs` | **27 pass, 0 fail** [RUN] | API rules, tenant isolation, branch scope, roles, concurrent returns, R2, backup import, and the full app driven through a browser against the local Worker. |
| `npm run e2e` (dashboard + local/offline desktop mode) | **43 pass, 0 fail** [RUN] | Chromium, using the Supabase stub and the local IndexedDB client. |
| `npm audit` (root, runtime) | 0 vulnerabilities [RUN] | |
| `npm audit` (worker) | 0 vulnerabilities [RUN] | |
| `npm audit --package-lock-only` (desktop) | **15 moderate** [RUN] | `minimatch` ReDoS in build tooling (electron-builder chain). Build-time only; the previous docs said 0, which is no longer true. |
| Screenshots of every dashboard tab, the cashier, and phone layouts | Captured [RUN] | 38 screens, used for §8. Not committed (they contain only throwaway test data). |
| Electron app, Android APK, United SQL Server sync | **Not executed here** | They need Windows, Flutter, and SQL Server. CI workflows exist; results are reported in [DOC] `docs/TESTING_REPORT.md` (Actions #80/#106/#111). I did not re-verify them. |
| Load/performance tests | **Not executed; none exist** | |
| Backup → restore on a cloud D1 | **Not executed; no mechanism exists** | |

Earlier QA reports (`docs/TESTING_REPORT.md`, dated 2026-10-31) were produced on the same code line. My runs agree with them for the suites I could execute. They are not evidence for platforms I could not run.

---

## 3. Architecture as built

```
Browser / PWA / Electron (online) / Android WebView
   │  index.html (dashboard, ~274 KB app.js), cashier.html, attendance.html, admin.html
   │  src/cf-client.js — Supabase-shaped query builder → POST /api/db {op,table,filters…}
   │  src/offline.js   — IndexedDB key-value store + outbox (queued writes, "stuck" list)
   │  src/inventory.js — stock = snapshot + catalog + purchases + sales + moves (computed client-side)
   ▼
Cloudflare Worker (worker/src/index.js)
   ├─ auth.js   PBKDF2 passwords, random bearer tokens (hash stored), 60-day sessions, rate limits in D1
   ├─ db.js     generic table API; rules from schema.js (role per op, column whitelist, value checks,
   │            same-pharmacy FK checks, branch scope, audit rows in the same D1 batch)
   ├─ rpc.js    pharmacy/branch/invite/employee/PIN/snapshot/admin/backup-import functions
   ├─ ai.js     Anthropic proxy (tools run on the client), invoice OCR
   └─ crons     morning WhatsApp report, patient reminders (off until WhatsApp is configured)
   ▼
D1 (SQLite): ~27 tables, 10 migrations   ·   R2: snapshots/<id>.json, images/<pharmacy>/<code>

Electron offline mode: src/local-db.js re-implements the same query API on IndexedDB (no server,
no permission checks: single owner, single device), daily JSON backups to Documents\Saydaliti\backups.
Connector: PowerShell / Node / Python readers for United/Genius (.Gen backup parsed in-browser by
src/genius.js; live read-only SQL Server read via desktop/genius-live.ps1).
```

Notes:
- **No build step.** Plain ES modules are served as-is. There is no bundling, minification, code splitting or tree-shaking. `app.js` is 274 KB and `i18n-en.js` (111 KB) loads even for Arabic users [CODE].
- **Very large source files.** `src/app.js` is 3,111 lines and `src/cashier.js` is 1,011 lines. The UI uses `innerHTML` templating with a manual `esc()` (78 `innerHTML` call sites) [CODE].
- **Legacy duplication.** The Supabase client (`supabase-store.js`, `e2e/supabase-stub.js`), Supabase-era RPC naming, and README text about "Vercel + Supabase" are still present. `local-db.js` is a second implementation of the data API, without the server's rules [CODE].

---

## 4. Subsystem status

Status values follow the spec: Complete & verified · Implemented, partially verified · Implemented but unreliable · Partially implemented · Missing · Unknown.

| Subsystem | Status | Evidence / reason |
|---|---|---|
| Authentication (email/password, sessions) | Implemented, partially verified | API tests pass [RUN]. No password reset, no MFA, no session list or revocation UI. The token is in `localStorage` (readable by any XSS). |
| Authorization / roles (6 fixed roles) | Implemented, partially verified | Enforced server-side per table and operation [CODE][RUN]. Roles are fixed: no fine-grained permissions, no per-action permissions (discounts, no-receipt returns, price overrides). |
| Tenant isolation | Implemented, partially verified | Server-side `pharmacy_id` scoping on every query, with a test [RUN]. No independent penetration test. |
| Branch scope (staff) | Implemented, partially verified | Migration 0010 plus tests [RUN]. Rows with no `branch_id` stay visible by role [DOC]. |
| Product catalog | Partially implemented | Code, names, category, price, cost, barcode (one barcode per item plus a `pos_barcodes` alias table), strips/pills, generic, maker, min qty, VAT %, image. Missing: structured strength/dosage form/pack, a units model beyond box/strip/pill, wholesale/min price, multiple suppliers per item, item status lifecycle. The catalog lives partly in uploaded snapshots (R2) and partly in `catalog_items`. |
| POS (cashier) | Implemented but unreliable | Fast keyboard flow, barcode, holds, strips, multiple payment methods, credit/insurance, offline queue, receipts, shifts [RUN]. But the server does not validate money or stock (§6.1), receipt numbers can collide (§6.3), and voiding is not supported (returns only) [DOC]. |
| Inventory (batches, FEFO, expiry) | Implemented but unreliable | FEFO and batch costing are correct in unit tests [RUN]. Stock is computed client-side, is not authoritative, has silent caps, and is reset by every new snapshot upload (§6.2). |
| Stock adjustments / counts / transfers / damage | Implemented, partially verified | `stock_moves` table, owner/stock roles, audited [CODE]. Transfers are two independent rows (not one atomic transfer document). |
| Purchasing / suppliers | Partially implemented | Purchase invoices, supplier returns, payments, cost history, supplier discounts and lead time [DOC][CODE]. There is no supplier table: suppliers live inside `pharmacies.settings` JSON and `supplier_id` is free text. No purchase orders as a document with a status (an "order draft" exists only in the UI). |
| Customers / credit / insurance | Implemented, partially verified | Customers, payments, credit limits, insurance share and claims [CODE]. No loyalty or customer groups. Balances are computed client-side. |
| Accounting / finance | Partially implemented | Net sales, COGS from batch cost, gross profit, expenses, net profit, withdrawals, day close [CODE][RUN]. There is no ledger, no period closing/lock, and no cash-account model. Figures are client-computed from possibly truncated data. Formulas are scattered in `core.js`, `accounts.js` and `sales-report.js` and not documented in one place. |
| Reports / analytics | Implemented, partially verified | Many reports with unit tests [RUN]. All are computed in the browser over the full history; no server-side aggregation; no pagination of results. |
| Offline / sync | Partially implemented | An outbox with client-generated UUIDs gives idempotent inserts [PROBE: a replayed id is ignored]. Rejected entries are kept, not discarded [CODE]. Gaps: no conflict detection for updates (last write wins); no server-side stock check, so offline sales on two terminals cannot be reconciled; sign-out deletes the device copy (it warns first if the queue is non-empty [DOC]). |
| Backup & restore (cloud) | Missing | No scheduled D1 export, no R2 backup, no restore drill. D1 Time Travel exists on Cloudflare's side but is not configured, documented or tested here. |
| Backup & restore (manual export / desktop) | Implemented, partially verified | JSON export and import into a *new* pharmacy (API test passes [RUN]). Desktop daily local backups with a fingerprint check on restore (tested in e2e [RUN]). Backups are unencrypted and include patient data. |
| Audit trail | Partially implemented | `audit_log` rows are written in the same batch for audited tables [CODE]. There is no API to modify them, but they are not tamper-evident. `pos_sales` inserts are not audited (they are immutable rows). No login history. |
| AI assistant | Implemented, partially verified | 14 client-side tools, so the model never sees the DB. Role and plan gated, rate limited [CODE]. Off unless `ANTHROPIC_API_KEY` is set; not exercised against a real model in this audit. Tool results come from the client, so their integrity is only as good as the client data. |
| Forecasting / anomalies / health score | Implemented, partially verified | Statistical, unit-tested [RUN]. Runs client-side. |
| Automation Doctor (system health) | Missing | Only `client_errors` logging plus the admin error list. |
| Multi-tenant SaaS / plans / trial | Partially implemented | Self-signup, trial, plans with server-enforced limits, manual activation [RUN]. No billing; manual payment via InstaPay. |
| United/Genius import & live read | Implemented, partially verified | `.Gen` parser unit-tested on fixtures [RUN]. The live SQL read is CI-tested on a synthetic DB [DOC]. Real pharmacy data: unknown. |
| E-Plus integration | Missing | Nothing in the repository. |
| Electron desktop | Implemented, partially verified [DOC] | Not runnable here. Electron 45 for current Windows; **Electron 22 (end-of-life) build for Win7/8/32-bit** (§7). |
| Android app | Implemented, partially verified [DOC] | A Flutter WebView pointing at the production URL. Not built here. |
| Egyptian tax / e-receipt | Missing | VAT % per item exists. ETA e-receipt is explicitly deferred by the owner [DOC]. No compliance claimed. |
| Hardware (scanner, thermal printer, drawer) | Unknown | Keyboard-wedge scanning and browser printing are coded. No hardware test evidence in the repository. |
| Observability / DR | Missing | Cloudflare observability flag on; client error table. No alerts, RPO/RTO, or runbook. |
| CI/CD | Implemented, partially verified | 4 workflows. **Production auto-deploy and remote migration on every push to `main`** (§7). |

---

## 5. Data model findings

The source of truth is `worker/src/schema.js`; the SQL is generated from it and applied by migrations 0001–0010.

| # | Finding | Severity |
|---|---|---|
| D1 | No authoritative stock table (`stock_levels` / `batches`). Stock = R2 snapshot JSON + later rows, recomputed in each browser (`src/inventory.js`). | P0 (architecture) |
| D2 | Uploading a new pharmacy-program file **replaces the opening balance**. Saydaliti-side activity before it is dropped from the stock calculation (by design while United is the master [DOC]). This cannot work once Saydaliti is the primary system. | P0 for go-live |
| D3 | Sale lines live in a JSON column (`pos_sales.lines`), not in a lines table, so SQL cannot aggregate, index or validate per-item sales. Same for `purchases.lines`. | P1 |
| D4 | `pos_sales.number` has an index but no `UNIQUE (pharmacy_id, number)`. | P0 |
| D5 | Suppliers are not a table; `supplier_id` is free text into settings JSON. Supplier balances cannot be enforced or joined. | P1 |
| D6 | No foreign keys at the SQLite level; integrity is enforced only in `db.js` `checkRefs`. Cascades are done in application code. | P2 |
| D7 | Money is `REAL` (floating point). Rounding happens in the client. A move to integer piasters or a documented rounding rule is needed before accounting features grow. | P1 |
| D8 | `catalog_items` hard-deletes (owner). An item referenced by history can be deleted (audited, but a soft-delete or status is preferable). `purchases` can also be deleted by the owner, which changes historical stock and cost. | P1 |
| D9 | Timestamps are a mix of UTC ISO strings (server) and local-midnight `Date`s (client); "day" boundaries depend on the device's time zone. | P2 |

---

## 6. Critical correctness findings (P0)

### 6.1 The server accepts arbitrary money values on sales and returns [PROBE]

I sent these requests as a `device` (cashier) member to a local Worker on a throwaway database. **Every one returned HTTP 201 (stored):**

| Request | Expected | Actual |
|---|---|---|
| Sale with lines worth 100, `total: 1` | reject | stored |
| Sale with `total: -500` | reject | stored |
| `kind: 'return'` with **no `return_of`**, 50 units of an arbitrary code, `total: -5000` | require receipt or a special permission | stored |
| `discount: 99999` on a 100 sale | bounded and permission-checked | stored |
| A second sale with an existing receipt `number` | reject | stored |
| Sale back-dated to `2020-01-01` | reject, or permission + audit | stored |
| Lines `[{foo:'bar'}]`, `total: 0` | reject (bad line shape) | stored |
| Return against a real 10-EGP sale, refunding at price 9,999 | refund ≤ original line price | stored |
| Replay of the same sale `id` | ignored | ignored ✅ |

Code cause: `checkPosSale` (`worker/src/rpc.js:383`) checks only the return quantity against the receipt, and only when `return_of` is present. `schema.js` has no constraints on `total`/`paid`/`discount`/`credit` beyond type and `discount ≥ 0`, and `lines` is checked only for array length.

Impact: a cashier account or device, or a compromised one, can record fake refunds and manipulate revenue without tripping any server check. The financial reports then believe whatever was sent. This is the most important finding of this audit.

### 6.2 Stock is computed on each device, with silent truncation [CODE]

- `src/app.js:937–948` (`loadTable`) reads at most **50,000** rows per table, newest first, then stops silently.
- `src/cashier.js:81–90` (`loadStock`) reads at most **20,000** `catalog_items`/`purchases`/`stock_moves` rows, **oldest first**. Past the cap the *newest* rows are dropped, which is the worst case for current stock.
- Every report and the stock figure are rebuilt from these arrays in the browser, so two devices can disagree, and the server can never refuse an oversell.
- Scale estimate (an assumption, not measured): a pharmacy with 300 receipts/day reaches 50,000 receipts in about 5.5 months.

### 6.3 Receipt numbers can collide [CODE]

The number is `YYMMDD-<device tag>-<counter>`. The device tag defaults to `K1` on every device, and the counter is in `localStorage` under `saydaliti-pos-count-<day>`. `clearLocal()` removes every `saydaliti-*` key on sign-out, so the counter restarts at 1 the same day. The return lookup (`cashier.js:617`) takes the first sale with that number (`limit(1)`), so it can pick the wrong receipt.

### 6.4 No server-side cloud backup or restore drill [CODE]

D1 is the cloud system of record. The repository has no scheduled export, no copy in R2, and no documented or tested restore. Until a restore has been proven, recovery readiness cannot be claimed.

### 6.5 Production deploys automatically on merge to `main` [CODE]

`.github/workflows/cloudflare.yml` runs `wrangler d1 migrations apply saydaliti --remote` and then `wrangler deploy` on every push to `main`, without an approval gate. Under the working rules, **I will not merge or push to `main`**. Adding a manual approval (a GitHub Environment with required reviewers, or `workflow_dispatch` only) is recommended, but it changes your release process, so it needs your decision.

---

## 7. Security findings

Status of the existing `docs/SECURITY_AUDIT.md` items: the closed items are consistent with what I observed (`npm audit` is clean for root and worker). The desktop lockfile now shows 15 moderate build-time advisories.

| # | Finding | Severity | Evidence |
|---|---|---|---|
| S1 | Financial values not validated server-side (§6.1) | **Critical** | [PROBE] |
| S2 | No per-action permissions: any seller can apply unlimited discounts, make no-receipt returns, sell expired stock with a free-text reason, and back-date sales | High | [PROBE][CODE] |
| S3 | Session bearer token in `localStorage`, 60-day lifetime, no Content-Security-Policy header. Any XSS = account takeover. Mitigation today is manual escaping across 78 `innerHTML` sites. | High | [CODE] `cf-client.js:4`, `index.js:16`, `public-headers` |
| S4 | `hashPin` falls back to the constant pepper `'saydaliti'` if `PIN_PEPPER` is missing. A 4–6 digit PIN space plus a known pepper means PIN hashes can be brute-forced offline from a DB leak. | High | [CODE] `auth.js:43` (already listed in the existing audit) |
| S5 | Windows 7/8/32-bit installer built on **Electron 22.3.27 (end-of-life, Chromium 108, no security patches)**. This violates spec rule 11 ("never sacrifice security for obsolete OS"). | High (decision needed) | [CODE] `.github/workflows/desktop.yml:64–88` |
| S6 | Auto-deploy and remote migrations on push to `main` without an approval gate | High (process) | [CODE] |
| S7 | `PBKDF2_ITER = 10000` (free-plan CPU limit); OWASP guidance for PBKDF2-SHA256 is far higher | Medium | [CODE] `wrangler.toml` |
| S8 | Rate limiting is stored in D1 per IP/email. Works, but the D1 write load grows with attacks. No Cloudflare WAF/rate-limit rules are configured in the repository. | Medium | [CODE] |
| S9 | Desktop backups (`Documents\Saydaliti\backups`) and exported JSON are unencrypted and include patients' names and phones | Medium | [CODE] |
| S10 | AI endpoint: the client supplies `messages` and `tools`, so a signed-in owner/partner could use the server's API key as a general LLM (capped at 60 calls/hour). Tool results are client-asserted. | Low/Medium | [CODE] `ai.js` |
| S11 | No password reset, MFA, login history, or active-session management | Medium (commercial) | [CODE] |
| S12 | Audit log is not tamper-evident (no hash chain); readable by the owner only | Low/Medium | [CODE] |
| S13 | Desktop build tooling: 15 moderate `minimatch` advisories | Low (build-time) | [RUN] |

Positive controls observed: parameterised SQL with a column whitelist (no SQL injection path found in `db.js`); hashed session tokens; constant-time password comparison; tenant scoping on every query; Electron `contextIsolation: true` and `nodeIntegration: false` with navigation and window-open handlers; SRI on the SheetJS CDN script; the connector's restore scripts refuse to touch a database not created by Saydaliti.

---

## 8. UI/UX findings (summary; `docs/design/UX_AUDIT.md` follows in the UX phase)

Based on 38 screenshots at 1366×800 and 390×844, all with test data.

What is already good:
- A coherent token set (`src/style.css`): a restrained palette with one accent and semantic red/amber/green, Arabic-friendly fonts (Alexandria / IBM Plex Sans Arabic), real light and dark themes (not inverted), and RTL-native layout.
- The cashier screen is focused: a large search box, the cart, a clear amount due, F2/Esc/F4 shortcuts, and big payment buttons.
- The phone layout has a real bottom navigation bar (not a shrunken desktop).

Problems:
1. **Information architecture overload.** 7 sections hold 32 tabs. Some labels are unclear without context ("البيع" holds offers and market prices, not selling). Selling itself (the cashier) is a separate page in the rail's secondary area.
2. **Repeated chrome before content.** Every section shows the page title, an owner filter, the upload button, an English toggle, the trial banner, and 4 inventory KPI tiles before its own content. That is about 330 px at 1366×800 and most of the first screen on a phone.
3. **The default landing tab is the last one used**, not a "today" view. There is no single answer to "how is today going?".
4. **Mixed concerns inside tabs.** For example, "اطلب إيه" puts the reorder table, a WhatsApp order composer, and a full supplier-management form on one long page.
5. **Visual bug:** the side rail does not extend the full height on long pages (`02-dashboard-default.png`).
6. **Copy register:** all copy is colloquial Egyptian Arabic. That fits the pilot, but a commercial product may need a Modern Standard Arabic option. English is a dictionary overlay that falls back to Arabic for any missing string.
7. **Phone:** the header packs 5 icons; the bottom bar has 7 items, with the most used item (the cashier) absent from it.
8. **Forms** are long, single-page and always fully expanded (e.g. supplier creation is always open under the reorder table).

Recommendation: an **evolutionary redesign**. Keep the tokens and RTL foundation. Rebuild the information architecture around daily jobs (Today, Sell, Stock, Buy, Money, Customers, Settings). Turn shared chrome into a compact contextual header. Extract reusable components from `app.js`. A visual rewrite from scratch would discard working, tested behaviour for no measurable gain.

---

## 9. Performance findings

| Finding | Evidence |
|---|---|
| No bundling or code splitting; the dashboard loads ~274 KB `app.js` plus 111 KB English dictionary plus other modules unminified | [CODE] |
| The full history of sales, purchases, moves, customers and payments is downloaded and processed on the UI thread at load | [CODE] |
| The snapshot (multi-MB JSON from R2) is downloaded whole by every client | [CODE] |
| No virtualisation for long tables | [CODE] |
| No performance measurements exist; no targets defined | — |
| Service worker caches the shell network-first; fine | [CODE] |

None of this has been measured yet. Benchmarks are a later phase and must use representative data volumes.

---

## 10. Documentation inventory

Existing (Arabic): `docs/ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `FEATURES_STATUS.md`, `TESTING_REPORT.md`, `SECURITY_AUDIT.md`, `PROJECT_ANALYSIS.md`, `PROJECT_ROADMAP.md`, `SAAS_ARCHITECTURE.md`, `AI_SYSTEM_DESIGN.md`, `DEPLOYMENT_GUIDE.md`, `DEVELOPMENT_LOG.md`, `CHANGELOG.md`.

Accuracy issues found:
- `FEATURES_STATUS.md` marks POS, inventory valuation and "منع الرصيد السالب" (preventing negative stock) as ✅. These are client-side behaviours only; the server does not enforce them (§6.1, §6.2).
- `FEATURES_STATUS.md` marks Windows 7 as ✅. It works only via an end-of-life Electron (S5).
- `TESTING_REPORT.md` says desktop `npm audit` is 0. It is now 15 moderate (S13).
- `ARCHITECTURE.md` says "no branch scope for members" in one paragraph, which was superseded by migration 0010.

Plan: keep these files, and move or merge them into the spec's structure (`docs/architecture/`, `docs/security/`, …) as each phase touches them. No duplicates will be created.

---

## 11. Prioritised backlog (evidence-based)

### P0: integrity, safety, recoverability

| ID | Task | Why (finding) | Size |
|---|---|---|---|
| P0-1 | Server-side validation of `pos_sales`: line shape; `total` recomputed from lines, discounts, tax and delivery fee within a rounding tolerance; sign rules for sale/return; discount bounds; return refund ≤ original line price; no-receipt returns and back-dated sales only with an explicit permission and reason. Regression tests for every probe in §6.1. | 6.1, S1, S2 | M |
| P0-2 | Receipt numbering: `UNIQUE (pharmacy_id, number)` via a migration (after checking existing duplicates read-only), a unique device tag per device, and a counter that survives sign-out (or server-assigned numbers). | 6.3, D4 | S–M |
| P0-3 | Stop silent truncation: the loaders must detect the cap and report it, never compute on partial data (a stopgap until P0-5). | 6.2 | S |
| P0-4 | Deployment gate: production deploy and remote migrations only after manual approval. **Needs your decision.** | 6.5, S6 | S |
| P0-5 | **Server-authoritative stock ledger**: `stock_batches` / `stock_movements` maintained atomically in the same D1 batch as sales, purchases and moves; FEFO on the server; configurable negative-stock policy enforced by the server; the client shows the server stock. Design doc first (`ARCHITECTURE.md` + `OFFLINE_SYNC.md`), with a migration that back-fills from existing data and is verified by reconciliation against the current client calculation. | 6.2, D1, D2 | L |
| P0-6 | Cloud backup: scheduled D1 export to R2 (per tenant), integrity check, retention, and a **restore drill into an isolated local/staging D1** with consistency checks. Production configuration needs your approval. | 6.4 | M |
| P0-7 | `PIN_PEPPER` required (fail closed), plus a CSP header and a review of the token storage strategy. | S3, S4 | S |
| P0-8 | Windows 7/8 decision (keep the EOL Electron 22 build, or drop it and document it as unsupported). **Needs your decision.** | S5 | S |

### P1: core ERP completeness

Supplier table and supplier ledger (D5); purchase orders with status; per-action permissions (discount limit, void, price override, no-receipt return); void/cancel with audit; financial formulas documented in one place (`docs/quality/FINANCIAL_INVENTORY_INTEGRITY.md`); money precision rule (D7); soft-delete for items and purchases (D8); period close/lock; atomic branch transfer document; sale and purchase lines as tables or indexed projections (D3).

### P2: complete UX

UX audit document; information-architecture redesign; component extraction from `app.js`/`cashier.js`; Today dashboard; reduced chrome; POS polish; phone navigation; accessibility pass; a build step with code splitting; virtualised tables; server-side report aggregation.

### P3: advanced

Automation Doctor; AI on server-side tools backed by the stock ledger; anomaly detection on server data; forecasting improvements.

### P4: integration and commercialisation

E-Plus discovery and migration (blocked on samples); import/export hardening; billing; licensing; tenant backups; support tooling.

---

## 12. Proposed phase sequence

| Phase | Content | Exit criteria |
|---|---|---|
| **1** | P0-1, P0-2, P0-3, P0-7 (+ P0-4 and P0-8 if you decide) | Every §6.1 probe rejected by a test; unique receipt numbers enforced; no silent truncation; all existing suites still green |
| **2** | P0-5 stock ledger (design → migration → dual-run reconciliation) + P0-6 backups and restore drill | Server refuses an oversell under concurrent sales; reconciliation report matches; restore drill passes on isolated D1 |
| **3** | UX: UX audit, IA redesign, design-system components, POS and Today screens, build step | Usability tasks measured before and after; RTL and LTR, light and dark, desktop and phone screenshots |
| **4** | P1 ERP completeness (suppliers, POs, permissions, voids, period close, financial formula doc) | Tests per workflow; formulas documented |
| **5** | Performance benchmarks, Automation Doctor, AI on server data | Measured targets met |
| **6** | E-Plus discovery and isolated migration test; pilot plan | Field mapping verified on authorised samples |

Phases 1 and 2 come before the UX redesign on purpose. A redesigned screen on top of numbers the server does not guarantee would make the product look ready when it is not.

---

## 13. Questions and inputs needed from you

1. **Production status:** Is `saydaliti.mosaedapp.workers.dev` used today by real pharmacies with real data? This decides how cautious the Phase 1/2 migrations must be.
2. **Pilot pharmacy system:** The spec says the pilot uses **E-Plus**, but the code integrates **United/Genius**. Which one does the pilot use? If it is E-Plus: what version, and can you provide authorised, non-sensitive sample exports or screenshots?
3. **Deploy gate (P0-4):** May I change the workflow so that production deploy needs manual approval?
4. **Windows 7/8 (P0-8):** Keep the end-of-life Electron 22 installer, or drop it and document Win7 as unsupported?
5. **Approval to start Phase 1** as defined in §12.
