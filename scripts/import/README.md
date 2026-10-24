# Importing an operations workbook

These scripts were written for one job: loading the Rubaya & Gisuma operations
workbook for **July-September 2026** into POMS (done 24 October 2026: 12 plans,
160 days, $118,398.41). They are kept so that import can be understood and
re-checked. **They are not a general-purpose importer.** Several rules below are
specific to that workbook, and a future import needs them reviewed, and probably
changed, first.

| File | Touches | What it does |
|---|---|---|
| `plans-from-workbook.mjs` | nothing (reads a file, writes a file) | turns the workbook into a JSON plans file |
| `workbookRules.mjs` | nothing (pure functions) | the workbook-specific rules: dates and the year, totals rows, delivery notes |
| `load-plans.mjs` | the API, as the Director and as each manager | creates the months and records the days |
| `http.mjs` | the network | the one request function: read-only in `--check`, retries only requests that never arrived |
| `credentials.mjs` | one new file you name | where generated passwords may go (never the console) |
| `compare.mjs` | nothing (pure functions) | what is already recorded, what is missing, the quantity to post, the days a run would add |
| `../../shared/workbookNote.js` | nothing (pure functions) | writes and reads the note each imported day carries |

## Before any future import

Do all of these, and keep the output:

1. **Look at the workbook.** Sheet names, column positions, the year, the
   currencies and the summary rows are hard-coded (see "Workbook-specific
   rules"). A changed workbook is read wrongly without warning.
2. **Run step 1 and read everything it prints**: every plan, objective and
   target, every row set aside (with the reason), every row set aside as a
   total (with its money), every row held for review.
3. **Write down the expected counts and totals** (months, days, money per
   operation and month) and agree them with the Director **before** writing.
4. **Back up the database** (for Neon: a branch) and verify the backup.
5. **Run `load-plans.mjs --check`** against the target and compare its answer
   with the expected counts. Only then run it without `--check`, with
   `--expect-days=<the number --check printed>`.
6. **Run one write run at a time.** Nothing locks the database against two runs;
   `--expect-days` makes a second run stop, but only if it is given.

## Step 1 -- workbook to plans file (no database, no network)

```bash
node scripts/import/plans-from-workbook.mjs <workbook.xlsx> <plans.json> --year=2026 \
  --rate-frw=1478 --rate-fco=2315 --ranges=first-day \
  [--delivery-notes=<notes.json>] [--exclude=mining/2026-08,...]
```

- `--year=<YYYY>` (**required**): the year every row must fall in. A row dated
  in any other year is **set aside with its reason** ("year 2028 is not 2026"),
  never rewritten. An impossible date (31 June) is set aside the same way.
- `--rate-frw` / `--rate-fco`: the exchange rates the Director approved. Give
  both or neither. Without them, the rate is the median the workbook itself
  implies (rows stating USD and a local figure). FRW is the workbook's word for
  RWF and FCO for CDF; notes keep the workbook's words.
- **Money**: the USD column when the row has one; otherwise FRW converted;
  otherwise FCO converted. A row with FRW and FCO but no USD uses FRW. Each day's
  note keeps the original figure and the rate, e.g. `6000 FRW at 1478/USD`.
- **Date ranges** ("10-11/8/2026", one payment for several days):
  - without `--ranges=first-day` the row is **held for review**: it is not
    recorded as a day, but its money is in the month's approved budget, so the
    month shows that amount as unspent until somebody decides;
  - with `--ranges=first-day` (the Director's decision for the 2026 import) the
    whole amount is recorded on the **first** day of the range, never split, and
    the description gains `(dates 10-11/8/2026, recorded on the first day)`.
- `--delivery-notes=<file.json>` (optional): Mining's delivery summaries -- the
  sales and profit POMS has no field for -- as words for a month's notes:
  `{ "mining/2026-08": "Delivery 1: ...", "mining/2026-09": "..." }`. Without
  it no month gets any. (They used to be hard-coded for August and September
  2026.)
- `--exclude=operation/YYYY-MM,...` leaves whole months out of the file.
- **Approved budget** of each month = the sum of its days (plus held rows), so
  budget and spending are equal for a fully recorded month.
- Each day's note records the source as `[<input file name> / <sheet> row <n>]`,
  using the name of the file given on the command line. The 2026 import was run
  with two differently named copies, so its notes name two files
  (`rubaya report.xlsx` and `Rubaya & Gisuma Proiects (2).xlsx`).

**Re-running step 1 on the 2026 workbook does not reproduce the import
exactly.** One row (`OPS Related to mining` row 23, $6.80, typed "25/8/2028")
was imported as 25 August 2026 when the year was still forced; it is now set
aside instead. Everything else comes out the same.

### How objectives and targets are decided

- One objective per kind of work (`BUCKETS`, first match wins); the row's own
  words stay on the day.
- **Countable work**: when at least two thirds of an objective's rows start with
  a number and they all share one unit ("424 meters", "108kg"), the target is
  the sum of those quantities in that unit -- i.e. what was actually done, a
  historical record rather than an originally agreed target.
- **Uncountable work** (no shared unit, or too few rows stating a number) gets
  **no target**: `targetQuantity` null, no unit, and each day's quantity null
  (stored as 0). Such an objective has no percentage ("not counted"); the month
  completes on its countable objectives only. A month made only of uncountable
  objectives never completes by itself.
- Older months imported before this rule (the 11 months first loaded in October
  2026) carry targets in `entries` that count one per row; they were left as
  they are.

## Step 2 -- plans file into a deployment

```bash
ENV_FILE=<settings file outside the repo> node scripts/import/load-plans.mjs <plans.json> <api-url> --check
ENV_FILE=<settings file outside the repo> node scripts/import/load-plans.mjs <plans.json> <api-url> --expect-days=<N>
```

### Check mode (`--check`) -- read-only

Every request goes through `http.mjs`, which in check mode refuses anything but
a GET **before it is sent** (tested without a network). For every month it
reports one of:

- **not there** -- would be created with N objectives, N days, $N;
- **already recorded in full** -- nothing to add (plus any day recorded with a
  different quantity than the file, and any budget that differs);
- **half recorded** -- lists the missing days;
- **left alone** -- the month differs from the file (extra days, unknown
  objectives, a different budget, or a Draft/Closed status) and needs a person.

It then prints the number of days a write run would add (`--expect-days=N`) and
which active manager would record each operation's days.

### Write mode (no `--check`)

- With `--expect-days=N`, refuses before writing anything unless it would add
  exactly N days -- so a run started after another one has written stops.
- Creates absent months as the Director, with the file's objectives and budget.
- Adds the missing days to half-recorded months **as the month's own manager**.
  Every day passes the same API checks as a day typed by hand (budget ceiling,
  remaining target, date inside the month, who may record).
- Never touches a complete month or a month left alone.
- In a month that already counts rows (`entries`/`times` targets), a missing
  day with no quantity (0 or none) is posted with **quantity 1**, so that
  month's existing targets can still be met; any quantity the file states is
  posted unchanged (`quantityToPost` in `compare.mjs`). This changes the
  workbook's figure and was approved for the 2026 import.
- Re-running is safe: a day is matched on objective + date + quantity + cost,
  and a day recorded earlier with another quantity is matched on objective +
  date + cost + **sheet and row** (the file name is not compared). Identical
  days are counted, not collapsed. A request is retried only when it never
  reached the server.
- Creates a project for an operation that has none.

### Signing key, accounts and passwords

- The script needs the deployment's `JWT_SECRET` and **creates sessions as the
  Director and as any manager without their passwords**. Whoever holds that
  settings file can act as anyone. Keep it outside the repo, never paste it
  anywhere, and consider rotating the key after a run.
- It uses the single **active** manager of each operation; name one with
  `--manager=<operation>=<username>` when there are several. With none, that
  operation stops.
- **Generated passwords are never printed.** Two cases generate them: a
  brand-new database (the seeded Director has to choose a password) and
  `--create-missing-managers` (for a throwaway database only). Both require
  `--credentials-out=<path>`: a **new** file **outside the repository**, created
  owner-only and never overwritten; the console shows only its path. Both are
  **refused on Windows**, where Node cannot restrict a new file to its owner --
  run those from Linux or macOS, or create the accounts in People. A run that
  dies after creating accounts leaves them to be reset in People.

## The one-off re-pricing of 24 October 2026

27 days already in production had been converted at the workbook's implied
rates. They were re-priced to the approved rates (1 USD = 1,478 FRW = 2,315 FCO)
with `reprice-history.mjs`. **It is a historical audit artifact: kept out of
commits, never to be run again.** It sits untracked in this folder until it is
moved to the import's records.

- It updated `plan_daily_reports.cost`, five `monthly_plans.approved_budget`
  values and two notes **directly in the database**, bypassing the API, in one
  transaction guarded by the exact expected counts (`--expect=27,5,2`) and the
  old values.
- Every change has a `Historical rate correction` row in `monthly_plan_history`
  (#219-#252) with the old and new value.
- It is **unsafe to reuse**: it connects **without verifying the database
  server's TLS certificate**, attributes every change to the first active
  Director, takes whatever plans file it is given as the truth, and has no
  tests. Any future correction of past days should be its own reviewed change.

## Workbook-specific rules (review before reuse)

- **Sheets and columns** are hard-coded in `SHEETS` and `SHEET_OPERATION`. An
  unknown sheet is skipped and reported; an inserted column is **not** detected.
- **Dates are d/m/y.** Cells Excel read as dates with both numbers 12 or under
  are swapped back (a cell showing 2026-07-08 means 7 August). The year must be
  the one given with `--year`.
- **Any row whose activity or description contains "total"**, "summary", "net
  profit" or a bare sum is set aside as arithmetic -- including a real cost that
  happens to say "total". Every such row is listed at the end of step 1 with its
  money: check each one.
- **Movement & Facilitation** takes both facilitation sheets; "OPS Related to
  mining" becomes objectives marked as supporting Mining.

## Tests

`node tests/pure-logic.test.mjs` needs no database and no network. For the
import it covers: `compare.mjs` (matching, duplicates, months left alone, the
quantity rule, the count a run would add), `http.mjs` (check mode refuses writes
before sending; only never-arrived requests are retried -- through a fake
fetch), `credentials.mjs` (refusals; an existing file is never overwritten),
`workbookRules.mjs` (dates and the year, totals, delivery notes) and
`workbookNote.js`. It does not run `load-plans.mjs` or
`plans-from-workbook.mjs` end to end, and nothing covers `reprice-history.mjs`.
