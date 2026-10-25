// The Boutique Management System (Project 5): every /api/boutique route.
//
// Seven parts, in the order the brief lists them: products and variants, the
// till (sales, returns, exchanges, voids), the stock ledger and the
// adjustments the Director decides, suppliers and purchases, the books,
// the cash sessions, and the reports and audit trail. All of it is scoped by
// boutiqueAccess (server/lib/boutique.js): the Director and the General
// Manager read it all, the Boutique Manager runs it, a cashier sells.
//
// THE RULES THAT HOLD EVERYWHERE HERE
//
//   * Money is RWF, in NUMERIC(18,2) columns, summed as integer hundredths.
//   * Stock only moves through moveStock(), under a row lock, with a ledger
//     row: a till cannot sell what two cashiers both saw as the last piece.
//   * A completed transaction is never deleted or edited. A sale is undone by
//     a void with a reason; an expense is voided with a reason; both leave
//     the row in place, marked, and an audit row saying who and why.
//   * The manager asks, the Director decides, for anything that changes the
//     inventory's value with nothing sold (write-offs, counts, transfers) and
//     for undoing a completed sale. The Director's own such acts apply at
//     once, recorded as approved by them.
//   * Every write is a row in boutique_audit.

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isValidDate, parseId } from '../lib/http.js';
import { notify, notifyDirectors, notifyMany } from '../lib/notifications.js';
import { readFile, saveFile, deleteFile, storedFileName, MAX_EVIDENCE_BYTES } from '../lib/storage.js';
import {
  BOUTIQUE_FOLDER, BoutiqueError, SUPPLIER_BALANCE_SQL, amount, audit, boutiqueAccess, canManage, canSell, financeFigures,
  id as parseRecordId, lowStockRecipients, mapAudit, moveStock, oneOf, requireDecide, requireManage, requireNotCashier, requireSell,
  sessionFigures, text, wholeNumber
} from '../lib/boutique.js';
import {
  ADDING_ADJUSTMENTS, ADJUSTMENT_KINDS, BOUTIQUE_PAYMENT_METHODS, CASH_MOVEMENT_KINDS, EXCHANGE_CREDIT, EXPENSE_CATEGORIES, PRODUCT_TYPES,
  PURCHASE_STATUSES, REPORT_PERIODS, SALE_STATUSES, fromMinor, lineTotals, saleTotals, toMinor
} from '../../shared/boutique.js';
import { RETAIL_OPERATION } from '../../shared/businessOperations.js';

const router = express.Router();
router.use(boutiqueAccess);

// Product pictures: images only, within the same body cap as evidence.
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 },
  fileFilter: (req, file, done) => {
    if (!IMAGE_MIME.has(file.mimetype)) return done(new BoutiqueError(400, 'A product picture must be a JPG, PNG, GIF or WEBP image.'));
    done(null, true);
  }
});

// ---- dates --------------------------------------------------------------------------
//
// The shop's day. A sale rung up at 00:30 in Kigali belongs to that day, not
// to the UTC day the database would stamp; the shop's own timezone decides,
// configurable for a boutique elsewhere.
const SHOP_TIMEZONE = process.env.BOUTIQUE_TIMEZONE || 'Africa/Kigali';
function todayInShop() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
// A timestamp column read as the shop's calendar day, for the filters that
// ask "which day was this?" of a till closing or a stock movement. The zone
// name comes from the environment, never from a request, and is quoted.
const SHOP_TIMEZONE_SQL = `'${SHOP_TIMEZONE.replace(/[^A-Za-z0-9_+\-/]/g, '')}'`;
function shopDay(column) {
  return `(${column} AT TIME ZONE ${SHOP_TIMEZONE_SQL})::date`;
}
function dateOr(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isValidDate(value)) throw new BoutiqueError(400, `${label} must be a valid date (YYYY-MM-DD).`);
  return value;
}
function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new BoutiqueError(400, 'Month must be YYYY-MM.');
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) throw new BoutiqueError(400, 'Month must be YYYY-MM.');
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}
// ?period=daily&date= | weekly&start= | monthly&month= | custom&start=&end=
function resolvePeriod(query) {
  const period = REPORT_PERIODS.includes(query.period) ? query.period : 'daily';
  const today = todayInShop();
  if (period === 'daily') { const day = dateOr(query.date, today, 'Date'); return { period, start: day, end: day }; }
  if (period === 'weekly') { const start = dateOr(query.start, shiftDate(today, -6), 'Start'); return { period, start, end: shiftDate(start, 6) }; }
  if (period === 'monthly') return { period, ...monthRange(query.month || today.slice(0, 7)) };
  const start = dateOr(query.start, today, 'Start');
  const end = dateOr(query.end, start, 'End');
  if (end < start) throw new BoutiqueError(400, 'The end date is before the start date.');
  return { period, start, end };
}

// ---- mapping rows ---------------------------------------------------------------------

const money = (value) => Number(value || 0);

function mapVariant(row) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    barcode: row.barcode || '',
    size: row.size || '',
    color: row.color || '',
    costPrice: money(row.cost_price),
    sellingPrice: money(row.selling_price),
    stockQuantity: Number(row.stock_quantity || 0),
    reorderLevel: Number(row.reorder_level || 0),
    lowStock: Number(row.stock_quantity || 0) <= Number(row.reorder_level || 0),
    status: row.status,
    // Carried when the variant is listed outside its product (stock, search).
    productName: row.product_name,
    productType: row.product_type,
    // What one unit of stock is: kg, bottles, pieces. Blank on products saved
    // before it was asked, which read as plain numbers.
    productUnit: row.product_unit ?? row.unit ?? '',
    brand: row.brand,
    hasImage: row.image_stored_name ? true : undefined
  };
}

// A variant as a cashier may see it: without the purchase cost.
function forRole(variant, cashier) {
  if (!cashier) return variant;
  const { costPrice, ...rest } = variant;
  return rest;
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    productType: row.product_type,
    unit: row.unit || '',
    category: row.category || '',
    brand: row.brand || '',
    description: row.description || '',
    hasImage: Boolean(row.image_stored_name),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variants: (row.variants || []).map((v) => mapVariant({ ...v, product_unit: row.unit || '' })),
    stockQuantity: (row.variants || []).reduce((sum, v) => sum + Number(v.stock_quantity || 0), 0)
  };
}

function mapSale(row) {
  return {
    id: row.id,
    number: row.number,
    cashierId: row.cashier_id,
    cashierName: row.cashier_name || '',
    sessionId: row.session_id,
    customerName: row.customer_name || '',
    status: row.status,
    subtotal: money(row.subtotal),
    discount: money(row.discount),
    total: money(row.total),
    paid: money(row.paid),
    changeGiven: money(row.change_given),
    note: row.note || '',
    exchangeOfReturnId: row.exchange_of_return_id,
    voidReason: row.void_reason || '',
    voidRequestedBy: row.void_requested_by,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
    soldAt: row.sold_at,
    soldOn: row.sold_on instanceof Date ? isoDay(row.sold_on) : row.sold_on,
    itemCount: row.item_count !== undefined ? Number(row.item_count) : undefined,
    items: row.items ? row.items.map(mapSaleItem) : undefined,
    payments: row.payments ? row.payments.map((p) => ({ id: p.id, method: p.method, amount: money(p.amount), reference: p.reference || '' })) : undefined,
    returns: row.returns ? row.returns.map(mapReturn) : undefined
  };
}

function mapSaleItem(row) {
  return {
    id: row.id,
    variantId: row.variant_id,
    productName: row.product_name,
    sku: row.sku,
    size: row.size || '',
    color: row.color || '',
    quantity: Number(row.quantity),
    unitPrice: money(row.unit_price),
    unitCost: money(row.unit_cost),
    discount: money(row.discount),
    lineTotal: money(row.line_total),
    returnedQuantity: Number(row.returned_quantity || 0)
  };
}

function mapReturn(row) {
  return {
    id: row.id,
    number: row.number,
    saleId: row.sale_id,
    saleNumber: row.sale_number,
    cashierId: row.cashier_id,
    cashierName: row.cashier_name || '',
    kind: row.kind,
    value: money(row.value),
    refundTotal: money(row.refund_total),
    refundMethod: row.refund_method,
    exchangeSaleId: row.exchange_sale_id,
    exchangeSaleNumber: row.exchange_sale_number,
    reason: row.reason,
    returnedAt: row.returned_at,
    returnedOn: row.returned_on,
    items: row.items ? row.items.map((i) => ({
      id: i.id, saleItemId: i.sale_item_id, variantId: i.variant_id, productName: i.product_name, sku: i.sku,
      quantity: Number(i.quantity), unitPrice: money(i.unit_price), restock: Boolean(i.restock)
    })) : undefined
  };
}

function mapSession(row, figures = null) {
  return {
    id: row.id,
    openedBy: row.opened_by,
    openedByName: row.opened_by_name || '',
    openedAt: row.opened_at,
    openingCash: money(row.opening_cash),
    status: row.status,
    closedBy: row.closed_by,
    closedByName: row.closed_by_name || '',
    closedAt: row.closed_at,
    expectedCash: row.expected_cash === null || row.expected_cash === undefined ? (figures ? figures.expectedCash : null) : money(row.expected_cash),
    countedCash: row.counted_cash === null || row.counted_cash === undefined ? null : money(row.counted_cash),
    cashVariance: row.cash_variance === null || row.cash_variance === undefined ? null : money(row.cash_variance),
    expectedByMethod: row.status === 'closed' ? (row.expected_by_method || {}) : (figures ? figures.expectedByMethod : {}),
    countedByMethod: row.counted_by_method || {},
    note: row.note || '',
    figures: figures ? {
      cashTaken: figures.cashTaken, changeGiven: figures.changeGiven, cashRefunded: figures.cashRefunded,
      cashExpenses: figures.cashExpenses, payouts: figures.payouts, cashIn: figures.cashIn, sales: figures.sales, sold: figures.sold
    } : undefined
  };
}

function mapAdjustment(row) {
  return {
    id: row.id,
    variantId: row.variant_id,
    productName: row.product_name,
    // What the shelf holds now, and what it is counted in, so the Director
    // sees "3 bottles now, 27 after you approve" rather than a bare number.
    productUnit: row.product_unit || '',
    onShelf: row.on_shelf === undefined || row.on_shelf === null ? null : Number(row.on_shelf),
    sku: row.sku,
    size: row.size || '',
    color: row.color || '',
    kind: row.kind,
    quantity: Number(row.quantity),
    delta: Number(row.delta),
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name || '',
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name || '',
    decidedAt: row.decided_at,
    decisionNote: row.decision_note || '',
    createdAt: row.created_at
  };
}

function mapSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name || '',
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    notes: row.notes || '',
    status: row.status,
    billed: money(row.billed),
    paid: money(row.paid),
    owed: money(row.owed),
    orderCount: row.order_count !== undefined ? Number(row.order_count) : undefined
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name || '',
    reference: row.reference,
    status: row.status,
    orderedOn: row.ordered_on,
    expectedOn: row.expected_on,
    invoiceNumber: row.invoice_number || '',
    invoiceTotal: row.invoice_total === null || row.invoice_total === undefined ? null : money(row.invoice_total),
    notes: row.notes || '',
    cancelReason: row.cancel_reason || '',
    orderedValue: money(row.ordered_value),
    receivedValue: money(row.received_value),
    createdAt: row.created_at,
    items: row.items ? row.items.map((i) => ({
      id: i.id, variantId: i.variant_id, productName: i.product_name, sku: i.sku, size: i.size || '', color: i.color || '',
      quantityOrdered: Number(i.quantity_ordered), quantityReceived: Number(i.quantity_received), unitCost: money(i.unit_cost)
    })) : undefined,
    receipts: row.receipts ? row.receipts.map((r) => ({
      id: r.id, receivedOn: r.received_on, note: r.note || '', receivedByName: r.received_by_name || '',
      pieces: Number(r.pieces || 0), value: money(r.value)
    })) : undefined,
    payments: row.payments ? row.payments.map(mapSupplierPayment) : undefined
  };
}

function mapSupplierPayment(row) {
  return {
    id: row.id, supplierId: row.supplier_id, supplierName: row.supplier_name, orderId: row.order_id, orderReference: row.order_reference,
    amount: money(row.amount), method: row.method, paidOn: row.paid_on, reference: row.reference || '', note: row.note || '',
    recordedByName: row.recorded_by_name || '', createdAt: row.created_at
  };
}

function mapExpense(row) {
  return {
    id: row.id, category: row.category, description: row.description, amount: money(row.amount), method: row.method,
    spentOn: row.spent_on, sessionId: row.session_id, status: row.status, voidReason: row.void_reason || '',
    recordedByName: row.recorded_by_name || '', createdAt: row.created_at
  };
}

function mapMovement(row) {
  return {
    id: row.id, variantId: row.variant_id, productName: row.product_name, sku: row.sku, size: row.size || '', color: row.color || '',
    quantity: Number(row.quantity), kind: row.kind, balanceAfter: Number(row.balance_after), referenceType: row.reference_type || '',
    referenceId: row.reference_id, note: row.note || '', recordedByName: row.recorded_by_name || '', createdAt: row.created_at
  };
}

// Dates come back from pg as Date objects for DATE columns unless told
// otherwise: a DATE of 2026-10-22 arrives as local midnight on that day. The
// API answers them as 'YYYY-MM-DD' read from the LOCAL parts -- toISOString
// would convert that midnight to UTC and, on any server east of Greenwich,
// print the day before (every sale showed 21 Oct on the 22nd).
export function isoDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function plainDates(value) {
  // A DATE column arrives as local midnight; a timestamp keeps its time, and
  // is sent whole so the trail can show the hour.
  if (value instanceof Date) {
    const midnight = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0;
    return midnight ? isoDay(value) : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(plainDates);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainDates(entry)]));
  }
  return value;
}
const send = (res, payload, status = 200) => res.status(status).json(plainDates(payload));

// The key a form made when it was opened, so a second press of the same Save
// is recognised (see request_key in boutiqueSchema.js). Optional: a caller
// that sends none gets exactly the old behaviour.
function requestKeyOf(body) {
  const key = typeof body?.requestKey === 'string' ? body.requestKey.trim() : '';
  if (!key) return null;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new BoutiqueError(400, 'The form sent an invalid request key. Please reload the page and try again.');
  return key;
}

// The caller's open till, if they have one; sales and refunds hang off it.
async function openSessionOf(db, userId) {
  const result = await db.query("SELECT id FROM boutique_cash_sessions WHERE opened_by = $1 AND status = 'open'", [userId]);
  return result.rowCount ? result.rows[0].id : null;
}

async function activeMethods(db) {
  const result = await db.query('SELECT code FROM boutique_payment_methods WHERE active ORDER BY sort_order');
  return result.rows.map((row) => row.code);
}

// Runs a transaction for a route, with the house rollback.
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

// =====================================================================================
// 0. Overview
// =====================================================================================

