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

- **Local / ordinary host:** `node server/index.js` runs `initDatabase()` then listens, and also serves `dist/` when it has been built -- so one process on one port is the whole deployment (`npm run build && npm start`). Hashed files under `dist/assets` are cached for a year, everything from `public/` is not, and any GET that matched no route falls back to `index.html` so the hash router keeps working on a refresh. An unmatched `/api` path answers JSON 404 instead, so a wrong route never reaches the client as HTML. `npm run dev` is unchanged: Vite on :5173 proxying /api to :5000.
- **Self-hosted, no external service:** Postgres 16 is installed natively on Windows (service `postgresql-x64-16`, port 5433; `docker-compose.yml` is an equivalent alternative on the same port), and `.env.local` points `DATABASE_URL` at it with `sslmode=disable`. Supabase and Vercel have both been removed entirely (storage, env entries, `supabase/schema.sql`, `api/index.js`, `vercel.json`); do not reintroduce them. `server/index.js` still only migrates/listens when it is the process entry point, so importing the app never runs DDL.
- `pool.query` is monkey-patched to retry once on stale-connection errors. Transactions use `pool.connect()` and must roll back with `safeRollback(client)`.
- **Vercel:** `api/index.js` re-exports the Express app and `vercel.json` rewrites `/api/(.*)` to `/api/index` (Express still sees the original `req.url`); `npm run vercel-build` builds the client and then runs `server/migrate.js`, so **no DDL runs on a cold start**. The pool uses `max: 1` and `trust proxy` is on when `VERCEL` is set. Postgres comes from Neon, files from Vercel Blob.
- Evidence files go through `server/lib/storage.js`: local disk by default (`server/uploads/`, or `UPLOADS_DIR` for a mounted disk), or **Vercel Blob** when `BLOB_READ_WRITE_TOKEN` is set -- the routes never know which. Blob objects sit at random addresses the app never hands out, but they are not themselves permission-checked, unlike a file on disk. Uploads are capped at `MAX_EVIDENCE_BYTES` (4 MB, mirrored by `MAX_BYTES` in `journey.jsx`) because a serverless request body cannot exceed 4.5 MB. Whichever store is used must be backed up with the database. Files are only ever served through permission-checked API routes. `?token=` is accepted **only** on `GET .../evidence/:id/file`, and only a *file token* (5 minutes, bound to that one path) minted by `POST /api/auth/file-link` -- never the session token. The client's `openFile(path)` (in `useApi`) asks for one on click. Upload routes authorize the record before multer buffers the body.
- A local Postgres without TLS works by adding `?sslmode=disable` to `DATABASE_URL` (or `DATABASE_SSL=false`).
- Input validation helpers live in `server/lib/http.js` (`parseId`, strict `isValidDate`, `validNumber` with a NUMERIC-safe ceiling, `contentDisposition`). The global error handler in `server/index.js` maps bad JSON and Postgres input errors (`22P02`, `22007`, `23505`, ...) to 400/409. Route-level error handlers should `next(error)` rather than answer 500 themselves.

### Schema and migrations

There are no migration files. `server/db/database.js#initDatabase` creates the base tables, then calls `migrateMovementModule`, `migrateActivityModule`, `migrateMonthlyModule` (in that order — monthly depends on activities). Every statement must stay idempotent (`IF NOT EXISTS`, drop-then-add constraints, idempotent `UPDATE`s), and legacy status values are remapped before CHECK constraints are added. Status/enum lists are exported from the `*Schema.js` files and reused by routes.
### Roles and authorization

Roles: `super-admin` (the "Director"), `manager` (scoped to one `sector`), `staff`, `partner` (external, view-only, exactly one sector). `isAdmin(user)` ⇔ `super-admin`.

