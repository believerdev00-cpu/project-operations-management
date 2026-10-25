// The Boutique Management System: who may do what, and the three pieces of
// arithmetic every boutique route shares -- moving stock, writing the audit
// trail, and working out what a till should hold.
//
// WHO. Four kinds of people reach the boutique, decided from the account row
// authMiddleware re-reads on every request (never from the browser):
//
//   director  the Director (super-admin). Sees everything, decides every
//             approval, configures the till's payment methods, voids at once.
//   reader    the General Manager. Sees everything, writes nothing -- exactly
//             as hasFullScope gives them every other operation to read.
//   manager   the Boutique Manager: a `manager` whose operations include the
//             boutique (or who covers every operation). Runs the shop --
//             products, purchases, suppliers, expenses, the till, sales --
//             and ASKS for the sensitive things: writing stock off, a count
//             correction, a transfer, voiding a completed sale.
//   cashier   a team member (`staff`) placed in the boutique operation. Sells,
//             takes returns, opens and closes their own till, reads the
//             catalogue and the stock. Nothing else.
//
// Everybody else -- a Mining manager, a partner (kept out earlier by the
// allowlist in auth.js) -- is refused by boutiqueAccess before any handler
// runs, so no route has to remember to check.

import { isAdmin, isGeneralManager, parseId, validNumber } from './http.js';
import { RETAIL_OPERATION, worksInBoutique } from '../../shared/businessOperations.js';
import { BOUTIQUE_PAYMENT_METHODS, EXCHANGE_CREDIT, STOCK_MOVEMENT_KINDS, fromMinor, toMinor } from '../../shared/boutique.js';

export const BOUTIQUE_FOLDER = 'boutique';