router.get('/overview', asyncRoute(async (req, res) => {
  const today = todayInShop();
  const [catalogue, todaySales, sessions, approvals, owed, lowStock] = await Promise.all([
    pool.query(`SELECT COUNT(DISTINCT p.id)::int AS products, COUNT(v.id)::int AS variants,
                       COALESCE(SUM(v.stock_quantity), 0)::int AS pieces, COALESCE(SUM(v.stock_quantity * v.cost_price), 0) AS stock_value,
                       COALESCE(SUM(v.stock_quantity * v.selling_price), 0) AS retail_value
                  FROM boutique_products p LEFT JOIN boutique_variants v ON v.product_id = p.id AND v.status = 'active'
                 WHERE p.status = 'active'`),
    // Today's sales: the till's, plus what today's shelf counts found sold.
    pool.query(`SELECT (SELECT COUNT(*) FROM boutique_sales WHERE status <> 'voided' AND sold_on = $1)::int AS count,
                       (SELECT COALESCE(SUM(total), 0) FROM boutique_sales WHERE status <> 'voided' AND sold_on = $1)
                     + (SELECT COALESCE(SUM(l.revenue), 0) FROM boutique_shelf_counts c JOIN boutique_shelf_count_lines l ON l.count_id = c.id
                         WHERE c.status = 'recorded' AND c.counted_on = $1) AS total`, [today]),
    pool.query(`SELECT COUNT(*)::int AS open FROM boutique_cash_sessions WHERE status = 'open'`),
    pool.query(`SELECT (SELECT COUNT(*) FROM boutique_stock_adjustments WHERE status = 'pending')::int AS adjustments,
                       (SELECT COUNT(*) FROM boutique_sales WHERE status = 'void_requested')::int AS voids,
                       (SELECT COUNT(*) FROM boutique_submissions WHERE status = 'submitted')::int AS submissions`),
    pool.query(`SELECT COALESCE(SUM(owed), 0) AS total FROM (${SUPPLIER_BALANCE_SQL}) b WHERE owed > 0`),
    pool.query(`SELECT COUNT(*)::int AS count FROM boutique_variants WHERE status = 'active' AND stock_quantity <= reorder_level`)
  ]);
  const mySession = canSell(req.boutique) ? await openSessionOf(pool, req.user.id) : null;
  // A cashier's overview is the shelf and their own till: the shelf's worth
  // at cost, the supplier balance and the Director's queue are not theirs.
  const cashier = req.boutique === 'cashier';
  // Profit and loss for today and for the month so far, on the first screen,
  // so the Director reads it as the shop works (the screen re-reads this every
  // half minute) instead of waiting for a report. The same financeFigures the
  // Books and Reports read, so the three can never disagree. Not a cashier's.
  let profit = null;
  if (!cashier) {
    const [day, month] = await Promise.all([
      financeFigures(pool, { start: today, end: today }),
      financeFigures(pool, { start: `${today.slice(0, 8)}01`, end: today })
    ]);
    const lines = (f) => ({ sales: f.netSales, cost: f.costOfSales, grossProfit: f.grossProfit, expenses: f.expenses.total, net: f.netProfit });
    profit = { today: lines(day), month: lines(month) };
  }
  send(res, {
    role: req.boutique,
    operation: RETAIL_OPERATION,
    today,
    products: catalogue.rows[0].products,
    variants: catalogue.rows[0].variants,
    pieces: catalogue.rows[0].pieces,
    stockValue: cashier ? null : money(catalogue.rows[0].stock_value),
    retailValue: money(catalogue.rows[0].retail_value),
    lowStock: lowStock.rows[0].count,
    todaySales: { count: todaySales.rows[0].count, total: money(todaySales.rows[0].total) },
    openSessions: sessions.rows[0].open,
    mySessionId: mySession,
    pendingApprovals: cashier ? 0 : approvals.rows[0].adjustments + approvals.rows[0].voids + approvals.rows[0].submissions,
    pendingAdjustments: cashier ? 0 : approvals.rows[0].adjustments,
    pendingVoids: cashier ? 0 : approvals.rows[0].voids,
    pendingSubmissions: cashier ? 0 : approvals.rows[0].submissions,
    supplierBalance: cashier ? null : money(owed.rows[0].total),
    profit
  });
}));

// =====================================================================================
// 1. Products and variants
// =====================================================================================

const PRODUCT_SQL = `
  SELECT p.*, COALESCE((
    SELECT json_agg(v ORDER BY v.size, v.color, v.id) FROM boutique_variants v WHERE v.product_id = p.id
  ), '[]'::json) AS variants
  FROM boutique_products p`;

router.get('/products', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  const status = req.query.status || 'active';
  if (status !== 'all') { values.push(status); filters.push(`p.status = $${values.length}`); }
  if (req.query.type && PRODUCT_TYPES.includes(req.query.type)) { values.push(req.query.type); filters.push(`p.product_type = $${values.length}`); }
  if (req.query.search) {
    values.push(`%${String(req.query.search).trim()}%`);
    filters.push(`(p.name ILIKE $${values.length} OR p.brand ILIKE $${values.length} OR p.category ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM boutique_variants v WHERE v.product_id = p.id AND (v.sku ILIKE $${values.length} OR v.barcode ILIKE $${values.length})))`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${PRODUCT_SQL} ${where} ORDER BY p.name, p.id LIMIT 500`, values);
  send(res, result.rows.map(mapProduct).map((p) => productForRole(p, req.boutique === 'cashier')));
}));

// A product as a cashier may see it: its variants without their cost.
function productForRole(product, cashier) {
  return cashier ? { ...product, variants: product.variants.map((v) => forRole(v, true)) } : product;
}

async function loadProduct(db, productId) {
  const result = await db.query(`${PRODUCT_SQL} WHERE p.id = $1`, [productId]);
  if (!result.rowCount) throw new BoutiqueError(404, 'Product not found.');
  return result.rows[0];
}

router.get('/products/:id', asyncRoute(async (req, res) => {
  send(res, productForRole(mapProduct(await loadProduct(pool, parseRecordId(req.params.id, 'Product'))), req.boutique === 'cashier'));
}));

function readProduct(body, current = null) {
  const pick = (field, fallback) => (body[field] === undefined ? fallback : body[field]);
  return {
    name: text(pick('name', current?.name), 200, { required: true, label: 'Product name' }),
    // Any saved value stays valid (an old 'clothing' product can still be
    // edited); a new product with no category is 'other'.
    productType: oneOf(pick('productType', current?.product_type || 'other'), PRODUCT_TYPES, 'Category'),
    // What the quantity is counted in -- kg, bottles, pieces, litres -- so
    // "20" on a screen always says 20 of what.
    unit: text(pick('unit', current?.unit), 30),
    category: text(pick('category', current?.category), 100),
    brand: text(pick('brand', current?.brand), 100),
    description: text(pick('description', current?.description), 2000),
    status: oneOf(pick('status', current?.status || 'active'), ['active', 'archived'], 'Status')
  };
}

function readVariant(body, current = null) {
  const pick = (field, fallback) => (body[field] === undefined ? fallback : body[field]);
  // A product code is optional: a corner shop rarely has one, and asking for
  // it was the first thing that stopped somebody adding "Sugar 1kg". Left
  // blank, insertVariant gives the item its own (ITEM-00012). On an edit the
  // existing code is kept unless a new one is typed.
  const sku = text(pick('sku', current?.sku), 60) || current?.sku || '';
  const barcode = text(pick('barcode', current?.barcode || ''), 60);
  const costPrice = amount(pick('costPrice', current?.cost_price ?? 0), { label: 'Purchase cost' });
  const sellingPrice = amount(pick('sellingPrice', current?.selling_price ?? 0), { label: 'Selling price' });
  return {
    sku, barcode: barcode || null,
    size: text(pick('size', current?.size), 40),
    color: text(pick('color', current?.color), 40),
    costPrice, sellingPrice,
    reorderLevel: wholeNumber(pick('reorderLevel', current?.reorder_level ?? 0), { label: 'Reorder level', minimum: 0 }),
    status: oneOf(pick('status', current?.status || 'active'), ['active', 'archived'], 'Status')
  };
}

async function insertVariant(client, productId, body, actor) {
  const variant = readVariant(body);
  const opening = body.openingStock === undefined || body.openingStock === '' ? 0 : wholeNumber(body.openingStock, { label: 'Opening stock', minimum: 0 });
  const inserted = await client.query(
    `INSERT INTO boutique_variants (product_id, sku, barcode, size, color, cost_price, selling_price, reorder_level, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [productId, variant.sku || `TMP-${randomUUID()}`, variant.barcode, variant.size, variant.color, variant.costPrice, variant.sellingPrice, variant.reorderLevel, variant.status]
  );
  const row = inserted.rows[0];
  // No code typed: the item is named after its own id, which nothing else
  // can hold, so two products added at once can never collide.
  if (!variant.sku) {
    row.sku = `ITEM-${String(row.id).padStart(5, '0')}`;
    await client.query('UPDATE boutique_variants SET sku = $2 WHERE id = $1', [row.id, row.sku]);
    variant.sku = row.sku;
  }
  if (opening > 0) {
    await moveStock(client, { variantId: row.id, quantity: opening, kind: 'opening', referenceType: 'variant', referenceId: row.id, note: 'Opening stock', actor });
    row.stock_quantity = opening;
  }
  await audit(client, { entityType: 'variant', entityId: row.id, action: 'Variant created', details: { productId, sku: variant.sku, openingStock: opening, costPrice: variant.costPrice, sellingPrice: variant.sellingPrice }, actor });
  return row;
}

router.post('/products', asyncRoute(async (req, res) => {
  requireManage(req);
  const body = req.body || {};
  const product = readProduct(body);
  const variants = Array.isArray(body.variants) ? body.variants : [];
  if (!variants.length) throw new BoutiqueError(400, 'A product needs a price per unit. Please fill it in and try again.');
  const requestKey = requestKeyOf(body);
  // The same press arriving twice is answered with the product it made.
  if (requestKey) {
    const earlier = await pool.query('SELECT id FROM boutique_products WHERE request_key = $1', [requestKey]);
    if (earlier.rowCount) return send(res, mapProduct(await loadProduct(pool, earlier.rows[0].id)), 200);
  }
  // A second "Sugar" next to the first splits one shelf's stock and sales
  // across two records nobody can tell apart. It is refused rather than
  // merged: merging would move stock and history between products on a guess.
  const twin = await pool.query("SELECT id, name FROM boutique_products WHERE lower(name) = lower($1) AND status = 'active' LIMIT 1", [product.name]);
  if (twin.rowCount) {
    throw new BoutiqueError(409, `A product called "${twin.rows[0].name}" is already in the shop. To add more of it, use Update stock on that product, or give this one a different name.`, 'PRODUCT_EXISTS');
  }
  const created = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO boutique_products (name, product_type, category, brand, description, status, created_by, request_key, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [product.name, product.productType, product.category, product.brand, product.description, product.status, req.user.id, requestKey, product.unit]
    );
    const productId = inserted.rows[0].id;
    await audit(client, { entityType: 'product', entityId: productId, action: 'Product created', details: { name: product.name, type: product.productType }, actor: req.user });
    for (const variant of variants) await insertVariant(client, productId, variant, req.user);
    return loadProduct(client, productId);
  });
  send(res, mapProduct(created), 201);
}));

router.put('/products/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const productId = parseRecordId(req.params.id, 'Product');
  const updated = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_products WHERE id = $1 FOR UPDATE', [productId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Product not found.');
    const product = readProduct(req.body || {}, current.rows[0]);
    await client.query(
      `UPDATE boutique_products SET name = $2, product_type = $3, category = $4, brand = $5, description = $6, status = $7, unit = $8, updated_at = NOW() WHERE id = $1`,
      [productId, product.name, product.productType, product.category, product.brand, product.description, product.status, product.unit]
    );
    await audit(client, { entityType: 'product', entityId: productId, action: 'Product updated', details: { before: { name: current.rows[0].name, status: current.rows[0].status }, after: { name: product.name, status: product.status } }, actor: req.user });
    return loadProduct(client, productId);
  });
  send(res, mapProduct(updated));
}));

router.post('/products/:id/variants', asyncRoute(async (req, res) => {
  requireManage(req);
  const productId = parseRecordId(req.params.id, 'Product');
  const updated = await transaction(async (client) => {
    const exists = await client.query('SELECT id FROM boutique_products WHERE id = $1', [productId]);
    if (!exists.rowCount) throw new BoutiqueError(404, 'Product not found.');
    await insertVariant(client, productId, req.body || {}, req.user);
    return loadProduct(client, productId);
  });
  send(res, mapProduct(updated), 201);
}));

router.put('/variants/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const variantId = parseRecordId(req.params.id, 'Variant');
  const updated = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_variants WHERE id = $1 FOR UPDATE', [variantId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Variant not found.');
    const before = current.rows[0];
    const variant = readVariant(req.body || {}, before);
    await client.query(
      `UPDATE boutique_variants SET sku = $2, barcode = $3, size = $4, color = $5, cost_price = $6, selling_price = $7, reorder_level = $8, status = $9, updated_at = NOW()
       WHERE id = $1`,
      [variantId, variant.sku, variant.barcode, variant.size, variant.color, variant.costPrice, variant.sellingPrice, variant.reorderLevel, variant.status]
    );
    await audit(client, { entityType: 'variant', entityId: variantId, action: 'Variant updated', details: {
      before: { sku: before.sku, costPrice: money(before.cost_price), sellingPrice: money(before.selling_price), status: before.status },
      after: { sku: variant.sku, costPrice: variant.costPrice, sellingPrice: variant.sellingPrice, status: variant.status }
    }, actor: req.user });
    return loadProduct(client, before.product_id);
  });
  send(res, mapProduct(updated));
}));

// The product picture. Authorised before multer reads the body, like evidence.
router.post('/products/:id/image', (req, res, next) => {
  if (!canManage(req.boutique)) return res.status(403).json({ message: 'Only the Boutique Manager or the Director can change a product picture.' });
  next();
}, upload.single('file'), asyncRoute(async (req, res) => {
  const productId = parseRecordId(req.params.id, 'Product');
  if (!req.file) throw new BoutiqueError(400, 'Choose a picture to upload.');
  const current = await pool.query('SELECT image_stored_name FROM boutique_products WHERE id = $1', [productId]);
  if (!current.rowCount) throw new BoutiqueError(404, 'Product not found.');
  const storedName = storedFileName(req.file.originalname);
  await saveFile(BOUTIQUE_FOLDER, storedName, req.file.buffer);
  await pool.query(
    'UPDATE boutique_products SET image_stored_name = $2, image_mime = $3, image_original_name = $4, updated_at = NOW() WHERE id = $1',
    [productId, storedName, req.file.mimetype, req.file.originalname.slice(0, 255)]
  );
  await audit(pool, { entityType: 'product', entityId: productId, action: 'Picture changed', details: { file: req.file.originalname }, actor: req.user });
  if (current.rows[0].image_stored_name) await deleteFile(BOUTIQUE_FOLDER, current.rows[0].image_stored_name);
  send(res, mapProduct(await loadProduct(pool, productId)));
}));

// Read by the browser with the session header (fetch -> blob), never from a
// plain <img src>, so no token ever sits in a URL.
router.get('/products/:id/image', asyncRoute(async (req, res) => {
  const productId = parseRecordId(req.params.id, 'Product');
  const result = await pool.query('SELECT image_stored_name, image_mime, image_original_name FROM boutique_products WHERE id = $1', [productId]);
  if (!result.rowCount || !result.rows[0].image_stored_name) return res.status(404).json({ message: 'No picture for this product.' });
  const row = result.rows[0];
  const file = await readFile(BOUTIQUE_FOLDER, row.image_stored_name);
  if (!file) return res.status(404).json({ message: 'The stored picture is missing from the server.' });
  res.type(row.image_mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  if (Buffer.isBuffer(file)) return res.send(file);
  file.once('error', () => (res.headersSent ? res.destroy() : res.status(500).json({ message: 'The stored picture could not be read.' })));
  return file.pipe(res);
}));

router.delete('/products/:id/image', asyncRoute(async (req, res) => {
  requireManage(req);
  const productId = parseRecordId(req.params.id, 'Product');
  const result = await pool.query(
    'UPDATE boutique_products SET image_stored_name = NULL, image_mime = NULL, image_original_name = NULL, updated_at = NOW() WHERE id = $1 RETURNING (SELECT image_stored_name FROM boutique_products WHERE id = $1) AS old_name',
    [productId]
  );
  if (!result.rowCount) throw new BoutiqueError(404, 'Product not found.');
  if (result.rows[0].old_name) await deleteFile(BOUTIQUE_FOLDER, result.rows[0].old_name);
  await audit(pool, { entityType: 'product', entityId: productId, action: 'Picture removed', actor: req.user });
  send(res, mapProduct(await loadProduct(pool, productId)));
}));

// =====================================================================================
// 2. The till
// =====================================================================================

router.get('/payment-methods', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT code, active FROM boutique_payment_methods ORDER BY sort_order');
  send(res, result.rows.map((row) => ({ code: row.code, active: row.active })));
}));