- `server/lib/auth.js#authMiddleware` re-reads the user row on every request (role, sector, `status`, `password_changed_at`, `must_change_password`) rather than trusting JWT claims, so suspension, reassignment and password resets take effect immediately. Tokens carry only `id` and are verified as HS256; `JWT_SECRET` must be at least 32 characters.
- Every password somebody else set is temporary: the seeded Director, and any account the Director creates or resets, gets `must_change_password`. Until the owner uses `POST /api/auth/password` (current + new password; returns a fresh token and ends other sessions), `authMiddleware` answers everything except the session and password routes with 403 `PASSWORD_CHANGE_REQUIRED`, and the client shows `ChoosePasswordScreen`. The password policy lives in `server/lib/passwords.js` (8-72 characters, not the username); the client mirrors the minimum as `MINIMUM_PASSWORD_LENGTH` in `ui.jsx`.
- Internal accounts (manager/staff) are suspended or reactivated with `PATCH /api/users/:id/status`; a suspension is never blocked by held work, but the response reports it. Login is rate-limited per address and per username; `trust proxy` is off unless `TRUST_PROXY` is set (only behind a real reverse proxy).
- Partners are restricted by an **allowlist** of paths in `authMiddleware` (`/api/partner/*`, `/api/auth/session`, `/api/auth/password`, `/api/sectors`, `/api/health`). New routes are unreachable to partners by default. `server/routes/partner.js` takes the operation only from `req.user.sector`, never from request params, and returns only `approval_status = 'approved'` + `externally_visible` records.
- Sector scoping for non-admins is done in SQL via `managerScope(user, column, values, filters)` from `server/lib/http.js`; queries build a `values` array and `$n` placeholders incrementally. Authorize against the row's current sector, not the one in the request body.
- Approval routing (`server/lib/approvals.js`): every activity and movement stores `approval_required_from` (a user id) + `approval_required_role` (`manager`|`director`) and a separate `approval_status` (`pending`|`approved`|`rejected`) distinct from the workflow `status`. `canApprove` (JS) and `pendingForMeSql` (SQL) are the single definition used by approve/reject endpoints, the "What I Need to Approve" queue, and the sidebar badge count in `/api/summary` — keep them in step.
- Workflow transitions are governed by a `STATUS_FLOW` map in each route module (`activities.js`, `movements.js`), mirrored on the client (`ActivityReview.jsx`, `MovementModule.jsx`). Status writes use `WHERE status = <previous>` and check `rowCount` (answering 409), so concurrent moves cannot both land. Material changes are appended to `activity_history` / `movement_history` / plan-level audit tables.
- `On Hold` keeps the record's approval state as it was, and `NOT_AWAITING_STATUSES` (Draft, Cancelled, On Hold) keeps parked work out of every approval queue.
- Closed monthly plans are read-only everywhere: `assertPlanOpen(row)` in `activities.js` guards every write to an activity in a closed plan, and `ActivityReview.jsx` hides those actions (`monthOpen`). Reopening a closed month hands its report back as `Returned`. Work in a month still in Draft cannot be started or spent against.
- Dead ends the audit found are closed, and `tests/workflow-fixes.test.mjs` keeps them closed: Rejected/Cancelled activities reopen to Pending Approval (never Draft); work that never needed approval (`allowedNextStatuses`) reopens as Approved instead; reopening Completed work clears `completion_submitted_at`; a manager's own request is assigned to them, and `canRecordExpense` follows the same "who carries it" rule as start/hand-back; activities with expenses cannot be deleted, and deleting planned work in a Confirmed month lowers the allocation with a plan-history entry; movements let their author withdraw (Pending -> Draft) and reopen refused ones (Rejected -> Draft), take figures only when Approved or later, and cannot be deleted once money is recorded. Edits, draft submission and hand-back write with `WHERE status = <previous>` + rowCount 409 like the other transitions.
- Only a `manager` (or the Director) adds activities or movements and raises approval requests; `POST /api/activities` and movement `canCreate` refuse `staff`, who follow their operation's work read-only. While a record's decision is open (`decisionOpen` in `approvals.js`, mirrored by `decisionIsOpen` in `ActivityReview.jsx`), it is approved or rejected **only** through `/approval`: the Director's `/decision` route may just put it On Hold or cancel it (409 `DECISION_PENDING` otherwise), and movement `/status` refuses Approved/Rejected. Rejecting or cancelling a movement requires a reason; every reject button asks for it in a dialog. A manager cannot be moved to another sector while holding open work there.

### Domain invariants

