// Monthly planning, expense recording and month-end reporting.
//
// The shape of the month:
//
//   monthly_plans        one per business operation per month, naming the
//                        manager responsible and the budget the Director
//                        approved for them
//     └── activities     the planned activities the Director set for the month
//                        (the existing table, extended with monthly_plan_id and
//                        priority -- there is no second activity system)
//           └── activities           the manager's day-by-day work towards that
//                                    planned activity, by parent_activity_id:
//                                    one row per day, with its date, the person
//                                    doing it, its cost and its evidence
//                 ├── activity_expenses    what was actually spent, one row per
//                 │     └── activity_evidence (evidence_type='payment')  spend
//                 └── activity_evidence    (evidence_type='activity') proof the
//                                          work was actually done
//   monthly_reports      the manager's account of the month, which the Director
//                        reviews before closing it
//
// WHAT THIS IS NOT: no money moves through this system. Confirming a plan
// records that the Director approved an allocation and handed the cash over
// outside the platform. There is no transaction, no wallet, no transfer and no
// payment gateway anywhere in this file or the routes built on it. The tables
// record what was approved, what was spent, the evidence for it, and what is
// left -- for accountability, not for payment.

// The life of a month, as the people using it describe it:
//
//   Draft        the Director is still writing it. Nobody can work it yet.
//   Confirmed    the budget is approved and the month is the manager's to do.
//                This is "PLANNED" on their screen: ready, not started.
//   In Progress  the manager has started, and is reporting each day against it.
//   Completed    the target has been reached.
//   Closed       the month is signed off and read-only.
//
// In Progress and Completed are new. They sit between Confirmed and Closed, so
// everything that asked "is this month open?" (anything but Closed) or "is it
// still a draft?" keeps its meaning.
export const PLAN_STATUSES = ['Draft', 'Confirmed', 'In Progress', 'Completed', 'Closed'];

// A month is being worked once the manager has started it, and stays workable
// until it is closed.
export const PLAN_WORKABLE_STATUSES = ['Confirmed', 'In Progress'];
export const PLAN_PRIORITIES = ['Low', 'Medium', 'High'];
export const REPORT_STATUSES = ['Submitted', 'Accepted', 'Returned'];

// How the money left the Director's hands. Recorded for the audit trail; the
// platform neither performs nor settles any of them.
export const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Cheque', 'Credit', 'Other'];

// Payment evidence proves money was spent. Activity evidence proves the work
// was done. They are different things and are counted separately (section 7).
export const EVIDENCE_TYPES = ['payment', 'activity'];

