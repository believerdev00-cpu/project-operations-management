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
```

Step 1 prints every plan it decided and every row it set aside. **Read that
output before running step 2** -- it is the whole review surface, and the import
is far easier to check there than in the database afterwards.

Both steps are safe to re-run in the sense that nothing is overwritten: a month
that already exists is refused by the API with 409 and reported as a problem at
the end. There is no "update an imported month" path. To redo one, delete the
plan first.

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
but no unit takes the unit of the rows beside it. A bucket whose rows genuinely
disagree on what they count, or do not count at all, is targeted in `entries`,
one per record. Either way the target equals what was actually done, so an
imported month reads as complete -- which is true, the workbook marks it so.

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
