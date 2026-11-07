# Stock Kept by the Server (Phase 2 M1)

Last updated: 2026-11-03. Implemented and tested **only on a local Worker with local D1**. Migration `0013_stock_ledger.sql` has **not** been applied to production.

## 1. Before M1 (inspected)

Stock was computed only in each browser (`src/inventory.js` `liveData`): the last uploaded pharmacy-program file of the branch (time `S`), plus every movement after `S`. The server stored the movements but kept no stock, so it could not refuse an oversell, and two devices could disagree.

Every path that changes stock (all through `/api/db` insert or delete):

| Record | Stock effect (boxes) | Time used |
|---|---|---|
| `pos_sales` kind `sale` | −`qty/per` per line | `sold_at` |
| `pos_sales` kind `return` | +`qty/per` per line | `sold_at` |
| `purchases` kind `buy` | +(`qty`+`bonus`) per line | `created_at` |
| `purchases` kind `return` (to supplier) | −`qty` per line | `created_at` |
| `stock_moves` (count, damaged, expired, supplier_return, transfer, withdrawal) | ±`qty` (a transfer is two rows, one per branch) | `happened_at` |
| Deleting a purchase or stock move (owner) | undoes it | — |
| A new uploaded file | becomes the new base | — |

Receipts are never updated or deleted. Purchase "edits" are a delete plus an insert. `import_backup` (moving to a new, empty pharmacy) writes rows directly; see §6.

## 2. Design

- **`stock_ledger`**, append-only: one row per line of each record, written **in the same D1 batch** as the record (atomic: both or neither). Ids are `<table>:<record id>:<line>`, inserted with `INSERT OR IGNORE`, so retries and duplicate requests add nothing.
  - `qty` is the movement.
  - `applied` is what it changes. It is 0 for a movement dated at or before the branch's base `S`, the same rule as `liveData`.
- **`stock_levels`** = Σ `applied`, kept by the trigger `stock_ledger_apply`. Tested: the level equals the ledger sum after every kind of movement.
- **Reversal:** deleting a purchase or stock move adds `rev:<ledger id>` rows with the opposite sign. History is never rewritten.
- **One statement per record** (a bulk insert from a JSON list) keeps a 300-line receipt to a single query. This matters because of D1's per-request query limits.
- **`stock_bases`** per branch holds:
  - `base_at` (S);
  - `opened_at`;
  - `stale` (a newer file was uploaded);
  - `block_negative` (the policy; 0 by default = today's behaviour).
- **Opening** (`open_stock`, owner or stock manager, in their branches) sets the levels to the numbers the app shows. It writes one `opening` ledger row per item (target − current) and an audit-log row. Race-safe:
  1. The app first gets `server_now` (the watermark), then reloads its data.
  2. Movements the server received after the watermark (and dated after the new base) are added on top of the app's numbers.
  3. Items with a level that the app no longer lists go to 0.
- **Oversell guard** (`block_negative = 1`, levels opened and not stale): it is checked **inside the same SQL statement that stores the receipt**. D1 runs one batch at a time, so the check and the stock change can't interleave with another device's sale. A refused receipt stores nothing and moves nothing.
  - Returns are never blocked.
  - Purchases and stock moves are not blocked: they are corrections by the stock manager or owner.
- **The cashier, when its branch blocks:** online, the receipt is sent to the server **before printing**. If refused, the cart stays on screen with the reason. Offline, it is queued as before; if the server refuses it on arrival, it stays in the device's refused list (never discarded).

## 3. Evidence (local Worker + local D1)

`worker/test/stock.test.mjs`, 8/8 tests:

| Test | Result |
|---|---|
| Ledger follows purchase (with bonus), box sale, strip sale, return, supplier return, damage, transfer (both branches), deletion (reversal); level = ledger sum | pass |
| Same sale sent 4 times (2 at the same moment): one ledger row, level −1. A refused receipt and an all-or-nothing refused request: no ledger rows | pass |
| Opening with a sale arriving after the watermark: level = app number + that sale; an unlisted item goes to 0; audit rows; other branch's staff and the device refused | pass |
| Default policy: selling below zero goes negative (as today) | pass |
| **Block:** 2 devices sell the last box at the same moment → exactly 1 stored, the other `insufficient stock: A1`, level 0, one ledger row. **10 devices race for 3 boxes → exactly 3 stored.** Unknown item refused; a mixed receipt refused whole; a return allowed; the other branch unaffected; only the owner sets the policy | pass |
| **Mutation check:** with the guard switched off, the 2-device test fails (2 stored), so the test does detect oversell | done (then restored) |
| New upload → stale → not enforced; reopen with a base time; a receipt dated before the base has `applied` 0 | pass |
| Staff of one branch see only that branch's levels | pass |

Browser test (`e2e/cloudflare.e2e.mjs`): the owner opens from the dashboard numbers; the comparison shows **no difference**; with the block on, the cashier is refused before printing (nothing saved, cart kept); after a delivery of 5 boxes, one box sells.

Migration 0013 on a copy of the local D1 (1,179 receipts, 113 purchases):
- apply → rollback → re-apply;
- receipts and purchases unchanged;
- ledger rows are lost on rollback (as documented).

## 4. Reconciliation plan

1. **Before using the block in a branch:** open the levels from the app (dashboard → الإعدادات والأدوات → «الرصيد على السيرفر» → «ابدأ…»), then «قارن…». The comparison (`src/stock-reconcile.js`, unit-tested) lists every item where the server and the app differ, biggest first.
2. **After each upload from the pharmacy program:** the levels are marked stale and the block is not enforced; open again.
3. **Daily during the pilot:** run the comparison. A difference means a movement one side is missing (e.g. a receipt still queued on an offline device: the app counts it, the server doesn't yet). Check «حركة الصنف» before reopening.
4. **Historical data is not rewritten.** Movements recorded before migration 0013 have no ledger rows, and the first opening absorbs them. The audit log keeps every opening.

## 5. Policy decisions still open (owner)

- Whether to turn on `block_negative` for the pilot branch. Default off; it requires an online cashier and opened levels.
- Whether stock moves and supplier returns should also be blocked from going below zero. Not implemented; they are corrections today.

## 6. Limits (known, documented)

- **Batches, expiry and FEFO are still computed in the app.** The server keeps boxes per item and branch only. Batch-level stock on the server is a later step.
- `import_backup` (moving to a new, empty pharmacy) writes no ledger rows; open the levels after moving.
- The desktop offline mode (`src/local-db.js`) has no server ledger. It is single-device by design.
- An online sale refused for stock still used a receipt number, so a gap appears in the numbering.
- The trigger and `json_each` work on the local D1 (Miniflare). **Production D1 support for this trigger has not been tested** and needs a staging environment or the first release run.
- `stock_status` and `open_stock` are new RPCs. Old app builds don't call them, which is harmless.