router.put('/payment-methods', asyncRoute(async (req, res) => {
  requireDecide(req);
  const methods = Array.isArray(req.body?.methods) ? req.body.methods : [];
  await transaction(async (client) => {
    for (const method of methods) {
      if (!BOUTIQUE_PAYMENT_METHODS.includes(method.code)) continue;
      await client.query('UPDATE boutique_payment_methods SET active = $2 WHERE code = $1', [method.code, Boolean(method.active)]);
    }
    const active = await activeMethods(client);
    if (!active.length) throw new BoutiqueError(400, 'At least one payment method must stay on.');
    await audit(client, { entityType: 'settings', action: 'Payment methods changed', details: { active }, actor: req.user });
  });
  const result = await pool.query('SELECT code, active FROM boutique_payment_methods ORDER BY sort_order');
  send(res, result.rows.map((row) => ({ code: row.code, active: row.active })));
}));

// What the cashier types into the search box: a name, a brand, a SKU or a
// barcode. In-stock, active variants only -- the till cannot sell what is
// not on the shelf -- newest match first on an exact barcode.
router.get('/pos/search', asyncRoute(async (req, res) => {
  requireSell(req);
  const q = String(req.query.q || '').trim();
  if (!q) return send(res, []);
  const result = await pool.query(
    `SELECT v.*, p.name AS product_name, p.product_type, p.unit AS product_unit, p.brand, p.image_stored_name
       FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id
      WHERE v.status = 'active' AND p.status = 'active'
        AND (v.barcode = $1 OR v.sku ILIKE $2 OR p.name ILIKE $2 OR p.brand ILIKE $2)
      ORDER BY (v.barcode = $1) DESC, p.name, v.size, v.color LIMIT 40`,
    [q, `%${q}%`]
  );
  send(res, result.rows.map(mapVariant).map((v) => forRole(v, req.boutique === 'cashier')));
}));

const SALE_SQL = `
  SELECT s.*, u.name AS cashier_name,
         (SELECT COUNT(*) FROM boutique_sale_items i WHERE i.sale_id = s.id)::int AS item_count
    FROM boutique_sales s LEFT JOIN users u ON u.id = s.cashier_id`;

async function loadSale(db, saleId) {
  const result = await db.query(`${SALE_SQL} WHERE s.id = $1`, [saleId]);
  if (!result.rowCount) throw new BoutiqueError(404, 'Sale not found.');
  const sale = result.rows[0];
  // One after the other: `db` may be a transaction client, which runs one
  // query at a time.
  const items = await db.query(
    `SELECT i.*, COALESCE((SELECT SUM(ri.quantity) FROM boutique_return_items ri WHERE ri.sale_item_id = i.id), 0)::int AS returned_quantity
       FROM boutique_sale_items i WHERE i.sale_id = $1 ORDER BY i.id`, [saleId]);
  const payments = await db.query('SELECT * FROM boutique_sale_payments WHERE sale_id = $1 ORDER BY id', [saleId]);
  const returns = await db.query(
    `SELECT r.*, u.name AS cashier_name, x.number AS exchange_sale_number
       FROM boutique_returns r LEFT JOIN users u ON u.id = r.cashier_id LEFT JOIN boutique_sales x ON x.id = r.exchange_sale_id
      WHERE r.sale_id = $1 ORDER BY r.id`, [saleId]);
  return { ...sale, items: items.rows, payments: payments.rows, returns: returns.rows };
}

// Ringing up a sale, in three steps shared by the till and by the new sale of
// an exchange: price the lines, read the payments, write the rows.
// Everything the brief asks of the till is decided here: each line is checked
// against the shelf under a lock, prices come from the catalogue unless a
// manager overrides them, discounts are capped at the line, the payments
// must cover the total, and change can only come out of cash.

async function priceLines(client, body, role) {
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new BoutiqueError(400, 'A sale needs at least one item.');
  if (lines.length > 100) throw new BoutiqueError(400, 'A sale cannot have more than 100 lines.');
  const items = [];
  for (const line of lines) {
    const variantId = parseId(line.variantId);
    if (!variantId) throw new BoutiqueError(400, 'Each line must name a product variant.');
    const quantity = wholeNumber(line.quantity, { label: 'Quantity' });
    const found = await client.query(
      `SELECT v.*, p.name AS product_name, p.status AS product_status FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id WHERE v.id = $1`,
      [variantId]
    );
    if (!found.rowCount) throw new BoutiqueError(404, 'Product variant not found.');
    const variant = found.rows[0];
    if (variant.status !== 'active' || variant.product_status !== 'active') throw new BoutiqueError(409, `${variant.product_name} (${variant.sku}) is no longer on sale.`);
    // A cashier sells at the catalogue price. A manager (or the Director) may
    // override it, which the audit trail records line by line.
    const catalogue = money(variant.selling_price);
    let unitPrice = catalogue;
    if (line.unitPrice !== undefined && line.unitPrice !== '' && line.unitPrice !== null) {
      const asked = amount(line.unitPrice, { label: 'Unit price' });
      if (toMinor(asked) !== toMinor(catalogue)) {
        if (!canManage(role)) throw new BoutiqueError(403, 'Only the Boutique Manager can change a price at the till.');
        unitPrice = asked;
      }
    }
    const discount = line.discount === undefined || line.discount === '' ? 0 : amount(line.discount, { label: 'Line discount' });
    // A discount is a price change by another name: a cashier who cannot
    // override the price cannot take money off either (audit finding H1).
    if (discount > 0 && !canManage(role)) throw new BoutiqueError(403, 'Only the Boutique Manager can give a discount at the till.');
    const totals = lineTotals({ quantity, unitPrice, discount });
    items.push({
      variantId, quantity, unitPrice, unitCost: money(variant.cost_price), discount: fromMinor(totals.discount), lineTotal: fromMinor(totals.total),
      productName: variant.product_name, sku: variant.sku, size: variant.size || '', color: variant.color || '', cataloguePrice: catalogue
    });
  }
  const saleDiscount = body.discount === undefined || body.discount === '' ? 0 : amount(body.discount, { label: 'Discount' });
  if (saleDiscount > 0 && !canManage(role)) throw new BoutiqueError(403, 'Only the Boutique Manager can give a discount at the till.');
  // Locked in a fixed order wherever two sales meet on the same shelf, so
  // two carts holding the same variants in different orders cannot deadlock
  // (audit finding M5).
  items.sort((a, b) => a.variantId - b.variantId);
  return { items, totals: saleTotals(items, saleDiscount) };
}

async function readPayments(client, body) {
  const activeCodes = await activeMethods(client);
  const typed = Array.isArray(body.payments) ? body.payments : [];
  const payments = [];
  for (const payment of typed) {
    const method = oneOf(payment.method, BOUTIQUE_PAYMENT_METHODS, 'Payment method');
    if (!activeCodes.includes(method)) throw new BoutiqueError(400, `${method} is not accepted at this till.`);
    const paid = amount(payment.amount, { label: 'Payment amount', minimum: 0 });
    if (toMinor(paid) <= 0) continue;
    payments.push({ method, amount: paid, reference: text(payment.reference, 100) });
  }
  return payments;
}

async function writeSale(client, { body, items, totals, payments, actor, sessionId, exchangeOfReturnId = null }) {
  const paid = payments.reduce((sum, payment) => sum + toMinor(payment.amount), 0);
  if (paid < totals.total) {
    throw new BoutiqueError(400, `The payments (RWF ${fromMinor(paid)}) do not cover the total of RWF ${fromMinor(totals.total)}.`, 'UNDERPAID');
  }
  const change = paid - totals.total;
  const cashPaid = payments.filter((p) => p.method === 'Cash').reduce((sum, p) => sum + toMinor(p.amount), 0);
  if (change > 0 && change > cashPaid) {
    throw new BoutiqueError(400, 'Change can only be given out of cash: the other methods must not exceed the total.', 'OVERPAID');
  }
  // Cash that goes into no till belongs to no reconciliation and to nobody
  // (audit finding H2): cash is only taken on an open till. Mobile money,
  // card and bank are reconciled against their statements and may be taken
  // without one.
  if (cashPaid > 0 && !sessionId) {
    throw new BoutiqueError(409, 'Open a till before taking cash.', 'NO_OPEN_TILL');
  }
  const number = (await client.query(`SELECT 'S-' || lpad(nextval('boutique_sale_number')::text, 6, '0') AS number`)).rows[0].number;
  const inserted = await client.query(
    `INSERT INTO boutique_sales (number, cashier_id, session_id, customer_name, status, subtotal, discount, total, paid, change_given, note, exchange_of_return_id, sold_on)
     VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [number, actor.id, sessionId, text(body.customerName, 150), fromMinor(totals.subtotal), fromMinor(totals.discount), fromMinor(totals.total),
      fromMinor(paid), fromMinor(change), text(body.note, 1000), exchangeOfReturnId, todayInShop()]
  );
  const saleId = inserted.rows[0].id;
  for (const item of items) {
    // The shelf is locked and taken from BEFORE the line is written. The line
    // references the variant, and that foreign key takes a share lock on the
    // variant row; two sales that each wrote their line first and then asked
    // for the exclusive lock in moveStock deadlocked on each other, and one
    // of them answered 500 (audit finding M5).
    const moved = await moveStock(client, { variantId: item.variantId, quantity: -item.quantity, kind: 'sale', referenceType: 'sale', referenceId: saleId, note: number, actor });
    await client.query(
      `INSERT INTO boutique_sale_items (sale_id, variant_id, product_name, sku, size, color, quantity, unit_price, unit_cost, discount, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [saleId, item.variantId, item.productName, item.sku, item.size, item.color, item.quantity, item.unitPrice, item.unitCost, item.discount, item.lineTotal]
    );
    // The shelf just ran low: the Director and the Boutique Manager are told
    // directly, in the same transaction as the sale that did it.
    if (moved.ranLow) {
      await notifyMany(client, await lowStockRecipients(client), {
        kind: 'boutique_low_stock',
        params: { title: `${item.productName} (${item.sku}${item.size || item.color ? ` ${[item.size, item.color].filter(Boolean).join('/')}` : ''})`, count: moved.after },
        link: '#/boutique/stock',
        actor
      });
    }
  }
  for (const payment of payments) {
    await client.query('INSERT INTO boutique_sale_payments (sale_id, method, amount, reference) VALUES ($1, $2, $3, $4)',
      [saleId, payment.method, payment.amount, payment.reference || '']);
  }
  await audit(client, { entityType: 'sale', entityId: saleId, action: 'Sale completed', details: {
    number, total: fromMinor(totals.total), paid: fromMinor(paid), change: fromMinor(change), lines: items.length,
    exchangeOfReturnId,
    priceOverrides: items.filter((item) => toMinor(item.unitPrice) !== toMinor(item.cataloguePrice)).map((item) => ({ sku: item.sku, catalogue: item.cataloguePrice, charged: item.unitPrice }))
  }, actor });
  return saleId;
}

router.post('/sales', asyncRoute(async (req, res) => {
  requireSell(req);
  const sale = await transaction(async (client) => {
    const sessionId = await openSessionOf(client, req.user.id);
    const body = req.body || {};
    const { items, totals } = await priceLines(client, body, req.boutique);
    const payments = await readPayments(client, body);
    const saleId = await writeSale(client, { body, items, totals, payments, actor: req.user, sessionId });
    return loadSale(client, saleId);
  });
  send(res, mapSale(sale), 201);
}));

router.get('/sales', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`s.sold_on >= $${values.length}`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`s.sold_on <= $${values.length}`); }
  if (req.query.status && SALE_STATUSES.includes(req.query.status)) { values.push(req.query.status); filters.push(`s.status = $${values.length}`); }
  if (req.query.cashierId) { values.push(parseRecordId(req.query.cashierId, 'Cashier')); filters.push(`s.cashier_id = $${values.length}`); }
  if (req.query.search) { values.push(`%${String(req.query.search).trim()}%`); filters.push(`(s.number ILIKE $${values.length} OR s.customer_name ILIKE $${values.length})`); }
  // A cashier reads their own sales; the manager, the Director and the
  // General Manager read the shop's.
  if (req.boutique === 'cashier') { values.push(req.user.id); filters.push(`s.cashier_id = $${values.length}`); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${SALE_SQL} ${where} ORDER BY s.sold_at DESC, s.id DESC LIMIT ${limit}`, values);
  send(res, result.rows.map(mapSale));
}));

router.get('/sales/:id', asyncRoute(async (req, res) => {
  const sale = await loadSale(pool, parseRecordId(req.params.id, 'Sale'));
  if (req.boutique === 'cashier' && sale.cashier_id !== req.user.id) throw new BoutiqueError(404, 'Sale not found.');
  send(res, mapSale(sale));
}));

// Undoing a completed sale puts the goods back and takes the money out of the
// books. The Director does it at once; the manager asks, and the Director
// answers through /void-decision. A sale with returns against it cannot be
// voided -- the returns already undid part of it, and the rest is a fresh
// return.
async function applyVoid(client, sale, actor, reason) {
  const items = await client.query('SELECT variant_id, quantity FROM boutique_sale_items WHERE sale_id = $1', [sale.id]);
  for (const item of items.rows) {
    await moveStock(client, { variantId: item.variant_id, quantity: item.quantity, kind: 'void', referenceType: 'sale', referenceId: sale.id, note: `${sale.number} voided`, actor });
  }
  const updated = await client.query(
    `UPDATE boutique_sales SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW() WHERE id = $1 AND status IN ('completed', 'void_requested')`,
    [sale.id, reason, actor.id]
  );
  if (!updated.rowCount) throw new BoutiqueError(409, 'This sale has already changed.');
}

router.post('/sales/:id/void', asyncRoute(async (req, res) => {
  requireManage(req);
  const saleId = parseRecordId(req.params.id, 'Sale');
  const reason = text(req.body?.reason, 1000, { required: true, label: 'The reason' });
  if (reason.length < 10) throw new BoutiqueError(400, 'Say why the sale is being voided, in at least 10 characters.');
  const sale = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Sale not found.');
    const row = current.rows[0];
    if (row.status !== 'completed') throw new BoutiqueError(409, 'Only a completed sale can be voided.');
    const returned = await client.query('SELECT 1 FROM boutique_returns WHERE sale_id = $1 LIMIT 1', [saleId]);
    if (returned.rowCount) throw new BoutiqueError(409, 'This sale has returns against it and cannot be voided; return the remaining items instead.');
    // The new sale of an exchange was paid with the value of the goods the
    // customer brought back. Voiding it would put the new goods back on the
    // shelf and leave the credit the customer used owed to nobody (audit
    // finding M3); it is undone by a return like any other sale.
    if (row.exchange_of_return_id) throw new BoutiqueError(409, 'This sale is the new half of an exchange and cannot be voided; return its items instead.');
    if (req.boutique === 'director') {
      await applyVoid(client, row, req.user, reason);
      await audit(client, { entityType: 'sale', entityId: saleId, action: 'Sale voided', details: { number: row.number, reason, total: money(row.total) }, actor: req.user });
    } else {
      await client.query(`UPDATE boutique_sales SET status = 'void_requested', void_reason = $2, void_requested_by = $3 WHERE id = $1`, [saleId, reason, req.user.id]);
      await audit(client, { entityType: 'sale', entityId: saleId, action: 'Void requested', details: { number: row.number, reason, total: money(row.total) }, actor: req.user });
      await notifyDirectors(client, { kind: 'boutique_approval_requested', params: { title: `Void ${row.number}`, reason }, link: '#/boutique/approvals', actor: req.user });
    }
    return loadSale(client, saleId);
  });
  send(res, mapSale(sale));
}));

router.post('/sales/:id/void-decision', asyncRoute(async (req, res) => {
  requireDecide(req);
  const saleId = parseRecordId(req.params.id, 'Sale');
  const approve = Boolean(req.body?.approve);
  const note = text(req.body?.note, 1000);
  if (!approve && note.length < 10) throw new BoutiqueError(400, 'Say why the void is refused, in at least 10 characters.');
  const sale = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Sale not found.');
    const row = current.rows[0];
    if (row.status !== 'void_requested') throw new BoutiqueError(409, 'No void is waiting on this sale.');
    if (approve) {
      await applyVoid(client, row, req.user, row.void_reason);
    } else {
      await client.query(`UPDATE boutique_sales SET status = 'completed', void_requested_by = NULL WHERE id = $1`, [saleId]);
    }
    await audit(client, { entityType: 'sale', entityId: saleId, action: approve ? 'Void approved' : 'Void refused', details: { number: row.number, note }, actor: req.user });
    await notify(client, { userId: row.void_requested_by, kind: 'boutique_approval_decided', params: { title: `Void ${row.number}`, outcome: approve ? 'approved' : 'refused', reason: note }, link: `#/boutique/sales?sale=${saleId}`, actor: req.user });
    return loadSale(client, saleId);
  });
  send(res, mapSale(sale));
}));

