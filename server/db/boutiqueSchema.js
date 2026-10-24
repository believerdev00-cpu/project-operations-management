// The Boutique Management System (Project 5): the shop's tables.
//
// The shape of the boutique:
//
//   projects (PRJ-BOUTIQUE)   the one project row, so the boutique is on the
//                             Director's Projects page like any other project
//   boutique_products          what the shop sells: a dress, a pair of shoes
//     └── boutique_variants    each size/colour of it, with its own SKU, cost,
//                              price and stock figure
//           └── boutique_stock_movements   the ledger: every change to that
//                                          figure, with the balance after it
//   boutique_stock_adjustments the manager's request to write off, count or
//                              transfer stock, decided by the Director
//   boutique_suppliers
//     └── boutique_purchase_orders   what was ordered, at what cost
//           ├── boutique_purchase_items
//           ├── boutique_goods_receipts (+ items)   what actually arrived
//           └── boutique_supplier_payments          what has been paid
//   boutique_sales             one row per till transaction, never deleted
//     ├── boutique_sale_items  the lines, with the cost frozen for the books
//     ├── boutique_sale_payments   how the customer paid (split allowed)
//     └── boutique_returns (+ items)   goods brought back, refunded or exchanged
//   boutique_cash_sessions     a cashier's till from opening to closing count
//     └── boutique_cash_movements   float in, cash out
//   boutique_expenses          the shop's running costs
//   boutique_payment_methods   which of the four methods the shop accepts
//   boutique_audit             who did what, on every write
//
// NOTHING IS SILENTLY DELETED. A completed sale, a receipt of goods, a closed
// till and a recorded expense are facts; the only way to undo one is a void
// with a reason, approved by the Director where the manager asked for it,
// and the void is itself a row in the audit trail. A product or supplier is
// archived, not removed, once anything refers to it.
//
// The platform records money, it never moves it. There is no gateway, wallet
// or transfer here: a "payment" is the cashier's note of how the customer
// paid, and a "supplier payment" is the manager's note that the shop paid.
//
// Every statement is idempotent, like the other schema files: the migration
// runs on every boot and on every Vercel build.

import {
  ADJUSTMENT_KINDS, ALL_BOUTIQUE_PAYMENT_METHODS, APPROVAL_STATUSES, BOUTIQUE_PAYMENT_METHODS, BOUTIQUE_PROJECT_ID,
  BOUTIQUE_WORKSPACE, CASH_MOVEMENT_KINDS, EXPENSE_STATUSES, PRODUCT_TYPES, PURCHASE_STATUSES, RETURN_KINDS,
  SALE_STATUSES, SESSION_STATUSES, SHELF_COUNT_STATUSES, STOCK_MOVEMENT_KINDS
} from '../../shared/boutique.js';
import { RETAIL_OPERATION } from '../../shared/businessOperations.js';

const list = (values) => values.map((value) => `'${value}'`).join(', ');

// Dropping and re-adding a CHECK is how every other schema file keeps a list
// constraint in step with the exported list: a value added to the list lands
// in the constraint on the next migration.
const check = (table, name, condition) => [
  `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`,
  `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${condition})`
];

