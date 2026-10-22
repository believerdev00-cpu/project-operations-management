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
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isValidDate, parseId } from '../lib/http.js';
import { notify, notifyDirectors } from '../lib/notifications.js';
import { readFile, saveFile, deleteFile, storedFileName, MAX_EVIDENCE_BYTES } from '../lib/storage.js';
import {
  BOUTIQUE_FOLDER, BoutiqueError, SUPPLIER_BALANCE_SQL, amount, audit, boutiqueAccess, canManage, canSell, financeFigures,
  id as parseRecordId, mapAudit, moveStock, oneOf, requireDecide, requireManage, requireNotCashier, requireSell, sessionFigures, text, wholeNumber
} from '../lib/boutique.js';
import {
  ADJUSTMENT_KINDS, BOUTIQUE_PAYMENT_METHODS, CASH_MOVEMENT_KINDS, EXCHANGE_CREDIT, EXPENSE_CATEGORIES, PRODUCT_TYPES,
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
    category: row.category || '',
    brand: row.brand || '',
    description: row.description || '',
    hasImage: Boolean(row.image_stored_name),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variants: (row.variants || []).map(mapVariant),
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
    soldOn: typeof row.sold_on === 'string' ? row.sold_on : row.sold_on?.toISOString?.().slice(0, 10),
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
// otherwise; the API answers them as 'YYYY-MM-DD' so nothing shifts a day in
// the browser's timezone.
function plainDates(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(plainDates);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainDates(entry)]));
  }
  return value;
}
const send = (res, payload, status = 200) => res.status(status).json(plainDates(payload));

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
    pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total FROM boutique_sales WHERE status <> 'voided' AND sold_on = $1`, [today]),
    pool.query(`SELECT COUNT(*)::int AS open FROM boutique_cash_sessions WHERE status = 'open'`),
    pool.query(`SELECT (SELECT COUNT(*) FROM boutique_stock_adjustments WHERE status = 'pending')::int AS adjustments,
                       (SELECT COUNT(*) FROM boutique_sales WHERE status = 'void_requested')::int AS voids`),
    pool.query(`SELECT COALESCE(SUM(owed), 0) AS total FROM (${SUPPLIER_BALANCE_SQL}) b WHERE owed > 0`),
    pool.query(`SELECT COUNT(*)::int AS count FROM boutique_variants WHERE status = 'active' AND stock_quantity <= reorder_level`)
  ]);
  const mySession = canSell(req.boutique) ? await openSessionOf(pool, req.user.id) : null;
  // A cashier's overview is the shelf and their own till: the shelf's worth
  // at cost, the supplier balance and the Director's queue are not theirs.
  const cashier = req.boutique === 'cashier';
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
    pendingApprovals: cashier ? 0 : approvals.rows[0].adjustments + approvals.rows[0].voids,
    pendingAdjustments: cashier ? 0 : approvals.rows[0].adjustments,
    pendingVoids: cashier ? 0 : approvals.rows[0].voids,
    supplierBalance: cashier ? null : money(owed.rows[0].total)
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
    productType: oneOf(pick('productType', current?.product_type || 'clothing'), PRODUCT_TYPES, 'Product type'),
    category: text(pick('category', current?.category), 100),
    brand: text(pick('brand', current?.brand), 100),
    description: text(pick('description', current?.description), 2000),
    status: oneOf(pick('status', current?.status || 'active'), ['active', 'archived'], 'Status')
  };
}

function readVariant(body, current = null) {
  const pick = (field, fallback) => (body[field] === undefined ? fallback : body[field]);
  const sku = text(pick('sku', current?.sku), 60, { required: true, label: 'SKU' });
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
    [productId, variant.sku, variant.barcode, variant.size, variant.color, variant.costPrice, variant.sellingPrice, variant.reorderLevel, variant.status]
  );
  const row = inserted.rows[0];
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
  if (!variants.length) throw new BoutiqueError(400, 'A product needs at least one variant (a size and colour with its price).');
  const created = await transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO boutique_products (name, product_type, category, brand, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [product.name, product.productType, product.category, product.brand, product.description, product.status, req.user.id]
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
      `UPDATE boutique_products SET name = $2, product_type = $3, category = $4, brand = $5, description = $6, status = $7, updated_at = NOW() WHERE id = $1`,
      [productId, product.name, product.productType, product.category, product.brand, product.description, product.status]
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
    `SELECT v.*, p.name AS product_name, p.product_type, p.brand, p.image_stored_name
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
    await moveStock(client, { variantId: item.variantId, quantity: -item.quantity, kind: 'sale', referenceType: 'sale', referenceId: saleId, note: number, actor });
    await client.query(
      `INSERT INTO boutique_sale_items (sale_id, variant_id, product_name, sku, size, color, quantity, unit_price, unit_cost, discount, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [saleId, item.variantId, item.productName, item.sku, item.size, item.color, item.quantity, item.unitPrice, item.unitCost, item.discount, item.lineTotal]
    );
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
  SELECT v.*, p.name AS product_name, p.product_type, p.brand, p.image_stored_name
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
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`m.created_at >= $${values.length}::date`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`m.created_at < ($${values.length}::date + 1)`); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT m.*, v.sku, v.size, v.color, p.name AS product_name, u.name AS recorded_by_name
       FROM boutique_stock_movements m JOIN boutique_variants v ON v.id = m.variant_id JOIN boutique_products p ON p.id = v.product_id
       LEFT JOIN users u ON u.id = m.recorded_by ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`, values);
  send(res, result.rows.map(mapMovement));
}));

