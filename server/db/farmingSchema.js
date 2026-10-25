// Farming Management: the farm's own tables.
//
// The shape of the farm:
//
//   farm_animal_types        what the farm keeps: Cows, Chickens, Goats -- and
//     │                      whatever the Farming Manager adds later. Data,
//     │                      not code: nothing branches on a type's name.
//     └── farm_measures      what each type is measured by: Milk (litres),
//           │                Eggs (pieces), the herd itself (head)
//           ├── farm_production   a day's production of a product, and what
//           │                     was lost; never a sale
//           ├── farm_herd_events  births, purchases, deaths, sales, counts
//           └── farm_sales        what was sold and the money received, with
//                                 the exchange rate frozen on the row
//   farm_expenses            the farm's costs: one animal type's, or shared
//                            (animal_type_id NULL) -- never split by guess
//   farm_issues              what stands in the way: missing feed, a sick
//                            animal, a broken pump
//   farm_budgets             the Director's monthly figure for the farm,
//                            separate from the farming monthly plan's budget
//   farm_settings            the alert thresholds (one row)
//   farm_audit               who did what, with before/after, on every write
//
// NOTHING IS DELETED once it is a record. An animal type or a measure with
// history is deactivated (ON DELETE RESTRICT guarantees it); a production
// entry, a herd change and a sale are voided with a reason; an approved
// expense is voided with a reason and entered again, never edited.
//
// THE FARMING MONTHLY PLAN IS UNTOUCHED. Its objectives, daily reports,
// activities and expenses stay where they are and keep their own budget: the
// Director decided the farm's costs here are budgeted separately, so nothing
// in this file reads or writes monthly_plans, activities or
// activity_expenses, and nothing there is counted twice here.
//
// The platform records money, it never moves it: an expense or a sale is a
// note of what was paid or received.
//
// Every statement is idempotent, like the other schema files: the migration
// runs on every boot and on every Vercel build. The seed rows are keyed on
// `seed_key` with ON CONFLICT DO NOTHING, so a type the Farming Manager
// renamed or deactivated is never put back the way it was.

import {
  DEFAULT_ANIMAL_TYPES, EXPENSE_STATUSES, FARM_CURRENCIES, HERD_EVENT_KINDS, ISSUE_KINDS, ISSUE_STATUSES,
  MEASURE_KINDS, RECORD_STATUSES, normaliseName
} from '../../shared/farming.js';

const list = (values) => values.map((value) => `'${value}'`).join(', ');

// Dropping and re-adding a CHECK keeps a list constraint in step with the
// exported list, as every other schema file does.
const check = (table, name, condition) => [
  `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`,
  `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${condition})`
];