// A return, or an exchange (a return whose value is applied to a new sale).
//
//   body.items          [{ saleItemId, quantity, restock }]
//   body.reason         why
//   body.refundMethod   how any money handed back was handed back
//   body.exchange       { items, payments, discount, customerName, note } --
//                       the new sale. The returned value pays for it first,
//                       as a line of 'Exchange credit'; its own payments need
//                       only cover what is left, and anything of the returned
//                       value the new sale does not use is refunded as money.
router.post('/sales/:id/returns', asyncRoute(async (req, res) => {
  requireSell(req);
  const saleId = parseRecordId(req.params.id, 'Sale');
  const body = req.body || {};
  const reason = text(body.reason, 1000, { required: true, label: 'The reason' });
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new BoutiqueError(400, 'Choose at least one item to return.');
  const result = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Sale not found.');
    const sale = current.rows[0];
    // A cashier takes returns on the sales they made (the ones they can
    // read); the manager and the Director on any. Answered as "not found",
    // like the read, so a cashier cannot probe other sales' ids (audit M2).
    if (req.boutique === 'cashier' && sale.cashier_id !== req.user.id) throw new BoutiqueError(404, 'Sale not found.');
    if (sale.status !== 'completed') throw new BoutiqueError(409, 'Items can only be returned against a completed sale.');
    const sold = await client.query(
      `SELECT i.*, COALESCE((SELECT SUM(ri.quantity) FROM boutique_return_items ri WHERE ri.sale_item_id = i.id), 0)::int AS returned
         FROM boutique_sale_items i WHERE i.sale_id = $1`, [saleId]);
    const bySaleItem = new Map(sold.rows.map((row) => [row.id, row]));
    // The sale-level discount is spread over the lines in proportion to what
    // each line came to, so a refund is what the customer actually paid for
    // the piece and never the price before the discount (audit finding H4).
    const subtotal = toMinor(sale.subtotal);
    const saleDiscount = toMinor(sale.discount);
    const paidForLine = (saleItem) => {
      const lineTotal = toMinor(saleItem.line_total);
      const share = subtotal > 0 ? Math.round(lineTotal * saleDiscount / subtotal) : 0;
      return lineTotal - share;
    };

    const items = [];
    for (const line of lines) {
      const saleItem = bySaleItem.get(parseId(line.saleItemId));
      if (!saleItem) throw new BoutiqueError(400, 'One of the items is not on this sale.');
      const quantity = wholeNumber(line.quantity, { label: 'Quantity' });
      const remaining = saleItem.quantity - saleItem.returned;
      if (quantity > remaining) throw new BoutiqueError(409, `Only ${remaining} of ${saleItem.product_name} (${saleItem.sku}) can still be returned.`);
      const restock = line.restock !== false;
      // Keeping returned goods off the shelf is a write-off, which is the
      // manager's decision, not the till's (audit finding M2).
      if (!restock && !canManage(req.boutique)) throw new BoutiqueError(403, 'Only the Boutique Manager can keep a returned item off the shelf.');
      const unitPaid = fromMinor(Math.round(paidForLine(saleItem) / saleItem.quantity));
      items.push({ saleItem, quantity, unitPaid, restock });
    }
    const value = items.reduce((sum, item) => sum + toMinor(item.unitPaid) * item.quantity, 0);
    // Rounding per piece can never hand back more than the sale took: the
    // value of everything returned against this sale is capped at its total.
    const alreadyReturned = await client.query('SELECT COALESCE(SUM(value), 0) AS total FROM boutique_returns WHERE sale_id = $1', [saleId]);
    if (toMinor(alreadyReturned.rows[0].total) + value > toMinor(sale.total)) {
      throw new BoutiqueError(409, 'The returns against this sale would exceed what was paid for it.', 'OVER_RETURN');
    }
    const sessionId = await openSessionOf(client, req.user.id);
    const number = (await client.query(`SELECT 'R-' || lpad(nextval('boutique_return_number')::text, 6, '0') AS number`)).rows[0].number;
    const exchange = body.exchange && typeof body.exchange === 'object' ? body.exchange : null;

    // On an exchange the new sale is priced first, so the credit is exactly
    // what it needs and no more: the rest of the returned value is money
    // handed back, and the sale never shows "change" that is really a refund.
    let credit = 0;
    let priced = null;
    let payments = [];
    if (exchange) {
      priced = await priceLines(client, exchange, req.boutique);
      payments = await readPayments(client, exchange);
      credit = Math.min(value, priced.totals.total);
    }
    const refund = value - credit;
    const refundMethod = refund > 0 ? oneOf(body.refundMethod, BOUTIQUE_PAYMENT_METHODS, 'Refund method') : null;
    // Cash handed back comes out of a till, so there has to be one open
    // (audit finding H2), exactly as cash taken has to go into one.
    if (refundMethod === 'Cash' && !sessionId) throw new BoutiqueError(409, 'Open a till before refunding cash.', 'NO_OPEN_TILL');

    const inserted = await client.query(
      `INSERT INTO boutique_returns (number, sale_id, cashier_id, session_id, kind, value, refund_total, refund_method, reason, returned_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [number, saleId, req.user.id, sessionId, exchange ? 'exchange' : 'return', fromMinor(value), fromMinor(refund), refundMethod, reason, todayInShop()]
    );
    const returnId = inserted.rows[0].id;
    for (const item of items) {
      await client.query(
        `INSERT INTO boutique_return_items (return_id, sale_item_id, variant_id, quantity, unit_price, unit_cost, restock) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [returnId, item.saleItem.id, item.saleItem.variant_id, item.quantity, item.unitPaid, money(item.saleItem.unit_cost), item.restock]
      );
      if (item.restock) {
        await moveStock(client, { variantId: item.saleItem.variant_id, quantity: item.quantity, kind: 'sale_return', referenceType: 'return', referenceId: returnId, note: number, actor: req.user });
      }
    }

    let exchangeSaleId = null;
    if (exchange) {
      if (credit > 0) payments.push({ method: EXCHANGE_CREDIT, amount: fromMinor(credit), reference: number });
      exchangeSaleId = await writeSale(client, {
        body: exchange, items: priced.items, totals: priced.totals, payments, actor: req.user, sessionId, exchangeOfReturnId: returnId
      });
      await client.query('UPDATE boutique_returns SET exchange_sale_id = $2 WHERE id = $1', [returnId, exchangeSaleId]);
    }
    await audit(client, { entityType: 'return', entityId: returnId, action: exchange ? 'Exchange recorded' : 'Return recorded', details: {
      number, sale: sale.number, value: fromMinor(value), refunded: fromMinor(refund), refundMethod, credit: fromMinor(credit), reason, items: items.length
    }, actor: req.user });
    return { returnId, saleId, exchangeSaleId };
  });
  const [sale, exchangeSale] = await Promise.all([loadSale(pool, result.saleId), result.exchangeSaleId ? loadSale(pool, result.exchangeSaleId) : null]);
  send(res, { sale: mapSale(sale), exchangeSale: exchangeSale ? mapSale(exchangeSale) : null, returnId: result.returnId }, 201);
}));

// =====================================================================================
// 3. Stock
// =====================================================================================

const STOCK_SQL = `
  SELECT v.*, p.name AS product_name, p.product_type, p.unit AS product_unit, p.brand, p.image_stored_name
    FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id`;

router.get('/stock', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [`v.status = 'active'`, `p.status = 'active'`];
  if (req.query.search) {
    values.push(`%${String(req.query.search).trim()}%`);
    filters.push(`(p.name ILIKE $${values.length} OR v.sku ILIKE $${values.length} OR v.barcode ILIKE $${values.length} OR p.brand ILIKE $${values.length})`);
  }
  if (req.query.low === '1') filters.push('v.stock_quantity <= v.reorder_level');
  if (req.query.type && PRODUCT_TYPES.includes(req.query.type)) { values.push(req.query.type); filters.push(`p.product_type = $${values.length}`); }
  const result = await pool.query(`${STOCK_SQL} WHERE ${filters.join(' AND ')} ORDER BY p.name, v.size, v.color LIMIT 1000`, values);
  const totals = await pool.query(`SELECT COALESCE(SUM(stock_quantity), 0)::int AS pieces, COALESCE(SUM(stock_quantity * cost_price), 0) AS value FROM boutique_variants WHERE status = 'active'`);
  // A cashier sees what is on the shelf and its price, not what it cost or
  // what the shelf is worth (audit finding M1).
  const cashier = req.boutique === 'cashier';
  send(res, { items: result.rows.map(mapVariant).map((v) => forRole(v, cashier)), pieces: totals.rows[0].pieces, value: cashier ? null : money(totals.rows[0].value) });
}));

