// The Boutique Management System (Project 5), end to end.
//
//   1. who gets in: the boutique's manager and cashier, the Director and the
//      General Manager (read-only); a Mining manager and a partner do not;
//   2. products and variants, with their opening stock in the ledger;
//   3. suppliers, a purchase order received in two deliveries, its invoice,
//      a payment and the balance owed;
//   4. the till: a split payment with change out of cash, the refusals
//      (underpaid, overpaid by card, out of stock, a cashier changing a
//      price), the ledger agreeing with the shelf;
//   5. a return refunded in cash and an exchange paid with credit;
//   6. voids: the manager asks, the Director decides; the Director voids at
//      once; a sale with returns cannot be voided; nothing is deleted;
//   7. stock adjustments: asked by the manager, decided by the Director,
//      applied by the Director at once;
//   8. the till closed against its expected cash, with an expense paid out of
//      it and the shortage recorded;
//   9. the books: net sales, cost of sales, gross and net profit with nothing
//      counted twice, voided sales out; the reports' sections;
//  10. the project row cannot be deleted, and the trail has every act.
//
// Drives the live API against a real database and removes what it creates.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { BOUTIQUE_PROJECT_ID } from '../shared/boutique.js';

const API = process.env.API || 'http://localhost:5000';
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });
const put = (token, path, body) => api(token, path, { method: 'PUT', body: JSON.stringify(body || {}) });
const get = (token, path) => api(token, path);

