# Importing an operations workbook

The Rubaya & Gisuma operations are kept by hand in an Excel workbook, one sheet
per area. These two scripts turn a month of that workbook into what this system
holds: a monthly plan per operation, with the budget the month actually cost, a
list of objectives, and one recorded day per row.

```bash
# 1. read the workbook, decide the plans   (no database, no network)
node scripts/import/plans-from-workbook.mjs "rubaya report.xlsx" /tmp/plans.json

# 2. load them through the API             (needs the API running)
node scripts/import/load-plans.mjs /tmp/plans.json
node scripts/import/load-plans.mjs /tmp/plans.json https://your-deployment   # or a deployment
node scripts/import/load-plans.mjs /tmp/plans.json https://your-deployment --check   # writes nothing; says what is already there
```

Step 1 prints every plan it decided and every row it set aside. **Read that
output before running step 2** -- it is the whole review surface, and the import
is far easier to check there than in the database afterwards.

## Running it again, and finishing an import that died

Both steps are safe to re-run, and the second one is written for it: before it
writes anything, `load-plans.mjs` reads every month in the file back off the
deployment and compares it with the file day by day.

```bash
node scripts/import/load-plans.mjs /tmp/plans.json https://your-deployment --check
```

`--check` writes nothing at all. It prints, month by month, whether the month is
**not there** (it would be created), **already recorded in full** (nothing to
add) or **half recorded** -- and for that last one, the dates it is missing. A
run then creates the absent months, leaves the complete ones exactly as they
are, and adds only the missing days to a half-recorded one, against the plan
that is already there.

That last case is what this is for. The unique index on
`monthly_plans(sector, month)` means a month that finished can never be written
twice, so a re-run was never going to double one -- but a month the import was
cut off in the middle of already has its plan, so the re-run was refused at
creation with a 409 indistinguishable from the finished months', and its missing
days were never recorded. There is no DELETE for a plan through the API either,
so "delete it and start again" was never a path this script could offer.

A month is **left untouched, with the reason printed**, when it is not the month
the file describes: it holds days the file does not, its objectives differ, its
approved budget differs, or its status (Draft, Closed) refuses a day. Those need
a person to look at them.

No day is ever posted twice. A day already recorded is matched on its objective,
date, quantity and cost -- not its note, which the server trims, and which is no
reason to record the same work again -- and identical days are counted rather
than collapsed, so two genuine tanks of fuel at the same price on one date stay
two. That comparison is `scripts/import/compare.mjs`, on its own and away from
the HTTP, because it is what decides whether a figure is doubled;
`tests/pure-logic.test.mjs` covers it and needs no database.

## What the scripts assume about the workbook

These are not guesses that can be left to drift -- each one changes the figures.

- **Sheet names and column positions** are hard-coded in `SHEETS` and
  `SHEET_OPERATION`. A renamed sheet is reported as skipped rather than
  mis-read. A column inserted in the middle of a sheet is NOT detected and will
  silently read the wrong values, so check the printed plans after any edit to
  the workbook's shape.
- **Dates are d/m/y.** Excel swallowed every cell whose first two numbers were
  both 12 or under as m/d/y, so a cell reading `2026-07-08` was typed `7/8/2026`
  and means **7 August**. Those are swapped back; text cells are read as d/m/y.
  Read literally, August's work scatters into July and every monthly total
  breaks.
- **Money comes from the USD column when the workbook states one**, and is
  otherwise converted from FRW or FCO at the rate the workbook itself implies --
  the median across every row that states both currencies, so one typo cannot
  move it. Each day keeps its original figure in its note.
- **Rows that are arithmetic about other rows are not costs.** Each consignment
  is closed with `DELIVERY n SUMMARY`, `Total kgs Received`, `Total Sale`,
  `net profit` and bare sums. Counted as spending they double the month. One of
  them reads `DELIVERY 2Total ...` with no space, which is why `total` is
  matched as a bare substring and not as `\btotal\b`.
- **Sales and profits have nowhere to go.** The platform records money going out
  and has no concept of a sale or a revenue, by design. Those figures are
  preserved verbatim in the plan's `notes` (`DELIVERY_NOTES`, which needs a new
  entry for each new consignment) rather than being forced into a column that
  would misrepresent them.

## How the objectives are decided

One objective per *kind* of work, not per row. The sheets name the same work a
dozen ways -- "fuel", "Buying fuel", "Full tank Fuel" -- and a month of twenty
near-duplicate lines is not a list of commitments anybody agreed to. `BUCKETS`
maps the words actually used to the kind of work they describe, first match
wins; the row's own wording survives verbatim on the day.

The target is the summed quantity from the sheet, with its unit, taken from a
leading number ("10 Labours", "424 meters", "108kg"). A quantity with a number
but no unit takes the unit of the rows beside it, and a row with no figure at
all is allowed as long as **at least two thirds of the bucket's rows state the
same unit** -- September's coltan deliveries read "60kgs", "66kgs", "20kgs",
"51.7kgs", "52kgs" and then one blank, and that blank used to turn 249.7kg of
coltan moved into "6 entries". Those rows keep their day, their cost and their
note, and add nothing to a target they never claimed.

Below two thirds, or where the rows disagree on the unit outright, the work is
not one countable thing -- August's shopping reads "Posho(25kg),Torch,Rice(2kg)
&2 Big fant" -- and the objective counts **the times it was done** instead.
Half was tried before two thirds and is too generous: two rows reading
"1Tech,1Carp&1Helper" out of four made a month of roof renovation a target of
"2 tech". The word is `times` and not `entries` because the Director reads these
targets and writes the next month from what they read, and the manager is then
asked to record against that same word.

Either way the target equals what was actually done, so an imported month reads
as complete -- which is true, the workbook marks it so.

## How the data gets in

Through the API, never with INSERTs. The Director creates each month and its
budget; the operation's own manager posts every day. That means every row has
passed the budget ceiling under its `FOR UPDATE` lock, the objective's remaining
target, the month-match on the date, and the rule that a Director may not record
a manager's work. An import written with INSERTs would prove none of that.

`load-plans.mjs` needs `JWT_SECRET` to mint those sessions, and `ADMIN_PASSWORD`
only on a database so fresh that the Director has not yet chosen a password. It
reads `.env.local` by default; point `ENV_FILE` elsewhere for a deployment:

```bash
npx vercel env pull /tmp/prod.env --environment=production
ENV_FILE=/tmp/prod.env node scripts/import/load-plans.mjs /tmp/plans.json https://your-deployment
```

Pull to a path **outside the repo**. `vercel env pull` writes `.env.local` by
default, and that file is your local database configuration.

Managers that already exist are never touched -- their sessions are minted, not
their passwords reset, because an import must not lock a real person out. Any
manager the import has to create is handed back with a temporary password and
`must_change_password` set, so its owner chooses their own at first sign-in.