export class BoutiqueError extends Error {
  // `params`: the values a translated sentence needs (shared/apiErrors.js).
  constructor(status, message, code = null, params = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export function boutiqueRole(user) {
  if (!user) return null;
  if (isAdmin(user)) return 'director';
  if (isGeneralManager(user)) return 'reader';
  if (!worksInBoutique(user)) return null;
  return user.role === 'manager' ? 'manager' : 'cashier';
}

// Express middleware in front of the whole router. The role is put on the
// request so handlers ask `req.boutique` rather than re-deriving it.
export function boutiqueAccess(req, res, next) {
  const role = boutiqueRole(req.user);
  if (!role) {
    return res.status(403).json({ code: 'BOUTIQUE_ACCESS', message: 'Only the boutique’s own people and the Director can open the boutique.' });
  }
  req.boutique = role;
  next();
}

// The gates, by what the action is rather than by role name, so a handler
// reads "may this person sell?" and the mapping lives in one place.
export const canSell = (role) => ['director', 'manager', 'cashier'].includes(role);
export const canManage = (role) => ['director', 'manager'].includes(role);
export const canDecide = (role) => role === 'director';

export function requireSell(req) {
  if (!canSell(req.boutique)) throw new BoutiqueError(403, 'Only the boutique’s cashiers and manager can use the till.');
}
export function requireManage(req) {
  if (!canManage(req.boutique)) throw new BoutiqueError(403, 'Only the Boutique Manager or the Director can do this.');
}
export function requireDecide(req) {
  if (!canDecide(req.boutique)) throw new BoutiqueError(403, 'Only the Director decides this.', 'DIRECTOR_ONLY');
}
// What a cashier does not need to see: suppliers, purchases, expenses, the
// adjustments queue, the books. The screen never offered them; the API
// refuses them too, so the screen is not the only wall (audit finding M1).
export function requireNotCashier(req) {
  if (req.boutique === 'cashier') throw new BoutiqueError(403, 'This is the manager’s and the Director’s.');
}

// ---- reading the body ----------------------------------------------------------

export function text(value, limit, { required = false, label = 'This field' } = {}) {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  if (required && !trimmed) throw new BoutiqueError(400, `${label} is required. Please fill it in and try again.`);
  return trimmed;
}

// An amount in RWF, non-negative, within what NUMERIC(18,2) holds. The
// messages say what is wrong and what to do, because they are read by a
// shopkeeper at the counter, not by a developer.
export function amount(value, { label = 'Amount', minimum = 0 } = {}) {
  const number = value === '' || value === null || value === undefined ? 0 : Number(value);
  if (!validNumber(number, { minimum })) {
    throw new BoutiqueError(400, `${label} must be a number${minimum > 0 ? ' above zero' : ', zero or more'}. Please check it and try again.`);
  }
  return fromMinor(toMinor(number));
}

export function wholeNumber(value, { label = 'Quantity', minimum = 1 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > 1e9) {
    throw new BoutiqueError(400, `${label} must be a whole number${minimum > 0 ? ` of at least ${minimum}` : ', zero or more'}. Please check the number and try again.`);
  }
  return number;
}

export function id(value, label = 'Record') {
  const parsed = parseId(value);
  if (!parsed) throw new BoutiqueError(404, `${label} not found.`);
  return parsed;
}

export function oneOf(value, options, label) {
  if (!options.includes(value)) throw new BoutiqueError(400, `${label} is not one of the allowed values.`);
  return value;
}

// ---- the stock ledger ------------------------------------------------------------

// The ONLY way a variant's stock figure changes. Locks the variant row, refuses
// to take the figure below zero, writes the new figure and the ledger row that
// explains it in the same transaction, and returns both. Every caller -- a
// sale, a receipt of goods, an approved write-off -- goes through here, which
// is what keeps SUM(ledger) equal to the figure on the row.
export async function moveStock(client, { variantId, quantity, kind, referenceType = '', referenceId = null, note = '', actor }) {
  if (!STOCK_MOVEMENT_KINDS.includes(kind)) throw new Error(`Unknown stock movement kind: ${kind}`);
  const change = Math.trunc(Number(quantity));
  if (!change) throw new BoutiqueError(400, 'A stock movement cannot be zero.');
  const locked = await client.query(
    `SELECT v.id, v.stock_quantity, v.reorder_level, v.sku, v.size, v.color, v.status, p.name AS product_name
       FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id
      WHERE v.id = $1 FOR UPDATE OF v`,
    [variantId]
  );
  if (!locked.rowCount) throw new BoutiqueError(404, 'Product variant not found.');
  const variant = locked.rows[0];
  const before = variant.stock_quantity;
  const after = variant.stock_quantity + change;
  if (after < 0) {
    throw new BoutiqueError(409,
      `Only ${variant.stock_quantity} of ${variant.product_name} (${variant.sku}) in stock; ${Math.abs(change)} asked for.`,
      'INSUFFICIENT_STOCK', { available: variant.stock_quantity, asked: Math.abs(change), product: variant.product_name });
  }
  await client.query('UPDATE boutique_variants SET stock_quantity = $2, updated_at = NOW() WHERE id = $1', [variantId, after]);
  const movement = await client.query(
    `INSERT INTO boutique_stock_movements (variant_id, quantity, kind, balance_after, reference_type, reference_id, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [variantId, change, kind, after, referenceType, referenceId, note, actor?.id ?? null]
  );
  return {
    movement: movement.rows[0],
    variant: { ...variant, stock_quantity: after },
    before,
    after,
    // Crossed down to the reorder level with this very movement: the moment
    // to tell the Director and the manager, once, not on every sale after.
    ranLow: before > variant.reorder_level && after <= variant.reorder_level
  };
}

// Who is told a shelf has run low: every active Director, and the boutique's
// own manager(s). Directly, the line the Boutique Manager reports along.
export async function lowStockRecipients(db) {
  const result = await db.query(
    `SELECT id FROM users WHERE status = 'active' AND (role = 'super-admin'
        OR (role = 'manager' AND covers_all_sectors = FALSE AND (sector = $1
            OR EXISTS (SELECT 1 FROM manager_operations mo WHERE mo.manager_id = users.id AND mo.sector = $1))))
      ORDER BY id`,
    [RETAIL_OPERATION]
  );
  return result.rows.map((row) => row.id);
}

// ---- the audit trail ----------------------------------------------------------------

export async function audit(db, { entityType, entityId = null, action, details = {}, actor }) {
  await db.query(
    `INSERT INTO boutique_audit (entity_type, entity_id, action, details, actor_id, actor_name)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [entityType, entityId, action, JSON.stringify(details || {}), actor?.id ?? null, actor?.name ?? '']
  );
}

export function mapAudit(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    details: row.details || {},
    actorId: row.actor_id,
    actorName: row.actor_name || '',
    createdAt: row.created_at
  };
}

// ---- the till ---------------------------------------------------------------------------

// What a session should hold, from the rows that name it. Cash is the drawer:
// opening float, plus cash taken on completed sales, less the change handed
// back, less cash refunds, less cash expenses paid from the drawer, less
// payouts, plus cash put in. Each other method is simply what was taken by it
// less what was refunded by it -- those are reconciled against the mobile
// money or card statement, not against a drawer. 'Exchange credit' is not
// money and is left out everywhere.
//
// Sales that were voided are left out: the void put the goods back and the
// money is treated as never taken (if it really was taken and handed back,
// that is what the void reason records).
export async function sessionFigures(db, sessionId) {
  // One query at a time: `db` is often a transaction client, which cannot
  // run two at once.
  const session = await db.query('SELECT * FROM boutique_cash_sessions WHERE id = $1', [sessionId]);
  if (!session.rowCount) return null;
  const payments = await db.query(
    `SELECT p.method, COALESCE(SUM(p.amount), 0) AS taken
       FROM boutique_sale_payments p JOIN boutique_sales s ON s.id = p.sale_id
      WHERE s.session_id = $1 AND s.status <> 'voided'
      GROUP BY p.method`,
    [sessionId]
  );
  // Change is a figure of the SALE, read once per sale. Summed through the
  // payment lines it was counted once per Cash line, so a sale paid with two
  // cash notes entered as two lines took its change out of the drawer twice
  // (audit finding H3).
  const change = await db.query(
    `SELECT COALESCE(SUM(change_given), 0) AS total FROM boutique_sales WHERE session_id = $1 AND status <> 'voided'`,
    [sessionId]
  );
  const refunds = await db.query(
    `SELECT refund_method AS method, COALESCE(SUM(refund_total), 0) AS refunded
       FROM boutique_returns WHERE session_id = $1 AND refund_total > 0 GROUP BY refund_method`,
    [sessionId]
  );
  const expenses = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM boutique_expenses
      WHERE session_id = $1 AND status = 'active' AND method = 'Cash'`,
    [sessionId]
  );
  const movements = await db.query(
    `SELECT kind, COALESCE(SUM(amount), 0) AS total FROM boutique_cash_movements WHERE session_id = $1 GROUP BY kind`,
    [sessionId]
  );
  const counts = await db.query(
    `SELECT COUNT(*)::int AS sales, COALESCE(SUM(total), 0) AS sold FROM boutique_sales WHERE session_id = $1 AND status <> 'voided'`,
    [sessionId]
  );
  const row = session.rows[0];
  const taken = Object.fromEntries(payments.rows.map((p) => [p.method, toMinor(p.taken)]));
  const changeGiven = toMinor(change.rows[0].total);
  const refunded = Object.fromEntries(refunds.rows.map((r) => [r.method, toMinor(r.refunded)]));
  const moved = Object.fromEntries(movements.rows.map((m) => [m.kind, toMinor(m.total)]));
  const cashExpenses = toMinor(expenses.rows[0].total);

  const expectedCash = toMinor(row.opening_cash)
    + (taken.Cash || 0) - changeGiven - (refunded.Cash || 0)
    - cashExpenses - (moved.payout || 0) + (moved.cash_in || 0);
  const byMethod = {};
  for (const method of BOUTIQUE_PAYMENT_METHODS) {
    if (method === 'Cash') continue;
    byMethod[method] = fromMinor((taken[method] || 0) - (refunded[method] || 0));
  }
  return {
    session: row,
    expectedCash: fromMinor(expectedCash),
    expectedByMethod: byMethod,
    cashTaken: fromMinor(taken.Cash || 0),
    changeGiven: fromMinor(changeGiven),
    cashRefunded: fromMinor(refunded.Cash || 0),
    cashExpenses: fromMinor(cashExpenses),
    payouts: fromMinor(moved.payout || 0),
    cashIn: fromMinor(moved.cash_in || 0),
    sales: counts.rows[0].sales,
    sold: Number(counts.rows[0].sold)
  };
}

// ---- the books --------------------------------------------------------------------------

// The shop's figures for a period, each from one query, and combined without
// counting anything twice:
//
//   gross sales      every completed sale's total (after line and sale discounts)
//   discounts        what was taken off, for information
//   returns          the value of goods brought back in the period
//   net sales        gross - returns
//   payments         money actually taken, by method: payments on completed
//                    sales (exchange credit excluded) less change less refunds
//   cost of sales    the frozen unit cost of what was sold, less the cost of
//                    what came back onto the shelf (a damaged return stays a cost)
//   gross profit     net sales - cost of sales
//   expenses         the shop's active expenses in the period
//   net profit       gross profit - expenses, an estimate: nothing here
//                    depreciates, accrues or is taxed
//   inventory value  what is on the shelf now, at cost (not a period figure)
//
// Purchases are reported beside these, not inside them: goods bought go into
// stock, and reach the books as cost of sales only when sold. Adding purchases
// to expenses would count every dress twice.
export async function financeFigures(db, { start, end }) {
  const range = [start, end];
  const [sales, returns, payments, refunds, cogs, expenses, inventory, purchases, supplierPayments, owed, counted] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(discount), 0) AS sale_discounts,
              COALESCE(SUM(subtotal), 0) AS subtotal
         FROM boutique_sales WHERE status <> 'voided' AND sold_on BETWEEN $1 AND $2`, range),
    db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(value), 0) AS value, COALESCE(SUM(refund_total), 0) AS refunded
         FROM boutique_returns WHERE returned_on BETWEEN $1 AND $2`, range),
    db.query(
      `SELECT p.method, COALESCE(SUM(p.amount), 0) AS taken
         FROM boutique_sale_payments p JOIN boutique_sales s ON s.id = p.sale_id
        WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 AND p.method <> $3
        GROUP BY p.method`, [...range, EXCHANGE_CREDIT]),
    db.query(
      `SELECT refund_method AS method, COALESCE(SUM(refund_total), 0) AS refunded
         FROM boutique_returns WHERE refund_total > 0 AND returned_on BETWEEN $1 AND $2 GROUP BY refund_method`, range),
    db.query(
      `SELECT
         (SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id
           WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2) AS sold_cost,
         (SELECT COALESCE(SUM(ri.quantity * ri.unit_cost), 0) FROM boutique_return_items ri JOIN boutique_returns r ON r.id = ri.return_id
           WHERE ri.restock AND r.returned_on BETWEEN $1 AND $2) AS returned_cost,
         (SELECT COALESCE(SUM(i.discount), 0) FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id
           WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2) AS line_discounts`, range),
    db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
         FROM boutique_expenses WHERE status = 'active' AND spent_on BETWEEN $1 AND $2`, range),
    db.query(
      `SELECT COALESCE(SUM(stock_quantity * cost_price), 0) AS value, COALESCE(SUM(stock_quantity), 0)::int AS pieces
         FROM boutique_variants WHERE status = 'active'`),
    db.query(
      `SELECT COUNT(DISTINCT r.id)::int AS receipts, COALESCE(SUM(ri.quantity * ri.unit_cost), 0) AS value, COALESCE(SUM(ri.quantity), 0)::int AS pieces
         FROM boutique_goods_receipts r JOIN boutique_goods_receipt_items ri ON ri.receipt_id = r.id
        WHERE r.received_on BETWEEN $1 AND $2`, range),
    db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM boutique_supplier_payments WHERE paid_on BETWEEN $1 AND $2`, range),
    db.query(`SELECT COALESCE(SUM(owed), 0) AS total FROM (${SUPPLIER_BALANCE_SQL}) b WHERE owed > 0`),
    // Sales worked out by counting the shelf (boutique_shelf_counts), at the
    // prices frozen on each line. No till took this money, so it is in the
    // sales and the profit but not in payments received by method.
    db.query(
      `SELECT COUNT(DISTINCT c.id)::int AS counts, COALESCE(SUM(l.sold), 0)::int AS pieces,
              COALESCE(SUM(l.revenue), 0) AS revenue, COALESCE(SUM(l.cost), 0) AS cost
         FROM boutique_shelf_counts c JOIN boutique_shelf_count_lines l ON l.count_id = c.id
        WHERE c.status = 'recorded' AND c.counted_on BETWEEN $1 AND $2`, range)
  ]);
  const s = sales.rows[0];
  const r = returns.rows[0];
  const c = cogs.rows[0];
  const changeGiven = await db.query(
    `SELECT COALESCE(SUM(change_given), 0) AS total FROM boutique_sales WHERE status <> 'voided' AND sold_on BETWEEN $1 AND $2`, range);

  const k = counted.rows[0];
  // Gross sales are the till's sales plus the counted ones: two ways of
  // knowing a piece left the shelf for money, never both for the same piece
  // (a till sale has already left the shelf before the count is taken).
  const gross = toMinor(s.gross) + toMinor(k.revenue);
  const returned = toMinor(r.value);
  const netSales = gross - returned;
  const costOfSales = toMinor(c.sold_cost) - toMinor(c.returned_cost) + toMinor(k.cost);
  const grossProfit = netSales - costOfSales;
  const expenseTotal = toMinor(expenses.rows[0].total);
  const refundedBy = Object.fromEntries(refunds.rows.map((row) => [row.method, toMinor(row.refunded)]));
  const takenBy = Object.fromEntries(payments.rows.map((row) => [row.method, toMinor(row.taken)]));
  const paymentsByMethod = BOUTIQUE_PAYMENT_METHODS.map((method) => ({
    method,
    taken: fromMinor(takenBy[method] || 0),
    changeGiven: method === 'Cash' ? fromMinor(toMinor(changeGiven.rows[0].total)) : 0,
    refunded: fromMinor(refundedBy[method] || 0),
    received: fromMinor((takenBy[method] || 0) - (method === 'Cash' ? toMinor(changeGiven.rows[0].total) : 0) - (refundedBy[method] || 0))
  }));

  return {
    period: { start, end },
    sales: { count: s.count, gross: fromMinor(gross), till: fromMinor(toMinor(s.gross)), counted: fromMinor(toMinor(k.revenue)), subtotal: Number(s.subtotal) },
    countSales: { counts: k.counts, pieces: k.pieces, revenue: fromMinor(toMinor(k.revenue)), cost: fromMinor(toMinor(k.cost)) },
    discounts: fromMinor(toMinor(s.sale_discounts) + toMinor(c.line_discounts)),
    returns: { count: r.count, value: fromMinor(returned), refunded: Number(r.refunded) },
    netSales: fromMinor(netSales),
    paymentsReceived: fromMinor(paymentsByMethod.reduce((sum, row) => sum + toMinor(row.received), 0)),
    paymentsByMethod,
    costOfSales: fromMinor(costOfSales),
    grossProfit: fromMinor(grossProfit),
    expenses: { count: expenses.rows[0].count, total: fromMinor(expenseTotal) },
    netProfit: fromMinor(grossProfit - expenseTotal),
    inventory: { value: Number(inventory.rows[0].value), pieces: inventory.rows[0].pieces },
    purchases: { receipts: purchases.rows[0].receipts, value: Number(purchases.rows[0].value), pieces: purchases.rows[0].pieces },
    supplierPayments: Number(supplierPayments.rows[0].total),
    supplierBalance: Number(owed.rows[0].total)
  };
}

// What each supplier is owed: the invoiced total of every order that has an
// invoice, else the value received so far at the order's unit costs, less
// what has been paid them. Cancelled orders owe nothing.
export const SUPPLIER_BALANCE_SQL = `
  SELECT s.id AS supplier_id,
         COALESCE(o.billed, 0) AS billed,
         COALESCE(p.paid, 0) AS paid,
         COALESCE(o.billed, 0) - COALESCE(p.paid, 0) AS owed
    FROM boutique_suppliers s
    LEFT JOIN (
      SELECT po.supplier_id,
             SUM(COALESCE(po.invoice_total, (SELECT COALESCE(SUM(pi.quantity_received * pi.unit_cost), 0)
                                                FROM boutique_purchase_items pi WHERE pi.order_id = po.id))) AS billed
        FROM boutique_purchase_orders po WHERE po.status <> 'cancelled' GROUP BY po.supplier_id
    ) o ON o.supplier_id = s.id
    LEFT JOIN (SELECT supplier_id, SUM(amount) AS paid FROM boutique_supplier_payments GROUP BY supplier_id) p ON p.supplier_id = s.id`;
