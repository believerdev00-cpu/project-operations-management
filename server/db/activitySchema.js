// Activity review workflow migration.
// Extends the existing `activities` table rather than introducing a second
// activity system, and adds the side tables the Logistics module already proved
// out: evidence, an audit trail, and the manager's budget-change requests.
//
// One table carries both directions of the workflow:
//   'assigned'  -- the Director creates the work, sets its budget and deadline,
//                  and hands it to a manager, who accepts it and carries it out.
//   'requested' -- a manager raises the need and the Director decides it.

export const ACTIVITY_ORIGINS = ['assigned', 'requested'];

export const ACTIVITY_STATUSES = [
  'Assigned', 'Accepted', 'Pending Review', 'Approved', 'Budget Adjusted',
  'In Progress', 'Needs Correction', 'Completed', 'Rejected', 'On Hold'
];

// The statuses the table used before the review workflow existed, mapped onto
// the ones above. Run before the CHECK constraint, or every legacy row fails it.
const LEGACY_STATUS_MAP = {
  Pending: 'Pending Review',
  Cancelled: 'Rejected'
};

const statements = [
  // The amount the manager asked for. Never overwritten by a decision: the
  // approved figure lands in its own column so both survive side by side.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS requested_budget NUMERIC(18,2) NOT NULL DEFAULT 0`,
  // NULL means "not decided yet", which is different from an approved zero.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approved_budget NUMERIC(18,2)`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS materials TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(150) NOT NULL DEFAULT ''`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
  // Stamped when the manager hands finished work back with its evidence. The
  // status stays where it is until the Director reviews and closes the record.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS completion_submitted_at TIMESTAMPTZ`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS evidence_status VARCHAR(20) NOT NULL DEFAULT 'Pending'`,

  // Director-assigned work: who is to carry it out, by when, and on what terms.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS deadline DATE`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,
  // Which way round the record was created. Rows predating the assignment flow
  // were all raised by a manager, which is the default.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'requested'`,
  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_origin_check`,
  `ALTER TABLE activities ADD CONSTRAINT activities_origin_check
     CHECK (origin IN (${ACTIVITY_ORIGINS.map((origin) => `'${origin}'`).join(', ')}))`,

  // Rows created before this workflow carry their request only as cost_usd.
  `UPDATE activities SET requested_budget = cost_usd WHERE requested_budget = 0 AND cost_usd > 0`,

  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_status_check`,
  ...Object.entries(LEGACY_STATUS_MAP).map(
    ([from, to]) => `UPDATE activities SET status = '${to}' WHERE status = '${from}'`
  ),
  `UPDATE activities SET status = 'Pending Review'
     WHERE status NOT IN (${ACTIVITY_STATUSES.map((status) => `'${status}'`).join(', ')})`,
  `ALTER TABLE activities ALTER COLUMN status SET DEFAULT 'Pending Review'`,
  `ALTER TABLE activities ADD CONSTRAINT activities_status_check
     CHECK (status IN (${ACTIVITY_STATUSES.map((status) => `'${status}'`).join(', ')}))`,
  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_evidence_status_check`,
  `ALTER TABLE activities ADD CONSTRAINT activities_evidence_status_check
     CHECK (evidence_status IN ('Pending', 'Partial', 'Complete'))`,

  `CREATE TABLE IF NOT EXISTS activity_evidence (
     id SERIAL PRIMARY KEY,
     activity_id VARCHAR(50) NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
     kind VARCHAR(50) NOT NULL DEFAULT 'Receipt',
     original_name VARCHAR(255) NOT NULL,
     stored_name VARCHAR(255) NOT NULL,
     mime_type VARCHAR(120) NOT NULL,
     size_bytes INTEGER NOT NULL DEFAULT 0,
     amount NUMERIC(18,2) NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT '',
     uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     uploaded_by_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // One row per material change: who, what field, the value before, the value
  // after, when, and the reason given. Never updated, only appended.
  `CREATE TABLE IF NOT EXISTS activity_history (
     id SERIAL PRIMARY KEY,
     activity_id VARCHAR(50) NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
     action VARCHAR(60) NOT NULL,
     field VARCHAR(60),
     old_value TEXT,
     new_value TEXT,
     note TEXT NOT NULL DEFAULT '',
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // A manager may not change a budget, only ask for a different one. Each ask is
  // a row here: the amount wanted, the reason, and the Director's answer. The
  // budget on the activity itself is only ever written by the Director.
  `CREATE TABLE IF NOT EXISTS activity_budget_requests (
     id SERIAL PRIMARY KEY,
     activity_id VARCHAR(50) NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
     current_budget NUMERIC(18,2) NOT NULL DEFAULT 0,
     requested_amount NUMERIC(18,2) NOT NULL,
     reason TEXT NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'Pending',
     decision_note TEXT NOT NULL DEFAULT '',
     requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     requested_by_name VARCHAR(150) NOT NULL DEFAULT '',
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_by_name VARCHAR(150) NOT NULL DEFAULT '',
     decided_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE activity_budget_requests DROP CONSTRAINT IF EXISTS activity_budget_requests_status_check`,
  `ALTER TABLE activity_budget_requests ADD CONSTRAINT activity_budget_requests_status_check
     CHECK (status IN ('Pending', 'Approved', 'Declined'))`,
  `CREATE INDEX IF NOT EXISTS activity_budget_requests_activity_idx ON activity_budget_requests(activity_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS activities_status_idx ON activities(status)`,
  `CREATE INDEX IF NOT EXISTS activities_assigned_to_idx ON activities(assigned_to)`,
  `CREATE INDEX IF NOT EXISTS activities_deadline_idx ON activities(deadline)`,
  `CREATE INDEX IF NOT EXISTS activities_created_by_idx ON activities(created_by)`,
  `CREATE INDEX IF NOT EXISTS activity_evidence_activity_idx ON activity_evidence(activity_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS activity_history_activity_idx ON activity_history(activity_id, created_at DESC)`
];

export async function migrateActivityModule(pool) {
  for (const statement of statements) {
    await pool.query(statement);
  }
}
