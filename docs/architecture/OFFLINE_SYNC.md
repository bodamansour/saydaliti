# Offline Work and Synchronization: Receipts

Last updated: 2026-11-03. Scope: how cashier receipts made without a connection reach the server, what the server now detects, and a **proposed** policy for late receipts that is **not enforced** until the owner decides.

## 1. How it works today (inspected)

| Part | Behaviour | Code |
|---|---|---|
| Making a receipt | The cashier builds the row on the device: `id` (random UUID), `number` (`YYMMDD-TAG-DEVICE-0001`, Phase 1), `sold_at` (**device clock**), `receipt_device`, `employee_id` / `shift_id` when a cashier is signed in with a PIN. It is saved on the device first, then queued. | `src/cashier.js` `checkout` |
| Queue (outbox) | IndexedDB key `outbox`. Entries are sent **in order**. A network or server-unavailable error stops the run, and the queue is retried on `online`, on focus and after each receipt. | `src/offline.js` `flush` |
| Refusals | An entry the server refuses is **never discarded automatically**. It moves to `outbox-stuck` with the reason; the owner can retry, save to a file, or discard it by hand. (Only a data-file upload is not kept, because it can be uploaded again.) | `src/offline.js` |
| Retries | Inserts are sent as `upsert … ignoreDuplicates` with the device's id. A retry after a lost answer is stored once (tested, including two identical requests arriving at the same moment). | `worker/src/db.js` `insert` |
| Two times per receipt | `sold_at` is the original transaction time from the device clock. `created_at` is the **server receipt time**; the server always overwrites it (Phase 1) and ignores any value sent. | `worker/src/db.js` |
| Device identity | `receipt_device` (4 characters, kept across sign-outs) plus the authenticated account (`created_by`) plus the PIN-signed cashier (`employee_id`). | Phase 1 |
| Sign-out | Deletes the device's data copy. It warns first if the queue still has entries. | `src/offline.js` `clearLocal` |

## 2. What the server checks now

| Situation | Behaviour | Since |
|---|---|---|
| `sold_at` more than 10 minutes in the future (server clock) | **Refused** (`sale time in the future`). The entry stays in the device's refused list. | Phase 1 |
| Same `id` sent again with identical contents (a retry) | Skipped and answered as success | Phase 1 |
| Same `id` with **different** contents (pharmacy, kind, number, `sold_at`, total, lines or `return_of` differ) | **Refused, 409 `conflicting receipt id`**. The stored receipt is unchanged; the new one stays in the device's refused list for the owner. Previously it was silently dropped. | Phase 2 prep |
| Same number with a different id | Refused, 409 (Phase 1) | Phase 1 |
| Signs of a wrong clock or a hand-set time | **Stored, and flagged** in the change log (`audit_log`, op `flag`), shown to the owner in «سجل التعديلات» as «وقت محتاج نظرة» | Phase 2 prep |

Flags (none of them refuses a receipt):

| Flag | Meaning | Why it matters |
|---|---|---|
| `time_not_number_day` | `sold_at` is not within the day the device wrote into the receipt number (−1 / +2 days of slack for time zones) | The number is made from the device's date at the moment of sale. A different `sold_at` means the time was changed afterwards, or the device clock jumped. |
| `before_shift_opened` / `after_shift_closed` | `sold_at` is outside the shift the receipt names (10-minute slack) | A receipt "sold" while its cashier's shift wasn't open |
| `return_before_sale` | A return dated before the sale it returns | Impossible in real time |
| `after_day_closed` | It arrives for a branch day already closed with «قفل اليوم» (date taken in the pharmacy's time zone) | It changes totals the owner already signed off. The stored day-close row is not updated. |

Not flagged on purpose: being late by itself. A receipt made offline two weeks ago and numbered that day is normal and gets no flag (tested).

Tests: `worker/test/api.test.mjs` "offline receipts: late ones are kept; a reused id with other contents is refused; odd times are flagged, not refused".

## 3. Proposed business policy for late receipts (NOT enforced, needs owner decision)

The **lag** of a receipt is `created_at − sold_at` (server receipt time minus original time). Proposal:

| Lag | Proposed handling |
|---|---|
| ≤ 72 hours | Accept silently (a normal outage or a weekend) |
| 72 hours – 30 days | Accept and flag `late` for the owner's review |
| > 30 days, or for a closed day | Hold as **pending owner confirmation**: stored but excluded from reports until the owner confirms it. Never discarded. |

Before choosing numbers:
1. Measure real lags during the pilot. Per pharmacy and device: the 50th/95th/99th percentile of `created_at − sold_at`, from `pos_sales` (read-only).
2. Decide whether the closed-day case should reopen the day, add an adjustment, or wait for the owner.
3. Decide who confirms (owner only, or an approving employee as for returns).

## 4. Edge cases

| Case | Current behaviour | Note |
|---|---|---|
| Device clock wrong but consistent (e.g. set a year back) | Receipt number and `sold_at` agree, so no `time_not_number_day`. It is caught only by the lag (proposal) or by a shift or closed-day flag. | Lag measurement is the main signal |
| Device clock in the future by more than 10 minutes | Refused (kept on the device) | The owner must fix the clock, then retry |
| Egypt summer time (DST) | `sold_at` is UTC; day boundaries use the pharmacy's time zone (`Africa/Cairo`, DST-aware via `Intl`) | |
| Two devices offline sell the last box | Not detectable until server-side stock exists (Phase 2 M1) | |
| A receipt edited on the device while queued | The app has no such feature. If a modified row is re-sent with the same id, it is refused as a conflict and kept for the owner. | |
| Sign-out with queued receipts | The app warns before deleting the device copy | Data loss is possible if the user confirms |
| Return without a receipt while offline | Not possible: the manager approval needs the server | Owner decision 2026-11-03 |
| Old app build sends a row without `receipt_device` | Accepted (legacy number format); uniqueness is still checked | |
