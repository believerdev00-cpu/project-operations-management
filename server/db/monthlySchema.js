// Monthly planning, expense recording and month-end reporting.
//
// The shape of the month:
//
//   monthly_plans        one per business operation per month, naming the
//                        manager responsible and the budget the Director
//                        approved for them
//     └── activities     the planned work (the existing table, extended with
//                        monthly_plan_id and priority -- there is no second
//                        activity system)
//           ├── activity_expenses    what was actually spent, one row per spend
//           │     └── activity_evidence (evidence_type='payment')
//           └── activity_evidence    (evidence_type='activity') proof the work
//                                    was actually done
//   monthly_reports      the manager's account of the month, which the Director
//                        reviews before closing it
//
// WHAT THIS IS NOT: no money moves through this system. Confirming a plan
// records that the Director approved an allocation and handed the cash over
// outside the platform. There is no transaction, no wallet, no transfer and no
// payment gateway anywhere in this file or the routes built on it. The tables
// record what was approved, what was spent, the evidence for it, and what is
// left -- for accountability, not for payment.

export const PLAN_STATUSES = ['Draft', 'Confirmed', 'Closed'];
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