router.get('/stock/movements', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  if (req.query.variantId) { values.push(parseRecordId(req.query.variantId, 'Variant')); filters.push(`m.variant_id = $${values.length}`); }
  if (req.query.kind) { values.push(req.query.kind); filters.push(`m.kind = $${values.length}`); }
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`${shopDay('m.created_at')} >= $${values.length}`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`${shopDay('m.created_at')} <= $${values.length}`); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT m.*, v.sku, v.size, v.color, p.name AS product_name, u.name AS recorded_by_name
       FROM boutique_stock_movements m JOIN boutique_variants v ON v.id = m.variant_id JOIN boutique_products p ON p.id = v.product_id
       LEFT JOIN users u ON u.id = m.recorded_by ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`, values);
  send(res, result.rows.map(mapMovement));
}));

const ADJUSTMENT_SQL = `
  SELECT a.*, v.sku, v.size, v.color, v.stock_quantity AS on_shelf, p.name AS product_name, p.unit AS product_unit,
         r.name AS requested_by_name, d.name AS decided_by_name
    FROM boutique_stock_adjustments a JOIN boutique_variants v ON v.id = a.variant_id JOIN boutique_products p ON p.id = v.product_id
    LEFT JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by`;

router.get('/stock/adjustments', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const values = [];
  const filters = [];
  if (req.query.status && ['pending', 'approved', 'rejected'].includes(req.query.status)) { values.push(req.query.status); filters.push(`a.status = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${ADJUSTMENT_SQL} ${where} ORDER BY a.created_at DESC LIMIT 300`, values);
  send(res, result.rows.map(mapAdjustment));
}));

// The signed change an adjustment means, from its kind and quantity, against
// the figure on the shelf at the moment it is worked out.
function adjustmentDelta(kind, quantity, onShelf) {
  if (kind === 'count') return quantity - onShelf;
  if (ADDING_ADJUSTMENTS.includes(kind)) return quantity;
  return -quantity;
}

async function applyAdjustment(client, row, actor) {
  const locked = await client.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1 FOR UPDATE', [row.variant_id]);
  const delta = adjustmentDelta(row.kind, row.quantity, locked.rows[0].stock_quantity);
  let movementId = null;
  if (delta !== 0) {
    const { movement } = await moveStock(client, { variantId: row.variant_id, quantity: delta, kind: row.kind, referenceType: 'adjustment', referenceId: row.id, note: row.reason, actor });
    movementId = movement.id;
  }
  await client.query(`UPDATE boutique_stock_adjustments SET status = 'approved', delta = $2, decided_by = $3, decided_at = NOW(), movement_id = $4 WHERE id = $1`,
    [row.id, delta, actor.id, movementId]);
  return delta;
}

router.post('/stock/adjustments', asyncRoute(async (req, res) => {
  requireManage(req);
  const body = req.body || {};
  const variantId = parseRecordId(body.variantId, 'Variant');
  const kind = oneOf(body.kind, ADJUSTMENT_KINDS, 'Adjustment kind');
  const quantity = wholeNumber(body.quantity, { label: 'Quantity', minimum: kind === 'count' ? 0 : 1 });
  // Stock that simply arrived explains itself; every change that takes goods
  // away or overwrites the count has to say why, because that is the line
  // somebody reads when the shelf and the books disagree.
  const reason = text(body.reason, 1000, { required: kind !== 'received', label: 'The reason' }) || 'New stock received';
  if (reason.length < 5) throw new BoutiqueError(400, 'Please say why, in at least 5 characters.');
  const requestKey = requestKeyOf(body);
  if (requestKey) {
    const earlier = await pool.query(`${ADJUSTMENT_SQL} WHERE a.request_key = $1`, [requestKey]);
    if (earlier.rowCount) return send(res, mapAdjustment(earlier.rows[0]), 200);
  }
  const adjustment = await transaction(async (client) => {
    const variant = await client.query('SELECT v.stock_quantity, v.sku, p.name AS product_name FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id WHERE v.id = $1', [variantId]);
    if (!variant.rowCount) throw new BoutiqueError(404, 'Variant not found.');
    const delta = adjustmentDelta(kind, quantity, variant.rows[0].stock_quantity);
    if (delta < 0 && variant.rows[0].stock_quantity + delta < 0) {
      throw new BoutiqueError(409, `Only ${variant.rows[0].stock_quantity} in stock, so ${quantity} cannot be taken out. Please check the number.`, 'INSUFFICIENT_STOCK');
    }
    const inserted = await client.query(
      `INSERT INTO boutique_stock_adjustments (variant_id, kind, quantity, delta, reason, status, requested_by, request_key) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING *`,
      [variantId, kind, quantity, delta, reason, req.user.id, requestKey]
    );
    const row = inserted.rows[0];
    if (req.boutique === 'director') {
      const applied = await applyAdjustment(client, row, req.user);
      await audit(client, { entityType: 'adjustment', entityId: row.id, action: 'Stock adjusted', details: { kind, sku: variant.rows[0].sku, quantity, delta: applied, reason }, actor: req.user });
    } else {
      await audit(client, { entityType: 'adjustment', entityId: row.id, action: 'Adjustment requested', details: { kind, sku: variant.rows[0].sku, quantity, delta, reason }, actor: req.user });
      await notifyDirectors(client, { kind: 'boutique_approval_requested', params: { title: `${kind.replace('_', ' ')}: ${variant.rows[0].product_name} (${variant.rows[0].sku})`, reason }, link: '#/boutique/approvals', actor: req.user });
    }
    return (await client.query(`${ADJUSTMENT_SQL} WHERE a.id = $1`, [row.id])).rows[0];
  });
  send(res, mapAdjustment(adjustment), 201);
}));

router.post('/stock/adjustments/:id/decision', asyncRoute(async (req, res) => {
  requireDecide(req);
  const adjustmentId = parseRecordId(req.params.id, 'Adjustment');
  const approve = Boolean(req.body?.approve);
  const note = text(req.body?.note, 1000);
  if (!approve && note.length < 10) throw new BoutiqueError(400, 'Say why the adjustment is refused, in at least 10 characters.');
  const adjustment = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_stock_adjustments WHERE id = $1 FOR UPDATE', [adjustmentId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Adjustment not found.');
    const row = current.rows[0];
    if (row.status !== 'pending') throw new BoutiqueError(409, 'This adjustment has already been decided.');
    let delta = row.delta;
    if (approve) {
      delta = await applyAdjustment(client, row, req.user);
      await client.query('UPDATE boutique_stock_adjustments SET decision_note = $2 WHERE id = $1', [adjustmentId, note]);
    } else {
      await client.query(`UPDATE boutique_stock_adjustments SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $1`, [adjustmentId, req.user.id, note]);
    }
    await audit(client, { entityType: 'adjustment', entityId: adjustmentId, action: approve ? 'Adjustment approved' : 'Adjustment refused', details: { kind: row.kind, quantity: row.quantity, delta, note }, actor: req.user });
    await notify(client, { userId: row.requested_by, kind: 'boutique_approval_decided', params: { title: `${row.kind.replace('_', ' ')} (${row.quantity})`, outcome: approve ? 'approved' : 'refused', reason: note }, link: '#/boutique/stock', actor: req.user });
    return (await client.query(`${ADJUSTMENT_SQL} WHERE a.id = $1`, [adjustmentId])).rows[0];
  });
  send(res, mapAdjustment(adjustment));
}));

// =====================================================================================
// 3b. Counting the shelf: what was sold, worked out from what is left
// =====================================================================================
//
// For a shop that sells over the counter without ringing each sale up. The
// manager (or the Director) counts what is left of each product; for each one
//
//     sold = what the shelf should hold now − what was counted
//
// where "what the shelf should hold" is the ledger's figure: the opening
// stock, plus every delivery recorded, minus damaged/missing/other
// adjustments, minus the till's own sales. So the formula in the brief --
// opening + received − closing, corrected for adjustments -- is exactly
// expected − counted, and nothing is counted twice: a piece sold at the till
// has already left the shelf before the count.
//
// Refused rather than guessed:
//  * counting MORE than the shelf should hold (COUNT_ABOVE_SHELF). That means
//    stock came in that nobody recorded; booking it as "−5 sold" would invent
//    a negative sale. The answer says to record the delivery first.
//  * a count on any day but today, so the pieces (ledger rows, written now)
//    and the money (counted_on) always fall on the same day of every report.
//
// The selling and buying prices are frozen on each line at the moment of the
// count, so changing a price afterwards rewrites nothing. Nothing is deleted:
// the Director voids a wrong count with a reason, which puts its pieces back.

const SHELF_COUNT_SQL = `
  SELECT c.*, u.name AS counted_by_name, vu.name AS voided_by_name,
         COALESCE((SELECT SUM(l.sold) FROM boutique_shelf_count_lines l WHERE l.count_id = c.id), 0)::int AS pieces,
         COALESCE((SELECT SUM(l.revenue) FROM boutique_shelf_count_lines l WHERE l.count_id = c.id), 0) AS revenue,
         COALESCE((SELECT SUM(l.cost) FROM boutique_shelf_count_lines l WHERE l.count_id = c.id), 0) AS cost,
         (SELECT COUNT(*) FROM boutique_shelf_count_lines l WHERE l.count_id = c.id)::int AS line_count
    FROM boutique_shelf_counts c
    LEFT JOIN users u ON u.id = c.counted_by LEFT JOIN users vu ON vu.id = c.voided_by`;

function mapShelfCount(row, lines = null) {
  return {
    id: row.id,
    countedOn: row.counted_on,
    note: row.note || '',
    status: row.status,
    countedBy: row.counted_by,
    countedByName: row.counted_by_name || '',
    voidedByName: row.voided_by_name || '',
    voidedAt: row.voided_at,
    voidReason: row.void_reason || '',
    lineCount: Number(row.line_count || 0),
    pieces: Number(row.pieces || 0),
    revenue: money(row.revenue),
    cost: money(row.cost),
    profit: fromMinor(toMinor(row.revenue) - toMinor(row.cost)),
    createdAt: row.created_at,
    lines: lines ? lines.map((l) => ({
      id: l.id, variantId: l.variant_id, productName: l.product_name, sku: l.sku,
      expected: l.expected, counted: l.counted, sold: l.sold,
      unitPrice: money(l.unit_price), unitCost: money(l.unit_cost), revenue: money(l.revenue), cost: money(l.cost),
      profit: fromMinor(toMinor(l.revenue) - toMinor(l.cost))
    })) : undefined
  };
}

async function loadShelfCount(db, countId) {
  const row = await db.query(`${SHELF_COUNT_SQL} WHERE c.id = $1`, [countId]);
  if (!row.rowCount) throw new BoutiqueError(404, 'Shelf count not found.');
  const lines = await db.query('SELECT * FROM boutique_shelf_count_lines WHERE count_id = $1 ORDER BY product_name, id', [countId]);
  return mapShelfCount(row.rows[0], lines.rows);
}

router.get('/shelf-counts', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const values = [];
  const filters = [];
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`c.counted_on >= $${values.length}`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`c.counted_on <= $${values.length}`); }
  const result = await pool.query(`${SHELF_COUNT_SQL} ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT 100`, values);
  send(res, result.rows.map((row) => mapShelfCount(row)));
}));

router.get('/shelf-counts/:id', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  send(res, await loadShelfCount(pool, parseRecordId(req.params.id, 'Shelf count')));
}));

router.post('/shelf-counts', asyncRoute(async (req, res) => {
  requireManage(req);
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw new BoutiqueError(400, 'Write how many are left of at least one product, then save.');
  if (lines.length > 1000) throw new BoutiqueError(400, 'A count can hold at most 1,000 products.');
  const wanted = lines.map((line) => ({
    variantId: parseRecordId(line?.variantId, 'Product'),
    counted: wholeNumber(line?.counted, { label: 'The number counted', minimum: 0 })
  }));
  if (new Set(wanted.map((line) => line.variantId)).size !== wanted.length) {
    throw new BoutiqueError(400, 'Each product can be counted only once in the same count.');
  }
  const note = text(body.note, 1000);
  const requestKey = requestKeyOf(body);
  if (requestKey) {
    const earlier = await pool.query('SELECT id FROM boutique_shelf_counts WHERE request_key = $1', [requestKey]);
    if (earlier.rowCount) return send(res, await loadShelfCount(pool, earlier.rows[0].id), 200);
  }
  const countedOn = todayInShop();
  const saved = await transaction(async (client) => {
    // Every product in the count is locked in id order -- the order every
    // other writer locks in -- so a till sale and a count cannot deadlock,
    // and "what the shelf should hold" cannot change between reading it and
    // booking the difference.
    const ids = [...wanted.map((line) => line.variantId)].sort((a, b) => a - b);
    const locked = await client.query(
      `SELECT v.id, v.sku, v.stock_quantity, v.selling_price, v.cost_price, v.status, p.name AS product_name, p.status AS product_status
         FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id
        WHERE v.id = ANY($1::int[]) ORDER BY v.id FOR UPDATE OF v`,
      [ids]
    );
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    for (const line of wanted) {
      const variant = byId.get(line.variantId);
      if (!variant) throw new BoutiqueError(404, 'One of the products in this count no longer exists. Reload the page and count again.');
      if (variant.status !== 'active' || variant.product_status !== 'active') {
        throw new BoutiqueError(400, `"${variant.product_name}" is archived and cannot be counted.`);
      }
      if (line.counted > variant.stock_quantity) {
        throw new BoutiqueError(409,
          `"${variant.product_name}": you counted ${line.counted}, but the shelf should only hold ${variant.stock_quantity}. If new stock came in, record it first (Update stock → New stock arrived), then count again.`,
          'COUNT_ABOVE_SHELF');
      }
    }
    const inserted = await client.query(
      'INSERT INTO boutique_shelf_counts (counted_on, note, counted_by, request_key) VALUES ($1, $2, $3, $4) RETURNING id',
      [countedOn, note, req.user.id, requestKey]
    );
    const countId = inserted.rows[0].id;
    let pieces = 0;
    let revenue = 0;
    for (const line of wanted) {
      const variant = byId.get(line.variantId);
      const expected = variant.stock_quantity;
      const sold = expected - line.counted;
      // Integer hundredths, like every money sum in the shop.
      const lineRevenue = toMinor(variant.selling_price) * sold;
      const lineCost = toMinor(variant.cost_price) * sold;
      await client.query(
        `INSERT INTO boutique_shelf_count_lines (count_id, variant_id, product_name, sku, expected, counted, sold, unit_price, unit_cost, revenue, cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [countId, variant.id, variant.product_name, variant.sku, expected, line.counted, sold,
          money(variant.selling_price), money(variant.cost_price), fromMinor(lineRevenue), fromMinor(lineCost)]
      );
      if (sold > 0) {
        const moved = await moveStock(client, { variantId: variant.id, quantity: -sold, kind: 'count_sale', referenceType: 'shelf_count', referenceId: countId, note: note || 'Sold, by shelf count', actor: req.user });
        if (moved.ranLow) {
          await notifyMany(client, await lowStockRecipients(client), {
            kind: 'boutique_low_stock', params: { title: `${variant.product_name} (${variant.sku})`, count: moved.after }, link: '#/boutique/stock', actor: req.user
          });
        }
      }
      pieces += sold;
      revenue += lineRevenue;
    }
    await audit(client, { entityType: 'shelf_count', entityId: countId, action: 'Shelf counted', details: { countedOn, products: wanted.length, pieces, revenue: fromMinor(revenue) }, actor: req.user });
    return loadShelfCount(client, countId);
  });
  send(res, saved, 201);
}));

router.post('/shelf-counts/:id/void', asyncRoute(async (req, res) => {
  requireDecide(req);
  const countId = parseRecordId(req.params.id, 'Shelf count');
  const reason = text(req.body?.reason, 1000);
  if (reason.length < 10) throw new BoutiqueError(400, 'Say why this count is wrong, in at least 10 characters.');
  const voided = await transaction(async (client) => {
    const current = await client.query("UPDATE boutique_shelf_counts SET status = 'voided', voided_by = $2, voided_at = NOW(), void_reason = $3 WHERE id = $1 AND status = 'recorded' RETURNING id", [countId, req.user.id, reason]);
    if (!current.rowCount) {
      const exists = await client.query('SELECT 1 FROM boutique_shelf_counts WHERE id = $1', [countId]);
      throw new BoutiqueError(exists.rowCount ? 409 : 404, exists.rowCount ? 'This count has already been voided.' : 'Shelf count not found.');
    }
    // The pieces the count booked as sold go back on the shelf, in id order.
    const lines = await client.query('SELECT variant_id, sold FROM boutique_shelf_count_lines WHERE count_id = $1 AND sold > 0 ORDER BY variant_id', [countId]);
    for (const line of lines.rows) {
      await moveStock(client, { variantId: line.variant_id, quantity: line.sold, kind: 'count_sale_void', referenceType: 'shelf_count', referenceId: countId, note: reason, actor: req.user });
    }
    await audit(client, { entityType: 'shelf_count', entityId: countId, action: 'Shelf count voided', details: { reason }, actor: req.user });
    return loadShelfCount(client, countId);
  });
  send(res, voided);
}));

// =====================================================================================
// 4. Suppliers and purchases
// =====================================================================================

const SUPPLIER_SQL = `
  SELECT s.*, b.billed, b.paid, b.owed, (SELECT COUNT(*) FROM boutique_purchase_orders o WHERE o.supplier_id = s.id)::int AS order_count
    FROM boutique_suppliers s JOIN (${SUPPLIER_BALANCE_SQL}) b ON b.supplier_id = s.id`;

router.get('/suppliers', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const status = req.query.status || 'active';
  const result = await pool.query(`${SUPPLIER_SQL} ${status === 'all' ? '' : 'WHERE s.status = $1'} ORDER BY s.name`, status === 'all' ? [] : [status]);
  send(res, result.rows.map(mapSupplier));
}));

function readSupplier(body, current = null) {
  const pick = (field, fallback) => (body[field] === undefined ? fallback : body[field]);
  return {
    name: text(pick('name', current?.name), 200, { required: true, label: 'Supplier name' }),
    contactName: text(pick('contactName', current?.contact_name), 150),
    phone: text(pick('phone', current?.phone), 50),
    email: text(pick('email', current?.email), 255),
    address: text(pick('address', current?.address), 1000),
    notes: text(pick('notes', current?.notes), 2000),
    status: oneOf(pick('status', current?.status || 'active'), ['active', 'archived'], 'Status')
  };
}

