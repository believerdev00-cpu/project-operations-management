# Tests

```bash
npm test                 # every suite
npm test monthly         # one suite, by name or filename
```

The runner starts the API if it is not already running and stops it afterwards,
so `npm test` works from cold without a second terminal. A server already
running is left alone.

## What is here

| Suite | Covers |
|---|---|
| `translations.test.mjs` | every key translated into all four languages, every key used, no hard-coded English left in the JSX |
| `approval-workflow.test.mjs` | who must approve a record, and that nobody else can |
| `partner-access.test.mjs` | an external partner sees one business operation and nothing else |
| `monthly-workflow.test.mjs` | planning, the approved allocation, expenses, the budget block, evidence, month-end |

## They run against the real database

These are not unit tests. They drive the live API against the live database,
because most of what they check only exists there: CHECK constraints, the
manager-per-sector trigger, `FOR UPDATE` row locking under a concurrent spend,
and the SQL scoping that decides who can read what. A mocked database would
prove none of it.

The consequences are worth knowing:

- **`DATABASE_URL` must point at a database you are willing to write to.** The
  suites create accounts, plans, activities and expenses.
- **Everything created is removed again.** Fixtures use a `zz-` username prefix
  and `ZZTEST`/`TEST` record names, and each suite cleans up in a `finally`, so
  a failure part-way through still tidies up.
- **They run in sequence, never in parallel.** The suites share that `zz-`
  namespace and would trip over each other's fixtures.
- **A killed run can leave fixtures behind** (piping to `head`, for instance,
  can end the process before cleanup). The next run may then fail on a duplicate
  username. Clear them with:

  ```sql
  DELETE FROM monthly_plans WHERE month = '2099-09-01';
  DELETE FROM activities WHERE activity LIKE 'ZZTEST %' OR activity LIKE 'TEST %';
  DELETE FROM users WHERE username LIKE 'zz-%';
  ```

`ADMIN_PASSWORD` is used to sign in as the Director; it defaults to the value in
`.env`.

## What they are actually guarding

The things that would be expensive to get wrong and are not obvious from
reading the code:

- A spend of exactly the remaining budget is allowed; one cent more is refused,
  with the exact wording the workflow specifies.
- A Mining partner asking for Farming data by any parameter name gets nothing.
- Only the account a record names as its approver can approve it.
- No table or API response anywhere carries a payment, wallet or transfer
  concept — the platform records money, it never moves it.