const ADJUSTMENT_SQL = `
  SELECT a.*, v.sku, v.size, v.color, p.name AS product_name, r.name AS requested_by_name, d.name AS decided_by_name
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
  if (kind === 'transfer_in') return quantity;
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
  const reason = text(body.reason, 1000, { required: true, label: 'The reason' });
  if (reason.length < 5) throw new BoutiqueError(400, 'Say why, in at least 5 characters.');
  const adjustment = await transaction(async (client) => {
    const variant = await client.query('SELECT v.stock_quantity, v.sku, p.name AS product_name FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id WHERE v.id = $1', [variantId]);
    if (!variant.rowCount) throw new BoutiqueError(404, 'Variant not found.');
    const delta = adjustmentDelta(kind, quantity, variant.rows[0].stock_quantity);
    if (delta < 0 && variant.rows[0].stock_quantity + delta < 0) {
      throw new BoutiqueError(409, `Only ${variant.rows[0].stock_quantity} in stock; ${quantity} cannot be taken out.`, 'INSUFFICIENT_STOCK');
    }
    const inserted = await client.query(
      `INSERT INTO boutique_stock_adjustments (variant_id, kind, quantity, delta, reason, status, requested_by) VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
      [variantId, kind, quantity, delta, reason, req.user.id]
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
  if (req.query.from) { values.push(dateOr(req.query.from, null, 'From')); filters.push(`c.opened_at >= $${values.length}::date`); }
  if (req.query.to) { values.push(dateOr(req.query.to, null, 'To')); filters.push(`c.opened_at < ($${values.length}::date + 1)`); }
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

router.get('/reports', asyncRoute(async (req, res) => {
  if (req.boutique === 'cashier') throw new BoutiqueError(403, 'Reports are the manager’s and the Director’s.');
  const period = resolvePeriod(req.query);
  const range = [period.start, period.end];
  const [finance, byDay, topProducts, sizes, colors, types, lowStock, byType, ordersByStatus, expensesByCategory, returns, cashiers, sessions] = await Promise.all([
    financeFigures(pool, period),
    pool.query(`SELECT sold_on AS day, COUNT(*)::int AS sales, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(discount), 0) AS discounts
                  FROM boutique_sales WHERE status <> 'voided' AND sold_on BETWEEN $1 AND $2 GROUP BY sold_on ORDER BY sold_on`, range),
    pool.query(`SELECT i.product_name, i.sku, i.size, i.color, SUM(i.quantity)::int AS pieces, SUM(i.line_total) AS revenue, SUM(i.quantity * i.unit_cost) AS cost
                  FROM boutique_sale_items i JOIN boutique_sales s ON s.id = i.sale_id WHERE s.status <> 'voided' AND s.sold_on BETWEEN $1 AND $2
                 GROUP BY i.product_name, i.sku, i.size, i.color ORDER BY pieces DESC, revenue DESC LIMIT 20`, range),
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
    pool.query(`SELECT COUNT(*)::int AS closed, COALESCE(SUM(expected_cash), 0) AS expected_cash, COALESCE(SUM(counted_cash), 0) AS counted_cash,
                       COALESCE(SUM(cash_variance), 0) AS cash_variance, COALESCE(json_agg(json_build_object('expected', expected_by_method, 'counted', counted_by_method)), '[]'::json) AS methods
                  FROM boutique_cash_sessions WHERE status = 'closed' AND closed_at >= $1::date AND closed_at < ($2::date + 1)`, range)
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

  send(res, {
    period,
    finance,
    salesByDay: byDay.rows.map((r) => ({ day: r.day, sales: r.sales, total: money(r.total), discounts: money(r.discounts) })),
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
  });
}));

// What waits for the Director: the manager's adjustment requests and void
// requests, newest first. The manager reads the same list to see what is
// still pending.
router.get('/approvals', asyncRoute(async (req, res) => {
  if (!canManage(req.boutique) && req.boutique !== 'reader') throw new BoutiqueError(403, 'Approvals are the manager’s and the Director’s.');
  const [adjustments, voids] = await Promise.all([
    pool.query(`${ADJUSTMENT_SQL} WHERE a.status = 'pending' ORDER BY a.created_at`),
    pool.query(`${SALE_SQL} WHERE s.status = 'void_requested' ORDER BY s.sold_at`)
  ]);
  send(res, { adjustments: adjustments.rows.map(mapAdjustment), voids: voids.rows.map(mapSale) });
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