router.post('/suppliers', asyncRoute(async (req, res) => {
  requireManage(req);
  const supplier = readSupplier(req.body || {});
  const inserted = await pool.query(
    `INSERT INTO boutique_suppliers (name, contact_name, phone, email, address, notes, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [supplier.name, supplier.contactName, supplier.phone, supplier.email, supplier.address, supplier.notes, supplier.status, req.user.id]
  );
  await audit(pool, { entityType: 'supplier', entityId: inserted.rows[0].id, action: 'Supplier created', details: { name: supplier.name }, actor: req.user });
  const row = await pool.query(`${SUPPLIER_SQL} WHERE s.id = $1`, [inserted.rows[0].id]);
  send(res, mapSupplier(row.rows[0]), 201);
}));

router.put('/suppliers/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const supplierId = parseRecordId(req.params.id, 'Supplier');
  const current = await pool.query('SELECT * FROM boutique_suppliers WHERE id = $1', [supplierId]);
  if (!current.rowCount) throw new BoutiqueError(404, 'Supplier not found.');
  const supplier = readSupplier(req.body || {}, current.rows[0]);
  await pool.query(
    `UPDATE boutique_suppliers SET name = $2, contact_name = $3, phone = $4, email = $5, address = $6, notes = $7, status = $8, updated_at = NOW() WHERE id = $1`,
    [supplierId, supplier.name, supplier.contactName, supplier.phone, supplier.email, supplier.address, supplier.notes, supplier.status]
  );
  await audit(pool, { entityType: 'supplier', entityId: supplierId, action: 'Supplier updated', details: { name: supplier.name, status: supplier.status }, actor: req.user });
  const row = await pool.query(`${SUPPLIER_SQL} WHERE s.id = $1`, [supplierId]);
  send(res, mapSupplier(row.rows[0]));
}));

const ORDER_SQL = `
  SELECT o.*, s.name AS supplier_name,
         (SELECT COALESCE(SUM(i.quantity_ordered * i.unit_cost), 0) FROM boutique_purchase_items i WHERE i.order_id = o.id) AS ordered_value,
         (SELECT COALESCE(SUM(i.quantity_received * i.unit_cost), 0) FROM boutique_purchase_items i WHERE i.order_id = o.id) AS received_value
    FROM boutique_purchase_orders o JOIN boutique_suppliers s ON s.id = o.supplier_id`;

async function loadOrder(db, orderId) {
  const result = await db.query(`${ORDER_SQL} WHERE o.id = $1`, [orderId]);
  if (!result.rowCount) throw new BoutiqueError(404, 'Purchase order not found.');
  // Sequential: `db` may be a transaction client.
  const items = await db.query(`SELECT i.*, v.sku, v.size, v.color, p.name AS product_name FROM boutique_purchase_items i JOIN boutique_variants v ON v.id = i.variant_id JOIN boutique_products p ON p.id = v.product_id WHERE i.order_id = $1 ORDER BY i.id`, [orderId]);
  const receipts = await db.query(`SELECT r.*, u.name AS received_by_name,
                     (SELECT COALESCE(SUM(ri.quantity), 0) FROM boutique_goods_receipt_items ri WHERE ri.receipt_id = r.id) AS pieces,
                     (SELECT COALESCE(SUM(ri.quantity * ri.unit_cost), 0) FROM boutique_goods_receipt_items ri WHERE ri.receipt_id = r.id) AS value
                FROM boutique_goods_receipts r LEFT JOIN users u ON u.id = r.received_by WHERE r.order_id = $1 ORDER BY r.id`, [orderId]);
  const payments = await db.query(`SELECT p.*, u.name AS recorded_by_name FROM boutique_supplier_payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.order_id = $1 ORDER BY p.paid_on, p.id`, [orderId]);
  return { ...result.rows[0], items: items.rows, receipts: receipts.rows, payments: payments.rows };
}

router.get('/suppliers/:id', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const supplierId = parseRecordId(req.params.id, 'Supplier');
  const row = await pool.query(`${SUPPLIER_SQL} WHERE s.id = $1`, [supplierId]);
  if (!row.rowCount) throw new BoutiqueError(404, 'Supplier not found.');
  const [orders, payments] = await Promise.all([
    pool.query(`${ORDER_SQL} WHERE o.supplier_id = $1 ORDER BY o.created_at DESC`, [supplierId]),
    pool.query(`SELECT p.*, o.reference AS order_reference, u.name AS recorded_by_name FROM boutique_supplier_payments p LEFT JOIN boutique_purchase_orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.recorded_by WHERE p.supplier_id = $1 ORDER BY p.paid_on DESC, p.id DESC`, [supplierId])
  ]);
  send(res, { ...mapSupplier(row.rows[0]), orders: orders.rows.map(mapOrder), payments: payments.rows.map(mapSupplierPayment) });
}));

router.post('/suppliers/:id/payments', asyncRoute(async (req, res) => {
  requireManage(req);
  const supplierId = parseRecordId(req.params.id, 'Supplier');
  const body = req.body || {};
  const paid = amount(body.amount, { label: 'Amount', minimum: 0.01 });
  const method = oneOf(body.method || 'Cash', BOUTIQUE_PAYMENT_METHODS, 'Payment method');
  const paidOn = dateOr(body.paidOn, todayInShop(), 'Date paid');
  const orderId = body.orderId ? parseRecordId(body.orderId, 'Purchase order') : null;
  const payment = await transaction(async (client) => {
    const supplier = await client.query('SELECT id FROM boutique_suppliers WHERE id = $1', [supplierId]);
    if (!supplier.rowCount) throw new BoutiqueError(404, 'Supplier not found.');
    if (orderId) {
      const order = await client.query('SELECT id FROM boutique_purchase_orders WHERE id = $1 AND supplier_id = $2', [orderId, supplierId]);
      if (!order.rowCount) throw new BoutiqueError(400, 'That purchase order is not this supplier’s.');
    }
    const inserted = await client.query(
      `INSERT INTO boutique_supplier_payments (supplier_id, order_id, amount, method, paid_on, reference, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [supplierId, orderId, paid, method, paidOn, text(body.reference, 100), text(body.note, 1000), req.user.id]
    );
    await audit(client, { entityType: 'supplier', entityId: supplierId, action: 'Supplier paid', details: { amount: paid, method, orderId, paidOn }, actor: req.user });
    return (await client.query(`SELECT p.*, o.reference AS order_reference FROM boutique_supplier_payments p LEFT JOIN boutique_purchase_orders o ON o.id = p.order_id WHERE p.id = $1`, [inserted.rows[0].id])).rows[0];
  });
  send(res, mapSupplierPayment(payment), 201);
}));

router.get('/purchases', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const values = [];
  const filters = [];
  if (req.query.status && PURCHASE_STATUSES.includes(req.query.status)) { values.push(req.query.status); filters.push(`o.status = $${values.length}`); }
  if (req.query.supplierId) { values.push(parseRecordId(req.query.supplierId, 'Supplier')); filters.push(`o.supplier_id = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${ORDER_SQL} ${where} ORDER BY o.created_at DESC LIMIT 300`, values);
  send(res, result.rows.map(mapOrder));
}));

router.get('/purchases/:id', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  send(res, mapOrder(await loadOrder(pool, parseRecordId(req.params.id, 'Purchase order'))));
}));

router.post('/purchases', asyncRoute(async (req, res) => {
  requireManage(req);
  const body = req.body || {};
  const supplierId = parseRecordId(body.supplierId, 'Supplier');
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new BoutiqueError(400, 'A purchase order needs at least one line.');
  const expectedOn = dateOr(body.expectedOn, null, 'Expected date');
  const orderedOn = dateOr(body.orderedOn, todayInShop(), 'Order date');
  const order = await transaction(async (client) => {
    const supplier = await client.query(`SELECT id FROM boutique_suppliers WHERE id = $1 AND status = 'active'`, [supplierId]);
    if (!supplier.rowCount) throw new BoutiqueError(404, 'Supplier not found.');
    const reference = text(body.reference, 60) || (await client.query(`SELECT 'PO-' || lpad(nextval('boutique_purchase_number')::text, 6, '0') AS n`)).rows[0].n;
    const inserted = await client.query(
      `INSERT INTO boutique_purchase_orders (supplier_id, reference, status, ordered_on, expected_on, notes, created_by) VALUES ($1, $2, 'ordered', $3, $4, $5, $6) RETURNING id`,
      [supplierId, reference, orderedOn, expectedOn, text(body.notes, 2000), req.user.id]
    );
    const orderId = inserted.rows[0].id;
    const seen = new Set();
    for (const line of lines) {
      const variantId = parseRecordId(line.variantId, 'Variant');
      if (seen.has(variantId)) throw new BoutiqueError(400, 'The same variant is on the order twice.');
      seen.add(variantId);
      const quantity = wholeNumber(line.quantity, { label: 'Quantity' });
      const unitCost = amount(line.unitCost, { label: 'Unit cost' });
      const variant = await client.query('SELECT id FROM boutique_variants WHERE id = $1', [variantId]);
      if (!variant.rowCount) throw new BoutiqueError(404, 'Variant not found.');
      await client.query('INSERT INTO boutique_purchase_items (order_id, variant_id, quantity_ordered, unit_cost) VALUES ($1, $2, $3, $4)', [orderId, variantId, quantity, unitCost]);
    }
    await audit(client, { entityType: 'purchase', entityId: orderId, action: 'Purchase order raised', details: { reference, supplierId, lines: lines.length }, actor: req.user });
    return loadOrder(client, orderId);
  });
  send(res, mapOrder(order), 201);
}));

// Goods arriving against an order. Each line received moves stock and, if the
// supplier charged a different cost than the order said, updates the
// variant's purchase cost so the next sale's cost of goods is right.
router.post('/purchases/:id/receive', asyncRoute(async (req, res) => {
  requireManage(req);
  const orderId = parseRecordId(req.params.id, 'Purchase order');
  const body = req.body || {};
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new BoutiqueError(400, 'Say what arrived: at least one line with a quantity.');
  const receivedOn = dateOr(body.receivedOn, todayInShop(), 'Date received');
  const order = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_purchase_orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Purchase order not found.');
    if (!['ordered', 'partially_received'].includes(current.rows[0].status)) throw new BoutiqueError(409, 'This order is not open for receiving.');
    const receipt = await client.query('INSERT INTO boutique_goods_receipts (order_id, received_on, note, received_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [orderId, receivedOn, text(body.note, 1000), req.user.id]);
    const receiptId = receipt.rows[0].id;
    let pieces = 0;
    for (const line of lines) {
      const variantId = parseRecordId(line.variantId, 'Variant');
      const quantity = wholeNumber(line.quantity, { label: 'Quantity received' });
      const item = await client.query('SELECT * FROM boutique_purchase_items WHERE order_id = $1 AND variant_id = $2 FOR UPDATE', [orderId, variantId]);
      if (!item.rowCount) throw new BoutiqueError(400, 'One of the lines is not on this order.');
      const unitCost = line.unitCost === undefined || line.unitCost === '' ? money(item.rows[0].unit_cost) : amount(line.unitCost, { label: 'Unit cost' });
      const remaining = item.rows[0].quantity_ordered - item.rows[0].quantity_received;
      if (quantity > remaining) throw new BoutiqueError(409, `Only ${remaining} of that line is still to come.`);
      await client.query('UPDATE boutique_purchase_items SET quantity_received = quantity_received + $3, unit_cost = $4 WHERE order_id = $1 AND variant_id = $2', [orderId, variantId, quantity, unitCost]);
      await client.query('INSERT INTO boutique_goods_receipt_items (receipt_id, variant_id, quantity, unit_cost) VALUES ($1, $2, $3, $4)', [receiptId, variantId, quantity, unitCost]);
      await client.query('UPDATE boutique_variants SET cost_price = $2, updated_at = NOW() WHERE id = $1', [variantId, unitCost]);
      await moveStock(client, { variantId, quantity, kind: 'purchase_receipt', referenceType: 'receipt', referenceId: receiptId, note: current.rows[0].reference, actor: req.user });
      pieces += quantity;
    }
    const left = await client.query('SELECT COALESCE(SUM(quantity_ordered - quantity_received), 0)::int AS outstanding FROM boutique_purchase_items WHERE order_id = $1', [orderId]);
    const status = left.rows[0].outstanding > 0 ? 'partially_received' : 'received';
    await client.query('UPDATE boutique_purchase_orders SET status = $2, updated_at = NOW() WHERE id = $1', [orderId, status]);
    await audit(client, { entityType: 'purchase', entityId: orderId, action: 'Goods received', details: { reference: current.rows[0].reference, pieces, receiptId, status }, actor: req.user });
    return loadOrder(client, orderId);
  });
  send(res, mapOrder(order));
}));

router.put('/purchases/:id/invoice', asyncRoute(async (req, res) => {
  requireManage(req);
  const orderId = parseRecordId(req.params.id, 'Purchase order');
  const invoiceNumber = text(req.body?.invoiceNumber, 100);
  const invoiceTotal = req.body?.invoiceTotal === '' || req.body?.invoiceTotal === null || req.body?.invoiceTotal === undefined ? null : amount(req.body.invoiceTotal, { label: 'Invoice total' });
  const result = await pool.query(
    `UPDATE boutique_purchase_orders SET invoice_number = $2, invoice_total = $3, updated_at = NOW() WHERE id = $1 AND status <> 'cancelled' RETURNING reference`,
    [orderId, invoiceNumber, invoiceTotal]
  );
  if (!result.rowCount) throw new BoutiqueError(404, 'Purchase order not found, or cancelled.');
  await audit(pool, { entityType: 'purchase', entityId: orderId, action: 'Invoice recorded', details: { reference: result.rows[0].reference, invoiceNumber, invoiceTotal }, actor: req.user });
  send(res, mapOrder(await loadOrder(pool, orderId)));
}));

router.post('/purchases/:id/cancel', asyncRoute(async (req, res) => {
  requireManage(req);
  const orderId = parseRecordId(req.params.id, 'Purchase order');
  const reason = text(req.body?.reason, 1000, { required: true, label: 'The reason' });
  const result = await pool.query(
    `UPDATE boutique_purchase_orders SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'ordered' AND NOT EXISTS (SELECT 1 FROM boutique_purchase_items i WHERE i.order_id = $1 AND i.quantity_received > 0)
      RETURNING reference`,
    [orderId, reason]
  );
  if (!result.rowCount) throw new BoutiqueError(409, 'Only an order with nothing received yet can be cancelled.');
  await audit(pool, { entityType: 'purchase', entityId: orderId, action: 'Purchase order cancelled', details: { reference: result.rows[0].reference, reason }, actor: req.user });
  send(res, mapOrder(await loadOrder(pool, orderId)));
}));

// =====================================================================================
// 5. Cash sessions
// =====================================================================================

const SESSION_SQL = `
  SELECT c.*, o.name AS opened_by_name, k.name AS closed_by_name
    FROM boutique_cash_sessions c LEFT JOIN users o ON o.id = c.opened_by LEFT JOIN users k ON k.id = c.closed_by`;

async function sessionWithFigures(db, sessionId) {
  const row = await db.query(`${SESSION_SQL} WHERE c.id = $1`, [sessionId]);
  if (!row.rowCount) throw new BoutiqueError(404, 'Till session not found.');
  const figures = await sessionFigures(db, sessionId);
  const movements = await db.query('SELECT m.*, u.name AS recorded_by_name FROM boutique_cash_movements m LEFT JOIN users u ON u.id = m.recorded_by WHERE m.session_id = $1 ORDER BY m.id', [sessionId]);
  return {
    ...mapSession(row.rows[0], figures),
    movements: movements.rows.map((m) => ({ id: m.id, kind: m.kind, amount: money(m.amount), reason: m.reason, recordedByName: m.recorded_by_name || '', createdAt: m.created_at }))
  };
}

router.get('/cash/sessions', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  if (req.query.status && ['open', 'closed'].includes(req.query.status)) { values.push(req.query.status); filters.push(`c.status = $${values.length}`); }
  if (req.boutique === 'cashier') { values.push(req.user.id); filters.push(`c.opened_by = $${values.length}`); }
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`${shopDay('c.opened_at')} >= $${values.length}`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`${shopDay('c.opened_at')} <= $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${SESSION_SQL} ${where} ORDER BY c.opened_at DESC LIMIT 200`, values);
  send(res, result.rows.map((row) => mapSession(row)));
}));

router.get('/cash/sessions/current', asyncRoute(async (req, res) => {
  const sessionId = await openSessionOf(pool, req.user.id);
  send(res, sessionId ? await sessionWithFigures(pool, sessionId) : null);
}));

router.post('/cash/sessions', asyncRoute(async (req, res) => {
  requireSell(req);
  const openingCash = amount(req.body?.openingCash, { label: 'Opening cash' });
  const session = await transaction(async (client) => {
    if (await openSessionOf(client, req.user.id)) throw new BoutiqueError(409, 'You already have an open till. Close it before opening another.');
    const inserted = await client.query('INSERT INTO boutique_cash_sessions (opened_by, opening_cash, note) VALUES ($1, $2, $3) RETURNING id', [req.user.id, openingCash, text(req.body?.note, 1000)]);
    await audit(client, { entityType: 'session', entityId: inserted.rows[0].id, action: 'Till opened', details: { openingCash }, actor: req.user });
    return sessionWithFigures(client, inserted.rows[0].id);
  });
  send(res, session, 201);
}));