// The columns every voidable record carries.
const VOIDABLE = `
     status VARCHAR(20) NOT NULL DEFAULT 'recorded',
     void_reason TEXT NOT NULL DEFAULT '',
     voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_at TIMESTAMPTZ,
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     recorded_by_name VARCHAR(150) NOT NULL DEFAULT '',
     request_key VARCHAR(64),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

const statements = [
  // ---- what the farm keeps -------------------------------------------------
  `CREATE TABLE IF NOT EXISTS farm_animal_types (
     id SERIAL PRIMARY KEY,
     name VARCHAR(60) NOT NULL,
     -- The name as compared for "already exists" (normaliseName): one Sheep,
     -- whatever its capitals or spaces, active or not.
     name_key VARCHAR(60) NOT NULL UNIQUE,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     expense_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
     sort_order INTEGER NOT NULL DEFAULT 0,
     seed_key VARCHAR(30) UNIQUE,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS farm_measures (
     id SERIAL PRIMARY KEY,
     animal_type_id INTEGER NOT NULL REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     name VARCHAR(60) NOT NULL,
     name_key VARCHAR(60) NOT NULL,
     kind VARCHAR(20) NOT NULL,
     unit VARCHAR(30) NOT NULL,
     sellable BOOLEAN NOT NULL DEFAULT FALSE,
     perishable BOOLEAN NOT NULL DEFAULT FALSE,
     daily_expected BOOLEAN NOT NULL DEFAULT FALSE,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     sort_order INTEGER NOT NULL DEFAULT 0,
     seed_key VARCHAR(30) UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (animal_type_id, name_key)
   )`,
  ...check('farm_measures', 'farm_measures_kind_check', `kind IN (${list(MEASURE_KINDS)})`),
  // Only a product is sold as a product or expected daily; a herd is sold
  // through a herd event.
  ...check('farm_measures', 'farm_measures_product_flags_check', `kind = 'product' OR (sellable = FALSE AND daily_expected = FALSE AND perishable = FALSE)`),

  // ---- what the farm records ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS farm_production (
     id SERIAL PRIMARY KEY,
     measure_id INTEGER NOT NULL REFERENCES farm_measures(id) ON DELETE RESTRICT,
     animal_type_id INTEGER NOT NULL REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     produced_on DATE NOT NULL,
     produced NUMERIC(14,2) NOT NULL,
     lost NUMERIC(14,2) NOT NULL DEFAULT 0,
     notes TEXT NOT NULL DEFAULT '',${VOIDABLE}
   )`,
  ...check('farm_production', 'farm_production_figures_check', 'produced >= 0 AND lost >= 0'),
  ...check('farm_production', 'farm_production_status_check', `status IN (${list(RECORD_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS farm_production_measure_day_idx ON farm_production(measure_id, produced_on)`,
  `CREATE INDEX IF NOT EXISTS farm_production_day_idx ON farm_production(produced_on)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS farm_production_request_key_idx ON farm_production(request_key) WHERE request_key IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS farm_sales (
     id SERIAL PRIMARY KEY,
     measure_id INTEGER NOT NULL REFERENCES farm_measures(id) ON DELETE RESTRICT,
     animal_type_id INTEGER NOT NULL REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     sold_on DATE NOT NULL,
     quantity NUMERIC(14,2) NOT NULL,
     amount NUMERIC(18,2) NOT NULL,
     currency VARCHAR(3) NOT NULL,
     -- Frozen at the reference rate of the moment it was recorded, as a trip
     -- freezes its rate; changing the rate later never rewrites a sale.
     amount_usd NUMERIC(18,2) NOT NULL,
     fx_rwf_per_usd NUMERIC(14,4) NOT NULL,
     fx_cdf_per_usd NUMERIC(14,4) NOT NULL,
     buyer VARCHAR(120) NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',${VOIDABLE}
   )`,
  ...check('farm_sales', 'farm_sales_figures_check', 'quantity > 0 AND amount > 0 AND amount_usd >= 0'),
  ...check('farm_sales', 'farm_sales_currency_check', `currency IN (${list(FARM_CURRENCIES)})`),
  ...check('farm_sales', 'farm_sales_status_check', `status IN (${list(RECORD_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS farm_sales_measure_day_idx ON farm_sales(measure_id, sold_on)`,
  `CREATE INDEX IF NOT EXISTS farm_sales_day_idx ON farm_sales(sold_on)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS farm_sales_request_key_idx ON farm_sales(request_key) WHERE request_key IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS farm_herd_events (
     id SERIAL PRIMARY KEY,
     measure_id INTEGER NOT NULL REFERENCES farm_measures(id) ON DELETE RESTRICT,
     animal_type_id INTEGER NOT NULL REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     event_on DATE NOT NULL,
     kind VARCHAR(20) NOT NULL,
     count INTEGER NOT NULL,
     -- The signed change to the head count. For a count it is counted minus
     -- what the ledger held, so SUM(delta) is always the head count.
     delta INTEGER NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     -- A herd sale is recorded once, on the sales form: the sale row carries
     -- the money and this row the animals, and voiding the sale voids both.
     sale_id INTEGER REFERENCES farm_sales(id) ON DELETE RESTRICT,${VOIDABLE}
   )`,
  ...check('farm_herd_events', 'farm_herd_events_kind_check', `kind IN (${list(HERD_EVENT_KINDS)})`),
  ...check('farm_herd_events', 'farm_herd_events_count_check', `count >= 0 AND (kind = 'count' OR count > 0)`),
  ...check('farm_herd_events', 'farm_herd_events_status_check', `status IN (${list(RECORD_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS farm_herd_events_measure_day_idx ON farm_herd_events(measure_id, event_on)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS farm_herd_events_request_key_idx ON farm_herd_events(request_key) WHERE request_key IS NOT NULL`,

  // ---- the farm's costs ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS farm_expenses (
     id SERIAL PRIMARY KEY,
     spent_on DATE NOT NULL,
     amount NUMERIC(18,2) NOT NULL,
     currency VARCHAR(3) NOT NULL,
     amount_usd NUMERIC(18,2) NOT NULL,
     fx_rwf_per_usd NUMERIC(14,4) NOT NULL,
     fx_cdf_per_usd NUMERIC(14,4) NOT NULL,
     -- NULL = shared by the whole farm. A shared cost is never allocated to an
     -- animal type without a documented rule.
     animal_type_id INTEGER REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     category VARCHAR(60) NOT NULL,
     description TEXT NOT NULL,
     payee VARCHAR(120) NOT NULL DEFAULT '',
     receipt_ref VARCHAR(120) NOT NULL DEFAULT '',
     status VARCHAR(20) NOT NULL DEFAULT 'pending',
     submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     submitted_by_name VARCHAR(150) NOT NULL DEFAULT '',
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_by_name VARCHAR(150) NOT NULL DEFAULT '',
     decided_at TIMESTAMPTZ,
     decision_note TEXT NOT NULL DEFAULT '',
     void_reason TEXT NOT NULL DEFAULT '',
     voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_at TIMESTAMPTZ,
     request_key VARCHAR(64),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('farm_expenses', 'farm_expenses_figures_check', 'amount > 0 AND amount_usd >= 0'),
  ...check('farm_expenses', 'farm_expenses_currency_check', `currency IN (${list(FARM_CURRENCIES)})`),
  ...check('farm_expenses', 'farm_expenses_status_check', `status IN (${list(EXPENSE_STATUSES)})`),
  // A decision is always somebody's, and a void always says why.
  ...check('farm_expenses', 'farm_expenses_decided_check', `status = 'pending' OR decided_at IS NOT NULL`),
  ...check('farm_expenses', 'farm_expenses_void_check', `status <> 'voided' OR length(void_reason) > 0`),
  `CREATE INDEX IF NOT EXISTS farm_expenses_day_idx ON farm_expenses(spent_on)`,
  `CREATE INDEX IF NOT EXISTS farm_expenses_status_idx ON farm_expenses(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS farm_expenses_request_key_idx ON farm_expenses(request_key) WHERE request_key IS NOT NULL`,

  // ---- problems, budget, settings, history ---------------------------------------------
  `CREATE TABLE IF NOT EXISTS farm_issues (
     id SERIAL PRIMARY KEY,
     kind VARCHAR(30) NOT NULL,
     urgent BOOLEAN NOT NULL DEFAULT FALSE,
     animal_type_id INTEGER REFERENCES farm_animal_types(id) ON DELETE RESTRICT,
     description TEXT NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'open',
     raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     raised_by_name VARCHAR(150) NOT NULL DEFAULT '',
     resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     resolved_by_name VARCHAR(150) NOT NULL DEFAULT '',
     resolved_at TIMESTAMPTZ,
     resolution_note TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('farm_issues', 'farm_issues_kind_check', `kind IN (${list(ISSUE_KINDS)})`),
  ...check('farm_issues', 'farm_issues_status_check', `status IN (${list(ISSUE_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS farm_issues_open_idx ON farm_issues(status, urgent DESC, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS farm_budgets (
     month DATE PRIMARY KEY,
     amount_usd NUMERIC(18,2) NOT NULL,
     set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     set_by_name VARCHAR(150) NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('farm_budgets', 'farm_budgets_amount_check', 'amount_usd >= 0 AND EXTRACT(DAY FROM month) = 1'),

  `CREATE TABLE IF NOT EXISTS farm_settings (
     id INTEGER PRIMARY KEY DEFAULT 1,
     alert_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('farm_settings', 'farm_settings_single_check', 'id = 1'),
  `INSERT INTO farm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS farm_audit (
     id SERIAL PRIMARY KEY,
     entity_type VARCHAR(30) NOT NULL,
     entity_id INTEGER,
     action VARCHAR(60) NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     details JSONB NOT NULL DEFAULT '{}'::jsonb,
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS farm_audit_entity_idx ON farm_audit(entity_type, entity_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS farm_audit_created_idx ON farm_audit(created_at DESC)`
];

// The starting names as first seeded, and the familiar words that replaced
// them. A row is renamed only while it still has its first name and unit (so
// nobody has changed it) and nothing is recorded under it (so no history is
// relabelled). Idempotent: once renamed, the first condition no longer holds.
const FAMILIAR_NAMES = [
  { seedKey: 'cows.cattle', from: ['Cattle', 'head'], to: ['Number of cows', 'cows'] },
  { seedKey: 'chickens.birds', from: ['Birds', 'birds'], to: ['Number of chickens', 'chickens'] },
  { seedKey: 'goats.goats', from: ['Goats', 'head'], to: ['Number of goats', 'goats'] },
  { seedKey: 'chickens.eggs', from: ['Eggs', 'pieces'], to: ['Eggs', 'eggs'] }
];

export async function migrateFarmingModule(pool) {
  for (const statement of statements) await pool.query(statement);

  // The three types the farm keeps today, each once. A seed the Farming
  // Manager has since renamed or switched off keeps their change: the
  // conflict on seed_key leaves the row alone.
  for (const [typeIndex, type] of DEFAULT_ANIMAL_TYPES.entries()) {
    await pool.query(
      `INSERT INTO farm_animal_types (name, name_key, sort_order, seed_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [type.name, normaliseName(type.name), typeIndex, type.key]
    );
    const owner = await pool.query('SELECT id FROM farm_animal_types WHERE seed_key = $1', [type.key]);
    if (!owner.rowCount) continue;
    for (const [measureIndex, measure] of type.measures.entries()) {
      await pool.query(
        `INSERT INTO farm_measures (animal_type_id, name, name_key, kind, unit, sellable, perishable, daily_expected, sort_order, seed_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [owner.rows[0].id, measure.name, normaliseName(measure.name), measure.kind, measure.unit,
          measure.kind === 'product' && measure.sellable === true, measure.kind === 'product' && measure.perishable === true,
          measure.kind === 'product' && measure.dailyExpected === true, measureIndex, `${type.key}.${measure.key}`]
      );
    }
  }

  for (const rename of FAMILIAR_NAMES) {
    await pool.query(
      `UPDATE farm_measures m SET name = $4, name_key = $5, unit = $6, updated_at = NOW()
        WHERE m.seed_key = $1 AND m.name = $2 AND m.unit = $3
          AND NOT EXISTS (SELECT 1 FROM farm_production p WHERE p.measure_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM farm_sales s WHERE s.measure_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM farm_herd_events e WHERE e.measure_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM farm_measures o WHERE o.animal_type_id = m.animal_type_id AND o.id <> m.id AND o.name_key = $5)`,
      [rename.seedKey, rename.from[0], rename.from[1], rename.to[0], normaliseName(rename.to[0]), rename.to[1]]
    );
  }
}
