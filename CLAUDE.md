# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # API on :5000 (node server/index.js) + Vite client on :5173 (proxies /api -> :5000)
npm run dev:server   # API only; migrates the schema on boot
npm run build        # vite build -> dist/
npm run migrate      # bring the DB schema up to date, then exit (idempotent)
npm test             # every suite, in sequence
npm test monthly     # one suite, matched by name or filename substring
```

There is no linter or formatter configured.

Env is loaded from `.env.local` then `.env` (see `.env.example`). `DATABASE_URL` and `JWT_SECRET` are required at import time; `ADMIN_PASSWORD` is required only to seed the `admin` account on first migration.

## Tests hit the real database

`tests/run.mjs` starts the API itself if nothing answers `/api/health` on `$API` (default `http://localhost:5000`), and leaves an already-running server alone. Apart from `translations`, the suites are end-to-end: they drive the live API over HTTP and seed/clean rows directly through `pool` against whatever `DATABASE_URL` points at. They exist to prove things that only live in Postgres (CHECK constraints, the max-three-managers-per-sector trigger, `FOR UPDATE` locking, SQL scoping).

- Fixtures use `zz-` usernames and `ZZTEST`/`TEST` record names and clean up in `finally`. Never run suites in parallel.
- A killed run (e.g. piping into `head`) can leave fixtures and break the next run on duplicate usernames — see `tests/README.md` for the cleanup SQL.
- `translations.test.mjs` fails the build on: a key missing any of en/rw/fr/sw, a `t('key')` that isn't defined, a defined key that is never used, or hard-coded English in JSX (`<th>`, `placeholder=`, `label=`, `title=`, button text, etc.). When adding a new status/role/enum value that is rendered via a template key like ``t(`status.${x}`)``, also add it to `FAMILIES` in that test.

## Architecture

Vite + React 18 SPA (`src/`) and an Express + `pg` API (`server/`), with no ORM and no router library. `shared/businessOperations.js` is imported by both sides.

### Deployment shape