const statements = [
  `CREATE TABLE IF NOT EXISTS monthly_plans (
     id SERIAL PRIMARY KEY,
     -- The business operation this plan covers: farming, agriculture, mining
     -- or movement. One plan per operation per month.
     sector VARCHAR(50) NOT NULL REFERENCES sectors(id) ON DELETE RESTRICT,
     -- Stored as the first day of the month, so it sorts and ranges correctly
     -- rather than as a 'YYYY-MM' string that sorts lexically.
     month DATE NOT NULL,
     manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'Draft',
     -- The figure the Director confirmed and handed over outside the platform.
     -- Written once at confirmation from the sum of the planned activities, and
     -- thereafter only by an explicit, audited change.
     approved_budget NUMERIC(18,2) NOT NULL DEFAULT 0,
     notes TEXT NOT NULL DEFAULT '',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     confirmed_at TIMESTAMPTZ,
     closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     closed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // What kind of work the month is about, from the operation's own category
  // list -- the same list the activity form offers, so Farming's September is
  // filed under a category a reader recognises rather than a phrase somebody
  // typed. Blank on plans made before the column existed.
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT ''`,
  // What the month is meant to achieve. `notes` is the Director's running
  // commentary; this is the objective the plan is judged against, which is a
  // different thing and was being written into notes for want of a field.
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS objective TEXT NOT NULL DEFAULT ''`,
  // The project the month's work belongs to, when the operation runs more than
  // one. Optional: with a single project per operation the activities already
  // resolve it, and an existing plan must not be forced to name one.
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL`,

  // ---- what the month is actually meant to achieve -------------------------
  //
  // THE MONTH IS THE WORK. A plan is not a folder of tasks somebody hands out:
  // it is one measurable objective for one business operation -- "prepare 1
  // hectare and plant potatoes", "vaccinate 500 chickens", "50 transport trips"
  // -- and the manager of that operation works towards it and reports each day.
  //
  // The target is a quantity and the unit it is counted in, so the same plan
  // shape serves hectares, chickens, square metres and trips without the system
  // knowing anything about farming or haulage. NULL means the month has no
  // countable target, and progress is then the manager's own judgement.
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS target_quantity NUMERIC(14,2)`,
  `ALTER TABLE monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_target_check`,
  `ALTER TABLE monthly_plans ADD CONSTRAINT monthly_plans_target_check
     CHECK (target_quantity IS NULL OR target_quantity > 0)`,
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS target_unit VARCHAR(40) NOT NULL DEFAULT ''`,
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS expected_output TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `ALTER TABLE monthly_plans ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,

  // ---- the month's objectives ----------------------------------------------
  //
  // A month is not one target. The Director and the four managers agree a set of
  // commitments outside the system -- "cultivate 2 hectares", "buy 1 irrigation
  // system", "irrigate 2 hectares" -- and the Director types that agreed list in.
  // Each one is measured on its own, so a month can be 100% on the equipment and
  // 40% on the irrigation instead of collapsing into a single misleading figure.
  //
  // WHY A TABLE AND NOT COLUMNS: monthly_plans already carried target_quantity
  // and target_unit, which forced a month to have exactly one countable aim. A
  // month with three commitments had to be written as three plans (the unique
  // index on (sector, month) forbids that) or squashed into one number. The
  // single-target columns are kept and backfilled below rather than dropped, so
  // months written before this still read correctly.
  //
  // The quantity/unit pair stays deliberately ignorant of any trade: hectares,
  // tons, systems, inspections, trips and cases are all just a number and a word.
  `CREATE TABLE IF NOT EXISTS plan_objectives (
     id SERIAL PRIMARY KEY,
     plan_id INTEGER NOT NULL REFERENCES monthly_plans(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     target_quantity NUMERIC(14,2),
     target_unit VARCHAR(40) NOT NULL DEFAULT '',
     -- Optional importance. When no objective on a plan carries one, the month's
     -- overall progress is the plain average of the objectives' percentages.
     weight NUMERIC(6,2),
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE plan_objectives DROP CONSTRAINT IF EXISTS plan_objectives_target_check`,
  `ALTER TABLE plan_objectives ADD CONSTRAINT plan_objectives_target_check
     CHECK (target_quantity IS NULL OR target_quantity > 0)`,
  `ALTER TABLE plan_objectives DROP CONSTRAINT IF EXISTS plan_objectives_weight_check`,
  `ALTER TABLE plan_objectives ADD CONSTRAINT plan_objectives_weight_check
     CHECK (weight IS NULL OR weight > 0)`,
  `CREATE INDEX IF NOT EXISTS plan_objectives_plan_idx ON plan_objectives(plan_id, sort_order)`,

  // ---- what a support objective is FOR --------------------------------------
  //
  // Movement & Facilitation is not a fourth production operation: it coordinates
  // transport, logistics and the other support that Mining, Agriculture and
  // Farming need. So an objective on ITS monthly plan is always support given to
  // one of those three, and this column says which.
  //
  // "50 transport trips" on its own is a number nobody can act on. "50 transport
  // trips for Mining" is the commitment that was actually agreed, and it lets
  // the Director read Mining's month as Mining's own objectives plus the support
  // promised to it.
  //
  // NULL on every objective of a primary operation's plan -- Mining's own
  // objectives support nothing, they produce. NULL is also allowed on a support
  // objective that genuinely serves all three at once (a shared fuel contract,
  // say) rather than forcing a false choice.
  //
  // Only a primary operation may be named, enforced in the route: support that
  // supports the support function is a loop, and nothing could read it.
  `ALTER TABLE plan_objectives ADD COLUMN IF NOT EXISTS supports_operation VARCHAR(50)
     REFERENCES sectors(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS plan_objectives_supports_idx ON plan_objectives(supports_operation)`,

  // ---- the daily form this objective is recorded through ---------------------
  //
  // The Director writes "Ore extraction, 500 tonnes" and the manager should be
  // asked "Tonnes extracted today", not "Work done". The wording of that one
  // question is what decides whether a manager records their day at all, and it
  // is different for every objective in every operation -- tonnes, inspections,
  // hectares, sessions, trips, cases.
  //
  // So the form is generated FROM the objective rather than hard-coded, and
  // stored here: generated once when the objective is written, not on every page
  // load. form_source says where it came from -- 'derived' for the deterministic
  // reading of the objective's own words, 'ai' once a model has improved it --
  // so a reader can always tell, and so a failed or unconfigured model leaves a
  // working form behind rather than nothing.
  //
  // IT IS ONLY THE QUESTION, NEVER THE ANSWER. Nothing in here affects progress:
  // that is still summed from plan_daily_reports. A generated form cannot change
  // a figure, only how the manager is asked for it.
  `ALTER TABLE plan_objectives ADD COLUMN IF NOT EXISTS form_spec JSONB`,
  `ALTER TABLE plan_objectives ADD COLUMN IF NOT EXISTS form_source VARCHAR(20)`,
  `ALTER TABLE plan_objectives ADD COLUMN IF NOT EXISTS form_generated_at TIMESTAMPTZ`,
  `ALTER TABLE plan_objectives DROP CONSTRAINT IF EXISTS plan_objectives_form_source_check`,
  `ALTER TABLE plan_objectives ADD CONSTRAINT plan_objectives_form_source_check
     CHECK (form_source IS NULL OR form_source IN ('derived', 'ai'))`,

  // ---- the manager's day, reported against the month ------------------------
  //
  // One row per working day. This is the manager's main record and the source of
  // truth for how far the month has got: progress is the sum of quantity_done
  // against the plan's target, never a figure anybody types.
  //
  // WHY COST LIVES HERE: a working day may cost nothing. Making the spend the
  // record of the work meant a day with no money in it could not be reported at
  // all, and "$0" read as "nothing happened". The work and the money are two
  // fields of one report, and cost defaults to zero.
  `CREATE TABLE IF NOT EXISTS plan_daily_reports (
     id SERIAL PRIMARY KEY,
     plan_id INTEGER NOT NULL REFERENCES monthly_plans(id) ON DELETE CASCADE,
     report_date DATE NOT NULL,
     quantity_done NUMERIC(14,2) NOT NULL DEFAULT 0,
     cost NUMERIC(18,2) NOT NULL DEFAULT 0,
     notes TEXT NOT NULL DEFAULT '',
     submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     submitted_by_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE plan_daily_reports DROP CONSTRAINT IF EXISTS plan_daily_reports_amounts_check`,
  `ALTER TABLE plan_daily_reports ADD CONSTRAINT plan_daily_reports_amounts_check
     CHECK (quantity_done >= 0 AND cost >= 0)`,
  `CREATE INDEX IF NOT EXISTS plan_daily_reports_plan_idx ON plan_daily_reports(plan_id, report_date DESC)`,

  // Which of the month's commitments this day's work counted towards. Without
  // it a day of irrigating and a day of cultivating both just added to one pile
  // and neither objective could show its own progress.
  //
  // Nullable because the months that existed before objectives did have days
  // recorded against the plan as a whole; the backfill below gives those a home
  // rather than stranding them. ON DELETE CASCADE, because a day's work towards
  // an objective is meaningless once that objective is gone -- and the Director
  // can only remove an objective that has no work against it (see the route).
  `ALTER TABLE plan_daily_reports ADD COLUMN IF NOT EXISTS objective_id INTEGER
     REFERENCES plan_objectives(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS plan_daily_reports_objective_idx ON plan_daily_reports(objective_id)`,

  // Backfill: every month written when a plan had a single target becomes a
  // month with a single objective, so nothing written before this reads as an
  // empty plan. Idempotent by the NOT EXISTS guard -- a plan that already has
  // objectives is left exactly as it is, on this boot and every later one.
  `INSERT INTO plan_objectives (plan_id, title, target_quantity, target_unit, sort_order)
   SELECT p.id,
          -- The objective text the Director wrote is the best title there is;
          -- falling back to the expected output, then to a plain label, so the
          -- row is never nameless.
          COALESCE(NULLIF(TRIM(p.objective), ''), NULLIF(TRIM(p.expected_output), ''), 'Monthly objective'),
          p.target_quantity,
          p.target_unit,
          0
     FROM monthly_plans p
    WHERE (p.target_quantity IS NOT NULL
           OR NULLIF(TRIM(p.objective), '') IS NOT NULL
           OR NULLIF(TRIM(p.expected_output), '') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM plan_objectives o WHERE o.plan_id = p.id)`,

  // And point that month's existing days at the objective just made for them,
  // so their quantities keep counting. Only days with no objective are touched.
  `UPDATE plan_daily_reports r
      SET objective_id = (SELECT o.id FROM plan_objectives o
                           WHERE o.plan_id = r.plan_id
                           ORDER BY o.sort_order, o.id LIMIT 1)
    WHERE r.objective_id IS NULL
      AND EXISTS (SELECT 1 FROM plan_objectives o WHERE o.plan_id = r.plan_id)`,

  // Proof of a particular day's work. Kept apart from activity_evidence because
  // that table's rows belong to an activity and are served through the activity
  // permission checks; these belong to a day of a month and are served through
  // the month's. Both go through server/lib/storage.js, so the files themselves
  // are handled in exactly one place.
  `CREATE TABLE IF NOT EXISTS plan_report_evidence (
     id SERIAL PRIMARY KEY,
     report_id INTEGER NOT NULL REFERENCES plan_daily_reports(id) ON DELETE CASCADE,
     kind VARCHAR(50) NOT NULL DEFAULT 'Photograph',
     original_name VARCHAR(255) NOT NULL,
     stored_name VARCHAR(255) NOT NULL,
     mime_type VARCHAR(120) NOT NULL,
     size_bytes INTEGER NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT '',
     uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     uploaded_by_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS plan_report_evidence_report_idx ON plan_report_evidence(report_id)`,
  `ALTER TABLE monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_status_check`,
  `ALTER TABLE monthly_plans ADD CONSTRAINT monthly_plans_status_check
     CHECK (status IN (${PLAN_STATUSES.map((status) => `'${status}'`).join(', ')}))`,
  // One plan per operation per month: two plans for the same Farming September
  // would each look authoritative and the budgets would double-count.
  `CREATE UNIQUE INDEX IF NOT EXISTS monthly_plans_operation_month_idx ON monthly_plans(sector, month)`,
  `CREATE INDEX IF NOT EXISTS monthly_plans_manager_idx ON monthly_plans(manager_id, month DESC)`,

  // Plan-level audit. Activity-level changes keep going to activity_history, so
  // a budget change is recorded against the activity it belongs to.
  `CREATE TABLE IF NOT EXISTS monthly_plan_history (
     id SERIAL PRIMARY KEY,
     plan_id INTEGER NOT NULL REFERENCES monthly_plans(id) ON DELETE CASCADE,
     action VARCHAR(60) NOT NULL,
     field VARCHAR(60),
     old_value TEXT,
     new_value TEXT,
     note TEXT NOT NULL DEFAULT '',
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS monthly_plan_history_plan_idx ON monthly_plan_history(plan_id, created_at DESC)`,

  // ---- the planned activities ---------------------------------------------
  //
  // The existing activities table, extended. An activity with a monthly_plan_id
  // is part of that month's approved budget; one without is off-plan work,
  // which is exactly how section 4 keeps a manager from raising an activity and
  // spending the month's money on it.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS monthly_plan_id INTEGER REFERENCES monthly_plans(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'Medium'`,
  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_priority_check`,
  `ALTER TABLE activities ADD CONSTRAINT activities_priority_check
     CHECK (priority IN (${PLAN_PRIORITIES.map((priority) => `'${priority}'`).join(', ')}))`,
  `CREATE INDEX IF NOT EXISTS activities_monthly_plan_idx ON activities(monthly_plan_id)`,

  // ---- the day-by-day work under a planned activity ------------------------
  //
  // Two levels, one table. A planned activity (parent_activity_id IS NULL) is
  // what the Director set for the month with a budget against it. The day-by-day
  // work the manager assigns to reach it hangs underneath, one row per day, each
  // with its own date, assignee, cost and evidence. Adding them up is how the
  // planned activity gets finished, and how the Director watches it progress.
  //
  // WHY NOT A SECOND TABLE: the daily work is an activity in every respect --
  // it is assigned, started, spent against, evidenced, handed back and approved
  // through the routes that already exist. A parallel table would have had to
  // reimplement all of it.
  //
  // Both levels carry monthly_plan_id, so scoping and the closed-month guard
  // reach the children too. Every plan-level BUDGET sum therefore has to filter
  // parent_activity_id IS NULL or it would count the same money twice; spend is
  // summed over both levels, because that is where it lands.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS parent_activity_id VARCHAR(50) REFERENCES activities(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS activities_parent_idx ON activities(parent_activity_id)`,
  // Whether finishing this needs something to show for it. Evidence has always
  // been demanded before work can be handed back; a meeting or a supervision
  // visit sometimes has nothing to photograph, and the rule had no way to say
  // so. TRUE by default, so every row that already exists keeps today's rule.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN NOT NULL DEFAULT TRUE`,

  // ---- what was actually spent --------------------------------------------
  //
  // One row per spend, not one figure on the activity: a manager buys
  // fertilizer twice and both are recorded, with their own date, method and
  // evidence. The activity's remaining budget is derived by summing these
  // rather than stored, so it can never drift from the rows it is made of.
  `CREATE TABLE IF NOT EXISTS activity_expenses (
     id SERIAL PRIMARY KEY,
     activity_id VARCHAR(50) NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
     amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
     spent_on DATE NOT NULL,
     payment_method VARCHAR(40) NOT NULL,
     description TEXT NOT NULL,
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     recorded_by_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE activity_expenses DROP CONSTRAINT IF EXISTS activity_expenses_method_check`,
  `ALTER TABLE activity_expenses ADD CONSTRAINT activity_expenses_method_check
     CHECK (payment_method IN (${PAYMENT_METHODS.map((method) => `'${method}'`).join(', ')}))`,
  `CREATE INDEX IF NOT EXISTS activity_expenses_activity_idx ON activity_expenses(activity_id, spent_on DESC)`,

  // ---- the two kinds of evidence ------------------------------------------
  //
  // Section 7: payment evidence and activity evidence are different things.
  // They share one table because they are the same sort of object -- a file
  // against a record -- but they are typed, counted and reported separately.
  `ALTER TABLE activity_evidence ADD COLUMN IF NOT EXISTS evidence_type VARCHAR(20) NOT NULL DEFAULT 'payment'`,
  `ALTER TABLE activity_evidence ADD COLUMN IF NOT EXISTS expense_id INTEGER REFERENCES activity_expenses(id) ON DELETE CASCADE`,
  `ALTER TABLE activity_evidence DROP CONSTRAINT IF EXISTS activity_evidence_type_check`,
  `ALTER TABLE activity_evidence ADD CONSTRAINT activity_evidence_type_check
     CHECK (evidence_type IN (${EVIDENCE_TYPES.map((type) => `'${type}'`).join(', ')}))`,
  // Only payment evidence hangs off an expense; activity evidence proves the
  // work, which has no expense to attach to.
  `ALTER TABLE activity_evidence DROP CONSTRAINT IF EXISTS activity_evidence_expense_type_check`,
  `ALTER TABLE activity_evidence ADD CONSTRAINT activity_evidence_expense_type_check
     CHECK (expense_id IS NULL OR evidence_type = 'payment')`,
  // Files uploaded before the two kinds were distinguished: a photograph was
  // proof the work happened, everything else was proof of payment.
  `UPDATE activity_evidence SET evidence_type = 'activity' WHERE kind = 'Photograph'`,
  `CREATE INDEX IF NOT EXISTS activity_evidence_type_idx ON activity_evidence(activity_id, evidence_type)`,
  `CREATE INDEX IF NOT EXISTS activity_evidence_expense_idx ON activity_evidence(expense_id)`,

  // ---- the manager's account of the month ---------------------------------
  `CREATE TABLE IF NOT EXISTS monthly_reports (
     id SERIAL PRIMARY KEY,
     plan_id INTEGER NOT NULL UNIQUE REFERENCES monthly_plans(id) ON DELETE CASCADE,
     -- Figures as they stood when the report was submitted, so the report is a
     -- record of what was said at the time rather than a live query that
     -- changes underneath the Director reading it.
     approved_budget NUMERIC(18,2) NOT NULL DEFAULT 0,
     total_spent NUMERIC(18,2) NOT NULL DEFAULT 0,
     remaining_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
     completed_activities INTEGER NOT NULL DEFAULT 0,
     incomplete_activities INTEGER NOT NULL DEFAULT 0,
     activity_evidence_count INTEGER NOT NULL DEFAULT 0,
     payment_evidence_count INTEGER NOT NULL DEFAULT 0,
     unused_balance_explanation TEXT NOT NULL DEFAULT '',
     budget_difference_explanation TEXT NOT NULL DEFAULT '',
     status VARCHAR(20) NOT NULL DEFAULT 'Submitted',
     review_note TEXT NOT NULL DEFAULT '',
     submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     reviewed_at TIMESTAMPTZ
   )`,
  `ALTER TABLE monthly_reports DROP CONSTRAINT IF EXISTS monthly_reports_status_check`,
  `ALTER TABLE monthly_reports ADD CONSTRAINT monthly_reports_status_check
     CHECK (status IN (${REPORT_STATUSES.map((status) => `'${status}'`).join(', ')}))`
];

export async function migrateMonthlyModule(pool) {
  for (const statement of statements) {
    await pool.query(statement);
  }
}
