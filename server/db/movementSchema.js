// Logistics & Facilitation module migration.
// Mirrors the trailing section of supabase/schema.sql so a plain PostgreSQL
// target reaches the same shape without anyone running the Supabase editor.

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

  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_status_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_status_check
     CHECK (status IN ('Draft', 'Pending', 'Approved', 'Funds Released', 'Ongoing', 'Completed', 'Rejected', 'Cancelled'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_currency_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_currency_check CHECK (currency IN ('RWF', 'USD', 'CDF'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_type_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_type_check
     CHECK (movement_type IN ('Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_evidence_status_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_evidence_status_check
     CHECK (evidence_status IN ('Pending', 'Partial', 'Complete'))`,
  `ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_related_area_check`,
  `ALTER TABLE movements ADD CONSTRAINT movements_related_area_check
     CHECK (related_area IS NULL OR related_area <> 'movement')`,

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
  `CREATE INDEX IF NOT EXISTS movements_departure_idx ON movements(departure_date DESC)`,
  `CREATE INDEX IF NOT EXISTS movement_evidence_movement_idx ON movement_evidence(movement_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS movement_history_movement_idx ON movement_history(movement_id, created_at DESC)`
];

export async function migrateMovementModule(pool) {
  // Rows predating the module carry only the estimated cost; back-fill the
  // breakdown so "Other Expenses" accounts for the amount already recorded.
  for (const statement of statements) {
    await pool.query(statement);
  }
  await pool.query(
    `UPDATE movements SET cost_other = cost
     WHERE cost > 0
       AND cost_transport = 0 AND cost_fuel = 0 AND cost_accommodation = 0
       AND cost_meals = 0 AND cost_handling = 0 AND cost_other = 0`
  );
}