- **Local / ordinary host:** `node server/index.js` runs `initDatabase()` then listens.
- **Vercel:** `api/index.js` re-exports the Express app; `vercel.json` rewrites `/api/(.*)` to `/api/index` (Express still sees the original `req.url`) and everything else to the SPA. `server/index.js` only migrates/listens when it is the process entry point, so **no DDL runs on serverless cold starts** — `npm run migrate` is a manual deploy step.
- The pool uses `max: 1` when `VERCEL` is set, and `pool.query` is monkey-patched to retry once on stale-connection errors. Transactions use `pool.connect()` and must roll back with `safeRollback(client)`.
- Evidence files go through `server/lib/storage.js`: local `server/uploads/` by default, Supabase Storage (REST, private bucket) when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set. Files are only ever served through permission-checked API routes. `?token=` is accepted **only** on `GET .../evidence/:id/file` (a plain link can't carry an Authorization header). Upload routes authorize the record before multer buffers the body.
- A local Postgres without TLS works by adding `?sslmode=disable` to `DATABASE_URL` (or `DATABASE_SSL=false`).
- Input validation helpers live in `server/lib/http.js` (`parseId`, strict `isValidDate`, `validNumber` with a NUMERIC-safe ceiling, `contentDisposition`). The global error handler in `server/index.js` maps bad JSON and Postgres input errors (`22P02`, `22007`, `23505`, ...) to 400/409. Route-level error handlers should `next(error)` rather than answer 500 themselves.

### Schema and migrations

There are no migration files. `server/db/database.js#initDatabase` creates the base tables, then calls `migrateMovementModule`, `migrateActivityModule`, `migrateMonthlyModule` (in that order — monthly depends on activities). Every statement must stay idempotent (`IF NOT EXISTS`, drop-then-add constraints, idempotent `UPDATE`s), and legacy status values are remapped before CHECK constraints are added. Status/enum lists are exported from the `*Schema.js` files and reused by routes. `supabase/schema.sql` is an older snapshot and is **not** the source of truth.

### Roles and authorization

Roles: `super-admin` (the "Director"), `manager` (scoped to one `sector`), `staff`, `partner` (external, view-only, exactly one sector). `isAdmin(user)` ⇔ `super-admin`.

- `server/lib/auth.js#authMiddleware` re-reads the user row on every request (role, sector, `status`, `password_changed_at`) rather than trusting JWT claims, so suspension, reassignment and password resets take effect immediately.
- Partners are restricted by an **allowlist** of paths in `authMiddleware` (`/api/partner/*`, `/api/auth/session`, `/api/sectors`, `/api/health`). New routes are unreachable to partners by default. `server/routes/partner.js` takes the operation only from `req.user.sector`, never from request params, and returns only `approval_status = 'approved'` + `externally_visible` records.
- Sector scoping for non-admins is done in SQL via `managerScope(user, column, values, filters)` from `server/lib/http.js`; queries build a `values` array and `$n` placeholders incrementally. Authorize against the row's current sector, not the one in the request body.
- Approval routing (`server/lib/approvals.js`): every activity and movement stores `approval_required_from` (a user id) + `approval_required_role` (`manager`|`director`) and a separate `approval_status` (`pending`|`approved`|`rejected`) distinct from the workflow `status`. `canApprove` (JS) and `pendingForMeSql` (SQL) are the single definition used by approve/reject endpoints, the "What I Need to Approve" queue, and the sidebar badge count in `/api/summary` — keep them in step.
- Workflow transitions are governed by a `STATUS_FLOW` map in each route module (`activities.js`, `movements.js`), mirrored on the client (`ActivityReview.jsx`, `MovementModule.jsx`). Status writes use `WHERE status = <previous>` and check `rowCount` (answering 409), so concurrent moves cannot both land. Material changes are appended to `activity_history` / `movement_history` / plan-level audit tables.
- `On Hold` keeps the record's approval state as it was, and `NOT_AWAITING_STATUSES` (Draft, Cancelled, On Hold) keeps parked work out of every approval queue.
- Closed monthly plans are read-only everywhere: `assertPlanOpen(row)` in `activities.js` guards every write to an activity in a closed plan. Reopening a closed month hands its report back as `Returned`.
- Only a `manager` raises approval requests. `staff` cannot raise requests or start unassigned work. A manager cannot be moved to another sector while holding open work there.

### Domain invariants

- **Four business operations only**, defined in `shared/businessOperations.js` with names in all four languages. IDs (`farming`, `agriculture`, `mining`, `movement`) are foreign keys everywhere and must not change; "Movements & Facilitation" keeps id `movement`. Use `operationName(id, language)` for display — these names are deliberately not in `i18n.js`. Per-operation category presets are duplicated in `src/App.jsx` and `server/data/seedData.js` and must be kept in sync.
- **The platform records money, it never moves it.** No payment, wallet, transfer or gateway concept anywhere (a test guards this).
- Monthly budget math (`server/lib/monthly.js`) is done in integer cents: a spend of exactly the remaining budget is allowed, one cent over is refused with `OVER_BUDGET_MESSAGE` verbatim. Closed plans are read-only. Month values are `'YYYY-MM'` parsed by hand (not `Date`) to avoid timezone shifts; the same care applies to date-only strings on the client.
- Movements freeze the exchange rate (`fx_rwf_per_usd`, `fx_cdf_per_usd`) onto the row; `exchange_rates` is append-only history. Currencies: RWF, USD, CDF.

### Frontend

- `src/App.jsx` has three layers:
  - `App` owns the session: `ops-token`/`ops-user` in localStorage, read defensively. It re-validates via `/api/auth/session` on start, and only a real 401/403 signs you out.
  - `LoginScreen` holds its own form state.
  - The workspace is `InternalWorkspace` or `PartnerWorkspace`, keyed by `user.id:token`. Signing out unmounts it, which resets all state.
- `useApi(token, onExpired)` provides `fetchJson`, `upload` (multipart) and `download` (blob).
  - A 401, or a 403 with `code: 'ACCOUNT_INACTIVE'`, ends the session.
  - Auth refusals carry a `code` (`TOKEN_INVALID`, `PASSWORD_CHANGED`, `BAD_CREDENTIALS`, ...). `authRefusal()` maps each code to translated text.
  - Other errors show the server's `message` only; request details go to the console.
- **Routing is the URL hash, with no router library.** `useHashRoute()` in `src/ui.jsx` gives addresses like `#/activities`, `#/activities/:id`, `#/movements/:id`, `#/monthly/:planId`, and partner tabs like `#/overview`. The open record comes from the address, so Back closes it and refresh keeps it. Callbacks passed to modules for routing must be stable (`useCallback`), because modules key their load effects on them.
- **Shared UI lives in `src/ui.jsx`:**
  - `ErrorBoundary`: one in `main.jsx`, and one per view keyed by the view.
  - `DialogProvider`/`useDialog()`: `confirm`/`prompt`/`password`. Never use `window.confirm`/`prompt`/`alert`.
  - `DetailView`: inline and scrolled into view on desktop; a full-screen sheet at ≤900px.
  - `useBusy()`: one action at a time. Handlers that must report success return `true`/`false`, so forms reset only on success.
- **Data loading.** `loadData()` in `InternalWorkspace` refreshes in the background. Only the first load shows the full spinner. Every loader numbers its requests and ignores stale responses. The activity register is paged from the server (`GET /api/activities?paged=1&limit&offset`, with filters); the dashboard queues use the newest 200. Modules call `onChanged` so the shell's badge and queues refresh.
- **Layout.**
  - ≤900px: the sidebar becomes a drawer behind `.mobile-bar`, and detail views and dialogs become sheets.
  - ≤640px: tables with class `card-table` render as cards. Give each `<td>` a `data-label={t(...)}`, the title cell `className="card-title-cell"`, and the actions cell `className="card-actions"`. Tables without `card-table` scroll horizontally.
  - Inputs are 16px on phones to avoid iOS zoom. Styling is plain CSS in `src/styles.css`.
- **i18n** (`src/i18n.js`):
  - Each `STRINGS` entry is one key with `en`/`rw`/`fr`/`sw` on the same line. Use `fill(text, { name })` for placeholders.
  - Components use `useT()`/`useI18n()`. Non-component helpers use `displayLanguage()`/`translate()`, which is why `App` calls `setDisplayLanguage(language)` during render.
  - Audit-trail actions written by the server in English are shown through `trailActionLabel()` (`history.<Action>` keys).
  - Every user-visible string must go through a key.

## Code style

The codebase favours long explanatory comments that state *why* a rule exists (often referencing a past bug or a spec section). Match that density when changing security, money, approval or scoping logic.
