# Real-World Pilot Plan (E-Plus stays the operational system)

Status: **plan, not started.** Last updated: 2026-11-03.

## 0. Ground rules

- **E-Plus remains the system of record** for sales, stock and accounts throughout the observation phases. Tablix Pharma runs alongside it; nothing in Tablix Pharma changes E-Plus.
- **No connection to the E-Plus database** and no writes to it. Data comes in only as **authorised exports** that the owner provides. The United/Genius connector is **not** used for E-Plus.
- Staging uses synthetic data only. Real pharmacy data enters Tablix Pharma only in phase 2 and later, with the owner's written go-ahead per phase, into a production pharmacy record that the owner controls. Production deployment needs its own approval.
- Every phase has explicit exit criteria. The **rollback is always the same**: stop using Tablix Pharma and keep working in E-Plus as today. Nothing in E-Plus depends on Tablix Pharma.

## 1. Phases

| Phase | What happens | Data | Exit criteria (all must hold) |
|---|---|---|---|
| **P0: Staging rehearsal** | The full scripted scenario set (§3) on staging, by the team | Synthetic | All scenarios pass. Backup restore drill passes on Cloudflare. No open P0/P1 defect. |
| **P1: Read-only comparison** | Daily E-Plus exports (items, stock with batches and expiry, sales, purchases) are imported into a **test pharmacy** and compared with E-Plus totals (§4) | Real exports, test pharmacy, owner-approved | 10 consecutive business days with stock differences ≤ 0.5% of items, explained or 0, and money totals equal to the piastre (or every difference explained) |
| **P2: Shadow cashier** | One counter also records each sale in Tablix Pharma; E-Plus is still the system of record. Opening from the E-Plus numbers each morning; "block selling below zero" **on** in that branch (owner decision 2026-11-03). | Real, one branch, one counter | 10 business days. Every Tablix Pharma receipt matched to an E-Plus receipt. No receipt lost. Refused receipts explained. Shift cash reconciles. Staff can complete the scripted tasks unaided (§5). |
| **P3: Limited operational use** | One branch uses Tablix Pharma for one defined workflow (e.g. expiry and reorder, or a second counter). E-Plus is still the source for accounts. | Real | Owner sign-off. Daily backups verified. A restore drill on staging from a production-shaped backup. Release approval. |

Moving between phases is the owner's decision, based on the discrepancy report (§4).

## 2. Who does what (permissions)

| Person | Tablix Pharma role | Can | Cannot |
|---|---|---|---|
| Owner | `owner` | Everything; sets stock policy; opens server stock; flags approvers; backups | — |
| Pharmacist at the counter | `pharmacist` (one branch) or the counter `device` account plus a personal PIN | Sell; return against a receipt | Change prices or stock; approve their own no-receipt return |
| Shift manager | Employee flagged "may approve returns" (own PIN) | Approve no-receipt returns at the counter | — (an approval is recorded with their name) |
| Stock person | `stock` | Deliveries, counts, damage, transfers; open server stock | Sell; payments |
| Accountant | `accountant` | Expenses, supplier and customer payments, reports | Sell; stock |

Training (about 1 hour per role, on staging first):
- the cashier: sale, return, offline banner, refused receipts;
- the manager: approval, the refused list;
- the stock person: delivery and count, opening the server stock;
- the owner: comparison, discrepancy report, backups.

## 3. Synthetic scenario set (staging, before any real data)

| # | Scenario | Expected result |
|---|---|---|
| S1 | Sale online, cash / card / wallet / on account / insurance | Confirmed by the server; stock −1; totals in reports |
| S2 | Return against a receipt (partial, then the rest) | Stock back; refund ≤ paid; can't exceed sold |
| S3 | Return without a receipt | Needs a reason, the cashier's PIN and a flagged manager's PIN; recorded |
| S4 | Delivery with bonus; supplier return | Stock +qty+bonus / −qty; supplier balance |
| S5 | Count and damage adjustment | Stock follows; a loss in accounts |
| S6 | Two counters sell the last box together (block on) | Exactly one sale; the other told "not enough stock" before printing |
| S7 | Counter offline sells; another counter sells the last box online; first reconnects | Offline one shown **refused** with the reason, kept; accepted after a restock |
| S8 | Counter restarts with receipts waiting | Sent on start, once each |
| S9 | Network drops mid-sync | Unsent ones keep waiting; nothing doubled |
| S10 | Device clock wrong (ahead / behind) | Ahead refused (fix the clock); behind counted and flagged |
| S11 | End of day: shift close, day close | Expected vs counted cash; day totals; late receipts for a closed day flagged |
| S12 | New E-Plus export uploaded mid-day | Server stock marked stale (block paused) until reopened; the owner is told |

S6–S10 are automated (`worker/test/stock.test.mjs`, `e2e/offline-sync.e2e.mjs`) and run in the staging workflow. The rest are done by the team with the checklist.

## 4. Discrepancy report (daily in P1/P2)

Produced from the E-Plus export of the day and Tablix Pharma's numbers (dashboard → «قارن رصيد السيرفر بالبرنامج» for stock; «الأرباح» / «الفواتير والمبيعات» for money).

| Section | Columns |
|---|---|
| Stock | item code · name · E-Plus qty · Tablix Pharma app qty · Tablix Pharma server qty · difference · explanation |
| Sales | day · E-Plus receipts / total · Tablix Pharma receipts / total · unmatched receipts (both sides) |
| Purchases | invoice no · supplier · E-Plus total · Tablix Pharma total |
| Cash | shift · expected · counted · difference |
| Refused / flagged | receipt no · state (refused / flagged) · reason · resolution |

Each difference is classified as one of: timing (export vs entry time), missing entry (which side), unit or pack mismatch, price change, data error, or Tablix Pharma defect. A defect goes into MASTER_PROGRESS with a priority.

**Blocked until the owner provides the E-Plus version and sample exports.** The field mapping (`docs/integrations/EPLUS_MIGRATION_PLAN.md`, to be written) depends on them.

## 5. Late-receipt measurement (owner decision: no fixed threshold yet)

During P2, every receipt's lag (`created_at − sold_at`) is kept. Each week, report the median, 95th percentile and maximum per counter, plus the count of flagged receipts. A rejection threshold is proposed only from these numbers (`docs/architecture/OFFLINE_SYNC.md` §3).

## 6. Rollback

At any phase: tell the staff to use E-Plus only, set the branch's stock policy back to "allowed", and stop the Tablix Pharma counter. Tablix Pharma data is kept for the comparison; nothing needs undoing in E-Plus.

## 7. Readiness today (2026-11-03)

| Phase | Ready? | What's missing |
|---|---|---|
| P0 | **Not yet** | Staging secrets (owner), then a green staging run; the team runs S1–S5, S11, S12 by checklist |
| P1 | No | E-Plus version, sample exports, the field mapping |
| P2 | No | P0 and P1 exit criteria; production release approval (migrations 0011–0014); production `BACKUP_KEY` |
| P3 | No | P2 exit criteria |