router.get('/cash/sessions/:id', asyncRoute(async (req, res) => {
  const session = await sessionWithFigures(pool, parseRecordId(req.params.id, 'Till session'));
  if (req.boutique === 'cashier' && session.openedBy !== req.user.id) throw new BoutiqueError(404, 'Till session not found.');
  send(res, session);
}));

router.post('/cash/sessions/:id/movements', asyncRoute(async (req, res) => {
  requireSell(req);
  const sessionId = parseRecordId(req.params.id, 'Till session');
  const kind = oneOf(req.body?.kind, CASH_MOVEMENT_KINDS, 'Movement kind');
  const value = amount(req.body?.amount, { label: 'Amount', minimum: 0.01 });
  const reason = text(req.body?.reason, 1000, { required: true, label: 'The reason' });
  const session = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_cash_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Till session not found.');
    if (current.rows[0].status !== 'open') throw new BoutiqueError(409, 'This till is closed.');
    if (req.boutique === 'cashier' && current.rows[0].opened_by !== req.user.id) throw new BoutiqueError(403, 'This is not your till.');
    await client.query('INSERT INTO boutique_cash_movements (session_id, kind, amount, reason, recorded_by) VALUES ($1, $2, $3, $4, $5)', [sessionId, kind, value, reason, req.user.id]);
    await audit(client, { entityType: 'session', entityId: sessionId, action: kind === 'payout' ? 'Cash paid out' : 'Cash put in', details: { amount: value, reason }, actor: req.user });
    return sessionWithFigures(client, sessionId);
  });
  send(res, session);
}));

// Closing: the expected figures are frozen beside the counted ones, and the
// difference is the day's shortage or surplus. Never recomputed afterwards.
router.post('/cash/sessions/:id/close', asyncRoute(async (req, res) => {
  requireSell(req);
  const sessionId = parseRecordId(req.params.id, 'Till session');
  const countedCash = amount(req.body?.countedCash, { label: 'Counted cash' });
  const countedByMethod = {};
  const typed = req.body?.countedByMethod && typeof req.body.countedByMethod === 'object' ? req.body.countedByMethod : {};
  for (const method of BOUTIQUE_PAYMENT_METHODS) {
    if (method === 'Cash') continue;
    countedByMethod[method] = typed[method] === undefined || typed[method] === '' ? null : amount(typed[method], { label: method });
  }
  const session = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_cash_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Till session not found.');
    if (current.rows[0].status !== 'open') throw new BoutiqueError(409, 'This till is already closed.');
    if (req.boutique === 'cashier' && current.rows[0].opened_by !== req.user.id) throw new BoutiqueError(403, 'This is not your till.');
    const figures = await sessionFigures(client, sessionId);
    const variance = fromMinor(toMinor(countedCash) - toMinor(figures.expectedCash));
    await client.query(
      `UPDATE boutique_cash_sessions SET status = 'closed', closed_by = $2, closed_at = NOW(), expected_cash = $3, counted_cash = $4, cash_variance = $5,
              expected_by_method = $6::jsonb, counted_by_method = $7::jsonb, note = CASE WHEN $8 = '' THEN note ELSE $8 END
        WHERE id = $1`,
      [sessionId, req.user.id, figures.expectedCash, countedCash, variance, JSON.stringify(figures.expectedByMethod), JSON.stringify(countedByMethod), text(req.body?.note, 1000)]
    );
    await audit(client, { entityType: 'session', entityId: sessionId, action: 'Till closed', details: { expectedCash: figures.expectedCash, countedCash, variance, expectedByMethod: figures.expectedByMethod, countedByMethod }, actor: req.user });
    return sessionWithFigures(client, sessionId);
  });
  send(res, session);
}));

// =====================================================================================
// 6. Expenses
// =====================================================================================

router.get('/expenses', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const values = [];
  const filters = [];
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`e.spent_on >= $${values.length}`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`e.spent_on <= $${values.length}`); }
  if (req.query.status && ['active', 'voided'].includes(req.query.status)) { values.push(req.query.status); filters.push(`e.status = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`SELECT e.*, u.name AS recorded_by_name FROM boutique_expenses e LEFT JOIN users u ON u.id = e.recorded_by ${where} ORDER BY e.spent_on DESC, e.id DESC LIMIT 500`, values);
  send(res, result.rows.map(mapExpense));
}));

router.post('/expenses', asyncRoute(async (req, res) => {
  requireManage(req);
  const body = req.body || {};
  const category = oneOf(body.category, EXPENSE_CATEGORIES, 'Expense category');
  const description = text(body.description, 1000, { required: true, label: 'Description' });
  const value = amount(body.amount, { label: 'Amount', minimum: 0.01 });
  const method = oneOf(body.method || 'Cash', BOUTIQUE_PAYMENT_METHODS, 'Payment method');
  const spentOn = dateOr(body.spentOn, todayInShop(), 'Date');
  const expense = await transaction(async (client) => {
    let sessionId = null;
    if (body.fromTill) {
      if (method !== 'Cash') throw new BoutiqueError(400, 'Only cash can come out of the till.');
      sessionId = await openSessionOf(client, req.user.id);
      if (!sessionId) throw new BoutiqueError(409, 'Open a till before paying an expense out of it.');
    }
    const inserted = await client.query(
      `INSERT INTO boutique_expenses (category, description, amount, method, spent_on, session_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [category, description, value, method, spentOn, sessionId, req.user.id]
    );
    await audit(client, { entityType: 'expense', entityId: inserted.rows[0].id, action: 'Expense recorded', details: { category, amount: value, method, spentOn, fromTill: Boolean(sessionId) }, actor: req.user });
    return (await client.query('SELECT e.*, u.name AS recorded_by_name FROM boutique_expenses e LEFT JOIN users u ON u.id = e.recorded_by WHERE e.id = $1', [inserted.rows[0].id])).rows[0];
  });
  send(res, mapExpense(expense), 201);
}));

router.post('/expenses/:id/void', asyncRoute(async (req, res) => {
  requireDecide(req);
  const expenseId = parseRecordId(req.params.id, 'Expense');
  const reason = text(req.body?.reason, 1000, { required: true, label: 'The reason' });
  if (reason.length < 10) throw new BoutiqueError(400, 'Say why the expense is voided, in at least 10 characters.');
  const result = await pool.query(
    `UPDATE boutique_expenses SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW() WHERE id = $1 AND status = 'active' RETURNING amount, category`,
    [expenseId, reason, req.user.id]
  );
  if (!result.rowCount) throw new BoutiqueError(409, 'Expense not found, or already voided.');
  await audit(pool, { entityType: 'expense', entityId: expenseId, action: 'Expense voided', details: { amount: money(result.rows[0].amount), category: result.rows[0].category, reason }, actor: req.user });
  const row = await pool.query('SELECT e.*, u.name AS recorded_by_name FROM boutique_expenses e LEFT JOIN users u ON u.id = e.recorded_by WHERE e.id = $1', [expenseId]);
  send(res, mapExpense(row.rows[0]));
}));

// =====================================================================================
// 7. The books, the reports, the approvals, the trail
// =====================================================================================

router.get('/finance', asyncRoute(async (req, res) => {
  if (req.boutique === 'cashier') throw new BoutiqueError(403, 'The books are the manager’s and the Director’s.');
  const period = resolvePeriod({ period: 'custom', ...req.query, period: req.query.period || 'custom' });
  send(res, { ...(await financeFigures(pool, period)), period });
}));

// The period report, as one object: what the Reports tab shows, and what the
// Boutique Manager sends to the Director frozen in a submission.
// ---- stock and profit, product by product ------------------------------------
//
// One line per product for the period, read from the ledger and the frozen
// prices, so it always adds up:
//
//     opening + received − sold + other changes = closing
//
//  * opening   the shelf at the start of the first day (every ledger row before it)
//  * received  the first count, purchase-order deliveries, "new stock arrived",
//              transfers in
//  * sold      till sales and shelf-count sales, less what came back (returns
//              restocked, voided sales, voided counts)
//  * other     damaged, missing, a physical count, sent back to the supplier,
//              transferred out -- signed, usually negative
//  * revenue   the till's line totals with the sale's own discount shared out
//              over its lines, less returns, plus the counted lines -- at the
//              prices frozen when each was sold, never today's price
//  * cost      the buying price frozen on each line sold (till and count), less
//              the cost of what went back on the shelf
//  * stock value  closing × the buying price per unit
//
// Pieces are dated by the ledger row and money by the sale or count, which
// fall on the same shop day for everything rung up or counted.
const SOLD_KINDS = ['sale', 'sale_return', 'void', 'count_sale', 'count_sale_void'];
const RECEIVED_KINDS = ['opening', 'purchase_receipt', 'received', 'transfer_in'];

async function stockProfit(period) {
  const range = [period.start, period.end];
  const day = shopDay('m.created_at');
  const [ledger, till, returned, counted] = await Promise.all([
    pool.query(
      `SELECT v.id, v.sku, v.size, v.color, v.cost_price, v.stock_quantity, v.status, p.name AS product_name, p.product_type, p.unit,
              COALESCE(SUM(m.quantity) FILTER (WHERE ${day} < $1), 0)::int AS opening,
              COALESCE(SUM(m.quantity) FILTER (WHERE ${day} BETWEEN $1 AND $2 AND m.kind = ANY($3::text[])), 0)::int AS received,
              COALESCE(SUM(m.quantity) FILTER (WHERE ${day} BETWEEN $1 AND $2 AND m.kind = ANY($4::text[])), 0)::int AS sold_signed,
              COALESCE(SUM(m.quantity) FILTER (WHERE ${day} BETWEEN $1 AND $2 AND NOT (m.kind = ANY($3::text[])) AND NOT (m.kind = ANY($4::text[]))), 0)::int AS other,
              COALESCE(SUM(m.quantity) FILTER (WHERE ${day} <= $2), 0)::int AS closing,
              COUNT(m.id) FILTER (WHERE ${day} BETWEEN $1 AND $2)::int AS moves
         FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id
         LEFT JOIN boutique_stock_movements m ON m.variant_id = v.id
        GROUP BY v.id, p.name, p.product_type, p.unit
        ORDER BY p.name, v.size, v.color`,
      [...range, RECEIVED_KINDS, SOLD_KINDS]
    ),
    pool.query(
      `SELECT i.variant_id,
              -- The sale's own discount shared over its lines in proportion,
              -- so the lines of a sale add up to what the customer paid.
              SUM(CASE WHEN s.subtotal > 0 THEN ROUND(i.line_total * s.total / s.subtotal, 2) ELSE 0 END) AS revenue,
              SUM(i.quantity * i.unit_cost) AS cost
         FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id
        WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY i.variant_id`, range),
    pool.query(
      `SELECT ri.variant_id, SUM(ri.quantity * ri.unit_price) AS value,
              SUM(CASE WHEN ri.restock THEN ri.quantity * ri.unit_cost ELSE 0 END) AS cost
         FROM boutique_return_items ri JOIN boutique_returns r ON r.id = ri.return_id
        WHERE r.returned_on BETWEEN $1 AND $2 GROUP BY ri.variant_id`, range),
    pool.query(
      `SELECT l.variant_id, SUM(l.revenue) AS revenue, SUM(l.cost) AS cost
         FROM boutique_shelf_count_lines l JOIN boutique_shelf_counts c ON c.id = l.count_id
        WHERE c.status = 'recorded' AND c.counted_on BETWEEN $1 AND $2 GROUP BY l.variant_id`, range)
  ]);
  const index = (rows) => new Map(rows.map((row) => [row.variant_id, row]));
  const tillBy = index(till.rows);
  const returnedBy = index(returned.rows);
  const countedBy = index(counted.rows);
  const totals = { opening: 0, received: 0, sold: 0, other: 0, closing: 0, revenue: 0, cost: 0, profit: 0, stockValue: 0 };
  const rows = [];
  for (const v of ledger.rows) {
    // A product that is archived and did nothing in the period is history,
    // not part of this period's shelf.
    if (v.status !== 'active' && !v.moves && !v.closing) continue;
    const t = tillBy.get(v.id);
    const r = returnedBy.get(v.id);
    const k = countedBy.get(v.id);
    const revenue = toMinor(t?.revenue) - toMinor(r?.value) + toMinor(k?.revenue);
    const cost = toMinor(t?.cost) - toMinor(r?.cost) + toMinor(k?.cost);
    const stockValue = toMinor(v.cost_price) * v.closing;
    const row = {
      variantId: v.id, productName: v.product_name, productType: v.product_type, unit: v.unit || '', sku: v.sku, size: v.size || '', color: v.color || '',
      opening: v.opening, received: v.received, sold: -v.sold_signed, other: v.other, closing: v.closing,
      revenue: fromMinor(revenue), cost: fromMinor(cost), profit: fromMinor(revenue - cost),
      unitCost: money(v.cost_price), stockValue: fromMinor(stockValue)
    };
    rows.push(row);
    for (const key of ['opening', 'received', 'sold', 'other', 'closing']) totals[key] += row[key];
    totals.revenue += revenue;
    totals.cost += cost;
    totals.stockValue += stockValue;
  }
  totals.profit = fromMinor(totals.revenue - totals.cost);
  totals.revenue = fromMinor(totals.revenue);
  totals.cost = fromMinor(totals.cost);
  totals.stockValue = fromMinor(totals.stockValue);
  return { rows, totals };
}

// Till sales and shelf-count sales, one row per day. `sales` stays the number
// of till sales; `counted` is the part of the day's total that a count found.
function mergeSalesByDay(tillRows, countedRows) {
  const key = (day) => (day instanceof Date ? isoDay(day) : String(day).slice(0, 10));
  const days = new Map();
  for (const r of tillRows) days.set(key(r.day), { day: key(r.day), sales: r.sales, till: toMinor(r.total), counted: 0, discounts: money(r.discounts) });
  for (const r of countedRows) {
    const entry = days.get(key(r.day)) || { day: key(r.day), sales: 0, till: 0, counted: 0, discounts: 0 };
    entry.counted += toMinor(r.total);
    days.set(entry.day, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, sales: d.sales, total: fromMinor(d.till + d.counted), counted: fromMinor(d.counted), discounts: d.discounts }));
}

