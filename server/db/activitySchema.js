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

// The seven workflow statuses the approval workflow is specified in terms of,
// plus the three this module needs on top of them: a budget the approver
// changed, work sent back for correction, and work parked. There is no bare
// "Pending": a record waiting on a decision is 'Pending Approval', and the row
// names the person it is waiting on.
export const ACTIVITY_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Rejected',
  'In Progress', 'Completed', 'Cancelled',
  'Budget Adjusted', 'Needs Correction', 'On Hold'
];

// The statuses the table used before, mapped onto the ones above. Run before
// the CHECK constraint, or every legacy row fails it.
//
//   Pending / Pending Review -> Pending Approval. Same meaning, but the row now
//     also carries who it is pending on.
//   Assigned -> Pending Approval. Work the Director handed to a manager was
//     always waiting on that manager to take it up; it is now waiting on them
//     to approve it, which is the same wait with a decision attached.
//   Accepted -> Approved. The manager taking work up *is* their approval of it.
const LEGACY_STATUS_MAP = {
  Pending: 'Pending Approval',
  'Pending Review': 'Pending Approval',
  Assigned: 'Pending Approval',
  Accepted: 'Approved'
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

  // ---- who must approve this record ---------------------------------------
  //
  // The record names its approver rather than sitting in a generic pending
  // state. approval_status is deliberately separate from status: status says
  // where the work is, approval_status says whether the decision has been taken.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approval_required_from INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approval_required_role VARCHAR(20)`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS rejection_reason TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_approval_status_check`,
  `ALTER TABLE activities ADD CONSTRAINT activities_approval_status_check
     CHECK (approval_status IN ('pending', 'approved', 'rejected'))`,
  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_approval_role_check`,
  `ALTER TABLE activities ADD CONSTRAINT activities_approval_role_check
     CHECK (approval_required_role IS NULL OR approval_required_role IN ('manager', 'director'))`,

  // ---- what an external business partner may see --------------------------
  //
  // A partner assigned to this operation sees an activity only when all three
  // hold: it is in their operation, it has actually been approved, and this
  // flag is on. The flag defaults on so an approved record is visible to the
  // operation it belongs to without the Director having to tick every row; the
  // Director turns it off for anything that should stay internal.
  //
  // The approval gate is not stored here -- it is read from approval_status at
  // query time -- so a record that is later reopened stops being visible by
  // itself, with nothing to remember to switch back.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS externally_visible BOOLEAN NOT NULL DEFAULT TRUE`,

  // Rows created before this workflow carry their request only as cost_usd.
  `UPDATE activities SET requested_budget = cost_usd WHERE requested_budget = 0 AND cost_usd > 0`,

  // ---- back-fill the approval trail from the statuses already on the rows ---
  //
  // Run before the statuses are renamed, so each legacy status can still be
  // read for what it meant. Only rows that have not been given an approver yet
  // are touched, which makes the whole block safe to run again.

  // Work the Director handed to a manager waits on that manager.
  `UPDATE activities
     SET approval_required_role = 'manager', approval_required_from = assigned_to
   WHERE approval_required_role IS NULL AND origin = 'assigned' AND assigned_to IS NOT NULL`,
  // Everything else -- a manager's own request, or assigned work with nobody on
  // it yet -- waits on the Director.
  `UPDATE activities a
     SET approval_required_role = 'director',
         approval_required_from = (SELECT id FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1)
   WHERE a.approval_required_role IS NULL`,
  // A decision that has already been taken keeps the person and the moment it
  // was taken. reviewed_by/reviewed_at is the Director's own decision stamp;
  // accepted_at is the manager taking up work assigned to them.
  `UPDATE activities
     SET approval_status = 'approved',
         approved_by = COALESCE(approved_by, reviewed_by, CASE WHEN accepted_at IS NOT NULL THEN assigned_to END, approval_required_from),
         approved_at = COALESCE(approved_at, reviewed_at, accepted_at, updated_at)
   WHERE approval_status = 'pending'
     AND status IN ('Accepted', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction', 'Completed')`,
  `UPDATE activities
     SET approval_status = 'rejected', rejection_reason = COALESCE(NULLIF(rejection_reason, ''), admin_note)
   WHERE approval_status = 'pending' AND status = 'Rejected'`,

  `ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_status_check`,
  ...Object.entries(LEGACY_STATUS_MAP).map(
    ([from, to]) => `UPDATE activities SET status = '${to}' WHERE status = '${from}'`
  ),
  `UPDATE activities SET status = 'Pending Approval'
     WHERE status NOT IN (${ACTIVITY_STATUSES.map((status) => `'${status}'`).join(', ')})`,
  `ALTER TABLE activities ALTER COLUMN status SET DEFAULT 'Pending Approval'`,
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
  // "What I Need to Approve" reads exactly these two columns together.
  `CREATE INDEX IF NOT EXISTS activities_approval_queue_idx
     ON activities(approval_required_from, approval_status)`,
  `CREATE INDEX IF NOT EXISTS activities_approval_role_idx
     ON activities(approval_required_role, approval_status)`,
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
