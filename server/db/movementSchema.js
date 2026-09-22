// Logistics & Facilitation module migration.
// Brings any PostgreSQL database to the movement module's current shape.

// The same workflow vocabulary the activity register uses, plus the one state
// this module needs on its own: money handed over before the trip. There is no
// bare "Pending" -- a movement waiting on a decision is 'Pending Approval', and
// the row names the person it is waiting on.
export const MOVEMENT_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Funds Released',
  'In Progress', 'Completed', 'Rejected', 'Cancelled'
];

const LEGACY_STATUS_MAP = {
  Pending: 'Pending Approval',
  Ongoing: 'In Progress'
};

const statements = [
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS movement_type VARCHAR(50) NOT NULL DEFAULT 'Other'`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS related_area VARCHAR(50) REFERENCES sectors(id) ON DELETE SET NULL`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS origin VARCHAR(200) NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS departure_date DATE`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS return_date DATE`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS person_team VARCHAR(200) NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS transport_type VARCHAR(100) NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS vehicle_driver VARCHAR(200) NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'RWF'`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_transport NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_fuel NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_accommodation NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_meals NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_handling NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS cost_other NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS funds_released NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS actual_expense NUMERIC(18,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS evidence_status VARCHAR(20) NOT NULL DEFAULT 'Pending'`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS fx_rwf_per_usd NUMERIC(18,6)`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS fx_cdf_per_usd NUMERIC(18,6)`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS fx_source VARCHAR(20) NOT NULL DEFAULT 'reference'`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS fx_recorded_at TIMESTAMPTZ`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,

  // ---- who carries it out, and who must approve it -------------------------
  //
  // person_team stays as it was: the free-text name of whoever travels. This is
  // the account answerable for the movement, which is what the approval routing
  // and the queue are built from.
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approval_required_from INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approval_required_role VARCHAR(20)`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS rejection_reason TEXT NOT NULL DEFAULT ''`,
  // What an external business partner may see, on the same terms as the
  // activity register: their operation, actually approved, and this flag on.
  `ALTER TABLE movements ADD COLUMN IF NOT EXISTS externally_visible BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_approval_status_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_approval_status_check
     CHECK (approval_status IN ('pending', 'approved', 'rejected'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_approval_role_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_approval_role_check
     CHECK (approval_required_role IS NULL OR approval_required_role IN ('manager', 'director'))`,

  // Back-fill from what the rows already say. A movement handed to a named
  // account waits on that account; everything else waits on the Director.
  // Only rows without an approver are touched, so this is safe to run again.
  `UPDATE movements
     SET approval_required_role = 'manager', approval_required_from = assigned_to
   WHERE approval_required_role IS NULL AND assigned_to IS NOT NULL`,
  `UPDATE movements
     SET approval_required_role = 'director',
         approval_required_from = (SELECT id FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1)
   WHERE approval_required_role IS NULL`,
  `UPDATE movements
     SET approval_status = 'approved',
         approved_by = COALESCE(approved_by, approval_required_from),
         approved_at = COALESCE(approved_at, updated_at)
   WHERE approval_status = 'pending'
     AND status IN ('Approved', 'Funds Released', 'Ongoing', 'In Progress', 'Completed')`,
  `UPDATE movements SET approval_status = 'rejected'
   WHERE approval_status = 'pending' AND status IN ('Rejected', 'Cancelled')`,

  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_status_check`,
  ...Object.entries(LEGACY_STATUS_MAP).map(
    ([from, to]) => `UPDATE movements SET status = '${to}' WHERE status = '${from}'`
  ),
  `UPDATE movements SET status = 'Pending Approval'
     WHERE status NOT IN (${MOVEMENT_STATUSES.map((status) => `'${status}'`).join(', ')})`,
  `ALTER TABLE movements ADD CONSTRAINT movements_status_check
     CHECK (status IN (${MOVEMENT_STATUSES.map((status) => `'${status}'`).join(', ')}))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_currency_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_currency_check CHECK (currency IN ('RWF', 'USD', 'CDF'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_type_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_type_check
     CHECK (movement_type IN ('Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_evidence_status_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_evidence_status_check
     CHECK (evidence_status IN ('Pending', 'Partial', 'Complete'))`,
  // A trip may name ANY of the four operations as the one it supports, or none.
  //
  // This used to forbid related_area = 'movement'. That made sense while the
  // operation with that id ran the trips register: movements.sector is
  // 'movement' on every row, so pointing a trip's related area at it was a
  // self-reference. The trips register belongs to Movement & Facilitation (see
  // TRIPS_OPERATION), and the operation reading as "Facilitation" is an ordinary
  // business concern a trip can be run for -- delivering to a facilitation case
  // is exactly as real as delivering to a mine. Forbidding it left such a trip
  // recordable only as "not linked", which hid it from the Facilitation partner
  // and from every per-operation total.
  //
  // Nothing replaces the constraint: related_area already REFERENCES sectors(id),
  // so only one of the four ids (or NULL) can ever be stored. Dropped rather
  // than relaxed because there is no longer any value to exclude.
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_related_area_check`,

  `CREATE TABLE IF NOT EXISTS movement_evidence (
     id SERIAL PRIMARY KEY,
     movement_id VARCHAR(50) NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
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

  `CREATE TABLE IF NOT EXISTS movement_history (
     id SERIAL PRIMARY KEY,
     movement_id VARCHAR(50) NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
     action VARCHAR(60) NOT NULL,
     field VARCHAR(60),
     old_value TEXT,
     new_value TEXT,
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS exchange_rates (
     id SERIAL PRIMARY KEY,
     rwf_per_usd NUMERIC(18,6) NOT NULL CHECK (rwf_per_usd > 0),
     cdf_per_usd NUMERIC(18,6) NOT NULL CHECK (cdf_per_usd > 0),
     note TEXT NOT NULL DEFAULT '',
     updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_by_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `INSERT INTO exchange_rates (rwf_per_usd, cdf_per_usd, note, updated_by_name)
     SELECT 1450, 2850, 'Initial reference rate', 'System'
     WHERE NOT EXISTS (SELECT 1 FROM exchange_rates)`,

  `CREATE TABLE IF NOT EXISTS movement_ref_counters (
     year INTEGER PRIMARY KEY,
     last_number INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE INDEX IF NOT EXISTS movements_related_area_idx ON movements(related_area)`,
  `CREATE INDEX IF NOT EXISTS movements_status_idx ON movements(status)`,
  `CREATE INDEX IF NOT EXISTS movements_assigned_to_idx ON movements(assigned_to)`,
  // "What I Need to Approve" reads exactly these two columns together.
  `CREATE INDEX IF NOT EXISTS movements_approval_queue_idx
     ON movements(approval_required_from, approval_status)`,
  `CREATE INDEX IF NOT EXISTS movements_approval_role_idx
     ON movements(approval_required_role, approval_status)`,
  `CREATE INDEX IF NOT EXISTS movements_departure_idx ON movements(departure_date DESC)`,
  `CREATE INDEX IF NOT EXISTS movement_evidence_movement_idx ON movement_evidence(movement_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS movement_history_movement_idx ON movement_history(movement_id, created_at DESC)`
];

export async function migrateMovementModule(pool) {
  for (const statement of statements) {
    await pool.query(statement);
  }
  // Rows predating the module carry only the estimated cost; back-fill the
  // breakdown so "Other Expenses" accounts for the amount already recorded.
  //
  // Once only. Run on every boot it also rewrote movements created since --
  // any with no cost lines whose total was later set at approval -- quietly
  // inventing an "Other Expenses" line on the next restart.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_markers (
       name VARCHAR(100) PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  const firstTime = await pool.query(
    "INSERT INTO schema_markers (name) VALUES ('movement-cost-backfill') ON CONFLICT (name) DO NOTHING RETURNING name"
  );
  if (firstTime.rowCount) {
    await pool.query(
      `UPDATE movements SET cost_other = cost
       WHERE cost > 0
         AND cost_transport = 0 AND cost_fuel = 0 AND cost_accommodation = 0
         AND cost_meals = 0 AND cost_handling = 0 AND cost_other = 0`
    );
  }
}