- **Four business operations only**, defined in `shared/businessOperations.js` with names in all four languages. IDs (`farming`, `agriculture`, `mining`, `movement`) are foreign keys everywhere and must not change; "Movements & Facilitation" keeps id `movement`. Use `operationName(id, language)` for display — these names are deliberately not in `i18n.js`. Per-operation **category presets live once** in `shared/categories.js` (`CATEGORIES`, `OPERATIONS_WITH_CATEGORIES`, `categoriesForOperation`, `OTHER_CATEGORY`), read by `src/App.jsx`, `src/MonthlyPlans.jsx` and `server/data/seedData.js` — do not restate them.
- **Project ≠ business operation ≠ monthly plan.** A *business operation* is one of the four fixed columns; a *project* is a named undertaking inside one operation (every activity has one); a *monthly plan* is one operation's one month with the budget approved for it (unique on `sector, month`). The monthly plan is what a manager works from.
- **The month has two levels of work, in one table.** A **planned activity** is an `activities` row with a `monthly_plan_id` and no `parent_activity_id`: what the Director set for the month, with a budget out of the month's. The manager's **day-by-day work** is a row with both, created only through `POST /api/monthly-plans/:id/activities/:activityId/work`: one row per day, with `scheduled_for`, an assignee, its own budget and its own evidence. There is no third entity. Both levels carry `monthly_plan_id`, so **every plan-level budget sum must filter `parent_activity_id IS NULL`** or each budget is counted twice; spend is summed over both levels, because that is where it lands.
- **The platform records money, it never moves it.** No payment, wallet, transfer or gateway concept anywhere (a test guards this).
- Monthly budget math (`server/lib/monthly.js`) is done in integer cents: a spend of exactly the remaining budget is allowed, one cent over is refused with `OVER_BUDGET_MESSAGE` verbatim. Closed plans are read-only. Month values are `'YYYY-MM'` parsed by hand (not `Date`) to avoid timezone shifts; the same care applies to date-only strings on the client.
- **`monthly_plans.approved_budget` is the Director's ceiling and is never recalculated.** It is typed when the plan is created or edited; `/confirm` only refuses a plan with no budget or one already over-committed. Three figures are derived from the rows and must stay derived: *committed* (sum of the planned activities' budgets), *spent*, and *remaining*. Anything that adds to a month or raises an activity's figure — `POST /:id/activities`, `POST /:id/attach/:activityId`, the `/decision` route and approving a budget-change request — checks the ceiling with `fitsBudget` under a `FOR UPDATE` lock on the plan row and refuses with `overMonthlyBudgetMessage(remaining)` ("This activity exceeds the remaining monthly budget of $200."). The day-by-day route checks the *planned activity's* own remaining the same way (`overActivityBudgetMessage`). **Never make the allocation follow the activities** — that is the bug this replaced: adding work raised the budget to cover itself, so a month could not be over budget and the refusal could never fire. Lowering the allocation below what is committed is refused.
- Money is recorded on the **day of work**, never on a planned activity that has days under it (the expense route refuses it), so the same budget cannot appear available twice. A planned activity with live work under it cannot be deleted.
- Work is assigned to a `manager` **or a `staff` member** (`/api/people` lists both, in scope; `/api/managers` still lists only managers and is what the "who runs this?" selects use). Assigning to staff sets `approval_required` false — a team member has no approval screen — and reassigning work to staff while a manager's decision is still pending is refused.
- `description` is required on every route that creates work, and `evidence_required` (default TRUE, so existing rows keep today's rule) decides whether evidence is demanded before work can be handed back.
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
- **Routing is the URL hash, with no router library.** `useHashRoute()` in `src/ui.jsx` gives addresses like `#/activities`, `#/activities/:id`, `#/activities/new` (the add form, in a sheet), `#/activities?filter=work|final-check` (what the home tiles open), `#/movements/:id`, `#/movements/new`, `#/monthly/:planId`, `#/reports`, and partner tabs like `#/overview`.
- **Navigation** (`navItems` in `InternalWorkspace`): each entry is `[id, label, badge, group, shortLabel]`. Group `main` (Home, Needs my approval -- Director/managers only --, Activities, Monthly budget, Movements) and `more` (Reports, Projects, Other requests, People, Partners). On phones `bottomNav` shows four main pages plus More, which opens the drawer; the burger only appears where there is no bottom bar (the partner portal).
- **Home** (`src/Home.jsx`) answers "what do I need to do?": tiles whose counts come from `/api/summary` (`myOpenWork`, `finalChecksWaiting`, `monthEndReportsWaiting`, the approval badge) built from the same SQL as the lists they open (`openWorkSql`/`FINAL_CHECK_SQL` in `server/lib/monthly.js`, `?awaiting=work|final-check` on the activity list); quick actions; decision cards (`DecisionList`, also used on the approvals page); and a card per business operation in scope with this month's `MoneyBar` from `/api/monthly-plans/review`. The open record comes from the address, so Back closes it and refresh keeps it. Callbacks passed to modules for routing must be stable (`useCallback`), because modules key their load effects on them.
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
- **Record screens** (`ActivityReview.jsx`, `MovementDetail` in `MovementModule.jsx`) share the pieces in `src/journey.jsx`: `activityJourney`/`movementJourney` work out a five-step journey (plus a side state such as Refused or Paused) from the existing status, approval and hand-back fields -- no new state -- and `journeyLabel`/`journeyTone` give lists the same words. Each record reads: `Journey`, a `NextStep` box whose buttons are only drawn when the reader's permissions allow that step, a `MoneyBar` (approved / spent / left), then folding `Section`s (details, money, receipts and photos, Director tools, history). `FilePicker` offers "Take a photo" (`capture`) and "Choose files" with previews and the server's own type/size limits. A receipt can be added in the expense form itself; `recordExpense` in `App.jsx` saves the expense and then uploads the receipt linked to it.
- **i18n** (`src/i18n.js`):
  - Each `STRINGS` entry is one key with `en`/`rw`/`fr`/`sw` on the same line. Use `fill(text, { name })` for placeholders.
  - Components use `useT()`/`useI18n()`. Non-component helpers use `displayLanguage()`/`translate()`, which is why `App` calls `setDisplayLanguage(language)` during render.
  - Audit-trail actions written by the server in English are shown through `trailActionLabel()` (`history.<Action>` keys).
  - Every user-visible string must go through a key.

## Code style

The codebase favours long explanatory comments that state *why* a rule exists (often referencing a past bug or a spec section). Match that density when changing security, money, approval or scoping logic.
