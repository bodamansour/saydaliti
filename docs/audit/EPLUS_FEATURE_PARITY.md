# E-Plus Feature Parity

Last updated: 2026-11-03 (Phase 0).

## Status: no E-Plus evidence available

The repository contains **no** E-Plus code, documentation, screenshots, exports, or sample data. A search for `e-plus`, `eplus`, `إي بلس` and `اي بلس` found nothing. The only pharmacy-program integration in the code is **United/Genius** (`src/genius.js`, `connector/`, `desktop/genius-live.*`).

So no claim of E-Plus parity, compatibility or migration support can be made. Per the spec, the United/Genius connector must never be pointed at an E-Plus database.

## Evidence needed (from the product owner)

1. The E-Plus version used by the pilot pharmacy.
2. Authorised, non-sensitive screenshots of the main E-Plus screens (sale, return, item card, receiving, stock count, reports).
3. Sample exports (CSV/XLSX/PDF) of: the item list, stock with batches and expiry, sales for a period, purchases, suppliers, and customer balances. Anonymised or test data only.
4. The list of E-Plus features the pharmacy uses daily (user-reported).

## Comparison matrix

Status values: Verified in E-Plus · Reported by user · Not verified · Implemented in Tablix Pharma · Missing in Tablix Pharma · Requires integration testing.

The Tablix Pharma column comes from `docs/audit/MASTER_AUDIT.md` §4. The E-Plus column stays "Not verified" until evidence arrives.

| Feature | E-Plus | Tablix Pharma | Evidence | Status |
|---|---|---|---|---|
| Barcode POS sale | Not verified | Implemented (server does not validate totals) | MASTER_AUDIT §6.1 | Not verified |
| Return against receipt | Not verified | Implemented (quantity checked server-side) | api.test.mjs | Not verified |
| Sale void / cancel | Not verified | Missing (returns only) | FEATURES_STATUS.md | Missing in Tablix Pharma |
| Batches / expiry / FEFO | Not verified | Implemented client-side | inventory tests | Not verified |
| Server-enforced stock | Not verified | Missing | MASTER_AUDIT §6.2 | Missing in Tablix Pharma |
| Purchase invoices / supplier returns | Not verified | Implemented | code | Not verified |
| Purchase orders (document with status) | Not verified | Missing | code | Missing in Tablix Pharma |
| Supplier accounts | Not verified | Partial (no supplier table) | MASTER_AUDIT D5 | Not verified |
| Customer credit / insurance | Not verified | Implemented | code | Not verified |
| Multi-branch | Not verified | Implemented | api tests | Not verified |
| Shifts / cash count | Not verified | Implemented | e2e | Not verified |
| Data import from E-Plus | — | Missing | — | Requires integration testing |