async function buildReport(period) {
  const range = [period.start, period.end];
  const [finance, byDay, topProducts, sizes, colors, types, lowStock, byType, ordersByStatus, expensesByCategory, returns, cashiers, sessions, products, countedByDay] = await Promise.all([
    financeFigures(pool, period),
    // Discounts per day are the sale-level ones plus the line ones, the same
    // sum the profit tile shows for the whole period.
    pool.query(`SELECT s.sold_on AS day, COUNT(*)::int AS sales, COALESCE(SUM(s.total), 0) AS total,
                       COALESCE(SUM(s.discount), 0) + COALESCE(SUM((SELECT SUM(i.discount) FROM boutique_sale_items i WHERE i.sale_id = s.id)), 0) AS discounts
                  FROM boutique_sales s WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY s.sold_on ORDER BY s.sold_on`, range),
    // Sold at the till or found sold by a shelf count: both are sales.
    pool.query(`SELECT product_name, sku, size, color, SUM(pieces)::int AS pieces, SUM(revenue) AS revenue, SUM(cost) AS cost FROM (
                  SELECT i.product_name, i.sku, i.size, i.color, i.quantity AS pieces, i.line_total AS revenue, i.quantity * i.unit_cost AS cost
                    FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2
                  UNION ALL
                  SELECT l.product_name, l.sku, v.size, v.color, l.sold, l.revenue, l.cost
                    FROM boutique_shelf_count_lines l JOIN boutique_shelf_counts c ON c.id = l.count_id JOIN boutique_variants v ON v.id = l.variant_id
                   WHERE c.status = 'recorded' AND c.counted_on BETWEEN $1 AND $2 AND l.sold > 0
                 ) sold GROUP BY product_name, sku, size, color ORDER BY pieces DESC, revenue DESC LIMIT 20`, range),
    pool.query(`SELECT COALESCE(NULLIF(i.size, ''), '—') AS size, SUM(i.quantity)::int AS pieces FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id
                 WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY 1 ORDER BY pieces DESC LIMIT 20`, range),
    pool.query(`SELECT COALESCE(NULLIF(i.color, ''), '—') AS color, SUM(i.quantity)::int AS pieces FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id
                 WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY 1 ORDER BY pieces DESC LIMIT 20`, range),
    pool.query(`SELECT p.product_type, SUM(i.quantity)::int AS pieces, SUM(i.line_total) AS revenue
                  FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id JOIN boutique_variants v ON v.id = i.variant_id JOIN boutique_products p ON p.id = v.product_id
                 WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY p.product_type ORDER BY revenue DESC`, range),
    pool.query(`${STOCK_SQL} WHERE v.status = 'active' AND p.status = 'active' AND v.stock_quantity <= v.reorder_level ORDER BY v.stock_quantity, p.name LIMIT 50`),
    pool.query(`SELECT p.product_type, COUNT(v.id)::int AS variants, COALESCE(SUM(v.stock_quantity), 0)::int AS pieces, COALESCE(SUM(v.stock_quantity * v.cost_price), 0) AS value
                  FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id WHERE v.status = 'active' GROUP BY p.product_type ORDER BY value DESC`),
    pool.query(`SELECT status, COUNT(*)::int AS count FROM boutique_purchase_orders WHERE ordered_on BETWEEN $1 AND $2 GROUP BY status`, range),
    pool.query(`SELECT category, COUNT(*)::int AS count, SUM(amount) AS total FROM boutique_expenses WHERE status = 'active' AND spent_on BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, range),
    pool.query(`SELECT r.*, s.number AS sale_number, u.name AS cashier_name FROM boutique_returns r JOIN boutique_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.cashier_id
                 WHERE r.returned_on BETWEEN $1 AND $2 ORDER BY r.returned_at DESC LIMIT 100`, range),
    pool.query(`SELECT u.id, u.name,
                       COUNT(s.id)::int AS sales, COALESCE(SUM(s.total), 0) AS total, COALESCE(SUM(s.discount), 0) AS discounts,
                       COALESCE(SUM((SELECT SUM(i.quantity) FROM boutique_sale_items i WHERE i.sale_id = s.id)), 0)::int AS pieces,
                       (SELECT COUNT(*) FROM boutique_returns r WHERE r.cashier_id = u.id AND r.returned_on BETWEEN $1 AND $2)::int AS returns,
                       (SELECT COUNT(*) FROM boutique_sales x WHERE x.cashier_id = u.id AND x.status = 'voided' AND x.sold_on BETWEEN $1 AND $2)::int AS voided
                  FROM boutique_sales s JOIN users u ON u.id = s.cashier_id
                 WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2 GROUP BY u.id, u.name ORDER BY total DESC`, range),
    // A till belongs to the shop's day it was closed on, not the database's
    // UTC day: closed at 00:30 in Kigali is still that day's till.
    pool.query(`SELECT COUNT(*)::int AS closed, COALESCE(SUM(expected_cash), 0) AS expected_cash, COALESCE(SUM(counted_cash), 0) AS counted_cash,
                       COALESCE(SUM(cash_variance), 0) AS cash_variance, COALESCE(json_agg(json_build_object('expected', expected_by_method, 'counted', counted_by_method)), '[]'::json) AS methods
                  FROM boutique_cash_sessions WHERE status = 'closed' AND ${shopDay('closed_at')} BETWEEN $1 AND $2`, range),
    stockProfit(period),
    pool.query(`SELECT c.counted_on AS day, COALESCE(SUM(l.revenue), 0) AS total
                  FROM boutique_shelf_counts c JOIN boutique_shelf_count_lines l ON l.count_id = c.id
                 WHERE c.status = 'recorded' AND c.counted_on BETWEEN $1 AND $2 GROUP BY c.counted_on`, range)
  ]);

  // Payment reconciliation: what the sales say was taken by each method
  // against what the closed tills of the period counted for it.
  const closed = sessions.rows[0];
  const countedByMethod = {};
  const expectedByMethod = {};
  for (const entry of closed.methods || []) {
    for (const [method, value] of Object.entries(entry.expected || {})) expectedByMethod[method] = (expectedByMethod[method] || 0) + toMinor(value);
    for (const [method, value] of Object.entries(entry.counted || {})) if (value !== null) countedByMethod[method] = (countedByMethod[method] || 0) + toMinor(value);
  }
  const reconciliation = finance.paymentsByMethod.map((row) => {
    const counted = row.method === 'Cash' ? toMinor(closed.counted_cash) : (countedByMethod[row.method] ?? null);
    const expected = row.method === 'Cash' ? toMinor(closed.expected_cash) : (expectedByMethod[row.method] || 0);
    return { ...row, tillExpected: fromMinor(expected), tillCounted: counted === null ? null : fromMinor(counted), tillVariance: counted === null ? null : fromMinor(counted - expected) };
  });

  return {
    period,
    finance,
    // A day's sales are the till's plus what that day's shelf counts found
    // sold, the same two the gross-sales figure adds.
    salesByDay: mergeSalesByDay(byDay.rows, countedByDay.rows),
    stockProfit: products,
    topProducts: topProducts.rows.map((r) => ({ productName: r.product_name, sku: r.sku, size: r.size, color: r.color, pieces: r.pieces, revenue: money(r.revenue), profit: fromMinor(toMinor(r.revenue) - toMinor(r.cost)) })),
    sizeDemand: sizes.rows.map((r) => ({ size: r.size, pieces: r.pieces })),
    colorDemand: colors.rows.map((r) => ({ color: r.color, pieces: r.pieces })),
    typeDemand: types.rows.map((r) => ({ productType: r.product_type, pieces: r.pieces, revenue: money(r.revenue) })),
    inventory: { value: finance.inventory.value, pieces: finance.inventory.pieces, lowStock: lowStock.rows.map(mapVariant), byType: byType.rows.map((r) => ({ productType: r.product_type, variants: r.variants, pieces: r.pieces, value: money(r.value) })) },
    purchases: { ...finance.purchases, byStatus: Object.fromEntries(ordersByStatus.rows.map((r) => [r.status, r.count])), supplierPayments: finance.supplierPayments, supplierBalance: finance.supplierBalance },
    expensesByCategory: expensesByCategory.rows.map((r) => ({ category: r.category, count: r.count, total: money(r.total) })),
    returns: returns.rows.map(mapReturn),
    paymentReconciliation: { closedSessions: closed.closed, cashVariance: money(closed.cash_variance), methods: reconciliation },
    cashierPerformance: cashiers.rows.map((r) => ({ cashierId: r.id, name: r.name, sales: r.sales, pieces: r.pieces, total: money(r.total), discounts: money(r.discounts), average: r.sales ? fromMinor(Math.round(toMinor(r.total) / r.sales)) : 0, returns: r.returns, voided: r.voided }))
  };
}

router.get('/reports', asyncRoute(async (req, res) => {
  if (req.boutique === 'cashier') throw new BoutiqueError(403, 'Reports are the manager’s and the Director’s.');
  send(res, await buildReport(resolvePeriod(req.query)));
}));

// =====================================================================================
// 7b. The Boutique Manager's line to the Director
// =====================================================================================
//
// The Boutique Manager reports DIRECTLY to the Director (Super Admin). A
// period report is sent with its figures frozen as they stood; an incident is
// sent as words. Every active Director is told at once; nobody else is in the
// chain. The Director accepts or returns it with a note, the requester is
// told, and the decision -- who, when, what -- stays on the row and in the
// trail. Nothing here is approved on anybody's behalf.

const SUBMISSION_SQL = `
  SELECT s.*, u.name AS submitted_by_name, d.name AS decided_by_name
    FROM boutique_submissions s LEFT JOIN users u ON u.id = s.submitted_by LEFT JOIN users d ON d.id = s.decided_by`;

function mapSubmission(row, { withSnapshot = false } = {}) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    note: row.note || '',
    status: row.status,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name || '',
    submittedAt: row.submitted_at,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name || '',
    decidedAt: row.decided_at,
    decisionNote: row.decision_note || '',
    snapshot: withSnapshot ? (row.snapshot || {}) : undefined
  };
}

router.get('/submissions', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const values = [];
  const filters = [];
  if (req.query.status && ['submitted', 'accepted', 'returned'].includes(req.query.status)) { values.push(req.query.status); filters.push(`s.status = $${values.length}`); }
  if (req.query.kind && ['report', 'incident'].includes(req.query.kind)) { values.push(req.query.kind); filters.push(`s.kind = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${SUBMISSION_SQL} ${where} ORDER BY s.submitted_at DESC LIMIT 200`, values);
  send(res, result.rows.map((row) => mapSubmission(row)));
}));

router.get('/submissions/:id', asyncRoute(async (req, res) => {
  requireNotCashier(req);
  const result = await pool.query(`${SUBMISSION_SQL} WHERE s.id = $1`, [parseRecordId(req.params.id, 'Submission')]);
  if (!result.rowCount) throw new BoutiqueError(404, 'Submission not found.');
  send(res, mapSubmission(result.rows[0], { withSnapshot: true }));
}));

// A period report, sent up with its figures frozen.
router.post('/submissions/report', asyncRoute(async (req, res) => {
  requireManage(req);
  const period = resolvePeriod(req.body || {});
  const note = text(req.body?.note, 4000);
  const title = text(req.body?.title, 200) || `${period.period} report ${period.start}${period.end !== period.start ? ` to ${period.end}` : ''}`;
  const created = await transaction(async (client) => {
    const snapshot = await buildReport(period);
    const inserted = await client.query(
      `INSERT INTO boutique_submissions (kind, title, period, period_start, period_end, note, snapshot, submitted_by)
       VALUES ('report', $1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [title, period.period, period.start, period.end, note, JSON.stringify(snapshot), req.user.id]
    );
    const id = inserted.rows[0].id;
    await audit(client, { entityType: 'submission', entityId: id, action: 'Report sent to the Director', details: { title, period: period.period, start: period.start, end: period.end, netSales: snapshot.finance.netSales, netProfit: snapshot.finance.netProfit }, actor: req.user });
    await notifyDirectors(client, { kind: 'boutique_report_submitted', params: { title, reason: note.slice(0, 200) }, link: `#/boutique/approvals?submission=${id}`, actor: req.user });
    return (await client.query(`${SUBMISSION_SQL} WHERE s.id = $1`, [id])).rows[0];
  });
  send(res, mapSubmission(created, { withSnapshot: true }), 201);
}));

// An incident or issue that needs the Director's intervention.
router.post('/submissions/incident', asyncRoute(async (req, res) => {
  requireManage(req);
  const title = text(req.body?.title, 200, { required: true, label: 'A title' });
  const note = text(req.body?.note, 4000, { required: true, label: 'What happened' });
  if (note.length < 10) throw new BoutiqueError(400, 'Say what happened, in at least 10 characters.');
  const created = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO boutique_submissions (kind, title, note, submitted_by) VALUES ('incident', $1, $2, $3) RETURNING id`,
      [title, note, req.user.id]
    );
    const id = inserted.rows[0].id;
    await audit(client, { entityType: 'submission', entityId: id, action: 'Issue raised to the Director', details: { title }, actor: req.user });
    await notifyDirectors(client, { kind: 'boutique_issue_raised', params: { title, reason: note.slice(0, 200) }, link: `#/boutique/approvals?submission=${id}`, actor: req.user });
    return (await client.query(`${SUBMISSION_SQL} WHERE s.id = $1`, [id])).rows[0];
  });
  send(res, mapSubmission(created), 201);
}));

// The Director's answer: accepted, or returned with what to do about it.
router.post('/submissions/:id/decision', asyncRoute(async (req, res) => {
  requireDecide(req);
  const id = parseRecordId(req.params.id, 'Submission');
  const decision = oneOf(req.body?.decision, ['accepted', 'returned'], 'Decision');
  const note = text(req.body?.note, 4000);
  if (decision === 'returned' && note.length < 10) throw new BoutiqueError(400, 'Say what should be done about it, in at least 10 characters.');
  const decided = await transaction(async (client) => {
    const current = await client.query('SELECT * FROM boutique_submissions WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new BoutiqueError(404, 'Submission not found.');
    const row = current.rows[0];
    if (row.status !== 'submitted') throw new BoutiqueError(409, 'This has already been answered.');
    await client.query('UPDATE boutique_submissions SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4 WHERE id = $1', [id, decision, req.user.id, note]);
    await audit(client, { entityType: 'submission', entityId: id, action: decision === 'accepted' ? 'Submission accepted' : 'Submission returned', details: { title: row.title, kind: row.kind, note }, actor: req.user });
    await notify(client, { userId: row.submitted_by, kind: 'boutique_submission_decided', params: { title: row.title, outcome: decision, reason: note }, link: `#/boutique/reports?submission=${id}`, actor: req.user });
    return (await client.query(`${SUBMISSION_SQL} WHERE s.id = $1`, [id])).rows[0];
  });
  send(res, mapSubmission(decided));
}));

// What waits for the Director: the manager's adjustment requests and void
// requests, newest first. The manager reads the same list to see what is
// still pending.
router.get('/approvals', asyncRoute(async (req, res) => {
  if (!canManage(req.boutique) && req.boutique !== 'reader') throw new BoutiqueError(403, 'Approvals are the manager’s and the Director’s.');
  const [adjustments, voids, submissions] = await Promise.all([
    pool.query(`${ADJUSTMENT_SQL} WHERE a.status = 'pending' ORDER BY a.created_at`),
    pool.query(`${SALE_SQL} WHERE s.status = 'void_requested' ORDER BY s.sold_at`),
    pool.query(`${SUBMISSION_SQL} WHERE s.status = 'submitted' ORDER BY s.submitted_at`)
  ]);
  send(res, { adjustments: adjustments.rows.map(mapAdjustment), voids: voids.rows.map(mapSale), submissions: submissions.rows.map((row) => mapSubmission(row)) });
}));

router.get('/audit', asyncRoute(async (req, res) => {
  if (req.boutique === 'cashier') throw new BoutiqueError(403, 'The audit trail is the manager’s and the Director’s.');
  const values = [];
  const filters = [];
  if (req.query.entityType) { values.push(String(req.query.entityType).slice(0, 30)); filters.push(`entity_type = $${values.length}`); }
  if (req.query.entityId) { values.push(parseRecordId(req.query.entityId, 'Record')); filters.push(`entity_id = $${values.length}`); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM boutique_audit ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, values);
  send(res, result.rows.map(mapAudit));
}));

// What the caller did wrong is answered with its status; everything else
// goes to the global handler, which maps Postgres input errors and answers
// 500 for the rest.
router.use((error, req, res, next) => {
  if (error instanceof BoutiqueError) {
    return res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'The picture is larger than 4 MB.' : 'The upload was refused.' });
  }
  next(error);
});

export default router;
