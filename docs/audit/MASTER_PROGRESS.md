# Saydaliti — Master Progress

**Source of truth for project progress.** Read this first at the start of every session, then check `git status`, the branch and the latest commit before trusting anything written here.

## Current state

| | |
|---|---|
| Current phase | **Phase 0: repository audit. Complete; waiting for the owner's approval to start Phase 1.** |
| Branch | `ccr-94719aa6-7k3i5e` |
| Base commit audited | `7d23b83` (= `main` at 2026-10-31) |
| Production | Not touched. Nothing deployed. No live database accessed. |
| Release decision | **NOT READY** (see MASTER_AUDIT §1) |

## Completed

| Task | Priority | Status | Location | Tests executed | Evidence |
|---|---|---|---|---|---|
| Phase 0 repository audit | — | Done | `docs/audit/MASTER_AUDIT.md` | `npm test` 173/0/17 skipped; Worker API + Cloudflare e2e 27/0; `npm run e2e` 43/0; `npm audit` root/worker 0, desktop 15 moderate; local probes of the sale API | MASTER_AUDIT §2, §6.1 |
| E-Plus parity skeleton | P4 | Done (no evidence available) | `docs/audit/EPLUS_FEATURE_PARITY.md` | — | Repository search found no E-Plus material |

## In progress

None.

## Next: proposed Phase 1 (waiting for approval)

| ID | Task | Priority | Status |
|---|---|---|---|
| P0-1 | Server-side validation of sales and returns (totals, line shape, discount bounds, refund ≤ sold price, permission + reason for no-receipt returns and back-dating) | P0 | Not started |
| P0-2 | Unique receipt numbers (migration + device tag + persistent counter) | P0 | Not started |
| P0-3 | No silent truncation in client loaders | P0 | Not started |
| P0-7 | `PIN_PEPPER` required; CSP header; token storage review | P0 | Not started |
| P0-4 | Production deploy approval gate | P0 | **Blocked: owner decision** |
| P0-8 | Windows 7/8 (EOL Electron 22) decision | P0 | **Blocked: owner decision** |

Phase 2: server-authoritative stock ledger (P0-5) and cloud backup with a restore drill (P0-6). Full backlog and phase plan: MASTER_AUDIT §11–12.

## Blocked / waiting for the owner

1. Approval to start Phase 1.
2. Is the production Worker serving real pharmacies today?
3. Pilot pharmacy system: E-Plus or United/Genius? E-Plus version and sample exports.
4. Deploy gate (P0-4) and Windows 7 (P0-8) decisions.

## Known bugs (confirmed)

| Bug | Evidence | Severity |
|---|---|---|
| Server stores sales and returns with arbitrary totals, negative totals, no-receipt returns, inflated refund prices, unlimited discounts, duplicate numbers, and back-dated times | [PROBE] MASTER_AUDIT §6.1 | Critical |
| Client loaders silently stop at 20k/50k rows (cashier stock drops the newest rows) | [CODE] `src/cashier.js:81`, `src/app.js:940` | High |
| Receipt counter is cleared on sign-out, and the default device tag `K1` is shared, so duplicate receipt numbers occur | [CODE] `src/cashier.js:662–667`, `src/offline.js` `clearLocal` | High |
| Side rail does not extend the full height on long dashboard pages | Screenshot | Low |

## Known risks

- Auto-deploy and remote D1 migrations on every push to `main`. **Do not merge to `main` without the owner's explicit approval.**
- No cloud backup or restore drill exists.
- Windows 7/8 installer uses end-of-life Electron 22.
- Not verified in this environment: Electron app, Android APK, United SQL Server sync, real hardware.

## Architectural decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-11-03 | Fix server-side integrity (Phases 1–2) before the UI/UX redesign (Phase 3) | A redesigned UI on top of numbers the server does not guarantee would misrepresent readiness |
| 2026-11-03 | Evolutionary redesign on the existing token system rather than a rewrite | Tokens, dark mode and RTL are already sound; the problems are information architecture and component structure (MASTER_AUDIT §8) |
| 2026-11-03 | Keep the existing `docs/*.md`; move or merge them into the spec's folders when each phase touches them | Avoid duplicate documents |

## UI/UX redesign progress

Not started. Audit findings: MASTER_AUDIT §8.

## Performance benchmarks

None measured yet.

## E-Plus integration status

No evidence. See `EPLUS_FEATURE_PARITY.md`.

## How to reproduce the test runs

```bash
npm ci && npm test
(cd worker && npm ci && npm run build && printf 'PIN_PEPPER=ci-pepper\nSIGNUP_PER_HOUR=10000\n' > .dev.vars \
  && npx wrangler d1 migrations apply saydaliti --local && npx wrangler dev --local --port 8787) &
WORKER_URL=http://localhost:8787 node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs
npm run e2e
```

## Session log

- **2026-11-03:** Phase 0 audit. Ran every suite runnable on Linux, probed the sale API locally, and captured screenshots of all 32 tabs plus the cashier and phone layouts. Wrote MASTER_AUDIT, MASTER_PROGRESS and EPLUS_FEATURE_PARITY. No application code changed.