async function account(username, name, role, sector) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [username, bcrypt.hashSync('test-pass-123', 10), name, role, sector]
  );
  if (role === 'partner') await pool.query('INSERT INTO partner_operations (partner_id, sector) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.rows[0].id, sector]);
  const login = await post(null, '/api/auth/login', { username, password: 'test-pass-123' });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.body.message}`);
  return { id: row.rows[0].id, token: login.body.token };
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const startedAt = new Date();

try {
  section('setup');
  const { token: admin } = await directorSession();
  // The books are checked as DIFFERENCES from what the day already held, so
  // the suite also passes on a database where the shop traded today.
  const today = (await get(admin, '/api/boutique/overview')).body.today;
  const baseline = (await get(admin, `/api/boutique/finance?start=${today}&end=${today}`)).body;
  const baselineReport = (await get(admin, `/api/boutique/reports?period=daily&date=${today}`)).body;
  const delta = (after, before) => Math.round((Number(after) - Number(before)) * 100) / 100;
  const byMethod = (figures, method) => figures.paymentsByMethod.find((m) => m.method === method);
  const manager = await account('zz-btq-manager', 'ZZ Boutique Manager', 'manager', 'boutique');
  const cashier = await account('zz-btq-cashier', 'ZZ Boutique Cashier', 'staff', 'boutique');
  const general = await account('zz-btq-gm', 'ZZ General Manager', 'general-manager', null);
  const miner = await account('zz-btq-miner', 'ZZ Mining Manager', 'manager', 'mining');
  const partner = await account('zz-btq-partner', 'ZZ Partner', 'partner', 'boutique');

  section('1. Who gets in');
  check('the boutique manager opens the overview', (await get(manager.token, '/api/boutique/overview')).status === 200);
  check('the cashier opens it too', (await get(cashier.token, '/api/boutique/overview')).status === 200);
  check('the Director opens it', (await get(admin, '/api/boutique/overview')).status === 200);
  const gm = await get(general.token, '/api/boutique/overview');
  check('the General Manager reads it', gm.status === 200 && gm.body.role === 'reader', gm.body);
  const minerIn = await get(miner.token, '/api/boutique/overview');
  check('a Mining manager is refused', minerIn.status === 403 && minerIn.body.code === 'BOUTIQUE_ACCESS', minerIn.body);
  check('a partner is refused by the allowlist', (await get(partner.token, '/api/boutique/overview')).status === 403);
  check('the General Manager cannot add a product', (await post(general.token, '/api/boutique/products', { name: 'ZZTEST x', variants: [{ sku: 'ZZ-GM' }] })).status === 403);
  check('the cashier cannot add a product', (await post(cashier.token, '/api/boutique/products', { name: 'ZZTEST x', variants: [{ sku: 'ZZ-CA' }] })).status === 403);
  const project = (await get(admin, '/api/projects')).body.find((row) => row.id === BOUTIQUE_PROJECT_ID);
  check('PRJ-BOUTIQUE is on the Projects page with its workspace', project?.workspace === 'boutique' && project.sector === 'boutique', project);

  section('2. Products and variants');
  const dress = await post(manager.token, '/api/boutique/products', {
    name: 'ZZTEST Summer dress', productType: 'clothing', brand: 'ZZ Brand', category: 'Dresses',
    variants: [
      { sku: 'ZZ-DRESS-M-RED', size: 'M', color: 'Red', costPrice: 8000, sellingPrice: 15000, reorderLevel: 2, openingStock: 10 },
      { sku: 'ZZ-DRESS-L-BLUE', size: 'L', color: 'Blue', costPrice: 8000, sellingPrice: 15000, reorderLevel: 2, openingStock: 3 }
    ]
  });
  check('a dress with two variants is created', dress.status === 201 && dress.body.variants.length === 2, dress.body);
  const red = dress.body.variants.find((v) => v.sku === 'ZZ-DRESS-M-RED');
  const blue = dress.body.variants.find((v) => v.sku === 'ZZ-DRESS-L-BLUE');
  check('  opening stock is on the shelf', red.stockQuantity === 10 && blue.stockQuantity === 3);
  const shoes = await post(manager.token, '/api/boutique/products', {
    name: 'ZZTEST Leather shoes', productType: 'shoes', brand: 'ZZ Brand',
    variants: [{ sku: 'ZZ-SHOE-42-BLK', barcode: '6009ZZ000042', size: '42', color: 'Black', costPrice: 20000, sellingPrice: 35000, openingStock: 4 }]
  });
  check('a pair of shoes with a barcode', shoes.status === 201, shoes.body);
  const shoe = shoes.body.variants[0];
  const duplicate = await post(manager.token, `/api/boutique/products/${dress.body.id}/variants`, { sku: 'zz-dress-m-red', size: 'S', color: 'Red' });
  check('a duplicate SKU is refused', duplicate.status === 409, duplicate.body);
  const noVariant = await post(manager.token, '/api/boutique/products', { name: 'ZZTEST bare', variants: [] });
  check('a product without a variant is refused', noVariant.status === 400);
  const ledger = await get(manager.token, `/api/boutique/stock/movements?variantId=${red.id}`);
  check('the ledger holds the opening movement', ledger.body.length === 1 && ledger.body[0].kind === 'opening' && ledger.body[0].balanceAfter === 10, ledger.body);
  const barcode = await get(cashier.token, '/api/boutique/pos/search?q=6009ZZ000042');
  check('the till finds a product by barcode', barcode.status === 200 && barcode.body[0]?.id === shoe.id, barcode.body);
  const byName = await get(cashier.token, '/api/boutique/pos/search?q=ZZTEST%20summer');
  check('  and by name', byName.body.length === 2);

  section('3. Suppliers and purchases');
  const supplier = await post(manager.token, '/api/boutique/suppliers', { name: 'ZZTEST Textiles Ltd', phone: '0780000000' });
  check('a supplier is created', supplier.status === 201, supplier.body);
  const order = await post(manager.token, '/api/boutique/purchases', {
    supplierId: supplier.body.id, items: [{ variantId: blue.id, quantity: 10, unitCost: 8000 }, { variantId: shoe.id, quantity: 2, unitCost: 21000 }]
  });
  check('a purchase order is raised', order.status === 201 && order.body.status === 'ordered' && order.body.reference.startsWith('PO-'), order.body);
  const partial = await post(manager.token, `/api/boutique/purchases/${order.body.id}/receive`, { items: [{ variantId: blue.id, quantity: 6 }] });
  check('a first delivery leaves the order partially received', partial.status === 200 && partial.body.status === 'partially_received', partial.body);
  const tooMany = await post(manager.token, `/api/boutique/purchases/${order.body.id}/receive`, { items: [{ variantId: blue.id, quantity: 5 }] });
  check('  more than was ordered is refused', tooMany.status === 409, tooMany.body);
  const rest = await post(manager.token, `/api/boutique/purchases/${order.body.id}/receive`, { items: [{ variantId: blue.id, quantity: 4 }, { variantId: shoe.id, quantity: 2, unitCost: 22000 }] });
  check('the rest arrives and the order is received', rest.status === 200 && rest.body.status === 'received', rest.body);
  const blueNow = (await get(manager.token, `/api/boutique/products/${dress.body.id}`)).body.variants.find((v) => v.id === blue.id);
  check('  blue dresses: 3 + 10 on the shelf', blueNow.stockQuantity === 13, blueNow);
  const shoeNow = (await get(manager.token, `/api/boutique/products/${shoes.body.id}`)).body.variants[0];
  check('  the shoes took the delivered cost', shoeNow.stockQuantity === 6 && shoeNow.costPrice === 22000, shoeNow);
  const invoice = await put(manager.token, `/api/boutique/purchases/${order.body.id}/invoice`, { invoiceNumber: 'INV-ZZ-1', invoiceTotal: 124000 });
  check('the invoice is recorded', invoice.status === 200 && invoice.body.invoiceTotal === 124000, invoice.body);
  const payment = await post(manager.token, `/api/boutique/suppliers/${supplier.body.id}/payments`, { amount: 100000, method: 'Bank Transfer', orderId: order.body.id });
  check('a payment is recorded', payment.status === 201, payment.body);
  const owed = (await get(manager.token, `/api/boutique/suppliers/${supplier.body.id}`)).body;
  check('the balance owed is invoice less payments', owed.billed === 124000 && owed.paid === 100000 && owed.owed === 24000, owed);
  const cancelLate = await post(manager.token, `/api/boutique/purchases/${order.body.id}/cancel`, { reason: 'changed mind' });
  check('a received order cannot be cancelled', cancelLate.status === 409);

  section('4. The till');
  const till = await post(cashier.token, '/api/boutique/cash/sessions', { openingCash: 20000 });
  check('the cashier opens a till with a float', till.status === 201 && till.body.status === 'open', till.body);
  check('  a second till for the same person is refused', (await post(cashier.token, '/api/boutique/cash/sessions', { openingCash: 0 })).status === 409);
  const sale = await post(cashier.token, '/api/boutique/sales', {
    items: [{ variantId: red.id, quantity: 2 }, { variantId: shoe.id, quantity: 1 }],
    customerName: 'ZZ Customer',
    payments: [{ method: 'Mobile Money', amount: 30000, reference: 'MM123' }, { method: 'Cash', amount: 40000 }]
  });
  check('a sale with a split payment', sale.status === 201 && sale.body.number.startsWith('S-'), sale.body);
  check('  total 2×15000 + 35000 = 65000', sale.body.total === 65000, sale.body.total);
  check('  paid 70000, change 5000 out of cash', sale.body.paid === 70000 && sale.body.changeGiven === 5000, sale.body);
  check('  the cost of goods is frozen on the lines', sale.body.items.every((i) => i.unitCost > 0) && sale.body.items.find((i) => i.sku === 'ZZ-SHOE-42-BLK').unitCost === 22000, sale.body.items);
  check('  the sale is on the cashier’s till', sale.body.sessionId === till.body.id);
  const underpaid = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 10000 }] });
  check('an underpaid sale is refused', underpaid.status === 400 && underpaid.body.code === 'UNDERPAID', underpaid.body);
  const overpaidCard = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Card', amount: 20000 }] });
  check('change cannot be given out of a card payment', overpaidCard.status === 400 && overpaidCard.body.code === 'OVERPAID', overpaidCard.body);
  const outOfStock = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 50 }], payments: [{ method: 'Cash', amount: 750000 }] });
  check('selling more than the shelf holds is refused', outOfStock.status === 409 && outOfStock.body.code === 'INSUFFICIENT_STOCK', outOfStock.body);
  const override = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1, unitPrice: 1000 }], payments: [{ method: 'Cash', amount: 1000 }] });
  check('a cashier cannot change a price', override.status === 403, override.body);
  // Mobile money: the manager has no till open, and cash needs one.
  const managerOverride = await post(manager.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1, unitPrice: 12000 }], payments: [{ method: 'Mobile Money', amount: 12000 }] });
  check('the manager can, and it is audited', managerOverride.status === 201 && managerOverride.body.total === 12000, managerOverride.body);
  const overrideTrail = await pool.query(`SELECT details FROM boutique_audit WHERE entity_type = 'sale' AND entity_id = $1 AND action = 'Sale completed'`, [managerOverride.body.id]);
  check('  the override is in the trail', overrideTrail.rows[0]?.details?.priceOverrides?.[0]?.charged === 12000, overrideTrail.rows[0]?.details);
  const shelf = await pool.query('SELECT stock_quantity, (SELECT SUM(quantity) FROM boutique_stock_movements WHERE variant_id = $1)::int AS ledger FROM boutique_variants WHERE id = $1', [red.id]);
  check('the shelf agrees with the ledger: 10 − 2 − 1 = 7', shelf.rows[0].stock_quantity === 7 && shelf.rows[0].ledger === 7, shelf.rows[0]);
  const offMethod = await put(admin, '/api/boutique/payment-methods', { methods: [{ code: 'Card', active: false }] });
  check('the Director switches Card off', offMethod.status === 200 && !offMethod.body.find((m) => m.code === 'Card').active, offMethod.body);
  const cardSale = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Card', amount: 15000 }] });
  check('  and the till no longer takes it', cardSale.status === 400, cardSale.body);
  await put(admin, '/api/boutique/payment-methods', { methods: [{ code: 'Card', active: true }] });
  check('a manager cannot configure the methods', (await put(manager.token, '/api/boutique/payment-methods', { methods: [{ code: 'Card', active: false }] })).status === 403);
  const notMine = await get(cashier.token, `/api/boutique/sales/${managerOverride.body.id}`);
  check('a cashier reads only their own sales', notMine.status === 404);

  section('5. Returns and exchanges');
  const redLine = sale.body.items.find((i) => i.sku === 'ZZ-DRESS-M-RED');
  const shoeLine = sale.body.items.find((i) => i.sku === 'ZZ-SHOE-42-BLK');
  const refund = await post(cashier.token, `/api/boutique/sales/${sale.body.id}/returns`, {
    items: [{ saleItemId: redLine.id, quantity: 1, restock: true }], reason: 'Wrong size', refundMethod: 'Cash'
  });
  check('one dress is returned and refunded in cash', refund.status === 201 && refund.body.sale.returns.length === 1, refund.body);
  const ret = refund.body.sale.returns[0];
  check('  the refund is what was paid for it: 15000', ret.value === 15000 && ret.refundTotal === 15000 && ret.refundMethod === 'Cash', ret);
  check('  it is back on the shelf: 8', (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [red.id])).rows[0].stock_quantity === 8);
  const tooManyBack = await post(cashier.token, `/api/boutique/sales/${sale.body.id}/returns`, { items: [{ saleItemId: redLine.id, quantity: 2 }], reason: 'x', refundMethod: 'Cash' });
  check('more than was sold cannot come back', tooManyBack.status === 409, tooManyBack.body);
  // The shoes (35000) exchanged for a blue dress (15000) and 20000 refunded
  // in cash.
  const exchange = await post(cashier.token, `/api/boutique/sales/${sale.body.id}/returns`, {
    items: [{ saleItemId: shoeLine.id, quantity: 1, restock: true }], reason: 'Exchange for a dress', refundMethod: 'Cash',
    exchange: { items: [{ variantId: blue.id, quantity: 1 }], payments: [] }
  });
  check('an exchange creates a new sale', exchange.status === 201 && exchange.body.exchangeSale?.number, exchange.body);
  const ex = exchange.body.sale.returns.find((r) => r.kind === 'exchange');
  check('  credit 15000 used, 20000 refunded', ex.value === 35000 && ex.refundTotal === 20000 && ex.exchangeSaleId === exchange.body.exchangeSale.id, ex);
  check('  the new sale is paid by exchange credit alone', exchange.body.exchangeSale.payments.length === 1 && exchange.body.exchangeSale.payments[0].method === 'Exchange credit' && exchange.body.exchangeSale.payments[0].amount === 15000, exchange.body.exchangeSale.payments);
  check('  with no change', exchange.body.exchangeSale.changeGiven === 0);
  // The manager's own sale: a cashier can only take returns on sales they
  // made themselves (the API answers 404 for anybody else's, like the read).
  const notTheirs = await post(cashier.token, `/api/boutique/sales/${managerOverride.body.id}/returns`, {
    items: [{ saleItemId: managerOverride.body.items[0].id, quantity: 1 }], reason: 'Not my sale', refundMethod: 'Cash'
  });
  check('a cashier cannot take a return on another person’s sale', notTheirs.status === 404, notTheirs.body);
  // The manager has no till open yet, so the top-up is paid by mobile money
  // (cash would need an open till -- checked in section 11).
  const topUp = await post(manager.token, `/api/boutique/sales/${managerOverride.body.id}/returns`, {
    items: [{ saleItemId: managerOverride.body.items[0].id, quantity: 1 }], reason: 'Exchange up',
    exchange: { items: [{ variantId: shoe.id, quantity: 1 }], payments: [{ method: 'Mobile Money', amount: 23000 }] }
  });
  check('an exchange for something dearer takes the difference', topUp.status === 201 && topUp.body.exchangeSale.total === 35000 && topUp.body.exchangeSale.paid === 35000, topUp.body);
  const voidExchangeSale = await post(admin, `/api/boutique/sales/${topUp.body.exchangeSale.id}/void`, { reason: 'Trying to void the new half of an exchange' });
  check('the new half of an exchange cannot be voided', voidExchangeSale.status === 409, voidExchangeSale.body);

  section('6. Voids');
  const toVoid = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 15000 }] });
  const shortReason = await post(manager.token, `/api/boutique/sales/${toVoid.body.id}/void`, { reason: 'oops' });
  check('a void needs a reason of at least 10 characters', shortReason.status === 400);
  const asked = await post(manager.token, `/api/boutique/sales/${toVoid.body.id}/void`, { reason: 'Rung up twice by mistake' });
  check('the manager asks for a void', asked.status === 200 && asked.body.status === 'void_requested', asked.body);
  const queue = await get(admin, '/api/boutique/approvals');
  check('  it waits for the Director', queue.body.voids.some((s) => s.id === toVoid.body.id), queue.body);
  const directorTold = await get(admin, '/api/notifications?limit=10');
  check('  who was told', (directorTold.body.items || []).some((n) => n.kind === 'boutique_approval_requested'), directorTold.body.items?.map((n) => n.kind));
  check('  the manager cannot decide it', (await post(manager.token, `/api/boutique/sales/${toVoid.body.id}/void-decision`, { approve: true })).status === 403);
  const before = (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [red.id])).rows[0].stock_quantity;
  const voided = await post(admin, `/api/boutique/sales/${toVoid.body.id}/void-decision`, { approve: true });
  check('the Director approves: voided, goods back', voided.status === 200 && voided.body.status === 'voided', voided.body);
  check('  the dress is back on the shelf', (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [red.id])).rows[0].stock_quantity === before + 1);
  const managerTold = await get(manager.token, '/api/notifications?limit=10');
  check('  the manager is told', (managerTold.body.items || []).some((n) => n.kind === 'boutique_approval_decided'), managerTold.body.items?.map((n) => n.kind));
  const stillThere = await pool.query('SELECT status FROM boutique_sales WHERE id = $1', [toVoid.body.id]);
  check('  the row is still there, marked', stillThere.rows[0]?.status === 'voided');
  const withReturns = await post(manager.token, `/api/boutique/sales/${sale.body.id}/void`, { reason: 'Trying to void a sale with returns' });
  check('a sale with returns cannot be voided', withReturns.status === 409, withReturns.body);
  const direct = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: blue.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 15000 }] });
  const directVoid = await post(admin, `/api/boutique/sales/${direct.body.id}/void`, { reason: 'Director voids directly' });
  check('the Director voids at once', directVoid.status === 200 && directVoid.body.status === 'voided', directVoid.body);
  const keep = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Mobile Money', amount: 15000 }] });
  const refused = await post(manager.token, `/api/boutique/sales/${keep.body.id}/void`, { reason: 'Second thoughts about it' });
  const refusal = await post(admin, `/api/boutique/sales/${keep.body.id}/void-decision`, { approve: false, note: 'short' });
  check('refusing needs a note of 10 characters', refused.status === 200 && refusal.status === 400, [refused.body, refusal.body]);
  const refusedOk = await post(admin, `/api/boutique/sales/${keep.body.id}/void-decision`, { approve: false, note: 'The sale was correct, keep it.' });
  check('a refused void leaves the sale completed', refusedOk.status === 200 && refusedOk.body.status === 'completed', refusedOk.body);

  section('7. Stock adjustments');
  const adj = await post(manager.token, '/api/boutique/stock/adjustments', { variantId: blue.id, kind: 'damaged', quantity: 2, reason: 'Water damage in the store room' });
  check('the manager asks to write off two dresses', adj.status === 201 && adj.body.status === 'pending' && adj.body.delta === -2, adj.body);
  const blueBefore = (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [blue.id])).rows[0].stock_quantity;
  check('  nothing moves until the Director decides', (await pool.query('SELECT COUNT(*)::int AS n FROM boutique_stock_movements WHERE kind = $1 AND variant_id = $2', ['damaged', blue.id])).rows[0].n === 0);
  check('  the cashier cannot ask', (await post(cashier.token, '/api/boutique/stock/adjustments', { variantId: blue.id, kind: 'missing', quantity: 1, reason: 'cannot find it' })).status === 403);
  const approvedAdj = await post(admin, `/api/boutique/stock/adjustments/${adj.body.id}/decision`, { approve: true });
  check('the Director approves and the stock moves', approvedAdj.status === 200 && approvedAdj.body.status === 'approved', approvedAdj.body);
  check('  by two', (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [blue.id])).rows[0].stock_quantity === blueBefore - 2);
  const count = await post(manager.token, '/api/boutique/stock/adjustments', { variantId: red.id, kind: 'count', quantity: 5, reason: 'Physical count at month end' });
  const countRefused = await post(admin, `/api/boutique/stock/adjustments/${count.body.id}/decision`, { approve: false, note: 'Count again with the manager present.' });
  check('a count correction can be refused with a note', countRefused.status === 200 && countRefused.body.status === 'rejected', countRefused.body);
  const redBefore = (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [red.id])).rows[0].stock_quantity;
  const directorCount = await post(admin, '/api/boutique/stock/adjustments', { variantId: red.id, kind: 'count', quantity: redBefore - 1, reason: 'Director counted the rail' });
  check('the Director’s own count applies at once', directorCount.status === 201 && directorCount.body.status === 'approved' && directorCount.body.delta === -1, directorCount.body);
  const transferIn = await post(admin, '/api/boutique/stock/adjustments', { variantId: shoe.id, kind: 'transfer_in', quantity: 3, reason: 'From the Kigali shop' });
  check('a transfer in adds stock', transferIn.status === 201 && transferIn.body.delta === 3, transferIn.body);
  const tooMuchOut = await post(manager.token, '/api/boutique/stock/adjustments', { variantId: shoe.id, kind: 'transfer_out', quantity: 999, reason: 'To the Kigali shop' });
  check('a transfer out of more than the shelf is refused', tooMuchOut.status === 409, tooMuchOut.body);

  section('8. Closing the till');
  const payout = await post(cashier.token, `/api/boutique/cash/sessions/${till.body.id}/movements`, { kind: 'payout', amount: 5000, reason: 'Cash to the bank' });
  check('a payout is recorded on the till', payout.status === 200 && payout.body.figures.payouts === 5000, payout.body);
  const managerTill = await post(manager.token, '/api/boutique/cash/sessions', { openingCash: 0 });
  const expense = await post(manager.token, '/api/boutique/expenses', { category: 'Shop supplies', description: 'ZZTEST hangers', amount: 3000, method: 'Cash', fromTill: true });
  check('the manager pays an expense out of their own till', expense.status === 201 && expense.body.sessionId === managerTill.body.id, expense.body);
  const bankExpense = await post(manager.token, '/api/boutique/expenses', { category: 'Rent and utilities', description: 'ZZTEST electricity', amount: 20000, method: 'Bank Transfer' });
  check('an expense paid from the bank names no till', bankExpense.status === 201 && bankExpense.body.sessionId === null, bankExpense.body);
  const current = await get(cashier.token, '/api/boutique/cash/sessions/current');
  // Cash on the cashier's till: 20000 float + 40000 taken − 5000 change
  // − 15000 refund − 20000 refund (exchange) − 5000 payout. The two voided
  // cash sales count as never taken; the mobile-money sales are not cash.
  const expectedCash = 20000 + 40000 - 5000 - 15000 - 20000 - 5000;
  check(`expected cash is worked out live: ${expectedCash}`, current.body.expectedCash === expectedCash, current.body);
  check('  mobile money expected 30000 + 15000', current.body.expectedByMethod['Mobile Money'] === 45000, current.body.expectedByMethod);
  const closed = await post(cashier.token, `/api/boutique/cash/sessions/${till.body.id}/close`, { countedCash: expectedCash - 2000, countedByMethod: { 'Mobile Money': 45000 }, note: 'ZZ close' });
  check('the till closes with a 2000 shortage', closed.status === 200 && closed.body.status === 'closed' && closed.body.cashVariance === -2000, closed.body);
  check('  the expected figure is frozen', closed.body.expectedCash === expectedCash);
  const cashNoTill = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 15000 }] });
  check('  with the till closed, cash cannot be taken', cashNoTill.status === 409 && cashNoTill.body.code === 'NO_OPEN_TILL', cashNoTill.body);
  const mobileNoTill = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: red.id, quantity: 1 }], payments: [{ method: 'Mobile Money', amount: 15000 }] });
  check('  but mobile money can, on no till', mobileNoTill.status === 201 && mobileNoTill.body.sessionId === null, mobileNoTill.body);
  check('  and cannot be closed again', (await post(cashier.token, `/api/boutique/cash/sessions/${till.body.id}/close`, { countedCash: 0 })).status === 409);
  const managerClose = await post(manager.token, `/api/boutique/cash/sessions/${managerTill.body.id}/close`, { countedCash: 0 });
  check('the manager’s till expected −3000 after the expense, counted 0', managerClose.body.expectedCash === -3000 && managerClose.body.cashVariance === 3000, managerClose.body);
  const voidExpense = await post(admin, `/api/boutique/expenses/${bankExpense.body.id}/void`, { reason: 'Entered twice, see the other row' });
  check('the Director voids an expense with a reason', voidExpense.status === 200 && voidExpense.body.status === 'voided', voidExpense.body);
  check('  the manager cannot', (await post(manager.token, `/api/boutique/expenses/${expense.body.id}/void`, { reason: 'Trying to void an expense' })).status === 403);

  section('9. The books and the reports');
  const books = await get(admin, `/api/boutique/finance?start=${today}&end=${today}`);
  check('the books open', books.status === 200, books.body);
  const f = books.body;
  // Completed sales today: 65000 (split), 12000 (override), 15000 (exchange
  // sale), 35000 (top-up exchange sale), 15000 (kept after a refused void),
  // 15000 (after close). Voided: 15000 ×2.
  const grossSales = 65000 + 12000 + 15000 + 35000 + 15000 + 15000;
  check(`  gross sales ${grossSales}, voided ones out`, delta(f.sales.gross, baseline.sales.gross) === grossSales, [f.sales, baseline.sales]);
  // Returned value: 15000 + 35000 + 12000 = 62000.
  check('  returns 62000', delta(f.returns.value, baseline.returns.value) === 62000, [f.returns, baseline.returns]);
  check('  net sales = gross − returns', delta(f.netSales, baseline.netSales) === grossSales - 62000, [f.netSales, baseline.netSales]);
  // Cost of sales: sold 2×8000 + 22000 + 8000 + 8000 + 22000 + 8000 + 8000 =
  // 92000, less restocked returns 8000 + 22000 + 8000 = 38000.
  check('  cost of sales 54000', delta(f.costOfSales, baseline.costOfSales) === 92000 - 38000, [f.costOfSales, baseline.costOfSales]);
  check('  gross profit = net sales − cost of sales', books.body.grossProfit === books.body.netSales - books.body.costOfSales);
  check('  expenses 3000 (the voided 20000 out)', delta(f.expenses.total, baseline.expenses.total) === 3000, [f.expenses, baseline.expenses]);
  check('  net profit = gross profit − expenses', near(f.netProfit, f.grossProfit - f.expenses.total), [f.netProfit, f.grossProfit, f.expenses.total]);
  const cashReceived = byMethod(f, 'Cash');
  const cashBefore = byMethod(baseline, 'Cash');
  // Cash taken on completed sales: 40000 (the split sale); change 5000;
  // refunded in cash 15000 + 20000. Everything else today was mobile money.
  check('  cash received = taken − change − refunds', delta(cashReceived.taken, cashBefore.taken) === 40000
    && delta(cashReceived.received, cashBefore.received) === 40000 - 5000 - 35000, [cashReceived, cashBefore]);
  // 30000 (split sale) + 12000 (override) + 23000 (top-up) + 15000 (kept) + 15000 (after close).
  check('  mobile money received 95000', delta(byMethod(f, 'Mobile Money').received, byMethod(baseline, 'Mobile Money').received) === 95000, byMethod(f, 'Mobile Money'));
  check('  exchange credit is not money received', !books.body.paymentsByMethod.some((m) => m.method === 'Exchange credit'));
  check('  purchases are beside the books, not in the expenses', delta(f.purchases.pieces, baseline.purchases.pieces) === 12
    && delta(f.purchases.value, baseline.purchases.value) === 6 * 8000 + 4 * 8000 + 2 * 22000, [f.purchases, baseline.purchases]);
  check('  inventory value is on the shelf at cost', books.body.inventory.value > 0 && near(books.body.inventory.value, (await pool.query('SELECT SUM(stock_quantity * cost_price) AS v FROM boutique_variants')).rows[0].v));
  check('  the supplier balance grew by 24000', delta(f.supplierBalance, baseline.supplierBalance) === 24000, [f.supplierBalance, baseline.supplierBalance]);
  const report = await get(manager.token, `/api/boutique/reports?period=daily&date=${today}`);
  check('the daily report has every section', report.status === 200 && ['salesByDay', 'topProducts', 'sizeDemand', 'colorDemand', 'inventory', 'purchases', 'expensesByCategory', 'returns', 'paymentReconciliation', 'cashierPerformance'].every((k) => report.body[k]), Object.keys(report.body));
  const cashierRow = report.body.cashierPerformance.find((r) => r.cashierId === cashier.id);
  // The split sale, the exchange's new sale, the kept sale, the one after
  // closing; the top-up exchange was the manager's.
  check('  the cashier’s performance: 4 completed sales, 2 voided', cashierRow?.sales === 4 && cashierRow.voided === 2, cashierRow);
  const cashRecon = report.body.paymentReconciliation.methods.find((m) => m.method === 'Cash');
  const reconBefore = baselineReport.paymentReconciliation;
  const cashReconBefore = reconBefore.methods.find((m) => m.method === 'Cash');
  check('  cash reconciliation: two tills closed, 2000 short and 3000 over', report.body.paymentReconciliation.closedSessions - reconBefore.closedSessions === 2
    && delta(cashRecon.tillVariance, cashReconBefore.tillVariance || 0) === -2000 + 3000, [report.body.paymentReconciliation, reconBefore]);
  check('  size demand names M', report.body.sizeDemand.some((s) => s.size === 'M'));
  check('a cashier cannot read the books', (await get(cashier.token, '/api/boutique/finance')).status === 403);
  check('the General Manager can', (await get(general.token, `/api/boutique/reports?period=monthly&month=${today.slice(0, 7)}`)).status === 200);
  const weekly = await get(admin, '/api/boutique/reports?period=weekly');
  check('a weekly report covers seven days', weekly.status === 200 && weekly.body.period.start < weekly.body.period.end, weekly.body.period);
  const badMonth = await get(admin, '/api/boutique/reports?period=monthly&month=2026-13');
  check('a bad month is a 400', badMonth.status === 400);

  section('10. Nothing deleted, everything in the trail');
  const noDelete = await api(admin, `/api/projects/${BOUTIQUE_PROJECT_ID}`, { method: 'DELETE' });
  check('the boutique project cannot be deleted', noDelete.status === 409 && noDelete.body.code === 'PROJECT_ANCHORED', noDelete.body);
  const trail = await get(admin, '/api/boutique/audit?limit=200');
  const actions = new Set(trail.body.map((row) => row.action));
  check('the trail records every kind of act', ['Product created', 'Variant created', 'Purchase order raised', 'Goods received', 'Invoice recorded', 'Supplier paid', 'Till opened', 'Sale completed', 'Return recorded', 'Exchange recorded', 'Void requested', 'Void approved', 'Sale voided', 'Void refused', 'Adjustment requested', 'Adjustment approved', 'Adjustment refused', 'Stock adjusted', 'Cash paid out', 'Expense recorded', 'Till closed', 'Expense voided', 'Payment methods changed'].every((a) => actions.has(a)), [...actions]);
  check('  a cashier cannot read it', (await get(cashier.token, '/api/boutique/audit')).status === 403);
  const forbidden = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'boutique%' AND (column_name ILIKE '%wallet%' OR column_name ILIKE '%gateway%' OR column_name ILIKE '%transfer_to%')`);
  check('no wallet, gateway or transfer concept in the schema', forbidden.rowCount === 0, forbidden.rows);

  section('11. What the audit found, kept fixed');
  // H1: a discount is a price change; a cashier can give neither.
  const lineOff = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: blue.id, quantity: 1, discount: 15000 }], payments: [{ method: 'Mobile Money', amount: 0 }] });
  check('a cashier cannot give a line discount', lineOff.status === 403, lineOff.body);
  const saleOff = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: blue.id, quantity: 1 }], discount: 15000, payments: [{ method: 'Mobile Money', amount: 0 }] });
  check('  nor a discount on the sale', saleOff.status === 403, saleOff.body);
  // H3: change is counted once per sale, however many cash lines paid it.
  const till2 = await post(cashier.token, '/api/boutique/cash/sessions', { openingCash: 0 });
  const twoNotes = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: blue.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 10000 }, { method: 'Cash', amount: 10000 }] });
  check('a sale paid with two cash lines', twoNotes.status === 201 && twoNotes.body.changeGiven === 5000, twoNotes.body);
  const till2Now = await get(cashier.token, '/api/boutique/cash/sessions/current');
  check('  takes its change out of the till once: 20000 − 5000', till2Now.body.expectedCash === 15000, till2Now.body);
  // M2: a cashier's return always restocks; keeping goods off the shelf is
  // the manager's write-off.
  const keepOff = await post(cashier.token, `/api/boutique/sales/${twoNotes.body.id}/returns`, { items: [{ saleItemId: twoNotes.body.items[0].id, quantity: 1, restock: false }], reason: 'Damaged on the way out', refundMethod: 'Cash' });
  check('a cashier cannot keep a returned item off the shelf', keepOff.status === 403, keepOff.body);
  // H4: a return refunds what was paid after the sale-level discount, and
  // the returns against a sale can never exceed what it took.
  const managerTill2 = await post(manager.token, '/api/boutique/cash/sessions', { openingCash: 0 });
  check('the manager opens a till again', managerTill2.status === 201, managerTill2.body);
  const discounted = await post(manager.token, '/api/boutique/sales', { items: [{ variantId: blue.id, quantity: 2 }], discount: 10000, payments: [{ method: 'Cash', amount: 20000 }] });
  check('two dresses at 15000 with 10000 off the sale: 20000 paid', discounted.status === 201 && discounted.body.total === 20000, discounted.body);
  const half = await post(manager.token, `/api/boutique/sales/${discounted.body.id}/returns`, { items: [{ saleItemId: discounted.body.items[0].id, quantity: 1 }], reason: 'One back', refundMethod: 'Cash' });
  check('  returning one refunds 10000, what was paid for it, not 15000', half.status === 201 && half.body.sale.returns[0].refundTotal === 10000, half.body.sale?.returns);
  const other = await post(manager.token, `/api/boutique/sales/${discounted.body.id}/returns`, { items: [{ saleItemId: discounted.body.items[0].id, quantity: 1 }], reason: 'The other', refundMethod: 'Cash' });
  check('  and the second one the remaining 10000', other.status === 201 && other.body.sale.returns[1].refundTotal === 10000, other.body.sale?.returns);
  const nothingLeft = await post(manager.token, `/api/boutique/sales/${discounted.body.id}/returns`, { items: [{ saleItemId: discounted.body.items[0].id, quantity: 1 }], reason: 'A third', refundMethod: 'Cash' });
  check('  a third return is refused', nothingLeft.status === 409, nothingLeft.body);
  // H2: cash needs a till, for refunds as for sales.
  await post(manager.token, `/api/boutique/cash/sessions/${managerTill2.body.id}/close`, { countedCash: 0 });
  const refundNoTill = await post(manager.token, `/api/boutique/sales/${twoNotes.body.id}/returns`, { items: [{ saleItemId: twoNotes.body.items[0].id, quantity: 1 }], reason: 'Customer changed their mind', refundMethod: 'Cash' });
  check('a cash refund with no till open is refused', refundNoTill.status === 409 && refundNoTill.body.code === 'NO_OPEN_TILL', refundNoTill.body);
  const refundMobile = await post(manager.token, `/api/boutique/sales/${twoNotes.body.id}/returns`, { items: [{ saleItemId: twoNotes.body.items[0].id, quantity: 1 }], reason: 'Customer changed their mind', refundMethod: 'Mobile Money' });
  check('  a mobile-money refund is not', refundMobile.status === 201, refundMobile.body);
  // M1: what a cashier is not shown, the API does not give either.
  for (const path of ['/api/boutique/suppliers', `/api/boutique/suppliers/${supplier.body.id}`, '/api/boutique/purchases', `/api/boutique/purchases/${order.body.id}`, '/api/boutique/expenses', '/api/boutique/stock/adjustments']) {
    check(`a cashier cannot read ${path.replace(/\/\d+$/, '/:id')}`, (await get(cashier.token, path)).status === 403);
  }
  const cashierStock = await get(cashier.token, '/api/boutique/stock?search=ZZTEST');
  check('a cashier’s stock list carries no purchase cost', cashierStock.status === 200 && cashierStock.body.items.length > 0 && cashierStock.body.items.every((v) => v.costPrice === undefined) && cashierStock.body.value === null, cashierStock.body.items?.[0]);
  const cashierSearch = await get(cashier.token, '/api/boutique/pos/search?q=ZZTEST');
  check('  nor the till search', cashierSearch.body.every((v) => v.costPrice === undefined));
  const cashierCatalogue = await get(cashier.token, `/api/boutique/products/${dress.body.id}`);
  check('  nor the catalogue', cashierCatalogue.body.variants.every((v) => v.costPrice === undefined));
  const cashierOverview = await get(cashier.token, '/api/boutique/overview');
  check('  nor the overview', cashierOverview.body.stockValue === null && cashierOverview.body.supplierBalance === null);
  check('  while the manager still sees the cost', (await get(manager.token, '/api/boutique/stock?search=ZZTEST')).body.items.every((v) => typeof v.costPrice === 'number'));
  // M5: six cashiers reach for the last piece at the same moment.
  const lastOne = await post(manager.token, `/api/boutique/products/${shoes.body.id}/variants`, { sku: 'ZZ-SHOE-45-BLK', size: '45', color: 'Black', costPrice: 20000, sellingPrice: 35000, openingStock: 1 });
  const last = lastOne.body.variants.find((v) => v.sku === 'ZZ-SHOE-45-BLK');
  const rush = await Promise.all(Array.from({ length: 6 }, () => post(cashier.token, '/api/boutique/sales', { items: [{ variantId: last.id, quantity: 1 }], payments: [{ method: 'Cash', amount: 35000 }] })));
  const rushStatuses = rush.map((r) => r.status).sort();
  check('one sale succeeds, five are refused, none fails', rushStatuses.filter((s) => s === 201).length === 1 && rushStatuses.filter((s) => s === 409).length === 5, rushStatuses);
  const lastShelf = await pool.query('SELECT stock_quantity, (SELECT SUM(quantity) FROM boutique_stock_movements WHERE variant_id = $1)::int AS ledger FROM boutique_variants WHERE id = $1', [last.id]);
  check('  the shelf is at 0 and the ledger agrees', lastShelf.rows[0].stock_quantity === 0 && lastShelf.rows[0].ledger === 0, lastShelf.rows[0]);

  section('12. The Boutique Manager reports directly to the Director');
  // The line: created through the API, a boutique manager reports to the
  // Director without anybody choosing it, and cannot be put under the General
  // Manager or another manager.
  const directorRow = (await pool.query("SELECT id FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1")).rows[0];
  const viaApi = await post(admin, '/api/users', { username: 'zz-btq-manager2', name: 'ZZ Boutique Manager 2', role: 'manager', sector: 'boutique', password: 'temporary-pass-123' });
  check('a boutique manager created by the Director', viaApi.status === 201, viaApi.body);
  const line = await pool.query('SELECT manager_id FROM users WHERE id = $1', [viaApi.body.id]);
  check('  reports to the Director from the start', line.rows[0]?.manager_id === directorRow.id, line.rows[0]);
  const underGm = await api(admin, `/api/users/${viaApi.body.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ managerId: general.id }) });
  check('  cannot be put under the General Manager', underGm.status === 400, underGm.body);
  const underMiner = await api(admin, `/api/users/${viaApi.body.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ managerId: miner.id }) });
  check('  nor under another project manager', underMiner.status === 400, underMiner.body);
  const stillDirector = await pool.query('SELECT manager_id FROM users WHERE id = $1', [viaApi.body.id]);
  check('  and still reports to the Director', stillDirector.rows[0]?.manager_id === directorRow.id);
  const sqlBypass = await pool.query('UPDATE users SET manager_id = $2 WHERE id = $1', [viaApi.body.id, general.id]).then(() => 'allowed', (e) => e.code);
  check('  the trigger refuses it even by SQL', sqlBypass === 'P0001', sqlBypass);
  const minerLine = await api(admin, `/api/users/${miner.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ managerId: general.id }) });
  check('a Mining manager still reports to the General Manager as before', minerLine.status === 200 && minerLine.body.managerId === general.id, minerLine.body);
  const chart = await get(admin, '/api/organization');
  const onChart = (chart.body.people || []).find((p) => p.id === viaApi.body.id);
  check('the chart shows the boutique manager under the Director', onChart && onChart.reportsToId === directorRow.id, onChart);

  // The report: sent with its figures frozen, straight to every Director.
  const sent = await post(manager.token, '/api/boutique/submissions/report', { period: 'daily', date: today, note: 'Quiet day, one till short by 2000.' });
  check('the manager sends today’s report to the Director', sent.status === 201 && sent.body.status === 'submitted' && sent.body.snapshot?.finance, sent.body);
  const directorBell = (await get(admin, '/api/notifications?limit=10')).body.items || [];
  const reportNotice = directorBell.find((n) => n.kind === 'boutique_report_submitted');
  check('  the Director is told directly', Boolean(reportNotice) && reportNotice.link.includes(`submission=${sent.body.id}`), directorBell.map((n) => n.kind));
  const gmBell = (await get(general.token, '/api/notifications?limit=10')).body.items || [];
  check('  the General Manager is not in the chain', !gmBell.some((n) => n.kind === 'boutique_report_submitted'), gmBell.map((n) => n.kind));
  check('  a cashier cannot send one', (await post(cashier.token, '/api/boutique/submissions/report', { period: 'daily' })).status === 403);
  check('  a Mining manager cannot read them', (await get(miner.token, '/api/boutique/submissions')).status === 403);
  check('  the General Manager reads them but cannot decide', (await get(general.token, '/api/boutique/submissions')).status === 200
    && (await post(general.token, `/api/boutique/submissions/${sent.body.id}/decision`, { decision: 'accepted' })).status === 403);
  check('  nor can the manager decide their own', (await post(manager.token, `/api/boutique/submissions/${sent.body.id}/decision`, { decision: 'accepted' })).status === 403);
  check('  it is in the Director’s queue', ((await get(admin, '/api/boutique/approvals')).body.submissions || []).some((s) => s.id === sent.body.id));
  check('  and in the Director’s badge', (await get(admin, '/api/summary')).body.summary.boutiquePending >= 1);
  const shortReturn = await post(admin, `/api/boutique/submissions/${sent.body.id}/decision`, { decision: 'returned', note: 'why' });
  check('returning needs a note of 10 characters', shortReturn.status === 400, shortReturn.body);
  const returned = await post(admin, `/api/boutique/submissions/${sent.body.id}/decision`, { decision: 'returned', note: 'Explain the 2000 shortage on the cashier’s till.' });
  check('the Director returns it with a note', returned.status === 200 && returned.body.status === 'returned' && returned.body.decidedBy === directorRow.id, returned.body);
  const managerBell = (await get(manager.token, '/api/notifications?limit=10')).body.items || [];
  check('  the manager is told, with the note', managerBell.some((n) => n.kind === 'boutique_submission_decided' && n.params?.outcome === 'returned' && n.params?.reason?.includes('2000')), managerBell.map((n) => [n.kind, n.params?.outcome]));
  check('  it cannot be answered twice', (await post(admin, `/api/boutique/submissions/${sent.body.id}/decision`, { decision: 'accepted' })).status === 409);
  const trailRow = await pool.query(`SELECT actor_id, details FROM boutique_audit WHERE entity_type = 'submission' AND entity_id = $1 AND action = 'Submission returned'`, [sent.body.id]);
  check('  the decision, who took it and the note are in the trail', trailRow.rows[0]?.actor_id === directorRow.id && trailRow.rows[0].details.note.includes('2000'), trailRow.rows[0]);

  // An issue, and its acceptance.
  const issue = await post(manager.token, '/api/boutique/submissions/incident', { title: 'ZZTEST Leaking roof over the shoe rail', note: 'Rain came in overnight; three pairs damaged. Roofer needed.' });
  check('the manager raises an issue', issue.status === 201 && issue.body.kind === 'incident', issue.body);
  check('  the Director is told', ((await get(admin, '/api/notifications?limit=10')).body.items || []).some((n) => n.kind === 'boutique_issue_raised'));
  const accepted = await post(admin, `/api/boutique/submissions/${issue.body.id}/decision`, { decision: 'accepted', note: 'Roofer booked for Monday.' });
  check('  the Director accepts it', accepted.status === 200 && accepted.body.status === 'accepted', accepted.body);
  const noIssue = await post(manager.token, '/api/boutique/submissions/incident', { title: 'x', note: 'short' });
  check('  an issue needs words', noIssue.status === 400);

  // The alert: a sale that takes a shelf down to its reorder level tells the
  // Director and the manager, once.
  const watched = (await post(manager.token, `/api/boutique/products/${dress.body.id}/variants`, { sku: 'ZZ-DRESS-XL-GRN', size: 'XL', color: 'Green', costPrice: 8000, sellingPrice: 15000, reorderLevel: 2, openingStock: 4 })).body.variants.find((v) => v.sku === 'ZZ-DRESS-XL-GRN');
  const sellOne = () => post(cashier.token, '/api/boutique/sales', { items: [{ variantId: watched.id, quantity: 1 }], payments: [{ method: 'Mobile Money', amount: 15000 }] });
  const lowNotices = async (token) => ((await get(token, '/api/notifications?limit=30')).body.items || []).filter((n) => n.kind === 'boutique_low_stock' && n.params?.title?.includes('ZZ-DRESS-XL-GRN'));
  await sellOne();
  check('4 → 3, above the reorder level of 2: no alert', (await lowNotices(admin)).length === 0);
  await sellOne();
  check('3 → 2, at the reorder level: the Director is alerted', (await lowNotices(admin)).length === 1, await lowNotices(admin));
  check('  and the manager', (await lowNotices(manager.token)).length === 1);
  check('  not the General Manager', (await lowNotices(general.token)).length === 0);
  await sellOne();
  check('2 → 1: no second alert', (await lowNotices(admin)).length === 1);

  section('13. A local shop: the simple product, its price and its stock');
  // The everyday form: a name, a category, how many and the price of one.
  // No product code is typed; the shop gives one.
  const key = `zz-key-${Date.now()}`;
  const sugarBody = { name: 'ZZTEST Sugar 1 kg', productType: 'groceries', requestKey: key, variants: [{ sellingPrice: 1500, costPrice: 1200, reorderLevel: 5, openingStock: 20 }] };
  const sugar = await post(manager.token, '/api/boutique/products', sugarBody);
  const sugarVariant = sugar.body.variants?.[0];
  check('a product is added with just a name, category, quantity and price', sugar.status === 201 && sugar.body.productType === 'groceries'
    && sugarVariant?.stockQuantity === 20 && near(sugarVariant?.sellingPrice, 1500), sugar.body);
  check('  and is given its own product code', /^ITEM-\d{5}$/.test(sugarVariant?.sku || ''), sugarVariant?.sku);
  const again = await post(manager.token, '/api/boutique/products', sugarBody);
  const sugarRows = await pool.query(`SELECT COUNT(*)::int AS n FROM boutique_products WHERE name = 'ZZTEST Sugar 1 kg'`);
  check('pressing Save twice adds it once', again.status === 200 && again.body.id === sugar.body.id && sugarRows.rows[0].n === 1, again.body);
  const twin = await post(manager.token, '/api/boutique/products', { ...sugarBody, name: 'zztest sugar 1 KG', requestKey: `${key}-b` });
  check('a second product with the same name is refused, not merged', twin.status === 409 && twin.body.code === 'PRODUCT_EXISTS', twin.body);
  const badPrice = await post(manager.token, '/api/boutique/products', { name: 'ZZTEST Bad price', variants: [{ sellingPrice: -5 }] });
  check('a negative price is refused', badPrice.status === 400, badPrice.body);
  const badQty = await post(manager.token, '/api/boutique/products', { name: 'ZZTEST Bad qty', variants: [{ sellingPrice: 100, openingStock: 2.5 }] });
  check('a quantity that is not a whole number is refused', badQty.status === 400, badQty.body);
  const badType = await post(manager.token, '/api/boutique/products', { name: 'ZZTEST Bad type', productType: 'spaceships', variants: [{ sellingPrice: 100 }] });
  check('an unknown category is refused', badType.status === 400, badType.body);
  check('a cashier cannot change a price', (await put(cashier.token, `/api/boutique/variants/${sugarVariant.id}`, { sellingPrice: 1 })).status === 403);
  check('a cashier cannot change stock', (await post(cashier.token, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'received', quantity: 5 })).status === 403);

  // A price change does not rewrite a sale already made.
  const sold = await post(cashier.token, '/api/boutique/sales', { items: [{ variantId: sugarVariant.id, quantity: 1 }], payments: [{ method: 'Mobile Money', amount: 1500 }] });
  check('one bag of sugar is sold at 1,500', sold.status === 201, sold.body);
  const repriced = await put(manager.token, `/api/boutique/variants/${sugarVariant.id}`, { sellingPrice: 1800 });
  const repricedVariant = repriced.body.variants?.find((v) => v.id === sugarVariant.id);
  check('the manager changes the price to 1,800', repriced.status === 200 && near(repricedVariant?.sellingPrice, 1800)
    && repricedVariant?.sku === sugarVariant.sku && repricedVariant?.stockQuantity === 19, repricedVariant);
  const soldAfter = await get(admin, `/api/boutique/sales/${sold.body.id}`);
  check('  the earlier sale keeps the price it was sold at', near(soldAfter.body.items?.[0]?.unitPrice, 1500), soldAfter.body.items);
  const priceTrail = await pool.query(`SELECT details FROM boutique_audit WHERE entity_type = 'variant' AND entity_id = $1 AND action = 'Variant updated' ORDER BY id DESC LIMIT 1`, [sugarVariant.id]);
  check('  the trail has the old and the new price', near(priceTrail.rows[0]?.details?.before?.sellingPrice, 1500) && near(priceTrail.rows[0]?.details?.after?.sellingPrice, 1800), priceTrail.rows[0]);

  // Stock that arrived ADDS; asked by the manager, it waits for the Director.
  const stockOf = async () => (await pool.query('SELECT stock_quantity FROM boutique_variants WHERE id = $1', [sugarVariant.id])).rows[0].stock_quantity;
  const arrived = await post(admin, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'received', quantity: 10 });
  check('new stock arriving adds to the shelf (19 + 10 = 29)', arrived.status === 201 && arrived.body.status === 'approved' && arrived.body.delta === 10 && await stockOf() === 29, arrived.body);
  check('  and needs no reason', arrived.body.reason === 'New stock received', arrived.body.reason);
  const askKey = `zz-ask-${Date.now()}`;
  const deliveryAsked = await post(manager.token, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'received', quantity: 5, requestKey: askKey });
  const deliveryAgain = await post(manager.token, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'received', quantity: 5, requestKey: askKey });
  const askedRows = await pool.query('SELECT COUNT(*)::int AS n FROM boutique_stock_adjustments WHERE request_key = $1', [askKey]);
  check('the manager’s delivery waits for the Director', deliveryAsked.status === 201 && deliveryAsked.body.status === 'pending' && await stockOf() === 29, deliveryAsked.body);
  check('  sent twice, it is recorded once', deliveryAgain.status === 200 && deliveryAgain.body.id === deliveryAsked.body.id && askedRows.rows[0].n === 1, deliveryAgain.body);
  await post(admin, `/api/boutique/stock/adjustments/${deliveryAsked.body.id}/decision`, { approve: true });
  check('  approved, the stock becomes 34', await stockOf() === 34);
  const tooMuch = await post(admin, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'damaged', quantity: 35, reason: 'ZZTEST more than there is' });
  check('taking out more than is on the shelf is refused', tooMuch.status === 409 && tooMuch.body.code === 'INSUFFICIENT_STOCK' && await stockOf() === 34, tooMuch.body);
  const noReason = await post(admin, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'damaged', quantity: 1 });
  check('a write-off without a reason is refused', noReason.status === 400, noReason.body);
  // Two write-offs of 20 at once against 34: one lands, one is refused, and
  // nothing is lost between them.
  const both = await Promise.all([1, 2].map((n) => post(admin, '/api/boutique/stock/adjustments', { variantId: sugarVariant.id, kind: 'damaged', quantity: 20, reason: `ZZTEST spoiled batch ${n}` })));
  const landed = both.filter((r) => r.status === 201).length;
  const refusedOne = both.filter((r) => r.status === 409).length;
  const ledgerSum = await pool.query('SELECT COALESCE(SUM(quantity), 0)::int AS total FROM boutique_stock_movements WHERE variant_id = $1', [sugarVariant.id]);
  check('two write-offs at once: one lands, one is refused', landed === 1 && refusedOne === 1, both.map((r) => r.status));
  check('  the shelf is 14 and the ledger agrees', await stockOf() === 14 && ledgerSum.rows[0].total === 14, { shelf: await stockOf(), ledger: ledgerSum.rows[0].total });
} catch (error) {
  failed += 1;
  console.log(`  FAIL  unexpected error -- ${error.stack || error.message}`);
} finally {
  // Everything this suite wrote, in dependency order. Sales hang off zz
  // cashiers and ZZTEST variants; products and suppliers carry the marker.
  const zz = `(SELECT id FROM users WHERE username LIKE 'zz-btq-%')`;
  const zzVariants = `(SELECT v.id FROM boutique_variants v JOIN boutique_products p ON p.id = v.product_id WHERE p.name LIKE 'ZZTEST %')`;
  const zzSales = `(SELECT id FROM boutique_sales WHERE cashier_id IN ${zz} OR id IN (SELECT sale_id FROM boutique_sale_items WHERE variant_id IN ${zzVariants}))`;
  // The Director's own trail rows are removed by the records they are about
  // -- the suite's sales, returns, adjustments, expenses, products, suppliers
  // and purchases -- never by a time window, so a run against a live
  // database cannot erase a real decision taken moments before.
  const ids = async (sql) => (await pool.query(sql)).rows.map((row) => row.id);
  const trail = {
    sale: await ids(`SELECT id FROM boutique_sales WHERE id IN ${zzSales}`),
    return: await ids(`SELECT id FROM boutique_returns WHERE sale_id IN ${zzSales}`),
    adjustment: await ids(`SELECT id FROM boutique_stock_adjustments WHERE variant_id IN ${zzVariants}`),
    expense: await ids(`SELECT id FROM boutique_expenses WHERE recorded_by IN ${zz}`),
    session: await ids(`SELECT id FROM boutique_cash_sessions WHERE opened_by IN ${zz}`),
    product: await ids(`SELECT id FROM boutique_products WHERE name LIKE 'ZZTEST %'`),
    variant: await ids(`SELECT id FROM boutique_variants WHERE id IN ${zzVariants}`),
    supplier: await ids(`SELECT id FROM boutique_suppliers WHERE name LIKE 'ZZTEST %'`),
    purchase: await ids(`SELECT id FROM boutique_purchase_orders WHERE supplier_id IN (SELECT id FROM boutique_suppliers WHERE name LIKE 'ZZTEST %')`),
    submission: await ids(`SELECT id FROM boutique_submissions WHERE submitted_by IN ${zz}`)
  };
  for (const [entityType, entityIds] of Object.entries(trail)) {
    if (entityIds.length) await pool.query('DELETE FROM boutique_audit WHERE entity_type = $1 AND entity_id = ANY($2::int[])', [entityType, entityIds]);
  }
  await pool.query(`DELETE FROM boutique_return_items WHERE return_id IN (SELECT id FROM boutique_returns WHERE sale_id IN ${zzSales})`);
  await pool.query(`UPDATE boutique_sales SET exchange_of_return_id = NULL WHERE id IN ${zzSales}`);
  await pool.query(`DELETE FROM boutique_returns WHERE sale_id IN ${zzSales}`);
  await pool.query(`DELETE FROM boutique_sales WHERE id IN ${zzSales}`);
  await pool.query(`DELETE FROM boutique_expenses WHERE recorded_by IN ${zz}`);
  await pool.query(`DELETE FROM boutique_cash_sessions WHERE opened_by IN ${zz}`);
  await pool.query(`DELETE FROM boutique_supplier_payments WHERE supplier_id IN (SELECT id FROM boutique_suppliers WHERE name LIKE 'ZZTEST %')`);
  await pool.query(`DELETE FROM boutique_purchase_orders WHERE supplier_id IN (SELECT id FROM boutique_suppliers WHERE name LIKE 'ZZTEST %')`);
  await pool.query(`DELETE FROM boutique_suppliers WHERE name LIKE 'ZZTEST %'`);
  await pool.query(`DELETE FROM boutique_products WHERE name LIKE 'ZZTEST %'`);
  // The payment-method toggles the suite made are the only settings rows
  // written since it started.
  await pool.query(`DELETE FROM boutique_audit WHERE actor_id IN ${zz} OR (entity_type = 'settings' AND created_at >= $1)`, [startedAt]);
  await pool.query(`DELETE FROM notifications WHERE actor_id IN ${zz} OR user_id IN ${zz} OR kind LIKE 'boutique_%'`);
  await pool.query(`DELETE FROM boutique_submissions WHERE submitted_by IN ${zz}`);
  await pool.query(`DELETE FROM organization_history WHERE subject_user_id IN ${zz} OR subject_name LIKE 'ZZ %'`);
  await pool.query(`DELETE FROM partner_operations WHERE partner_id IN ${zz}`);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-btq-%'");
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