const statements = [
  // ---- the project row ---------------------------------------------------------
  //
  // Which workspace a project opens into, when it has one. NULL for the
  // ordinary projects, whose work is the activity register; 'boutique' for
  // PRJ-BOUTIQUE, which the Projects page opens into the shop instead. A
  // project with a workspace cannot be deleted from the register.
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace VARCHAR(30)`,
  `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category, workspace)
     VALUES ('${BOUTIQUE_PROJECT_ID}', 'Boutique Management System', '${RETAIL_OPERATION}', 'Boutique', 'Gisuma', 'On Track', 0, 0, 0, 'Business Operations', '${BOUTIQUE_WORKSPACE}')
     ON CONFLICT (id) DO UPDATE SET workspace = EXCLUDED.workspace, sector = EXCLUDED.sector`,

  // ---- products and variants ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS boutique_products (
     id SERIAL PRIMARY KEY,
     name VARCHAR(200) NOT NULL,
     product_type VARCHAR(20) NOT NULL DEFAULT 'clothing',
     category VARCHAR(100) NOT NULL DEFAULT '',
     brand VARCHAR(100) NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     -- One picture per product, stored through server/lib/storage.js under
     -- the 'boutique' folder and served only through the permission-checked
     -- image route. The database holds the stored name, never a path.
     image_stored_name VARCHAR(100),
     image_mime VARCHAR(100),
     image_original_name VARCHAR(255),
     status VARCHAR(20) NOT NULL DEFAULT 'active',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_products', 'boutique_products_type_check', `product_type IN (${list(PRODUCT_TYPES)})`),
  ...check('boutique_products', 'boutique_products_status_check', `status IN ('active', 'archived')`),
  `CREATE INDEX IF NOT EXISTS boutique_products_name_idx ON boutique_products(lower(name))`,

  `CREATE TABLE IF NOT EXISTS boutique_variants (
     id SERIAL PRIMARY KEY,
     product_id INTEGER NOT NULL REFERENCES boutique_products(id) ON DELETE CASCADE,
     sku VARCHAR(60) NOT NULL,
     barcode VARCHAR(60),
     size VARCHAR(40) NOT NULL DEFAULT '',
     color VARCHAR(40) NOT NULL DEFAULT '',
     cost_price NUMERIC(18,2) NOT NULL DEFAULT 0,
     selling_price NUMERIC(18,2) NOT NULL DEFAULT 0,
     -- The figure on the shelf today. It is only ever written by
     -- moveStock() in server/lib/boutique.js, under a row lock, together with
     -- the ledger row that explains the change -- so SUM(quantity) over
     -- boutique_stock_movements for the variant always equals this.
     stock_quantity INTEGER NOT NULL DEFAULT 0,
     reorder_level INTEGER NOT NULL DEFAULT 0,
     status VARCHAR(20) NOT NULL DEFAULT 'active',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_variants_sku_idx ON boutique_variants(lower(sku))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_variants_barcode_idx ON boutique_variants(barcode) WHERE barcode IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_variants_size_color_idx ON boutique_variants(product_id, lower(size), lower(color))`,
  ...check('boutique_variants', 'boutique_variants_money_check', `cost_price >= 0 AND selling_price >= 0`),
  ...check('boutique_variants', 'boutique_variants_stock_check', `stock_quantity >= 0 AND reorder_level >= 0`),
  ...check('boutique_variants', 'boutique_variants_status_check', `status IN ('active', 'archived')`),

  // ---- the stock ledger -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS boutique_stock_movements (
     id SERIAL PRIMARY KEY,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE CASCADE,
     -- Signed: goods in are positive, goods out negative. Never zero.
     quantity INTEGER NOT NULL,
     kind VARCHAR(30) NOT NULL,
     balance_after INTEGER NOT NULL,
     -- What caused it: 'sale' + the sale id, 'receipt' + the receipt id,
     -- 'adjustment' + the adjustment id. Text, not a foreign key, because the
     -- ledger outlives nothing and refers to several tables.
     reference_type VARCHAR(30) NOT NULL DEFAULT '',
     reference_id INTEGER,
     note TEXT NOT NULL DEFAULT '',
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_stock_movements', 'boutique_stock_movements_kind_check', `kind IN (${list(STOCK_MOVEMENT_KINDS)})`),
  ...check('boutique_stock_movements', 'boutique_stock_movements_quantity_check', `quantity <> 0`),
  `CREATE INDEX IF NOT EXISTS boutique_stock_movements_variant_idx ON boutique_stock_movements(variant_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS boutique_stock_movements_created_idx ON boutique_stock_movements(created_at DESC)`,

  // ---- adjustments the Director decides -------------------------------------------
  //
  // Writing stock off, correcting a count or moving goods to another shop
  // changes the value of the inventory with nothing sold, so the manager asks
  // and the Director decides. The Director's own adjustments are recorded as
  // approved at once. `quantity` is the counted figure for a count and the
  // number of pieces for everything else; `delta` is the signed change that
  // was (or would be) applied, worked out when the request is written so the
  // Director sees exactly what approving means.
  `CREATE TABLE IF NOT EXISTS boutique_stock_adjustments (
     id SERIAL PRIMARY KEY,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE CASCADE,
     kind VARCHAR(30) NOT NULL,
     quantity INTEGER NOT NULL,
     delta INTEGER NOT NULL,
     reason TEXT NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'pending',
     requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_at TIMESTAMPTZ,
     decision_note TEXT NOT NULL DEFAULT '',
     movement_id INTEGER REFERENCES boutique_stock_movements(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_stock_adjustments', 'boutique_stock_adjustments_kind_check', `kind IN (${list(ADJUSTMENT_KINDS)})`),
  ...check('boutique_stock_adjustments', 'boutique_stock_adjustments_status_check', `status IN (${list(APPROVAL_STATUSES)})`),
  ...check('boutique_stock_adjustments', 'boutique_stock_adjustments_quantity_check', `quantity >= 0`),
  `CREATE INDEX IF NOT EXISTS boutique_stock_adjustments_status_idx ON boutique_stock_adjustments(status, created_at DESC)`,

  // ---- suppliers and purchases ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS boutique_suppliers (
     id SERIAL PRIMARY KEY,
     name VARCHAR(200) NOT NULL,
     contact_name VARCHAR(150) NOT NULL DEFAULT '',
     phone VARCHAR(50) NOT NULL DEFAULT '',
     email VARCHAR(255) NOT NULL DEFAULT '',
     address TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     status VARCHAR(20) NOT NULL DEFAULT 'active',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_suppliers', 'boutique_suppliers_status_check', `status IN ('active', 'archived')`),

  `CREATE SEQUENCE IF NOT EXISTS boutique_purchase_number`,
  `CREATE TABLE IF NOT EXISTS boutique_purchase_orders (
     id SERIAL PRIMARY KEY,
     supplier_id INTEGER NOT NULL REFERENCES boutique_suppliers(id) ON DELETE RESTRICT,
     reference VARCHAR(60) NOT NULL UNIQUE,
     status VARCHAR(30) NOT NULL DEFAULT 'ordered',
     ordered_on DATE NOT NULL DEFAULT CURRENT_DATE,
     expected_on DATE,
     invoice_number VARCHAR(100) NOT NULL DEFAULT '',
     -- The supplier's invoice total, once it arrives. Until then what the shop
     -- owes is what it received at the order's unit costs.
     invoice_total NUMERIC(18,2),
     notes TEXT NOT NULL DEFAULT '',
     cancel_reason TEXT NOT NULL DEFAULT '',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_purchase_orders', 'boutique_purchase_orders_status_check', `status IN (${list(PURCHASE_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS boutique_purchase_orders_supplier_idx ON boutique_purchase_orders(supplier_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS boutique_purchase_items (
     id SERIAL PRIMARY KEY,
     order_id INTEGER NOT NULL REFERENCES boutique_purchase_orders(id) ON DELETE CASCADE,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE RESTRICT,
     quantity_ordered INTEGER NOT NULL,
     quantity_received INTEGER NOT NULL DEFAULT 0,
     unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
     UNIQUE (order_id, variant_id)
   )`,
  ...check('boutique_purchase_items', 'boutique_purchase_items_quantity_check', `quantity_ordered > 0 AND quantity_received >= 0 AND unit_cost >= 0`),

  `CREATE TABLE IF NOT EXISTS boutique_goods_receipts (
     id SERIAL PRIMARY KEY,
     order_id INTEGER NOT NULL REFERENCES boutique_purchase_orders(id) ON DELETE CASCADE,
     received_on DATE NOT NULL DEFAULT CURRENT_DATE,
     note TEXT NOT NULL DEFAULT '',
     received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS boutique_goods_receipt_items (
     id SERIAL PRIMARY KEY,
     receipt_id INTEGER NOT NULL REFERENCES boutique_goods_receipts(id) ON DELETE CASCADE,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE RESTRICT,
     quantity INTEGER NOT NULL,
     unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0
   )`,
  ...check('boutique_goods_receipt_items', 'boutique_goods_receipt_items_quantity_check', `quantity > 0 AND unit_cost >= 0`),

  `CREATE TABLE IF NOT EXISTS boutique_supplier_payments (
     id SERIAL PRIMARY KEY,
     supplier_id INTEGER NOT NULL REFERENCES boutique_suppliers(id) ON DELETE RESTRICT,
     order_id INTEGER REFERENCES boutique_purchase_orders(id) ON DELETE SET NULL,
     amount NUMERIC(18,2) NOT NULL,
     method VARCHAR(40) NOT NULL DEFAULT 'Cash',
     paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
     reference VARCHAR(100) NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_supplier_payments', 'boutique_supplier_payments_amount_check', `amount > 0`),
  ...check('boutique_supplier_payments', 'boutique_supplier_payments_method_check', `method IN (${list(BOUTIQUE_PAYMENT_METHODS)})`),
  `CREATE INDEX IF NOT EXISTS boutique_supplier_payments_supplier_idx ON boutique_supplier_payments(supplier_id, paid_on DESC)`,

  // ---- the till ---------------------------------------------------------------------
  //
  // Which methods the shop accepts. Four rows, seeded on; the Director turns
  // one off (a shop with no card machine) and the till stops offering it,
  // while sales already recorded with it keep it.
  `CREATE TABLE IF NOT EXISTS boutique_payment_methods (
     code VARCHAR(40) PRIMARY KEY,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     sort_order INTEGER NOT NULL DEFAULT 0
   )`,
  `INSERT INTO boutique_payment_methods (code, sort_order)
     SELECT * FROM UNNEST($1::text[], $2::int[]) ON CONFLICT (code) DO NOTHING`,

  // A cashier's till from opening to closing. Expected figures are worked out
  // live from the sales, refunds, expenses and movements that name the
  // session, and written down at closing beside what was counted, so the
  // shortage or surplus of that day is a fact that never changes afterwards.
  `CREATE TABLE IF NOT EXISTS boutique_cash_sessions (
     id SERIAL PRIMARY KEY,
     opened_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     opening_cash NUMERIC(18,2) NOT NULL DEFAULT 0,
     status VARCHAR(20) NOT NULL DEFAULT 'open',
     closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     closed_at TIMESTAMPTZ,
     expected_cash NUMERIC(18,2),
     counted_cash NUMERIC(18,2),
     cash_variance NUMERIC(18,2),
     -- Mobile Money, card and bank are reconciled separately from the cash
     -- drawer: {"Mobile Money": 12000, "Card": 0, ...}, expected and counted.
     expected_by_method JSONB NOT NULL DEFAULT '{}'::jsonb,
     counted_by_method JSONB NOT NULL DEFAULT '{}'::jsonb,
     note TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_cash_sessions', 'boutique_cash_sessions_status_check', `status IN (${list(SESSION_STATUSES)})`),
  ...check('boutique_cash_sessions', 'boutique_cash_sessions_opening_check', `opening_cash >= 0`),
  // One open till per person: a second opening while the first is still open
  // would leave sales with two sessions to choose from.
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_cash_sessions_open_idx ON boutique_cash_sessions(opened_by) WHERE status = 'open'`,

  `CREATE TABLE IF NOT EXISTS boutique_cash_movements (
     id SERIAL PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES boutique_cash_sessions(id) ON DELETE CASCADE,
     kind VARCHAR(20) NOT NULL,
     amount NUMERIC(18,2) NOT NULL,
     reason TEXT NOT NULL,
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_cash_movements', 'boutique_cash_movements_kind_check', `kind IN (${list(CASH_MOVEMENT_KINDS)})`),
  ...check('boutique_cash_movements', 'boutique_cash_movements_amount_check', `amount > 0`),

  // ---- sales ------------------------------------------------------------------------
  `CREATE SEQUENCE IF NOT EXISTS boutique_sale_number`,
  `CREATE SEQUENCE IF NOT EXISTS boutique_return_number`,
  `CREATE TABLE IF NOT EXISTS boutique_sales (
     id SERIAL PRIMARY KEY,
     number VARCHAR(20) NOT NULL UNIQUE,
     cashier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     session_id INTEGER REFERENCES boutique_cash_sessions(id) ON DELETE SET NULL,
     customer_name VARCHAR(150) NOT NULL DEFAULT '',
     status VARCHAR(20) NOT NULL DEFAULT 'completed',
     subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
     discount NUMERIC(18,2) NOT NULL DEFAULT 0,
     total NUMERIC(18,2) NOT NULL DEFAULT 0,
     paid NUMERIC(18,2) NOT NULL DEFAULT 0,
     change_given NUMERIC(18,2) NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT '',
     -- An exchange is a return plus a new sale; the new sale names the return
     -- so the two read as one event.
     exchange_of_return_id INTEGER,
     void_reason TEXT NOT NULL DEFAULT '',
     void_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_at TIMESTAMPTZ,
     sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     sold_on DATE NOT NULL DEFAULT CURRENT_DATE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_sales', 'boutique_sales_status_check', `status IN (${list(SALE_STATUSES)})`),
  ...check('boutique_sales', 'boutique_sales_money_check', `subtotal >= 0 AND discount >= 0 AND total >= 0 AND paid >= 0 AND change_given >= 0`),
  `CREATE INDEX IF NOT EXISTS boutique_sales_sold_idx ON boutique_sales(sold_on DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS boutique_sales_cashier_idx ON boutique_sales(cashier_id, sold_on DESC)`,
  `CREATE INDEX IF NOT EXISTS boutique_sales_session_idx ON boutique_sales(session_id)`,

  `CREATE TABLE IF NOT EXISTS boutique_sale_items (
     id SERIAL PRIMARY KEY,
     sale_id INTEGER NOT NULL REFERENCES boutique_sales(id) ON DELETE CASCADE,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE RESTRICT,
     -- Frozen at the sale: the receipt and the books must read the same in a
     -- year, whatever the product is called or costs by then.
     product_name VARCHAR(200) NOT NULL,
     sku VARCHAR(60) NOT NULL,
     size VARCHAR(40) NOT NULL DEFAULT '',
     color VARCHAR(40) NOT NULL DEFAULT '',
     quantity INTEGER NOT NULL,
     unit_price NUMERIC(18,2) NOT NULL,
     unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
     discount NUMERIC(18,2) NOT NULL DEFAULT 0,
     line_total NUMERIC(18,2) NOT NULL
   )`,
  ...check('boutique_sale_items', 'boutique_sale_items_quantity_check', `quantity > 0 AND unit_price >= 0 AND discount >= 0 AND line_total >= 0`),
  `CREATE INDEX IF NOT EXISTS boutique_sale_items_sale_idx ON boutique_sale_items(sale_id)`,
  `CREATE INDEX IF NOT EXISTS boutique_sale_items_variant_idx ON boutique_sale_items(variant_id)`,

  `CREATE TABLE IF NOT EXISTS boutique_sale_payments (
     id SERIAL PRIMARY KEY,
     sale_id INTEGER NOT NULL REFERENCES boutique_sales(id) ON DELETE CASCADE,
     method VARCHAR(40) NOT NULL,
     amount NUMERIC(18,2) NOT NULL,
     reference VARCHAR(100) NOT NULL DEFAULT ''
   )`,
  ...check('boutique_sale_payments', 'boutique_sale_payments_method_check', `method IN (${list(ALL_BOUTIQUE_PAYMENT_METHODS)})`),
  ...check('boutique_sale_payments', 'boutique_sale_payments_amount_check', `amount > 0`),
  `CREATE INDEX IF NOT EXISTS boutique_sale_payments_sale_idx ON boutique_sale_payments(sale_id)`,

  `CREATE TABLE IF NOT EXISTS boutique_returns (
     id SERIAL PRIMARY KEY,
     number VARCHAR(20) NOT NULL UNIQUE,
     sale_id INTEGER NOT NULL REFERENCES boutique_sales(id) ON DELETE RESTRICT,
     cashier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     session_id INTEGER REFERENCES boutique_cash_sessions(id) ON DELETE SET NULL,
     kind VARCHAR(20) NOT NULL DEFAULT 'return',
     -- The value of what came back, and how much of it was handed back as
     -- money (the rest, on an exchange, went onto the new sale as credit).
     value NUMERIC(18,2) NOT NULL DEFAULT 0,
     refund_total NUMERIC(18,2) NOT NULL DEFAULT 0,
     refund_method VARCHAR(40),
     exchange_sale_id INTEGER REFERENCES boutique_sales(id) ON DELETE SET NULL,
     reason TEXT NOT NULL,
     returned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     returned_on DATE NOT NULL DEFAULT CURRENT_DATE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_returns', 'boutique_returns_kind_check', `kind IN (${list(RETURN_KINDS)})`),
  ...check('boutique_returns', 'boutique_returns_money_check', `value >= 0 AND refund_total >= 0 AND refund_total <= value`),
  ...check('boutique_returns', 'boutique_returns_method_check', `refund_method IS NULL OR refund_method IN (${list(BOUTIQUE_PAYMENT_METHODS)})`),
  `CREATE INDEX IF NOT EXISTS boutique_returns_sale_idx ON boutique_returns(sale_id)`,
  `CREATE INDEX IF NOT EXISTS boutique_returns_returned_idx ON boutique_returns(returned_on DESC)`,
  `ALTER TABLE boutique_sales DROP CONSTRAINT IF EXISTS boutique_sales_exchange_fk`,
  `ALTER TABLE boutique_sales ADD CONSTRAINT boutique_sales_exchange_fk FOREIGN KEY (exchange_of_return_id) REFERENCES boutique_returns(id) ON DELETE SET NULL`,

  `CREATE TABLE IF NOT EXISTS boutique_return_items (
     id SERIAL PRIMARY KEY,
     return_id INTEGER NOT NULL REFERENCES boutique_returns(id) ON DELETE CASCADE,
     sale_item_id INTEGER NOT NULL REFERENCES boutique_sale_items(id) ON DELETE RESTRICT,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE RESTRICT,
     quantity INTEGER NOT NULL,
     unit_price NUMERIC(18,2) NOT NULL,
     unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
     -- Back on the shelf, or damaged and written off with the return.
     restock BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  ...check('boutique_return_items', 'boutique_return_items_quantity_check', `quantity > 0`),
  `CREATE INDEX IF NOT EXISTS boutique_return_items_sale_item_idx ON boutique_return_items(sale_item_id)`,

  // ---- expenses ---------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS boutique_expenses (
     id SERIAL PRIMARY KEY,
     category VARCHAR(100) NOT NULL,
     description TEXT NOT NULL,
     amount NUMERIC(18,2) NOT NULL,
     method VARCHAR(40) NOT NULL DEFAULT 'Cash',
     spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
     -- Set when the money came out of an open till, so that till's expected
     -- cash drops by it. An expense paid from the bank names no session.
     session_id INTEGER REFERENCES boutique_cash_sessions(id) ON DELETE SET NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'active',
     void_reason TEXT NOT NULL DEFAULT '',
     voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_at TIMESTAMPTZ,
     recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_expenses', 'boutique_expenses_amount_check', `amount > 0`),
  ...check('boutique_expenses', 'boutique_expenses_method_check', `method IN (${list(BOUTIQUE_PAYMENT_METHODS)})`),
  ...check('boutique_expenses', 'boutique_expenses_status_check', `status IN (${list(EXPENSE_STATUSES)})`),
  `CREATE INDEX IF NOT EXISTS boutique_expenses_spent_idx ON boutique_expenses(spent_on DESC)`,

  // ---- the audit trail --------------------------------------------------------------
  //
  // One row per write, whatever the table: who, what, on which record, with
  // the figures that changed. Read back per record (a sale's history) and as
  // a whole (the Director's audit page). Rows are never updated or deleted.
  `CREATE TABLE IF NOT EXISTS boutique_audit (
     id SERIAL PRIMARY KEY,
     entity_type VARCHAR(30) NOT NULL,
     entity_id INTEGER,
     action VARCHAR(60) NOT NULL,
     details JSONB NOT NULL DEFAULT '{}'::jsonb,
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS boutique_audit_entity_idx ON boutique_audit(entity_type, entity_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS boutique_audit_created_idx ON boutique_audit(created_at DESC)`,

  // ---- what the Boutique Manager puts in front of the Director ---------------------
  //
  // The Boutique Manager reports directly to the Director (Super Admin): a
  // period report (sales, stock, purchases, money, expenses, profit) as the
  // figures stood when it was sent, frozen in `snapshot`, or an incident that
  // needs the Director's intervention. The Director accepts it or returns it
  // with a note; who decided, when and what they said stay on the row and in
  // boutique_audit. Nothing in between: no General Manager, no other manager.
  `CREATE TABLE IF NOT EXISTS boutique_submissions (
     id SERIAL PRIMARY KEY,
     kind VARCHAR(20) NOT NULL,
     title VARCHAR(200) NOT NULL,
     period VARCHAR(20),
     period_start DATE,
     period_end DATE,
     note TEXT NOT NULL DEFAULT '',
     snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     status VARCHAR(20) NOT NULL DEFAULT 'submitted',
     submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_at TIMESTAMPTZ,
     decision_note TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_submissions', 'boutique_submissions_kind_check', `kind IN ('report', 'incident')`),
  ...check('boutique_submissions', 'boutique_submissions_status_check', `status IN ('submitted', 'accepted', 'returned')`),
  `CREATE INDEX IF NOT EXISTS boutique_submissions_status_idx ON boutique_submissions(status, submitted_at DESC)`,

  // Every Boutique Manager already on the books reports to the Director from
  // now on. Only a manager whose own operation is the boutique (not one
  // covering every operation), and only when the line is not a Director yet.
  `UPDATE users u SET manager_id = (SELECT id FROM users WHERE role = 'super-admin' AND status = 'active' ORDER BY id LIMIT 1)
    WHERE u.role = 'manager' AND u.covers_all_sectors = FALSE
      AND (u.sector = '${RETAIL_OPERATION}' OR EXISTS (SELECT 1 FROM manager_operations mo WHERE mo.manager_id = u.id AND mo.sector = '${RETAIL_OPERATION}'))
      AND NOT EXISTS (SELECT 1 FROM users boss WHERE boss.id = u.manager_id AND boss.role = 'super-admin')
      AND EXISTS (SELECT 1 FROM users WHERE role = 'super-admin' AND status = 'active')`,

  // ---- a local shop, and one press is one change ------------------------------
  //
  // The shop sells everyday goods, so a new product with no category given is
  // 'other', not 'clothing'. Existing rows keep whatever they were saved as.
  `ALTER TABLE boutique_products ALTER COLUMN product_type SET DEFAULT 'other'`,
  // The form sends a key it made when it was opened. A second press of
  // "Save" -- a double tap, a slow network, a retried request -- arrives with
  // the same key and is answered with the row the first press made, instead
  // of adding the stock (or the product) twice.
  `ALTER TABLE boutique_products ADD COLUMN IF NOT EXISTS request_key VARCHAR(64)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_products_request_key_idx ON boutique_products(request_key) WHERE request_key IS NOT NULL`,
  `ALTER TABLE boutique_stock_adjustments ADD COLUMN IF NOT EXISTS request_key VARCHAR(64)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_stock_adjustments_request_key_idx ON boutique_stock_adjustments(request_key) WHERE request_key IS NOT NULL`,

  // ---- sales worked out by counting the shelf ----------------------------------
  //
  // A small shop often sells over the counter without ringing each sale up.
  // It still knows what it sold by counting what is left: one row here per
  // count, one line per product counted. `expected` is the shelf as the ledger
  // had it at the moment of the count (opening + received − adjustments − till
  // sales), `counted` what was found, `sold` the difference. The selling price
  // and the buying price are FROZEN onto the line, so a later price change can
  // never rewrite the revenue or the profit of a day already counted. The sold
  // pieces leave the shelf through moveStock (kind count_sale), so the ledger
  // and the shelf still agree; a void puts them back (count_sale_void).
  // What one unit of a product is -- kg, bottles, pieces, litres -- typed
  // beside the quantity when the product is added. Blank on products saved
  // before it was asked. Quantities stay whole numbers: sugar sold by the
  // half-kilo is counted in 500 g bags, not in 0.5 kg.
  `ALTER TABLE boutique_products ADD COLUMN IF NOT EXISTS unit VARCHAR(30) NOT NULL DEFAULT ''`,

  `CREATE TABLE IF NOT EXISTS boutique_shelf_counts (
     id SERIAL PRIMARY KEY,
     counted_on DATE NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     status VARCHAR(20) NOT NULL DEFAULT 'recorded',
     counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     voided_at TIMESTAMPTZ,
     void_reason TEXT NOT NULL DEFAULT '',
     request_key VARCHAR(64),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  ...check('boutique_shelf_counts', 'boutique_shelf_counts_status_check', `status IN (${list(SHELF_COUNT_STATUSES)})`),
  `CREATE UNIQUE INDEX IF NOT EXISTS boutique_shelf_counts_request_key_idx ON boutique_shelf_counts(request_key) WHERE request_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS boutique_shelf_counts_day_idx ON boutique_shelf_counts(counted_on, status)`,
  `CREATE TABLE IF NOT EXISTS boutique_shelf_count_lines (
     id SERIAL PRIMARY KEY,
     count_id INTEGER NOT NULL REFERENCES boutique_shelf_counts(id) ON DELETE RESTRICT,
     variant_id INTEGER NOT NULL REFERENCES boutique_variants(id) ON DELETE RESTRICT,
     product_name VARCHAR(200) NOT NULL,
     sku VARCHAR(60) NOT NULL,
     expected INTEGER NOT NULL,
     counted INTEGER NOT NULL,
     sold INTEGER NOT NULL,
     unit_price NUMERIC(18,2) NOT NULL,
     unit_cost NUMERIC(18,2) NOT NULL,
     revenue NUMERIC(18,2) NOT NULL,
     cost NUMERIC(18,2) NOT NULL,
     UNIQUE (count_id, variant_id)
   )`,
  ...check('boutique_shelf_count_lines', 'boutique_shelf_count_lines_check',
    'counted >= 0 AND expected >= counted AND sold = expected - counted AND unit_price >= 0 AND unit_cost >= 0 AND revenue >= 0 AND cost >= 0')
];

export async function migrateBoutiqueModule(pool) {
  for (const statement of statements) {
    if (statement.includes('$1::text[]')) {
      await pool.query(statement, [BOUTIQUE_PAYMENT_METHODS, BOUTIQUE_PAYMENT_METHODS.map((_, index) => index)]);
    } else {
      await pool.query(statement);
    }
  }
}
